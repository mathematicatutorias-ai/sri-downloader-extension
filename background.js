/**
 * Descargador de Comprobantes SRI - Background Service Worker
 * Maneja la descarga de forma persistente (no se detiene al cerrar popup)
 * Guarda historial en chrome.storage.local
 * Verifica descargas reales con chrome.downloads API
 */

importScripts('config.js');

// Estado global de descarga
let estadoDescarga = {
  activo: false,
  detenido: false,
  exitosos: 0,
  fallidos: 0,
  omitidos: 0,
  paginaActual: 0,
  totalPaginas: 0,
  documentoActual: 0,
  totalDocumentos: 0,
  tipoDescarga: 'xml',
  origen: 'recibidos',
  tabId: null,
  sesionId: null,
  rucUsuario: null,
  timestampInicio: null,
  tiempoEstimado: null,
  error: null,
  avisos: [],
  viaAlternativa: 0
};

/**
 * true si la URL pertenece al SRI. Compara el hostname (no un includes()
 * sobre la URL completa, que aceptaria "otro-sitio.com/?x=sri.gob.ec").
 * @param {string} url
 * @returns {boolean}
 */
function esUrlDelSri(url) {
  try {
    const host = new URL(url).hostname;
    return host === SRI_CONFIG.DOMINIO_SRI || host.endsWith('.' + SRI_CONFIG.DOMINIO_SRI);
  } catch (e) {
    return false;
  }
}

// Sistema de deteccion de descargas basado en timing + filtro laxo de origen.
// Cuando hacemos click en un link del SRI, esperamos que onCreated se dispare
// dentro del timeout. El filtro acepta dominio SRI, blob: o URL vacia (JSF
// puede no exponer la URL), pero rechaza descargas de otros sitios para no
// marcar como exito una descarga ajena que el usuario inicie en paralelo.
let pendingDownload = { resolver: null, timestamp: null, docMetadata: null, tipoArchivo: null };

// Map de metadata por downloadId para onDeterminingFilename
let downloadMetadataMap = new Map();

// Metadata pendiente de una descarga iniciada por la propia extension con
// chrome.downloads.download sobre un data URL (XML de emitidos obtenido del
// web service, PDF de emitidos obtenido por fetch). Esa descarga no pasa por
// onCreated/pendingDownload, asi que se consume directamente en
// onDeterminingFilename para decidir la ruta. Las descargas son secuenciales:
// a lo sumo hay una pendiente a la vez.
let pendingDataUrlMeta = null;

chrome.downloads.onCreated.addListener((downloadItem) => {
  if (!pendingDownload.resolver || !pendingDownload.timestamp) return;

  const elapsed = Date.now() - pendingDownload.timestamp;
  if (elapsed >= SRI_CONFIG.TIMEOUT_DESCARGA) return;

  const url = downloadItem.url || '';
  const finalUrl = downloadItem.finalUrl || '';
  const esDelSri = url === '' || url.startsWith('blob:') ||
    esUrlDelSri(url) || esUrlDelSri(finalUrl);
  if (!esDelSri) return;

  // Guardar metadata para onDeterminingFilename antes de limpiar
  if (pendingDownload.docMetadata) {
    downloadMetadataMap.set(downloadItem.id, {
      docMetadata: { ...pendingDownload.docMetadata, rucUsuario: estadoDescarga.rucUsuario },
      tipoArchivo: pendingDownload.tipoArchivo
    });
  }
  pendingDownload.resolver({ success: true, downloadId: downloadItem.id });
  pendingDownload.resolver = null;
  pendingDownload.timestamp = null;
  pendingDownload.docMetadata = null;
  pendingDownload.tipoArchivo = null;
});

// Interceptar descargas para organizar en carpetas
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  let meta = downloadMetadataMap.get(downloadItem.id);
  let esDataUrl = false;

  // Descarga por data URL iniciada por la extension (XML del WS o archivo
  // obtenido por fetch): el filename pasado a chrome.downloads.download NO
  // sobrevive a este listener (cualquier suggest con nombre lo pisa), asi
  // que la ruta definitiva se decide aqui
  if (!meta && pendingDataUrlMeta && downloadItem.url?.startsWith('data:')) {
    meta = pendingDataUrlMeta;
    pendingDataUrlMeta = null;
    esDataUrl = true;
  }

  if (!meta) {
    // Descarga ajena: usar filename original - suggest() sin args puede
    // cancelar la descarga
    suggest({ filename: downloadItem.filename });
    return true;
  }

  downloadMetadataMap.delete(downloadItem.id);

  // Obtener extension del archivo original
  const nombreOriginal = downloadItem.filename || '';
  let extension = '';
  if (nombreOriginal.includes('.')) {
    extension = '.' + nombreOriginal.split('.').pop().toLowerCase();
  } else {
    extension = meta.tipoArchivo === 'xml' ? '.xml' : '.pdf';
  }

  // Devuelve null si la organizacion esta deshabilitada
  const rutaCompleta = construirRutaArchivo(meta.docMetadata, meta.tipoArchivo, extension);

  if (rutaCompleta) {
    suggest({ filename: rutaCompleta, conflictAction: 'overwrite' });
  } else if (esDataUrl) {
    // Sin organizacion: nombre por clave de acceso en la carpeta de descargas
    // (el nombre generico que Chrome genera para un data URL no sirve)
    suggest({ filename: construirNombreArchivo('claveAcceso', meta.docMetadata, extension) });
  } else {
    suggest({ filename: downloadItem.filename });
  }
  return true;
});

// Intentar aceptar descargas del SRI marcadas como "peligrosas". Es solo un
// intento: Chrome exige que acceptDanger se llame desde un contexto visible
// (pestana o popup), asi que desde el service worker normalmente rechaza la
// promesa; se captura para no dejar errores sin manejar. Si el navegador
// bloquea el archivo, el usuario debe conservarlo desde la barra de descargas
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.danger && delta.danger.current === 'file') {
    chrome.downloads.search({ id: delta.id }, (items) => {
      if (items.length > 0 && esUrlDelSri(items[0].url || '')) {
        try {
          const p = chrome.downloads.acceptDanger?.(delta.id);
          if (p?.catch) p.catch(() => {});
        } catch (e) {
          // acceptDanger no disponible en esta version de Chrome/Edge
        }
      }
    });
  }
});

// Detectar si la tab del SRI se cierra durante descarga
chrome.tabs.onRemoved.addListener((tabId) => {
  if (estadoDescarga.activo && estadoDescarga.tabId === tabId) {
    estadoDescarga.detenido = true;
    estadoDescarga.error = 'La pestana del SRI fue cerrada';
    actualizarBadge();
    notificarProgreso();
  }
});

/**
 * Genera un ID unico para la sesion de descarga.
 * @returns {string} ID con timestamp + sufijo aleatorio (ej: "sesion_1700000000000_ab12cd34e")
 */
