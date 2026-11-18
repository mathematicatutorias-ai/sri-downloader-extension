// Mock de la API chrome.* para renderizar el popup real con datos FICTICIOS
// (capturas de la Web Store). La escena se elige con ?scene=...
(() => {
  const scene = new URLSearchParams(location.search).get('scene') || 'menu';
  const RUC = '1790012345001';

  const emisores = [
    ['1790098765001', 'DISTRIBUIDORA ANDINA S.A.'], ['0990123456001', 'SERVICIOS COSTA CIA. LTDA.'],
    ['1791234567001', 'IMPORTADORA SIERRA S.A.'], ['0992345678001', 'COMERCIAL DEL VALLE S.A.'],
    ['1790876543001', 'TECNOLOGIA GLOBAL CIA. LTDA.'], ['0991987654001', 'TRANSPORTES UNIDOS S.A.'],
    ['1792468135001', 'SUMINISTROS EXPRESS S.A.'], ['0993571246001', 'ALIMENTOS DEL PACIFICO S.A.']
  ];

  const docsRecibidos = emisores.map(([ruc], i) => ({
    index: i, nro: String(i + 1), ruc,
    tipoYSerie: `${i === 3 ? 'Comprobante de Retencion' : 'Factura'}  00${1 + (i % 3)}-001-0000${45821 + i * 137}`,
    claveAcceso: `0${i + 1}07202601${ruc}2001001000004582${i}0000000${i}1${i}`,
    fecha: `0${i + 1}/07/2026`, tieneXml: true, tienePdf: true,
    linkXmlId: `f:${i}:lnkXml`, linkPdfId: `f:${i}:lnkPdf`
  }));

  const docsEmitidos = Array.from({ length: 12 }, (_, i) => ({
    index: i, nro: String(i + 1), ruc: '',
    tipoYSerie: `Factura  001-001-0000249${81 + i}`,
    claveAcceso: `140720260${RUC}20010010000249${81 + i}000000001${i % 10}`,
    fecha: '14/07/2026', tieneXml: true, tienePdf: true, linkXmlId: null, linkPdfId: `f:${i}:lnkPdf`
  }));

  const inactivo = { activo: false, detenido: false, exitosos: 0, fallidos: 0, omitidos: 0, paginaActual: 0, totalPaginas: 0, documentoActual: 0, totalDocumentos: 0, tipoDescarga: 'xml', origen: 'recibidos', error: null, avisos: [], viaAlternativa: 0 };
  const descargando = { ...inactivo, activo: true, exitosos: 54, omitidos: 0, paginaActual: 3, totalPaginas: 5, documentoActual: 55, totalDocumentos: 75, tiempoEstimado: 80000 };

  const ahora = Date.now();
  const hace = (min) => new Date(ahora - min * 60000).toISOString();
  const reg = (i, extra = {}) => ({
    claveAcceso: docsRecibidos[i].claveAcceso, ruc: emisores[i][0], razonSocial: emisores[i][1],
    tipoDoc: docsRecibidos[i].tipoYSerie, serie: docsRecibidos[i].tipoYSerie.match(/\d{3}-\d{3}-\d+/)[0],
    fechaEmision: docsRecibidos[i].fecha, fechaAutorizacion: docsRecibidos[i].fecha + ' 10:15:00',
    valorSinImpuestos: '100.00', iva: '15.00', importeTotal: '115.00',
    pagina: 1, exito: true, exitoXml: true, exitoPdf: true, error: null, nota: null, fechaDescarga: hace(5 + i * 2), ...extra
  });
  const historial = {
    [RUC]: {
      sesiones: {
        sesion_1: { fecha: hace(5), tipoDescarga: 'ambos', origen: 'recibidos', documentos: [
          reg(0), reg(1, { nota: 'XML por metodo alternativo (fetch)' }), reg(2),
          reg(3, { exito: false, exitoPdf: false, error: 'Error descargando PDF' }), reg(4), reg(5)
        ] },
        sesion_2: { fecha: hace(60), tipoDescarga: 'ambos', origen: 'emitidos', documentos: [0, 1, 2].map(i => ({
          claveAcceso: docsEmitidos[i].claveAcceso, ruc: RUC, razonSocial: '', tipoDoc: docsEmitidos[i].tipoYSerie,
          serie: docsEmitidos[i].tipoYSerie.match(/\d{3}-\d{3}-\d+/)[0], fechaEmision: '14/07/2026', fechaAutorizacion: '14/07/2026 09:00:00',
          valorSinImpuestos: '250.00', iva: '37.50', importeTotal: '287.50', pagina: 1, exito: true, exitoXml: true, exitoPdf: true,
          error: null, nota: null, fechaDescarga: hace(60 + i)
        })) }
      }
    }
  };

  // Asistente de devolucion de IVA: estado que devolveria iva.js tras
  // "Rellenar esta pagina" sobre las facturas ficticias de iva_page.html
  const linea = (msg, cls = 'info') => ({ msg, cls });
  const logIva = [
    linea('Procesando 6 facturas...'),
    linea('Fila 1: FARMACIA SAN RAFAEL...'), linea('  IVA: $2.35', 'ok'), linea('  Gasto: Salud', 'ok'),
    linea('Fila 2: FERRETERIA EL CONSTRUCTOR...'), linea('  IVA: $5.10', 'ok'), linea('  Gasto: Vivienda', 'ok'),
    linea('Fila 3: LIBRERIA Y PAPELERIA ESTUDIANT...'), linea('  IVA: $1.80', 'ok'), linea('  Gasto: Educacion', 'ok'),
    linea('Fila 4: RESTAURANTE LA ESQUINA...'), linea('  IVA: $3.45', 'ok'), linea('  Gasto: Alimentacion', 'ok'),
    linea('Fila 5: CLINICA SANTA ANA...'), linea('  IVA: $12.00', 'ok'), linea('  Gasto: Salud', 'ok'),
    linea('Fila 6: COMERCIAL DEL VALLE S.A....'), linea('  IVA: $4.20', 'ok'),
    linea('  SIN CATEGORIA: "COMERCIAL DEL VALLE S.A." - seleccione manualmente (se guardara para la proxima vez)', 'warn'),
    linea('Pagina completada: 6 facturas', 'ok'),
    linea('Categoria guardada: COMERCIAL DEL VALLE S.A. -> Alimentacion', 'ok')
  ];
  const estadoIva = {
    hayTabla: true, enPeriodos: false, procesando: false, hayPaginaSiguiente: true,
    status: { msg: 'Pagina lista - Revise', tipo: 'done' },
    // Sin busqueda de periodos: su seccion no se muestra y el popup entra
    // completo en la captura
    busqueda: null,
    logGen: 1, logDesde: 0, logTotal: logIva.length, log: logIva
  };

  const escenas = {
    iva: { docs: { error: 'sin tabla' }, estado: inactivo },
    menu: { docs: { error: 'sin tabla' }, estado: inactivo },
    recibidos: { docs: { documentos: docsRecibidos, total: 8, origen: 'recibidos', paginacion: { actual: 3, total: 5 } }, estado: descargando },
    emitidos: { docs: { documentos: docsEmitidos, total: 12, origen: 'emitidos', paginacion: { actual: 1, total: 1 } }, estado: { ...inactivo, origen: 'emitidos' } },
    historial: { docs: { documentos: docsRecibidos, total: 8, origen: 'recibidos', paginacion: { actual: 1, total: 5 } }, estado: inactivo }
  };
  const esc = escenas[scene] || escenas.menu;

  const storage = {
    ultimoTipoDescarga: scene === 'emitidos' ? 'ambos' : 'xml', emitidosTodosLosTipos: true,
    ivaCategoriasCustom: { 'RESTAURANTE': '4', 'COMERCIAL DEL VALLE S.A.': '4', 'OPTICA VISION': '3' }
  };
  const responder = (valor, cb) => (cb ? (setTimeout(() => cb(valor), 0), undefined) : Promise.resolve(valor));

  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: '__VERSION__' }),
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        const r = {
          obtenerEstado: { estado: esc.estado },
          obtenerHistorial: { historial },
          obtenerConfig: { config: null }
        }[msg.action] || { success: true };
        return responder(r, cb);
      }
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf' }],
      get: async () => ({ id: 1, url: 'https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT' }),
      sendMessage(id, msg, cb) {
        if (msg.action === 'obtenerDocumentos') return responder(esc.docs, cb);
        // iva.js solo "esta" en la escena de devolucion de IVA. El log se
        // entrega una vez: las consultas siguientes piden desde logDesde
        if (scene === 'iva' && msg.action.startsWith('iva')) {
          const desde = msg.logGen === estadoIva.logGen ? msg.logDesde : 0;
          return responder({ ...estadoIva, logDesde: desde, log: logIva.slice(desde) }, cb);
        }
        return responder(null, cb);
      },
      update() {}
    },
    scripting: { executeScript: async () => [], insertCSS: async () => {} },
    storage: { local: {
      get(keys, cb) {
        const o = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in storage) o[k] = storage[k]; });
        return responder(o, cb);
      },
      set(o) { Object.assign(storage, o); return Promise.resolve(); }
    }, onChanged: { addListener() {} } },
    downloads: { download() {} }
  };

  // Ajustes de la escena tras renderizar + aviso del alto al contenedor
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (scene === 'recibidos') document.querySelector('#contentArea details.options-section').open = true;
      if (scene === 'historial') { document.querySelector('[data-tab="historial"]').click(); document.getElementById('listaHistorial').style.maxHeight = '205px'; }
      setTimeout(() => {
        parent.postMessage({ popupAlto: document.documentElement.scrollHeight }, '*');
      }, 400);
    }, 400);
  });
})();