function generarSesionId() {
  return `sesion_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Buffer en memoria para la sesion actual
let bufferSesion = {
  documentos: [],
  rucUsuario: null
};

// Indice de documentos ya descargados (Set para O(1) lookup)
let indiceDescargados = new Set();

/**
 * Construye un Set con claves de acceso ya descargadas exitosamente, usado
 * para deduplicar en O(1) durante la sesion.
 *
 * Semantica de exitoXml/exitoPdf en el historial:
 * - null  = ese formato NO se intento (no fue solicitado o el doc no tenia link)
 * - true  = se descargo correctamente
 * - false = se intento y fallo
 * Solo se cuenta como "cubierto" un formato si ademas la sesion realmente lo
 * solicito (sesion.tipoDescarga), porque registros de versiones viejas
 * guardaban true por defecto sin haberlo intentado.
 *
 * Un documento entra al indice solo si cubre lo que la NUEVA sesion pide:
 * 'xml' requiere xmlOk, 'pdf' requiere pdfOk, 'ambos' requiere los dos.
 * Esto es deliberadamente conservador: ante duda se re-descarga.
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Tipo solicitado en la nueva sesion
 * @returns {Promise<Set<string>>} Claves de acceso que se pueden omitir
 */
async function construirIndiceDescargados(tipoDescarga) {
  const historial = await leerHistorial();
  const indice = new Set();

  for (const ruc in historial) {
    for (const sid in historial[ruc].sesiones) {
      const sesion = historial[ruc].sesiones[sid];
      // Un flag exitoXml/exitoPdf solo es confiable si esa sesion realmente
      // intento ese formato (registros de versiones viejas guardaban true por defecto)
      const cubreXml = sesion.tipoDescarga === 'xml' || sesion.tipoDescarga === 'ambos';
      const cubrePdf = sesion.tipoDescarga === 'pdf' || sesion.tipoDescarga === 'ambos';
      for (const doc of sesion.documentos) {
        if (!doc.exito) continue;
        const xmlOk = cubreXml && doc.exitoXml === true;
        const pdfOk = cubrePdf && doc.exitoPdf === true;
        if (tipoDescarga === 'xml' && xmlOk) indice.add(doc.claveAcceso);
        else if (tipoDescarga === 'pdf' && pdfOk) indice.add(doc.claveAcceso);
        else if (tipoDescarga === 'ambos' && xmlOk && pdfOk) indice.add(doc.claveAcceso);
      }
    }
  }

  return indice;
}

/**
 * Agrega un documento al buffer en memoria (no escribe a storage).
 * @param {Object} registro - Registro del documento procesado (clave, exito, etc.)
 */
function agregarAlBuffer(registro) {
  bufferSesion.documentos.push(registro);
}

/**
 * Guarda el buffer al storage bajo el sesionId actual (sobreescribe la misma
 * sesion en cada llamada, no duplica). Se llama incrementalmente (al terminar
 * cada pagina) porque Chrome puede terminar el service worker MV3 en cualquier
 * momento de una descarga larga y el buffer en memoria se perderia; y al
 * finalizar con esFinal=true para ademas limpiar el buffer.
 * @param {boolean} [esFinal=true] - true limpia el buffer tras guardar
 * @returns {Promise<void>}
 */
async function guardarBufferAlStorage(esFinal = true) {
  if (bufferSesion.documentos.length === 0) return;

  try {
    const exitosos = bufferSesion.documentos.filter(d => d.exito).length;

    // Una clave por sesion: guardar solo reescribe ESTA sesion, no todo el
    // historial (antes cada pagina leia y reescribia el historial completo)
    await chrome.storage.local.set({
      [PREFIJO_SESION + estadoDescarga.sesionId]: {
        ruc: bufferSesion.rucUsuario || 'sin_ruc',
        fecha: new Date().toISOString(),
        tipoDescarga: estadoDescarga.tipoDescarga,
        origen: estadoDescarga.origen || 'recibidos',
        documentos: bufferSesion.documentos,
        resumen: {
          exitosos: exitosos,
          fallidos: bufferSesion.documentos.length - exitosos,
          total: bufferSesion.documentos.length
        }
      }
    });

    if (esFinal) {
      bufferSesion = { documentos: [], rucUsuario: null };
    }

  } catch (e) {
    // No ocultar el fallo: sin historial la deduplicacion deja de funcionar
    agregarAviso(`No se pudo guardar el historial de descargas (${e.message}). Los documentos de esta sesion podrian volver a descargarse.`);
  }
}

/**
 * Prefijo de las claves de chrome.storage.local que guardan una sesion del
 * historial: `hs_<sesionId>` -> {ruc, fecha, tipoDescarga, origen, documentos,
 * resumen}. Hasta la v1.6.0 todo el historial vivia en una sola clave
 * `historialDescargas` ({ruc: {sesiones: {...}}}); limpiarHistorialAntiguo la
 * migra al formato nuevo y leerHistorial entiende ambos.
 */
const PREFIJO_SESION = 'hs_';

/**
 * Lee el historial completo y lo devuelve con la forma
 * {ruc: {sesiones: {sesionId: sesion}}} (la que consumen el popup y el indice
 * de dedup), juntando las claves por sesion y el formato anterior si existe.
 * @returns {Promise<Object>}
 */
async function leerHistorial() {
  const todo = await chrome.storage.local.get(null);
  const historial = {};
  const agregar = (ruc, sesionId, sesion) => {
    if (!sesion || !Array.isArray(sesion.documentos)) return;
    if (!historial[ruc]) historial[ruc] = { sesiones: {} };
    historial[ruc].sesiones[sesionId] = sesion;
  };

  const anterior = todo.historialDescargas || {};
  for (const ruc in anterior) {
    for (const sesionId in (anterior[ruc].sesiones || {})) {
      agregar(ruc, sesionId, anterior[ruc].sesiones[sesionId]);
    }
  }

  for (const clave in todo) {
    if (clave.startsWith(PREFIJO_SESION)) {
      agregar(todo[clave]?.ruc || 'sin_ruc', clave.slice(PREFIJO_SESION.length), todo[clave]);
    }
  }
  return historial;
}

/**
 * Obtiene el historial de descargas desde storage.
 * @param {string|null} [ruc=null] - Si se indica, devuelve solo el historial de ese RUC
 * @returns {Promise<Object|null>} Historial completo, el de un RUC, o null si falla
 */
async function obtenerHistorial(ruc = null) {
  try {
    const historial = await leerHistorial();
    return ruc ? (historial[ruc] || null) : historial;
  } catch (e) {
    return null;
  }
}

/**
 * Borra todo el historial (claves por sesion + formato anterior).
 * @returns {Promise<void>}
 */
async function borrarHistorial() {
  const todo = await chrome.storage.local.get(null);
  const claves = Object.keys(todo).filter(k => k.startsWith(PREFIJO_SESION));
  claves.push('historialDescargas');
  await chrome.storage.local.remove(claves);
}

/**
 * Limpia sesiones del historial con mas de N dias de antiguedad
 * (SRI_CONFIG.DIAS_HISTORIAL). De paso migra el formato anterior (una sola
 * clave con todo) a una clave por sesion.
 * @returns {Promise<void>}
 */
async function limpiarHistorialAntiguo() {
  try {
    const todo = await chrome.storage.local.get(null);
    const limite = Date.now() - (SRI_CONFIG.DIAS_HISTORIAL * 24 * 60 * 60 * 1000);
    const esAntigua = (sesion) => !(new Date(sesion?.fecha).getTime() >= limite);
    const borrar = [];
    const escribir = {};

    // Migracion del formato anterior: conservar solo las sesiones vigentes
    if (todo.historialDescargas) {
      for (const ruc in todo.historialDescargas) {
        const sesiones = todo.historialDescargas[ruc].sesiones || {};
        for (const sesionId in sesiones) {
          if (!esAntigua(sesiones[sesionId])) {
            escribir[PREFIJO_SESION + sesionId] = { ...sesiones[sesionId], ruc };
          }
        }
      }
      borrar.push('historialDescargas');
    }

    for (const clave in todo) {
      if (clave.startsWith(PREFIJO_SESION) && esAntigua(todo[clave])) borrar.push(clave);
    }

    // Primero escribir lo migrado y recien despues borrar el formato anterior
    if (Object.keys(escribir).length > 0) await chrome.storage.local.set(escribir);
    if (borrar.length > 0) await chrome.storage.local.remove(borrar);
  } catch (e) {
    // Error limpiando historial: se reintenta en la proxima sesion
  }
}

/**
 * Agrega un aviso a la sesion actual (sin duplicarlo). Los avisos no son
 * errores que aborten: el popup y la notificacion final los muestran.
 * @param {string} texto
 */
function agregarAviso(texto) {
  if (!Array.isArray(estadoDescarga.avisos)) estadoDescarga.avisos = [];
  if (!estadoDescarga.avisos.includes(texto)) estadoDescarga.avisos.push(texto);
}

// Metodo de descarga activo: 'mojarra' o 'click'
let metodoDescarga = 'mojarra';

/**
 * Carga la configuracion del usuario desde storage y la aplica sobre
 * SRI_CONFIG (solo las claves definidas; el resto conserva los defaults).
 * @returns {Promise<void>}
 */
async function cargarConfigUsuario() {
  const data = await chrome.storage.local.get(['sriConfig']);
  if (data.sriConfig) {
    if (data.sriConfig.DELAY_DESCARGA !== undefined) SRI_CONFIG.DELAY_DESCARGA = data.sriConfig.DELAY_DESCARGA;
    if (data.sriConfig.TIMEOUT_DESCARGA !== undefined) SRI_CONFIG.TIMEOUT_DESCARGA = data.sriConfig.TIMEOUT_DESCARGA;
    if (data.sriConfig.DELAY_PAGINA !== undefined) SRI_CONFIG.DELAY_PAGINA = data.sriConfig.DELAY_PAGINA;
    if (data.sriConfig.TIMEOUT_PAGINA !== undefined) SRI_CONFIG.TIMEOUT_PAGINA = data.sriConfig.TIMEOUT_PAGINA;
    if (data.sriConfig.MAX_REINTENTOS !== undefined) SRI_CONFIG.MAX_REINTENTOS = data.sriConfig.MAX_REINTENTOS;
    if (data.sriConfig.DELAY_REINTENTO !== undefined) SRI_CONFIG.DELAY_REINTENTO = data.sriConfig.DELAY_REINTENTO;
    if (data.sriConfig.DIAS_HISTORIAL !== undefined) SRI_CONFIG.DIAS_HISTORIAL = data.sriConfig.DIAS_HISTORIAL;
    if (data.sriConfig.METODO_DESCARGA) metodoDescarga = data.sriConfig.METODO_DESCARGA;
    if (data.sriConfig.ORGANIZACION !== undefined) {
      SRI_CONFIG.ORGANIZACION = { ...SRI_CONFIG.ORGANIZACION, ...data.sriConfig.ORGANIZACION };
    }
  }
}

/**
 * Ejecuta descarga usando mojarra.jsfcljs (metodo directo JSF).
 * Llama la funcion JSF directamente sin pasar por el click del DOM. Requiere
 * world: 'MAIN' porque mojarra solo existe en el contexto de la pagina y el
 * CSP del SRI bloquea scripts inline.
 * La confirmacion de exito NO es el return del script sino que
 * chrome.downloads.onCreated se dispare dentro de TIMEOUT_DESCARGA
 * (via pendingDownload), evitando marcar OK descargas que nunca ocurrieron.
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del link JSF de descarga (ej: "frmPrincipal:...:lnkXml")
 * @param {Object} docMetadata - Metadata del documento para organizar el archivo
 * @param {'xml'|'pdf'} tipoArchivo - Formato que se esta descargando
 * @returns {Promise<boolean>} true si la descarga fue confirmada por onCreated
 */
function ejecutarDescargaMojarra(tabId, linkId, docMetadata, tipoArchivo) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingDownload.resolver = null;
      pendingDownload.timestamp = null;
      pendingDownload.docMetadata = null;
      pendingDownload.tipoArchivo = null;
      resolve(false);
    }, SRI_CONFIG.TIMEOUT_DESCARGA);

    pendingDownload.timestamp = Date.now();
    pendingDownload.docMetadata = docMetadata || null;
    pendingDownload.tipoArchivo = tipoArchivo || null;
    pendingDownload.resolver = (resultado) => {
      clearTimeout(timeout);
      resolve(resultado?.success ?? false);
    };

    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: (linkId) => {
        try {
          mojarra.jsfcljs(
            document.getElementById('frmPrincipal'),
            { [linkId]: linkId },
            ''
          );
          return { success: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [linkId]
    }).then((resultado) => {
      const res = resultado[0]?.result;
      if (!res?.success) {
        clearTimeout(timeout);
        pendingDownload.resolver = null;
        pendingDownload.timestamp = null;
        pendingDownload.docMetadata = null;
        pendingDownload.tipoArchivo = null;
        resolve(false);
      }
    }).catch(() => {
      clearTimeout(timeout);
      pendingDownload.resolver = null;
      pendingDownload.timestamp = null;
      pendingDownload.docMetadata = null;
      pendingDownload.tipoArchivo = null;
      resolve(false);
    });
  });
}

/**
 * Ejecuta descarga usando click emulado en el link de descarga.
 * Alternativa mas compatible (pero mas lenta) al metodo mojarra; misma
 * confirmacion via chrome.downloads.onCreated que ejecutarDescargaMojarra.
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del elemento link a clickear
 * @param {Object} docMetadata - Metadata del documento para organizar el archivo
 * @param {'xml'|'pdf'} tipoArchivo - Formato que se esta descargando
 * @returns {Promise<boolean>} true si la descarga fue confirmada por onCreated
 */
function ejecutarDescargaClick(tabId, linkId, docMetadata, tipoArchivo) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingDownload.resolver = null;
      pendingDownload.timestamp = null;
      pendingDownload.docMetadata = null;
      pendingDownload.tipoArchivo = null;
      resolve(false);
    }, SRI_CONFIG.TIMEOUT_DESCARGA);

    pendingDownload.timestamp = Date.now();
    pendingDownload.docMetadata = docMetadata || null;
    pendingDownload.tipoArchivo = tipoArchivo || null;
    pendingDownload.resolver = (resultado) => {
      clearTimeout(timeout);
      resolve(resultado?.success ?? false);
    };

    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: (linkId) => {
        const el = document.getElementById(linkId);
        if (!el) return { success: false, error: 'no-element' };
        el.click();
        return { success: true };
      },
      args: [linkId]
    }).then((resultado) => {
      const res = resultado[0]?.result;
      if (!res?.success) {
        clearTimeout(timeout);
        pendingDownload.resolver = null;
        pendingDownload.timestamp = null;
        pendingDownload.docMetadata = null;
        pendingDownload.tipoArchivo = null;
        resolve(false);
      }
    }).catch(() => {
      clearTimeout(timeout);
      pendingDownload.resolver = null;
      pendingDownload.timestamp = null;
      pendingDownload.docMetadata = null;
      pendingDownload.tipoArchivo = null;
      resolve(false);
    });
  });
}

/**
 * Ejecuta la descarga usando el metodo configurado por el usuario
 * ('mojarra' por defecto, 'click' como alternativa compatible).
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del link de descarga
 * @param {Object} docMetadata - Metadata del documento
 * @param {'xml'|'pdf'} tipoArchivo - Formato que se esta descargando
 * @returns {Promise<boolean>} true si la descarga fue confirmada
 */
function ejecutarDescargaSRI(tabId, linkId, docMetadata, tipoArchivo) {
  if (metodoDescarga === 'click') {
    return ejecutarDescargaClick(tabId, linkId, docMetadata, tipoArchivo);
  }
  return ejecutarDescargaMojarra(tabId, linkId, docMetadata, tipoArchivo);
}

// =====================================================
// Descarga de XML de emitidos via web service del SRI
// =====================================================
// En la pantalla de emitidos no hay link de descarga de XML (solo el PDF/RIDE).
// El XML autorizado se obtiene del WS publico AutorizacionComprobantesOffline
// usando la clave de acceso. Requiere host_permissions para cel/celcer.sri.gob.ec.

/**
 * Des-escapa las entidades XML de una cadena (el WS devuelve el comprobante
 * con &lt; &gt; &amp; etc.). El service worker MV3 no tiene DOMParser, asi que
 * se resuelven manualmente. Se hace en UNA SOLA pasada con una alternancia
 * para que el texto producido nunca se re-escanee (evita dobles
 * decodificaciones como &amp;#38;lt; → &lt; → <).
 * @param {string} s - Cadena con entidades escapadas
 * @returns {string} XML des-escapado
 */
function desescaparXml(s) {
  const nombradas = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (m, ent) => {
    if (ent[0] === '#') {
      const codigo = (ent[1] === 'x' || ent[1] === 'X')
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return String.fromCodePoint(codigo);
    }
    return nombradas[ent];
  });
}

/**
 * Convierte un string XML a un data URL base64 (UTF-8). En el service worker
 * MV3 no existe URL.createObjectURL, asi que se descarga via data URL.
 * @param {string} xml - Contenido XML
 * @returns {string} data URL descargable
 */
function xmlADataUrl(xml) {
  return bytesADataUrl(new TextEncoder().encode(xml), 'application/xml');
}

/**
 * Convierte bytes a data URL base64 (el service worker MV3 no tiene
 * URL.createObjectURL). Se concatena por bloques para no desbordar la pila
 * con String.fromCharCode(...bytes) en archivos grandes.
 * @param {Uint8Array} bytes - Contenido binario
 * @param {string} mime - Content-Type del data URL
 * @returns {string} data URL
 */
function bytesADataUrl(bytes, mime) {
  let bin = '';
  const BLOQUE = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOQUE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOQUE));
  }
  return 'data:' + mime + ';base64,' + btoa(bin);
}

/**
 * Consulta el WS de autorizacion del SRI (siempre PRODUCCION: es el ambiente
 * del portal donde se consulta) y devuelve el XML del comprobante autorizado
 * (des-escapado).
 * Distingue la respuesta definitiva del SRI (el comprobante no esta
 * autorizado o no existe: reintentar no cambia nada) de los fallos
 * transitorios (red, timeout, HTTP de error), que lanzan excepcion.
 * @param {string} claveAcceso - Clave de acceso de 49 digitos
 * @returns {Promise<{xml: string, numeroAutorizacion: string, fechaAutorizacion: string}|{noAutorizado: true, estado: string}>}
 * @throws {Error} Fallo transitorio (red, timeout, HTTP >= 400)
 */
async function consultarXmlAutorizado(claveAcceso) {
  const endpoint = SRI_CONFIG.WS_AUTORIZACION.PRODUCCION;
  const soap = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="' +
    SRI_CONFIG.WS_AUTORIZACION.NAMESPACE + '"><soapenv:Header/><soapenv:Body>' +
    '<ec:autorizacionComprobante><claveAccesoComprobante>' + claveAcceso +
    '</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>';

  // Con timeout: sin el, un WS colgado bloquea la sesion entera (y el boton
  // Detener no responde porque el bucle esta esperando este await)
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '' },
    body: soap,
    signal: AbortSignal.timeout(SRI_CONFIG.TIMEOUT_WS)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const txt = await resp.text();

  // Verificar estado AUTORIZADO. Sin <estado> el WS no encontro el comprobante
  const estado = (txt.match(/<estado>([^<]*)<\/estado>/) || [])[1];
  if (estado !== 'AUTORIZADO') return { noAutorizado: true, estado: estado || 'NO ENCONTRADO' };

  // Extraer el comprobante (viene escapado, puede o no estar en CDATA)
  const m = txt.match(/<comprobante>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/comprobante>/);
  if (!m || !m[1]) throw new Error('respuesta sin comprobante');

  const xml = desescaparXml(m[1]).trim();
  return {
    xml,
    numeroAutorizacion: (txt.match(/<numeroAutorizacion>([^<]*)<\/numeroAutorizacion>/) || [])[1] || '',
    fechaAutorizacion: (txt.match(/<fechaAutorizacion>([^<]*)<\/fechaAutorizacion>/) || [])[1] || ''
  };
}

/**
 * Descarga el XML autorizado de un comprobante emitido via web service
 * (ambiente de produccion).
 * @param {string} claveAcceso - Clave de acceso de 49 digitos
 * @param {Object} docMetadata - Metadata para organizar/nombrar el archivo
 * @returns {Promise<{ok: boolean, definitivo?: boolean, error?: string}>}
 *   ok=true si se disparo la descarga; definitivo=true si el SRI respondio
 *   que el comprobante no esta autorizado (no tiene sentido reintentar)
 */
async function descargarXmlEmitido(claveAcceso, docMetadata) {
  try {
    const resultado = await consultarXmlAutorizado(claveAcceso);
    if (resultado.noAutorizado) {
      return { ok: false, definitivo: true, error: `XML no disponible en el SRI (estado: ${resultado.estado})` };
    }

    const url = xmlADataUrl(resultado.xml);
    const meta = { ...docMetadata, rucUsuario: estadoDescarga.rucUsuario };

    // La ruta organizada NO se pasa aqui como filename: nuestro propio
    // listener de onDeterminingFilename la pisaria (un suggest con nombre
    // anula el filename de downloads.download). La ruta se decide en el
    // listener via pendingDataUrlMeta; este filename queda solo de respaldo.
    pendingDataUrlMeta = { docMetadata: meta, tipoArchivo: 'xml' };
    await chrome.downloads.download({
      url,
      filename: `${claveAcceso}.xml`,
      conflictAction: 'uniquify'
    });
    return { ok: true };
  } catch (e) {
    pendingDataUrlMeta = null;
    return { ok: false, error: `Error descargando XML (${e.message})` };
  }
}

/**
 * Descarga el archivo de un link JSF (XML o PDF/RIDE) haciendo el POST del
 * link con fetch desde la pagina (misma sesion y cookies) en vez de enviar el
 * formulario con mojarra.jsfcljs.
 * - Emitidos (PDF): es el metodo principal. Verificado en vivo (2026-11): el
 *   submit del formulario (incluso el click manual en RIDE) responde 503,
 *   mientras que el mismo POST por fetch devuelve el PDF en ~100 ms.
 * - Recibidos: es solo el RESPALDO cuando el metodo normal (mojarra/click)
 *   agoto sus reintentos; el llamador lo avisa al usuario.
 * La respuesta se valida por contenido y no por Content-Type: un PDF empieza
 * con "%PDF"; un XML empieza con "<" y no es una pagina HTML ni una respuesta
 * parcial de JSF (lo que devuelve el SRI con la sesion caida o un error).
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del link JSF (...:lnkXml o ...:lnkPdf)
 * @param {Object} docMetadata - Metadata para organizar/nombrar el archivo
 * @param {'xml'|'pdf'} tipoArchivo - Formato esperado
 * @returns {Promise<boolean>} true si se disparo la descarga
 */
async function descargarPorFetch(tabId, linkId, docMetadata, tipoArchivo) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async (linkId, tipoArchivo, timeoutMs) => {
        const form = document.getElementById('frmPrincipal');
        if (!form || !document.getElementById(linkId)) return { ok: false, error: 'sin-form-o-link' };
        // Mismos campos que enviaria mojarra.jsfcljs: el formulario completo
        // (incluye javax.faces.ViewState) + el id del link como parametro
        const fd = new FormData(form);
        fd.append(linkId, linkId);
        const resp = await fetch(form.action || location.href, {
          method: 'POST',
          body: new URLSearchParams([...fd]),
          credentials: 'include',
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!resp.ok) return { ok: false, error: `status ${resp.status}` };
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (bytes.length === 0) return { ok: false, error: 'vacio' };

        const cabecera = new TextDecoder('utf-8').decode(bytes.subarray(0, 600)).replace(/^﻿/, '').trimStart();
        const valido = tipoArchivo === 'pdf'
          ? cabecera.startsWith('%PDF')
          : cabecera.startsWith('<') && !/<!doctype html|<html|<partial-response/i.test(cabecera);
        if (!valido) return { ok: false, error: 'contenido-inesperado' };

        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return { ok: true, base64: btoa(bin) };
      },
      args: [linkId, tipoArchivo, SRI_CONFIG.TIMEOUT_WS]
    });
    const res = r[0]?.result;
    if (!res?.ok) return false;

    const meta = { ...docMetadata, rucUsuario: estadoDescarga.rucUsuario };
    const mime = tipoArchivo === 'pdf' ? 'application/pdf' : 'application/xml';
    // Igual que el XML del WS: la ruta final la decide onDeterminingFilename
    pendingDataUrlMeta = { docMetadata: meta, tipoArchivo };
    await chrome.downloads.download({
      url: `data:${mime};base64,${res.base64}`,
      filename: `${docMetadata.claveAcceso}.${tipoArchivo}`,
      conflictAction: 'uniquify'
    });
    return true;
  } catch (e) {
    pendingDataUrlMeta = null;
    return false;
  }
}

/**
 * PDF de emitidos con reintentos: primero por fetch; si en todos los intentos
 * el servidor no entrega un PDF, cae al metodo clasico (mojarra/click) por
 * compatibilidad, que a su vez tiene sus propios reintentos.
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del link JSF del PDF
 * @param {Object} docMetadata - Metadata del documento
 * @returns {Promise<boolean>} true si se disparo la descarga
 */
async function descargarPdfEmitidoConReintento(tabId, linkId, docMetadata) {
  for (let intento = 0; intento <= SRI_CONFIG.MAX_REINTENTOS; intento++) {
    const exito = await descargarPorFetch(tabId, linkId, docMetadata, 'pdf');
    if (exito) return true;
    if (estadoDescarga.detenido) return false;
    if (intento < SRI_CONFIG.MAX_REINTENTOS) {
      await delay(SRI_CONFIG.DELAY_REINTENTO);
    }
  }
  return ejecutarConReintento(tabId, linkId, docMetadata, 'pdf');
}

/**
 * Descarga de RECIBIDOS: prima el metodo normal (mojarra/click, con sus
 * reintentos). Solo si ese metodo no logro descargar se intenta UNA vez por
 * fetch como respaldo; cuando el respaldo funciona se cuenta en
 * estadoDescarga.viaAlternativa para avisar al usuario al terminar.
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del link JSF
 * @param {Object} docMetadata - Metadata del documento
 * @param {'xml'|'pdf'} tipoArchivo - Formato que se esta descargando
 * @returns {Promise<{ok: boolean, alternativa: boolean}>}
 */
async function descargarRecibidoConRespaldo(tabId, linkId, docMetadata, tipoArchivo) {
  if (await ejecutarConReintento(tabId, linkId, docMetadata, tipoArchivo)) {
    return { ok: true, alternativa: false };
  }
  if (estadoDescarga.detenido) return { ok: false, alternativa: false };

  const ok = await descargarPorFetch(tabId, linkId, docMetadata, tipoArchivo);
  if (ok) estadoDescarga.viaAlternativa = (estadoDescarga.viaAlternativa || 0) + 1;
  return { ok, alternativa: ok };
}

/**
 * Descarga el XML de un emitido via web service, con reintentos automaticos
 * (SRI_CONFIG.MAX_REINTENTOS, con DELAY_REINTENTO entre intentos). No
 * reintenta si el SRI respondio de forma definitiva que no esta autorizado.
 * @param {string} claveAcceso - Clave de acceso de 49 digitos
 * @param {Object} docMetadata - Metadata para organizar/nombrar el archivo
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function descargarXmlEmitidoConReintento(claveAcceso, docMetadata) {
  let resultado = { ok: false, error: 'Error descargando XML' };
  for (let intento = 0; intento <= SRI_CONFIG.MAX_REINTENTOS; intento++) {
    resultado = await descargarXmlEmitido(claveAcceso, docMetadata);
    if (resultado.ok || resultado.definitivo) return resultado;
    // No seguir reintentando si el usuario pulso Detener
    if (estadoDescarga.detenido) return resultado;
    if (intento < SRI_CONFIG.MAX_REINTENTOS) {
      await delay(SRI_CONFIG.DELAY_REINTENTO);
    }
  }
  return resultado;
}

/**
 * Ejecuta una descarga por link de la pagina con reintentos automaticos
 * (SRI_CONFIG.MAX_REINTENTOS, con DELAY_REINTENTO entre intentos).
 * @param {number} tabId - Tab del SRI
 * @param {string} linkId - ID del link de descarga
 * @param {Object} docMetadata - Metadata del documento
 * @param {'xml'|'pdf'} tipoArchivo - Formato que se esta descargando
 * @returns {Promise<boolean>} true si alguna de las ejecuciones tuvo exito
 */
async function ejecutarConReintento(tabId, linkId, docMetadata, tipoArchivo) {
  for (let intento = 0; intento <= SRI_CONFIG.MAX_REINTENTOS; intento++) {
    const exito = await ejecutarDescargaSRI(tabId, linkId, docMetadata, tipoArchivo);
    if (exito) return true;
    // No seguir reintentando si el usuario pulso Detener
    if (estadoDescarga.detenido) return false;
    if (intento < SRI_CONFIG.MAX_REINTENTOS) {
      await delay(SRI_CONFIG.DELAY_REINTENTO);
    }
  }
  return false;
}

/**
 * Obtiene datos de la pagina actual via executeScript: filas de la tabla
 * (segun origen), paginacion y RUC del usuario logueado.
 * En emitidos la tabla no trae link XML (el XML se obtiene despues del web
 * service con la clave de acceso) y el emisor es el propio usuario.
 * @param {number} tabId - Tab del SRI
 * @param {'recibidos'|'emitidos'} [origen='recibidos'] - Tabla a extraer
 * @returns {Promise<{documentos: Array<Object>, paginacion: {actual: number, total: number}, rucUsuario: string, origen: string}|{error: string}>}
 */
async function obtenerDatosPagina(tabId, origen = 'recibidos') {
  try {
    const resultado = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (selectores, origen) => {
        const tabla = document.querySelector(
          origen === 'emitidos' ? selectores.TABLA_EMITIDOS : selectores.TABLA_RECIBIDOS
        );
        if (!tabla) {
          // Sesion caida: el SRI redirige al login (Keycloak)
          if (/\/auth\/realms\//.test(location.pathname) || document.querySelector('#kc-form-login, #kc-login')) {
            return { error: 'La sesion del SRI expiro. Inicia sesion de nuevo y vuelve a iniciar la descarga (lo ya descargado se omite).' };
          }
          return { error: `No se encontro la tabla de comprobantes ${origen}` };
        }

        // RUC del usuario logueado
        const rucUsuario = document.querySelector(selectores.RUC_USUARIO)?.textContent?.match(/\d{13}/)?.[0] || 'desconocido';

        const filas = tabla.querySelectorAll('tr');
        const documentos = [];

        filas.forEach((fila, index) => {
          const celdas = fila.querySelectorAll('td');
          const linkXml = fila.querySelector(selectores.LINK_XML);
          const linkPdf = fila.querySelector(selectores.LINK_PDF);

          if (origen === 'recibidos' && celdas.length >= 6) {
            const ruc = celdas[1]?.textContent?.trim().split('\n')[0] || '';
            const razonSocial = celdas[1]?.textContent?.trim().split('\n')[1] || '';
            const celda2Texto = celdas[2]?.textContent?.trim() || '';
            const tipoDoc = celda2Texto;
            // Extraer serie del texto (ej: "Factura  001-006-055715817" -> "001-006-055715817")
            const serieMatch = celda2Texto.match(/(\d{3}-\d{3}-\d+)/);
            const serie = serieMatch ? serieMatch[1] : '';
            // Columnas verificadas en vivo (2026-09): Nro | RUC y razon social |
            // Tipo y serie | Clave de acceso | Fecha y hora de autorizacion |
            // Fecha emision | Valor | IVA | Total | Documento(xml) | RIDE | Relacionados
            const claveAcceso = celdas[3]?.textContent?.trim() || '';
            const fechaAutorizacion = celdas[4]?.textContent?.trim() || '';
            const fechaEmision = celdas[5]?.textContent?.trim() || '';

            documentos.push({
              index, ruc, razonSocial, tipoDoc, serie, claveAcceso,
              fechaEmision, fechaAutorizacion,
              valorSinImpuestos: celdas[6]?.textContent?.trim() || '',
              iva: celdas[7]?.textContent?.trim() || '',
              importeTotal: celdas[8]?.textContent?.trim() || '',
              tieneXml: !!linkXml,
              tienePdf: !!linkPdf,
              linkXmlId: linkXml?.id,
              linkPdfId: linkPdf?.id,
            });
          } else if (origen === 'emitidos' && celdas.length >= 9) {
            // Emitidos: Nro | Tipo y serie | Clave acceso | Fecha/hora aut |
            // Fecha emision | Valor | IVA | Total | RIDE(pdf) | Docs relacionados.
            // No hay link XML: el XML se obtiene del WS con la clave de acceso.
            const celda1Texto = celdas[1]?.textContent?.trim() || '';
            const serieMatch = celda1Texto.match(/(\d{3}-\d{3}-\d+)/);
            const claveAcceso = celdas[2]?.textContent?.trim() || '';

            documentos.push({
              index,
              ruc: rucUsuario, // el emisor es el propio usuario
              razonSocial: '',
              tipoDoc: celda1Texto,
              serie: serieMatch ? serieMatch[1] : '',
              claveAcceso,
              fechaEmision: celdas[4]?.textContent?.trim() || '',
              fechaAutorizacion: celdas[3]?.textContent?.trim() || '',
              valorSinImpuestos: celdas[5]?.textContent?.trim() || '',
              iva: celdas[6]?.textContent?.trim() || '',
              importeTotal: celdas[7]?.textContent?.trim() || '',
              tieneXml: !!claveAcceso, // via web service
              tienePdf: !!linkPdf,
              linkXmlId: null,
              linkPdfId: linkPdf?.id,
            });
          }
        });

        // Paginacion
        const paginador = document.querySelector(selectores.PAGINADOR);
        let paginacion = { actual: 1, total: 1 };
        if (paginador) {
          const match = paginador.textContent.match(/\((\d+) of (\d+)\)/);
          if (match) {
            paginacion = { actual: parseInt(match[1]), total: parseInt(match[2]) };
          }
        }

        return { documentos, paginacion, rucUsuario, origen };
      },
      args: [SRI_CONFIG.SELECTORES, origen]
    });
    return resultado[0]?.result || { error: 'No se pudo leer la pagina del SRI' };
  } catch (e) {
    // Tipico cuando la pestana salio del SRI (login en otro dominio, pagina
    // de error del navegador) y la extension ya no tiene acceso a ella
    return { error: `No se pudo acceder a la pagina del SRI (${e.message}). Verifica que la sesion siga activa.` };
  }
}

/**
 * Lleva la tabla a la pagina indicada y CONFIRMA que llego: el paginador de
 * PrimeFaces solo cambia su texto cuando llega la respuesta, asi que es la
 * senal de que la tabla es la nueva. Si el SRI tarda mas que TIMEOUT_PAGINA
 * se reintenta (esperando mas y, si sigue en la pagina anterior, volviendo a
 * pulsar). Devolver false obliga al llamador a abortar: seguir sin confirmar
 * reprocesaria la pagina vieja (todo "omitido") y dejaria sin descargar las
 * ultimas paginas, en silencio.
 * @param {number} tabId - Tab del SRI
 * @param {number} esperada - Pagina destino (1 = primera; n = siguiente de n-1)
 * @param {'recibidos'|'emitidos'} origen - Tabla consultada
 * @returns {Promise<boolean>} true solo si el paginador muestra la pagina esperada
 */
async function irAPagina(tabId, esperada, origen) {
  const INTENTOS = 3;
  for (let intento = 0; intento < INTENTOS; intento++) {
    if (estadoDescarga.detenido) return false;

    const datos = await obtenerDatosPagina(tabId, origen);
    if (datos.error) return false;
    const actual = datos.paginacion.actual;
    if (actual === esperada) return true;

    if (esperada === 1) {
      await navegarPrimera(tabId);
    } else if (actual === esperada - 1) {
      await navegarSiguiente(tabId, esperada - 1);
    } else {
      return false; // pagina inesperada: no se puede llegar con "siguiente"
    }

    if (await esperarCambioPagina(tabId, esperada, origen)) return true;
    // Timeout: margen extra antes de volver a comprobar/pulsar
    await delay(SRI_CONFIG.DELAY_PAGINA);
  }

  const datos = await obtenerDatosPagina(tabId, origen);
  return !datos.error && datos.paginacion.actual === esperada;
}

/**
 * Navega a la primera pagina del paginador PrimeFaces.
 * @param {number} tabId - Tab del SRI
 * @returns {Promise<boolean>} false solo si executeScript fallo
 */
async function navegarPrimera(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (selector) => {
        const boton = document.querySelector(selector);
        if (boton) boton.click();
      },
      args: [SRI_CONFIG.SELECTORES.BOTON_PRIMERA]
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Navega a la siguiente pagina del paginador PrimeFaces.
 * @param {number} tabId - Tab del SRI
 * @param {number} [soloSiPagina] - Si se indica, solo pulsa cuando el
 *   paginador muestra esa pagina. La comprobacion y el click ocurren en la
 *   misma ejecucion: evita avanzar dos paginas si la respuesta de un click
 *   anterior llego justo entre la lectura y el nuevo click
 * @returns {Promise<boolean>} true si el boton existia y se clickeo
 */
async function navegarSiguiente(tabId, soloSiPagina) {
  try {
    const resultado = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (selector, selectorPaginador, soloSiPagina) => {
        if (soloSiPagina) {
          const texto = document.querySelector(selectorPaginador)?.textContent || '';
          const actual = parseInt((texto.match(/\((\d+) of \d+\)/) || [])[1], 10);
          if (actual !== soloSiPagina) return false;
        }
        const boton = document.querySelector(selector);
        if (boton) {
          boton.click();
          return true;
        }
        return false;
      },
      args: [SRI_CONFIG.SELECTORES.BOTON_SIGUIENTE, SRI_CONFIG.SELECTORES.PAGINADOR, soloSiPagina || null]
    });
    return resultado[0]?.result ?? false;
  } catch (e) {
    return false;
  }
}

/**
 * Espera inteligente de paginacion: hace polling cada 500ms hasta que el
 * paginador muestre la pagina esperada, en vez de un delay fijo (el servidor
 * del SRI tiene latencia variable). Con timeout TIMEOUT_PAGINA como tope.
 * @param {number} tabId - Tab del SRI
 * @param {number} paginaEsperada - Numero de pagina que debe aparecer
 * @param {'recibidos'|'emitidos'} [origen='recibidos'] - Tabla consultada
 * @returns {Promise<boolean>} true si la pagina cambio; false por timeout o detencion
 */
async function esperarCambioPagina(tabId, paginaEsperada, origen = 'recibidos') {
  const inicio = Date.now();
  while (Date.now() - inicio < SRI_CONFIG.TIMEOUT_PAGINA) {
    // Responder de inmediato al boton Detener
    if (estadoDescarga.detenido) return false;
    const datos = await obtenerDatosPagina(tabId, origen);
    if (datos.paginacion?.actual === paginaEsperada) return true;
    await delay(500);
  }
  return false;
}

/**
 * Espera asincrona simple.
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Funciones de organizacion de archivos ---

/**
 * Sanitiza un nombre para usarlo como carpeta/archivo en Windows y Unix:
 * reemplaza caracteres invalidos, colapsa espacios y limita a 100 caracteres.
 * @param {string} nombre - Nombre original
 * @returns {string} Nombre seguro para el filesystem
 */
function sanitizarNombreCarpeta(nombre) {
  return nombre
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100)
    // Windows no admite carpetas/archivos terminados en punto o espacio
    .replace(/[. ]+$/, '') || 'sin_nombre';
}

/**
 * Parsea una fecha del SRI en formato dd/mm/aaaa (o dd/mm/aaaa hh:mm:ss).
 * @param {string} fechaStr - Fecha como la muestra el SRI
 * @returns {{dia: string, mes: string, anio: string}|null} Partes de la fecha o null
 */
function parsearFechaSRI(fechaStr) {
  if (!fechaStr) return null;
  const partes = fechaStr.split('/');
  if (partes.length >= 3) {
    return { dia: partes[0], mes: partes[1], anio: partes[2].substring(0, 4) };
  }
  return null;
}

/**
 * Extrae solo el tipo de documento sin la serie
 * Ej: "Factura  001-001-034700490" -> "factura"
 * @param {string} tipoDoc - Tipo y serie del documento desde el DOM
 * @returns {string} Tipo de documento limpio en minusculas
 */
function limpiarTipoDoc(tipoDoc) {
  const tipoLimpio = (tipoDoc || 'sin_tipo').replace(/\s+\d{3}-\d{3}-\d+.*$/, '').trim();
  return sanitizarNombreCarpeta(tipoLimpio || 'sin_tipo').toLowerCase().replace(/\s+/g, '_');
}

/**
 * Construye el nombre del archivo segun el formato configurado.
 * @param {'claveAcceso'|'ruc_serie'|'razon_serie'} formato - Formato elegido
 * @param {Object} metadata - Metadata del documento (ruc, serie, razonSocial, claveAcceso)
 * @param {string} extension - Extension con punto (.xml, .pdf)
 * @returns {string} Nombre del archivo con extension
 */
function construirNombreArchivo(formato, metadata, extension) {
  switch (formato) {
    case 'ruc_serie': {
      const ruc = metadata.ruc || 'sin_ruc';
      const serie = (metadata.serie || 'sin_serie').replace(/[-\s]+/g, '');
      return `${ruc}_${serie}${extension}`;
    }
    case 'razon_serie': {
      // Emitidos no trae razon social (el emisor es el propio usuario):
      // usar el RUC antes que un "sin_razon" generico
      const razon = sanitizarNombreCarpeta(metadata.razonSocial || metadata.ruc || 'sin_razon').replace(/\s+/g, '_');
      const serie = (metadata.serie || 'sin_serie').replace(/[-\s]+/g, '');
      return `${razon}_${serie}${extension}`;
    }
    case 'claveAcceso':
    default:
      return `${metadata.claveAcceso || 'sin_clave'}${extension}`;
  }
}

/**
 * Construye la ruta completa del archivo organizado.
 * Estructura: carpetaRaiz / [ruc+fecha o fecha+ruc] / [recibidos|emitidos] / tipoDoc / [xml|pdf] / nombre.ext
 * El nivel recibidos/emitidos sale de metadata.origen.
 * @param {Object} metadata - Metadata del documento (incluye origen y rucUsuario)
 * @param {'xml'|'pdf'} tipoArchivo - Formato del archivo
 * @param {string} extension - Extension del archivo con punto (.xml, .pdf)
 * @returns {string|null} Ruta relativa completa o null si organizacion deshabilitada
 */
function construirRutaArchivo(metadata, tipoArchivo, extension) {
  if (!SRI_CONFIG.ORGANIZACION?.HABILITADO) return null;

  const org = SRI_CONFIG.ORGANIZACION;
  const fechaParsed = parsearFechaSRI(metadata.fechaEmision);
  const ruc = metadata.rucUsuario || 'sin_ruc';
  const anio = fechaParsed?.anio || 'sin_anio';
  const mes = fechaParsed?.mes || 'sin_mes';

  // Normalizada: una raiz invalida (C:\..., "..") haria que Chrome rechace la
  // ruta y el archivo caiga suelto en Descargas
  const segmentos = [sriNormalizarCarpetaRaiz(org.CARPETA_RAIZ)];

  // Niveles configurables: orden del RUC y fecha
  if (org.ORDEN === 'fecha_ruc') {
    segmentos.push(anio, mes, ruc);
  } else {
    segmentos.push(ruc, anio, mes);
  }

  // Niveles fijos: tipo movimiento / tipo documento / tipo archivo
  segmentos.push(metadata.origen === 'emitidos' ? 'emitidos' : 'recibidos');
  segmentos.push(limpiarTipoDoc(metadata.tipoDoc));
  segmentos.push(tipoArchivo === 'xml' ? 'xml' : 'pdf');

  // Nombre del archivo
  segmentos.push(construirNombreArchivo(org.FORMATO_NOMBRE, metadata, extension));

  return segmentos.join('/');
}

/**
 * Actualiza el badge del icono de la extension con el conteo de exitosos
 * (verde sin fallos, naranja con fallos). Al terminar la descarga limpia el
 * badge tras 5s, salvo que otra descarga haya empezado en ese lapso.
 */
function actualizarBadge() {
  if (estadoDescarga.activo) {
    const texto = `${estadoDescarga.exitosos}`;
    chrome.action.setBadgeText({ text: texto });
    chrome.action.setBadgeBackgroundColor({
      color: estadoDescarga.fallidos > 0 ? '#ff9800' : '#4caf50'
    });
  } else {
    setTimeout(() => {
      if (!estadoDescarga.activo) {
        chrome.action.setBadgeText({ text: '' });
      }
    }, 5000);
  }
}

/**
 * Notifica el progreso al popup via mensaje 'estadoDescarga'. El catch vacio
 * es intencional: si el popup esta cerrado no hay receptor y sendMessage
 * rechaza, lo cual es normal (la descarga sigue en el background).
 */
function notificarProgreso() {
  chrome.runtime.sendMessage({
    action: 'estadoDescarga',
    estado: { ...estadoDescarga }
  }).catch(() => {});
}

/**
 * Calcula el tiempo estimado restante segun el promedio por documento
 * de lo transcurrido en la sesion actual.
 * @returns {number|null} Milisegundos estimados o null si aun no hay datos
 */
function calcularTiempoEstimado() {
  if (!estadoDescarga.timestampInicio || estadoDescarga.documentoActual === 0) {
    return null;
  }
  const transcurrido = Date.now() - estadoDescarga.timestampInicio;
  const promedioPorDoc = transcurrido / estadoDescarga.documentoActual;
  const restantes = estadoDescarga.totalDocumentos - estadoDescarga.documentoActual;
  return Math.round(promedioPorDoc * restantes);
}

/**
 * Envia una notificacion nativa de Chrome al finalizar la descarga
 * (funciona aunque el popup este cerrado).
 */
function notificarFinalizacion() {
  // Priorizar el motivo del error si la descarga termino de forma anomala
  let mensaje = estadoDescarga.error
    ? `Error: ${estadoDescarga.error}`
    : estadoDescarga.detenido
      ? `Detenido: ${estadoDescarga.exitosos} OK, ${estadoDescarga.fallidos} fallidos`
      : `Completado: ${estadoDescarga.exitosos} OK, ${estadoDescarga.fallidos} fallidos`;
  if (estadoDescarga.avisos?.length) {
    mensaje += `\nAviso: ${estadoDescarga.avisos.join(' ')}`;
  }

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Descargador de Comprobantes SRI',
    message: mensaje
  });
}

/**
 * Procesa un documento: dedup, descarga XML/PDF segun tipo, registra en buffer.
 *
 * exitoXml/exitoPdf usan null = no se intento ese formato (no solicitado o sin
 * link), true/false = resultado real. Asi la deduplicacion no confunde
 * "no intentado" con "descargado" ni "fallido" (ver construirIndiceDescargados).
 *
 * En emitidos el XML no se descarga desde la pagina (no existe link) sino
 * consultando el web service de autorizacion con la clave de acceso.
 * @param {number} tabId - Tab del SRI
 * @param {Object} doc - Documento extraido de la tabla
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {number} pagina - Numero de pagina de donde salio el documento
 * @param {'recibidos'|'emitidos'} [origen='recibidos'] - Pantalla de origen
 * @returns {Promise<void>}
 */
async function procesarDocumento(tabId, doc, tipoDescarga, pagina, origen = 'recibidos') {
  estadoDescarga.documentoActual++;

  // Verificar si ya fue descargado (O(1) con Set)
  if (indiceDescargados.has(doc.claveAcceso)) {
    estadoDescarga.omitidos++;
    estadoDescarga.tiempoEstimado = calcularTiempoEstimado();
    actualizarBadge();
    notificarProgreso();
    return;
  }

  const esEmitidos = origen === 'emitidos';
  const intentaXml = (tipoDescarga === 'xml' || tipoDescarga === 'ambos') && doc.tieneXml;
  const intentaPdf = (tipoDescarga === 'pdf' || tipoDescarga === 'ambos') && doc.tienePdf;

  let exitoXml = null;
  let exitoPdf = null;
  let errorMsg = null;
  // Formatos que solo se lograron por el metodo alternativo (fetch) en recibidos
  const alternativos = [];

  try {
    // Metadata del documento para organizar archivos
    const docMeta = {
      claveAcceso: doc.claveAcceso,
      ruc: doc.ruc,
      razonSocial: doc.razonSocial,
      tipoDoc: doc.tipoDoc,
      serie: doc.serie,
      fechaEmision: doc.fechaEmision,
      rucUsuario: estadoDescarga.rucUsuario,
      origen: origen
    };

    // Descargar XML con reintentos. En emitidos no hay link en la pagina:
    // se obtiene el XML autorizado del web service con la clave de acceso.
    if (intentaXml) {
      if (esEmitidos) {
        const r = await descargarXmlEmitidoConReintento(doc.claveAcceso, docMeta);
        exitoXml = r.ok;
        if (!r.ok) errorMsg = r.error || 'Error descargando XML';
      } else {
        // Recibidos: prima el metodo normal; fetch solo como respaldo
        const r = await descargarRecibidoConRespaldo(tabId, doc.linkXmlId, docMeta, 'xml');
        exitoXml = r.ok;
        if (r.alternativa) alternativos.push('XML');
        if (!r.ok) errorMsg = 'Error descargando XML';
      }
      await delay(SRI_CONFIG.DELAY_DESCARGA);
    }

    // Descargar PDF con reintentos. En emitidos el submit del formulario
    // responde 503 (ver descargarPorFetch): se usa fetch como metodo principal
    if (intentaPdf) {
      if (esEmitidos) {
        exitoPdf = await descargarPdfEmitidoConReintento(tabId, doc.linkPdfId, docMeta);
      } else {
        const r = await descargarRecibidoConRespaldo(tabId, doc.linkPdfId, docMeta, 'pdf');
        exitoPdf = r.ok;
        if (r.alternativa) alternativos.push('PDF');
      }
      if (!exitoPdf) errorMsg = errorMsg ? `${errorMsg}; error descargando PDF` : 'Error descargando PDF';
      await delay(SRI_CONFIG.DELAY_DESCARGA);
    }

  } catch (e) {
    if (intentaXml && exitoXml !== true) exitoXml = false;
    if (intentaPdf && exitoPdf !== true) exitoPdf = false;
    errorMsg = e.message;
  }

  // Nada que intentar (el comprobante no tiene link para el formato pedido):
  // no es un exito, no se descargo ningun archivo
  const nadaQueIntentar = !intentaXml && !intentaPdf;
  if (nadaQueIntentar) errorMsg = 'El comprobante no tiene enlace de descarga para el formato solicitado';

  // Exito si se intento algo y nada de lo intentado fallo
  const exito = !nadaQueIntentar && exitoXml !== false && exitoPdf !== false;

  if (exito) {
    estadoDescarga.exitosos++;
    indiceDescargados.add(doc.claveAcceso);
  } else {
    estadoDescarga.fallidos++;
  }

  agregarAlBuffer({
    claveAcceso: doc.claveAcceso,
    ruc: doc.ruc,
    razonSocial: doc.razonSocial,
    tipoDoc: doc.tipoDoc,
    serie: doc.serie,
    fechaEmision: doc.fechaEmision,
    fechaAutorizacion: doc.fechaAutorizacion,
    valorSinImpuestos: doc.valorSinImpuestos || '',
    iva: doc.iva || '',
    importeTotal: doc.importeTotal || '',
    pagina: pagina,
    exito: exito,
    exitoXml: exitoXml,
    exitoPdf: exitoPdf,
    error: errorMsg,
    nota: alternativos.length > 0 ? `${alternativos.join(' y ')} por metodo alternativo (fetch)` : null,
    fechaDescarga: new Date().toISOString()
  });

  estadoDescarga.tiempoEstimado = calcularTiempoEstimado();
  actualizarBadge();
  notificarProgreso();
}

/**
 * Procesa todas las paginas de la tabla actualmente consultada en el SRI.
 * Asume que estadoDescarga ya esta inicializado. Acumula sobre
 * estadoDescarga.totalDocumentos para soportar varias consultas en una
 * misma sesion (modo mes de emitidos, que llama esta funcion una vez por dia).
 * Guarda el buffer a storage al terminar cada pagina para no perder registro
 * si Chrome termina el service worker MV3 durante una descarga larga.
 * @param {number} tabId - Tab del SRI
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {'recibidos'|'emitidos'} origen - Pantalla/tabla a procesar
 * @returns {Promise<string|null>} Mensaje de error o null si todo fue bien
 */
async function procesarPaginasActuales(tabId, tipoDescarga, origen) {
  let datos = await obtenerDatosPagina(tabId, origen);
  if (datos.error) return datos.error;

  if (!estadoDescarga.rucUsuario || estadoDescarga.rucUsuario === 'desconocido') {
    estadoDescarga.rucUsuario = datos.rucUsuario;
    bufferSesion.rucUsuario = datos.rucUsuario;
  }

  const totalPaginas = datos.paginacion.total;
  estadoDescarga.totalPaginas = totalPaginas;

  // Ir a primera pagina si no estamos en ella. Se hace ANTES de estimar el
  // total: si el usuario estaba parado en la ultima pagina (incompleta), el
  // conteo de esa pagina no sirve como "docs por pagina"
  if (datos.paginacion.actual > 1) {
    if (!(await irAPagina(tabId, 1, origen))) {
      return estadoDescarga.detenido ? null : 'El SRI no respondio al volver a la pagina 1. Vuelve a iniciar la descarga.';
    }
    datos = await obtenerDatosPagina(tabId, origen);
    if (datos.error) return datos.error;
  }

  // Estimar total de documentos (docs en pagina 1 * total paginas),
  // acumulando sobre lo contado en consultas anteriores de esta sesion
  const docsPorPagina = datos.documentos.length;
  const base = estadoDescarga.totalDocumentos;
  estadoDescarga.totalDocumentos = base + docsPorPagina * totalPaginas;

  // Procesar todas las paginas
  for (let pag = 1; pag <= totalPaginas; pag++) {
    if (estadoDescarga.detenido) break;

    estadoDescarga.paginaActual = pag;

    // Obtener documentos de pagina actual
    datos = await obtenerDatosPagina(tabId, origen);
    if (datos.error) return datos.error;

    // La tabla debe mostrar la pagina que creemos estar procesando; si no,
    // se descargarian (u omitirian) documentos de otra pagina
    if (datos.paginacion.actual !== pag) {
      return `La tabla del SRI muestra la pagina ${datos.paginacion.actual} cuando se esperaba la ${pag}. Vuelve a iniciar la descarga: lo ya descargado se omite.`;
    }

    // Ajustar el total real al llegar a la ultima pagina (puede estar incompleta)
    if (pag === totalPaginas) {
      estadoDescarga.totalDocumentos = base + (pag - 1) * docsPorPagina + datos.documentos.length;
    }

    // Descargar documentos de esta pagina
    for (const doc of datos.documentos) {
      if (estadoDescarga.detenido) break;
      await procesarDocumento(tabId, doc, tipoDescarga, pag, origen);
    }

    // Guardar progreso parcial (protege contra terminacion del service worker)
    await guardarBufferAlStorage(false);

    // Ir a siguiente pagina si hay mas. Si el SRI no llega a mostrarla (ni
    // con reintentos) se aborta con un error visible: continuar reprocesaria
    // la pagina anterior y dejaria las ultimas paginas sin descargar
    if (pag < totalPaginas && !estadoDescarga.detenido) {
      if (!(await irAPagina(tabId, pag + 1, origen)) && !estadoDescarga.detenido) {
        return `El SRI no respondio al pasar a la pagina ${pag + 1} de ${totalPaginas}. Vuelve a iniciar la descarga: lo ya descargado se omite y continuara con lo que falta.`;
      }
    }
  }

  return null;
}

/**
 * Crea el estado de una sesion nueva. Se asigna de forma SINCRONA al recibir
 * el mensaje de inicio (antes de cualquier await) para que `activo` ya sea
 * true si llega un segundo mensaje de inicio: asi no arrancan dos sesiones.
 * @param {number} tabId - Tab del SRI
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {'recibidos'|'emitidos'} origen - Pantalla de origen
 * @param {Object} [extra] - Campos adicionales (modo mes: diaActual, totalDias...)
 * @returns {Object} Estado inicial de la sesion
 */
function crearEstadoSesion(tabId, tipoDescarga, origen, extra = {}) {
  return {
    activo: true,
    detenido: false,
    exitosos: 0,
    fallidos: 0,
    omitidos: 0,
    paginaActual: 1,
    totalPaginas: 1,
    documentoActual: 0,
    totalDocumentos: 0,
    tipoDescarga: tipoDescarga,
    origen: origen,
    tabId: tabId,
    sesionId: generarSesionId(),
    rucUsuario: null,
    timestampInicio: Date.now(),
    tiempoEstimado: null,
    error: null,
    avisos: [],
    viaAlternativa: 0,
    ...extra
  };
}

/**
 * Preparacion comun de una sesion (despues de crearEstadoSesion): buffer,
 * config del usuario, limpieza del historial antiguo e indice de dedup.
 * Deja ademas una marca en chrome.storage.session para poder avisar si
 * Chrome reinicia el service worker a mitad de la descarga.
 * @param {boolean} usarHistorial - false = no deduplicar (indice vacio)
 * @returns {Promise<void>}
 */
async function prepararSesion(usarHistorial) {
  bufferSesion = { documentos: [], rucUsuario: null };
  indiceDescargados = new Set();

  chrome.storage.session?.set({
    sesionEnCurso: { sesionId: estadoDescarga.sesionId, origen: estadoDescarga.origen, inicio: estadoDescarga.timestampInicio }
  }).catch(() => {});

  actualizarBadge();
  notificarProgreso();

  await cargarConfigUsuario();
  // await para evitar carrera de escritura con el guardado incremental
  await limpiarHistorialAntiguo();

  if (usarHistorial) {
    indiceDescargados = await construirIndiceDescargados(estadoDescarga.tipoDescarga);
  }
}

/**
 * Cierre comun de una sesion: guarda el buffer, arma los avisos finales,
 * limpia estado temporal y notifica (popup, badge y notificacion de Chrome).
 * @returns {Promise<void>}
 */
async function finalizarSesion() {
  if (estadoDescarga.viaAlternativa > 0) {
    agregarAviso(`${estadoDescarga.viaAlternativa} archivo(s) no respondieron al metodo normal y se descargaron por el metodo alternativo (fetch). Verifica que se abran correctamente.`);
  }

  await guardarBufferAlStorage(true);

  downloadMetadataMap.clear();
  pendingDataUrlMeta = null;

  estadoDescarga.activo = false;
  estadoDescarga.tiempoEstimado = null;
  chrome.storage.session?.remove('sesionEnCurso').catch(() => {});

  actualizarBadge();
  notificarProgreso();
  notificarFinalizacion();
}

// Al arrancar el service worker: si quedo la marca de una sesion en curso es
// que Chrome lo reinicio a mitad de una descarga (el estado en memoria se
// perdio y la descarga se corto). Avisar en vez de morir en silencio; lo
// descargado hasta la ultima pagina completa ya esta en el historial.
chrome.storage.session?.get('sesionEnCurso').then(({ sesionEnCurso }) => {
  if (!sesionEnCurso || estadoDescarga.activo) return;
  chrome.storage.session.remove('sesionEnCurso').catch(() => {});
  estadoDescarga.origen = sesionEnCurso.origen || 'recibidos';
  estadoDescarga.error = 'La descarga anterior se interrumpio porque el navegador reinicio la extension. Vuelve a iniciarla: lo ya descargado se omite.';
  notificarProgreso();
  notificarFinalizacion();
}).catch(() => {});

/**
 * Proceso principal de descarga: todas las paginas de la consulta en pantalla.
 * Corre en el background para sobrevivir al cierre del popup.
 * @param {number} tabId - Tab del SRI con la consulta ejecutada
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {boolean} [ignorarHistorial=false] - true re-descarga todo (indice de dedup vacio)
 * @param {'recibidos'|'emitidos'} [origen='recibidos'] - Pantalla de origen
 * @returns {Promise<void>}
 */
async function descargarTodasLasPaginas(tabId, tipoDescarga, ignorarHistorial = false, origen = 'recibidos') {
  // Sincrono (antes de cualquier await): marca la sesion como activa
  estadoDescarga = crearEstadoSesion(tabId, tipoDescarga, origen);
  await prepararSesion(!ignorarHistorial);

  const error = await procesarPaginasActuales(tabId, tipoDescarga, origen);
  if (error) {
    estadoDescarga.error = error;
  }

  await finalizarSesion();
}

/**
 * Descarga solo los documentos seleccionados (por clave de acceso) de la
 * pagina actual. La seleccion es explicita del usuario, asi que no se
 * aplica deduplicacion contra el historial.
 * @param {number} tabId - Tab del SRI
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {string[]} claves - Claves de acceso marcadas en el popup
 * @param {'recibidos'|'emitidos'} [origen='recibidos'] - Pantalla de origen
 * @returns {Promise<void>}
 */
async function descargarSeleccionados(tabId, tipoDescarga, claves, origen = 'recibidos') {
  estadoDescarga = crearEstadoSesion(tabId, tipoDescarga, origen);
  // Seleccion explicita del usuario: sin deduplicacion contra el historial
  await prepararSesion(false);

  const datos = await obtenerDatosPagina(tabId, origen);
  if (datos.error) {
    estadoDescarga.error = datos.error;
    await finalizarSesion();
    return;
  }

  estadoDescarga.rucUsuario = datos.rucUsuario;
  bufferSesion.rucUsuario = datos.rucUsuario;
  estadoDescarga.paginaActual = datos.paginacion?.actual || 1;
  estadoDescarga.totalPaginas = estadoDescarga.paginaActual;

  const setClaves = new Set(claves);
  const docs = datos.documentos.filter(d => setClaves.has(d.claveAcceso));
  estadoDescarga.totalDocumentos = docs.length;

  for (const doc of docs) {
    if (estadoDescarga.detenido) break;
    await procesarDocumento(tabId, doc, tipoDescarga, estadoDescarga.paginaActual, origen);
  }

  await finalizarSesion();
}

/**
 * Setea la fecha en el formulario de emitidos y pulsa Consultar (MAIN world,
 * porque el CSP del SRI bloquea scripts inline y el evento change debe llegar
 * al JSF de la pagina).
 *
 * Antes de consultar marca la tabla y el contenedor .ui-messages con el
 * atributo data-sri-esperando: el AJAX de PrimeFaces reemplaza esos nodos al
 * responder, asi que la DESAPARICION del atributo es la senal de que llego la
 * respuesta nueva. Sin el marcador no se podria distinguir la tabla/mensaje
 * viejos de los nuevos (dias consecutivos pueden verse identicos). Los
 * atributos DOM son visibles entre el world MAIN y el ISOLATED, por eso se
 * usa un atributo y no una variable JS.
 * @param {number} tabId - Tab del SRI
 * @param {string} fechaStr - Fecha en formato dd/mm/aaaa
 * @returns {Promise<boolean>} true si se pudo disparar la consulta
 */
function setearFechaYConsultar(tabId, fechaStr) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: (fecha, selectores) => {
      const inp = document.querySelector(selectores.EMITIDOS_FECHA_INPUT);
      const btn = document.querySelector(selectores.EMITIDOS_BTN_CONSULTAR);
      if (!inp || !btn) return false;

      // Hook (una sola vez) sobre XMLHttpRequest para detectar respuestas de
      // error (JSF <partial-response><error> o HTTP 4xx/5xx): PrimeFaces no las refleja
      // en el DOM (la tabla queda igual y el dialogo "Espere por favor" se
      // queda abierto), asi que sin esto solo se detectarian por timeout.
      // Se publica en un atributo del <html> para que el poll, que corre en
      // el mundo aislado, pueda leerlo.
      if (!window.__sriXhrHook) {
        window.__sriXhrHook = true;
        const sendOriginal = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
          this.addEventListener('loadend', () => {
            // Error JSF (partial-response con <error>) o HTTP de error (500,
            // 503...): en ambos casos PrimeFaces no actualiza la tabla
            const txt = this.responseText || '';
            const m = txt.match(/<partial-response>\s*<error>\s*<error-name>([^<]*)<\/error-name>/);
            const err = m ? m[1].trim() : (this.status >= 400 ? 'HTTP ' + this.status : null);
            if (err) document.documentElement.setAttribute('data-sri-ajax-error', err);
          });
          return sendOriginal.apply(this, arguments);
        };
      }
      document.documentElement.removeAttribute('data-sri-ajax-error');

      inp.value = fecha;
      inp.dispatchEvent(new Event('change', { bubbles: true }));

      // Marcar tabla y contenedor de mensajes: cuando el AJAX los reemplace,
      // el atributo desaparece (permite detectar dias con y sin datos)
      const tabla = document.querySelector(selectores.TABLA_EMITIDOS);
      if (tabla) tabla.setAttribute('data-sri-esperando', '1');
      const msgs = document.querySelector('.ui-messages');
      if (msgs) msgs.setAttribute('data-sri-esperando', '1');

      btn.click();
      return true;
    },
    args: [fechaStr, SRI_CONFIG.SELECTORES]
  }).then(r => r[0]?.result === true).catch(() => false);
}

/**
 * Espera (polling cada 500ms) a que el AJAX de la consulta de emitidos
 * termine, detectado por la desaparicion del atributo marcador
 * data-sri-esperando en la tabla o en el contenedor de mensajes
 * (ver setearFechaYConsultar), o por el atributo data-sri-ajax-error que
 * deja el hook de XHR cuando JSF responde con error.
 * @param {number} tabId - Tab del SRI
 * @returns {Promise<{resultado: 'datos'|'vacio'|'error'|'timeout', detalle?: string}>}
 *   'datos' si hay tabla nueva, 'vacio' si el SRI respondio "No existen
 *   datos", 'error' si JSF devolvio un error (detalle = nombre de la
 *   excepcion), 'timeout' si no se supo (tambien al detener manualmente,
 *   para salir del bucle de inmediato)
 */
async function esperarResultadosEmitidos(tabId) {
  const inicio = Date.now();
  while (Date.now() - inicio < SRI_CONFIG.TIMEOUT_PAGINA) {
    // Responder de inmediato al boton Detener
    if (estadoDescarga.detenido) return { resultado: 'timeout' };
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (selectores) => {
          const err = document.documentElement.getAttribute('data-sri-ajax-error');
          if (err) return { resultado: 'error', detalle: err };
          const tabla = document.querySelector(selectores.TABLA_EMITIDOS);
          if (tabla && !tabla.hasAttribute('data-sri-esperando')) return { resultado: 'datos' };
          // Dia sin comprobantes: mensaje nuevo (sin marcador) "No existen datos"
          const msgs = document.querySelector('.ui-messages');
          if (msgs && !msgs.hasAttribute('data-sri-esperando') && /No existen datos/i.test(msgs.textContent)) return { resultado: 'vacio' };
          return null;
        },
        args: [SRI_CONFIG.SELECTORES]
      });
      if (r[0]?.result) return r[0].result;
    } catch (e) {
      // Tab ocupada o navegando; reintentar
    }
    await delay(500);
  }
  return { resultado: 'timeout' };
}

/**
 * Lleva la tabla de emitidos a la pagina 1 si esta en otra. OBLIGATORIO
 * antes de consultar otro dia: verificado en vivo (2026-11), si se pulsa
 * Consultar con el paginador en una pagina distinta de la 1, el SRI responde
 * ArithmeticException y la vista JSF queda inservible (todas las peticiones
 * siguientes, incluso paginar, devuelven el mismo error hasta recargar la
 * pagina). Como cada dia se procesa hasta su ultima pagina, sin esto solo
 * se descargaba el primer dia del mes.
 * @param {number} tabId - Tab del SRI
 * @returns {Promise<boolean>} false si habia paginador en otra pagina y no se
 *   logro volver a la 1
 */
async function asegurarPrimeraPaginaEmitidos(tabId) {
  const datos = await obtenerDatosPagina(tabId, 'emitidos');
  if (datos.error || !datos.paginacion || datos.paginacion.actual <= 1) return true;
  await navegarPrimera(tabId);
  return esperarCambioPagina(tabId, 1, 'emitidos');
}

/**
 * Verifica si la pantalla de emitidos muestra "No existen datos para los
 * parametros ingresados" (dia sin comprobantes). Se usa como confirmacion
 * cuando el marcador no alcanzo a detectar la respuesta (timeout) o cuando
 * procesarPaginasActuales no encontro tabla.
 * @param {number} tabId - Tab del SRI
 * @returns {Promise<boolean>} true si el mensaje esta visible en la pagina
 */
async function verificarSinDatosEmitidos(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => /No existen datos/i.test(document.body.innerText)
    });
    return r[0]?.result === true;
  } catch (e) {
    return false;
  }
}

/**
 * Selecciona el tipo de comprobante en el formulario de emitidos (MAIN world
 * para que el evento change llegue al JSF de la pagina).
 * @param {number} tabId - Tab del SRI
 * @param {string} tipo - Value del select (ver SRI_CONFIG.TIPOS_EMITIDOS)
 * @returns {Promise<'igual'|'cambiado'|'sin-opcion'|'sin-select'>}
 */
function setearTipoComprobanteEmitidos(tabId, tipo) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: (tipo, selector) => {
      const sel = document.querySelector(selector);
      if (!sel) return 'sin-select';
      if (sel.value === tipo) return 'igual';
      if (!Array.from(sel.options || []).some(o => o.value === tipo)) return 'sin-opcion';
      sel.value = tipo;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'cambiado';
    },
    args: [tipo, SRI_CONFIG.SELECTORES.EMITIDOS_CMB_TIPO]
  }).then(r => r[0]?.result || 'sin-select').catch(() => 'sin-select');
}

/**
 * Consulta y descarga, dia por dia, los emitidos de un mes para el tipo de
 * comprobante seleccionado en el formulario. El formulario del SRI solo
 * acepta UNA fecha por consulta (no un rango). La iteracion llega solo hasta
 * AYER: el SRI rechaza consultar el dia en curso ("la fecha debe ser menor a
 * la fecha actual").
 *
 * Manejo por dia:
 * - 'vacio' (mensaje "No existen datos"): se salta al siguiente dia.
 * - 'timeout': margen extra y re-verificacion; si el SRI muestra "No existen
 *   datos", se salta el dia.
 * - Error de procesarPaginasActuales: solo se continua si en realidad fue un
 *   dia sin datos; cualquier otro fallo (sesion caida, cambio de pantalla)
 *   aborta para no enmascarar errores reales.
 * Los fallos que abortan se dejan en estadoDescarga.error.
 * @param {number} tabId - Tab del SRI (debe estar en la pantalla de emitidos)
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {number} anio - Anio del mes a descargar
 * @param {number} mes - Mes 1-12
 * @param {number} totalDias - Dias del mes
 * @returns {Promise<number>} Cantidad de dias consultados
 */
async function descargarDiasEmitidos(tabId, tipoDescarga, anio, mes, totalDias) {
  // Iterar desde el dia 1 hasta UN DIA ANTES del actual: consultar el dia
  // en curso da error en el SRI
  const hoy = new Date();
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  let diasProcesados = 0;

  for (let dia = 1; dia <= totalDias; dia++) {
    if (estadoDescarga.detenido) break;
    if (new Date(anio, mes - 1, dia) >= inicioHoy) break;

    diasProcesados++;
    estadoDescarga.diaActual = dia;
    estadoDescarga.paginaActual = 1;
    notificarProgreso();

    const fechaStr = `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${anio}`;

    // La consulta anterior dejo la tabla en su ultima pagina: volver a la 1
    // antes de consultar, si no el SRI rompe la vista (ver la funcion)
    if (!(await asegurarPrimeraPaginaEmitidos(tabId))) {
      if (estadoDescarga.detenido) break;
      estadoDescarga.error = `No se pudo volver a la pagina 1 antes de consultar el dia ${fechaStr}.`;
      break;
    }

    const consultado = await setearFechaYConsultar(tabId, fechaStr);
    if (!consultado) {
      estadoDescarga.error = `No se pudo consultar el dia ${fechaStr}. Verifica estar en la pantalla de emitidos.`;
      break;
    }

    const { resultado, detalle } = await esperarResultadosEmitidos(tabId);
    if (estadoDescarga.detenido) break;

    // Dia sin comprobantes (mensaje "No existen datos" detectado): siguiente dia
    if (resultado === 'vacio') continue;

    // JSF respondio con error: la vista queda rota, no tiene sentido seguir
    // (procesar la tabla vieja solo produciria "omitidos" falsos)
    if (resultado === 'error') {
      estadoDescarga.error = `El SRI respondio con error al consultar el dia ${fechaStr} (${detalle}). Recarga la pagina de emitidos y vuelve a intentar.`;
      break;
    }

    // Timeout: dar margen extra; si el SRI muestra "No existen datos", saltar
    if (resultado === 'timeout') {
      await delay(SRI_CONFIG.DELAY_PAGINA);
      if (estadoDescarga.detenido) break;
      if (await verificarSinDatosEmitidos(tabId)) continue;
    }

    // Verificar que la tabla en pantalla corresponde al dia consultado: si la
    // consulta no llego a actualizarla (timeout real), procesarla descargaria
    // o marcaria como omitidos los documentos del dia anterior
    const datosDia = await obtenerDatosPagina(tabId, 'emitidos');
    const fechaEnTabla = datosDia.documentos?.[0]?.fechaEmision;
    if (!datosDia.error && fechaEnTabla && fechaEnTabla !== fechaStr) {
      estadoDescarga.error = `La tabla no se actualizo al consultar el dia ${fechaStr} (muestra ${fechaEnTabla}). Recarga la pagina de emitidos y vuelve a intentar.`;
      break;
    }

    const error = await procesarPaginasActuales(tabId, tipoDescarga, 'emitidos');
    if (error) {
      // Continuar SOLO si el SRI realmente respondio "No existen datos"
      // (dia sin comprobantes); cualquier otro fallo aborta para no
      // enmascarar errores reales (sesion caida, cambio de pantalla, etc.)
      if (await verificarSinDatosEmitidos(tabId)) continue;
      estadoDescarga.error = error;
      break;
    }
  }

  return diasProcesados;
}

/**
 * Descarga los comprobantes emitidos de un mes completo, consultando dia
 * por dia (ver descargarDiasEmitidos). Con todosLosTipos recorre ademas
 * todos los tipos de comprobante del formulario (SRI_CONFIG.TIPOS_EMITIDOS),
 * repitiendo el mes para cada uno; si no, usa el tipo que este seleccionado
 * en la pantalla.
 * La deduplicacion omite lo ya descargado salvo que ignorarHistorial sea true.
 * @param {number} tabId - Tab del SRI (debe estar en la pantalla de emitidos)
 * @param {'xml'|'pdf'|'ambos'} tipoDescarga - Formatos solicitados
 * @param {boolean} ignorarHistorial - Re-descargar aunque ya exista
 * @param {number} anio - Anio del mes a descargar
 * @param {number} mes - Mes 1-12
 * @param {boolean} [todosLosTipos=false] - Recorrer todos los tipos de comprobante
 * @returns {Promise<void>}
 */
async function descargarEmitidosMes(tabId, tipoDescarga, ignorarHistorial, anio, mes, todosLosTipos = false) {
  const totalDias = new Date(anio, mes, 0).getDate();
  const tipos = todosLosTipos ? Object.keys(SRI_CONFIG.TIPOS_EMITIDOS) : [null];

  estadoDescarga = crearEstadoSesion(tabId, tipoDescarga, 'emitidos', {
    diaActual: 0,
    totalDias: totalDias,
    tipoComprobante: null,   // nombre del tipo en curso (solo con todosLosTipos)
    tipoActual: 0,
    totalTipos: tipos.length
  });
  await prepararSesion(!ignorarHistorial);

  let diasProcesados = 0;

  for (let i = 0; i < tipos.length; i++) {
    if (estadoDescarga.detenido || estadoDescarga.error) break;
    const tipo = tipos[i];

    if (tipo) {
      estadoDescarga.tipoActual = i + 1;
      estadoDescarga.tipoComprobante = SRI_CONFIG.TIPOS_EMITIDOS[tipo];
      estadoDescarga.diaActual = 0;
      notificarProgreso();

      const cambio = await setearTipoComprobanteEmitidos(tabId, tipo);
      if (cambio === 'sin-select') {
        estadoDescarga.error = 'No se encontro el selector de tipo de comprobante. Verifica estar en la pantalla de emitidos.';
        break;
      }
      // El formulario no ofrece este tipo: pasar al siguiente
      if (cambio === 'sin-opcion') continue;
      // Margen por si el cambio de tipo dispara AJAX propio
      if (cambio === 'cambiado') await delay(800);
    }

    diasProcesados += await descargarDiasEmitidos(tabId, tipoDescarga, anio, mes, totalDias);
  }

  // Caso borde: mes actual y hoy es dia 1: no hay dias anteriores a hoy
  // que consultar; avisar en vez de terminar en silencio con 0 documentos
  if (diasProcesados === 0 && !estadoDescarga.detenido && !estadoDescarga.error) {
    estadoDescarga.error = 'El mes seleccionado no tiene dias anteriores a hoy para consultar.';
  }

  await finalizarSesion();
}

// Escuchar mensajes del popup. Los handlers sincronos responden y retornan
// false; los que consultan storage retornan true para mantener el canal de
// sendResponse abierto hasta que la promesa resuelva.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'iniciarDescargaTotal') {
    if (estadoDescarga.activo) {
      sendResponse({ status: 'ocupado' });
      return false;
    }
    descargarTodasLasPaginas(request.tabId, request.tipoDescarga, request.ignorarHistorial || false, request.origen || 'recibidos');
    sendResponse({ status: 'iniciado' });
    return false;
  }

  if (request.action === 'iniciarDescargaSeleccionados') {
    if (estadoDescarga.activo) {
      sendResponse({ status: 'ocupado' });
      return false;
    }
    descargarSeleccionados(request.tabId, request.tipoDescarga, request.claves || [], request.origen || 'recibidos');
    sendResponse({ status: 'iniciado' });
    return false;
  }

  if (request.action === 'iniciarDescargaEmitidosMes') {
    if (estadoDescarga.activo) {
      sendResponse({ status: 'ocupado' });
      return false;
    }
    descargarEmitidosMes(request.tabId, request.tipoDescarga, request.ignorarHistorial || false, request.anio, request.mes, request.todosLosTipos === true);
    sendResponse({ status: 'iniciado' });
    return false;
  }

  if (request.action === 'detenerDescarga') {
    estadoDescarga.detenido = true;
    sendResponse({ status: 'deteniendo' });
    return false;
  }

  if (request.action === 'obtenerEstado') {
    sendResponse({ estado: estadoDescarga });
    return false;
  }

  // Asistente de devolucion de IVA (iva.js): abrir el popup sobre la pestana
  // del SRI cuando aparece la pantalla de periodos o un periodo pendiente.
  // Solo si esa pestana es la que el usuario esta viendo. openPopup falla si
  // la ventana no tiene el foco o el popup ya esta abierto: no es un error
  if (request.action === 'ivaAbrirPopup') {
    if (!sender.tab?.active) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.action.openPopup({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (request.action === 'obtenerHistorial') {
    obtenerHistorial(request.ruc)
      .then(historial => sendResponse({ historial }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Nota: el popup actual ya no envia 'obtenerFallidos' (reintentar fallidos
  // ahora relanza una descarga total y la deduplicacion omite los exitosos);
  // se mantiene el handler por compatibilidad
  if (request.action === 'obtenerFallidos') {
    obtenerHistorial()
      .then(historial => {
        const fallidos = [];
        for (const ruc in historial) {
          for (const sesionId in historial[ruc].sesiones) {
            const sesion = historial[ruc].sesiones[sesionId];
            const docsFallidos = sesion.documentos.filter(d => !d.exito);
            fallidos.push(...docsFallidos.map(d => ({
              ...d,
              rucUsuario: ruc,
              sesionId: sesionId,
              fechaSesion: sesion.fecha
            })));
          }
        }
        fallidos.sort((a, b) => new Date(b.fechaDescarga) - new Date(a.fechaDescarga));
        sendResponse({ fallidos });
      })
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === 'limpiarHistorial') {
    borrarHistorial()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === 'obtenerConfig') {
    chrome.storage.local.get(['sriConfig'])
      .then(data => sendResponse({ config: data.sriConfig || null }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === 'guardarConfig') {
    // La pestana Configuracion guarda tiempos/metodo SIN la seccion
    // ORGANIZACION (y la pestana Organizacion la envia completa). Si no
    // viene, se conserva la guardada: antes se perdia y la organizacion en
    // carpetas quedaba desactivada al reiniciarse el service worker
    chrome.storage.local.get(['sriConfig'])
      .then((data) => {
        const config = { ...request.config };
        if (config.ORGANIZACION === undefined && data.sriConfig?.ORGANIZACION) {
          config.ORGANIZACION = data.sriConfig.ORGANIZACION;
        }
        return chrome.storage.local.set({ sriConfig: config });
      })
      .then(() => cargarConfigUsuario()) // Aplicar inmediatamente
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Navegar a la pantalla de comprobantes emitidos. Se navega a
  // accederAplicacion.jspa (redireccion=60) y NO a la URL directa del .jsf:
  // accederAplicacion hace el handshake SSO que inicializa la sesion de la
  // aplicacion de comprobantes; la URL directa rebota al login si esa sesion
  // no existe. El destino es menu.jsf con un menu de seleccion; al cargar se
  // hace click en la opcion "Comprobantes electronicos emitidos", se
  // preselecciona el tipo de comprobante y se consulta automaticamente
  if (request.action === 'navegarAEmitidos') {
    const tabId = request.tabId;
    const tipoComprobante = request.tipoComprobante || null;
    chrome.tabs.update(tabId, { url: request.url });

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Reintentar cada 1s (max 10) porque la pagina SRI carga contenido
        // con AJAX y el click en el menu intermedio tarda en surtir efecto
        let intentos = 0;
        const intervalo = setInterval(() => {
          intentos++;
          chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (tipoComprobante) => {
              // Ya estamos en la pantalla de emitidos: consultar de una vez
              // (no hay captcha). El form trae la fecha de HOY por defecto y
              // el SRI la rechaza ("debe ser menor a la fecha actual"), asi
              // que se consulta el primer dia del mes (o ayer si hoy es dia 1)
              const inp = document.getElementById('frmPrincipal:calendarFechaDesde_input');
              if (inp) {
                const hoy = new Date();
                let fecha = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
                if (hoy.getDate() === 1) {
                  fecha = new Date(hoy.getFullYear(), hoy.getMonth(), 0); // ultimo dia del mes anterior
                }
                const dd = String(fecha.getDate()).padStart(2, '0');
                const mm = String(fecha.getMonth() + 1).padStart(2, '0');
                inp.value = `${dd}/${mm}/${fecha.getFullYear()}`;
                inp.dispatchEvent(new Event('change', { bubbles: true }));

                // Preseleccionar el tipo de comprobante elegido en el menu
                if (tipoComprobante) {
                  const sel = document.getElementById('frmPrincipal:cmbTipoComprobante');
                  if (sel) {
                    sel.value = tipoComprobante;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }

                // Margen breve por si el cambio de tipo dispara AJAX propio
                setTimeout(() => {
                  document.getElementById('frmPrincipal:btnConsultar')?.click();
                }, 800);
                return true;
              }
              // Menu intermedio: click en la opcion de emitidos (la siguiente
              // iteracion del intervalo hara la consulta automatica)
              const link = Array.from(document.querySelectorAll('#consultaDocumentoForm a'))
                .find(a => /emitidos/i.test(a.textContent));
              if (link) link.click();
              return false;
            },
            args: [tipoComprobante]
          }).then(result => {
            if (result?.[0]?.result || intentos >= 10) {
              clearInterval(intervalo);
            }
          }).catch(() => {
            // executeScript falla mientras la tab navega (el click en el menu
            // intermedio carga otra pagina): seguir intentando hasta el tope
            if (intentos >= 10) clearInterval(intervalo);
          });
        }, 1000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    sendResponse({ status: 'navegando' });
    return false;
  }

  // Navegar a comprobantes recibidos y setear dia = "Todos" + tipo de comprobante
  if (request.action === 'navegarYSetearDia') {
    const tabId = request.tabId;
    const tipoComprobante = request.tipoComprobante || null;
    chrome.tabs.update(tabId, { url: request.url });

    // Esperar a que la pagina cargue y setear los selects del formulario
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Reintentar varias veces porque la pagina SRI carga contenido con AJAX
        let intentos = 0;
        const intervalo = setInterval(() => {
          intentos++;
          chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (tipo) => {
              const selDia = document.getElementById('frmPrincipal:dia');
              if (!selDia) return false;
              // Setear dia = "Todos"
              selDia.value = '0';
              selDia.dispatchEvent(new Event('change', { bubbles: true }));
              // Setear tipo de comprobante si se especifico
              if (tipo) {
                const selTipo = document.getElementById('frmPrincipal:cmbTipoComprobante');
                if (selTipo) {
                  selTipo.value = tipo;
                  selTipo.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
              return true;
            },
            args: [tipoComprobante]
          }).then(result => {
            if (result?.[0]?.result || intentos >= 10) {
              clearInterval(intervalo);
            }
          }).catch(() => {
            // La tab puede estar navegando (redirecciones SSO): seguir
            // intentando hasta el tope en vez de abortar al primer error
            if (intentos >= 10) clearInterval(intervalo);
          });
        }, 1000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    sendResponse({ status: 'navegando' });
    return false;
  }

  return false;
});

// Evento cuando se instala la extension
chrome.runtime.onInstalled.addListener(() => {
  // Cargar config del usuario al instalar/actualizar
  cargarConfigUsuario();
});
