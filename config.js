/**
 * Descargador de Comprobantes SRI - Configuracion centralizada
 * Compartido entre background.js y content.js
 */

if (typeof SRI_CONFIG !== 'undefined') {
  // Ya cargado, no redeclarar
} else {

var SRI_CONFIG = {
  // Delays
  DELAY_DESCARGA: 300,       // ms entre descargas individuales
  DELAY_PAGINA: 1500,        // ms minimo al cambiar de pagina (fallback)
  DELAY_REINTENTO: 1000,     // ms entre reintentos de descarga fallida
  TIMEOUT_DESCARGA: 5000,    // ms maximo esperando confirmacion de descarga
  TIMEOUT_PAGINA: 10000,     // ms maximo esperando cambio de pagina
  TIMEOUT_WS: 15000,         // ms maximo esperando al web service de autorizacion (XML emitidos)

  // Reintentos
  MAX_REINTENTOS: 2,         // reintentos por descarga fallida

  // Historial
  DIAS_HISTORIAL: 90,        // dias antes de limpiar historial automaticamente (~3 meses)

  // Metodo de descarga por link de la pagina: 'mojarra' (JSF directo) o 'click'
  METODO_DESCARGA: 'mojarra',

  // Selectores CSS del DOM del portal SRI
  SELECTORES: {
    TABLA_RECIBIDOS: '#frmPrincipal\\:tablaCompRecibidos_data', // tbody tabla de comprobantes recibidos
    TABLA_EMITIDOS: '#frmPrincipal\\:tablaCompEmitidos_data',   // tbody tabla de comprobantes emitidos
    PAGINADOR: '.ui-paginator-current',                         // texto "(X of Y)" del paginador
    BOTON_SIGUIENTE: '.ui-paginator-next:not(.ui-state-disabled)', // boton siguiente pagina
    BOTON_PRIMERA: '.ui-paginator-first:not(.ui-state-disabled)',  // boton primera pagina
    LINK_XML: '[id$=":lnkXml"]',                                // links de descarga XML por fila (solo recibidos)
    LINK_PDF: '[id$=":lnkPdf"]',                                // links de descarga PDF/RIDE por fila (ambas)
    RUC_USUARIO: '.area-usuario-blue span',                     // RUC del usuario logueado en topbar
    // Emitidos: campos del formulario de consulta (fecha por dia, sin rango)
    EMITIDOS_FECHA_INPUT: '#frmPrincipal\\:calendarFechaDesde_input', // fecha emision (dd/mm/aaaa)
    EMITIDOS_CMB_TIPO: '#frmPrincipal\\:cmbTipoComprobante',    // 1=Fact 2=Liq 3=NC 4=ND 5=Guia 6=Ret
    EMITIDOS_BTN_CONSULTAR: '#frmPrincipal\\:btnConsultar',     // boton Consultar (verificado en vivo)
  },

  // Tipos de comprobante del formulario de emitidos (value del select ->
  // nombre). Los usa el modo mes con "todos los tipos"
  TIPOS_EMITIDOS: {
    '1': 'Facturas',
    '2': 'Liquidaciones de compra',
    '3': 'Notas de Credito',
    '4': 'Notas de Debito',
    '5': 'Guias de Remision',
    '6': 'Comprobantes de Retencion',
  },

  // Web service publico de autorizacion del SRI: entrega el XML autorizado a
  // partir de la clave de acceso. Usado para el XML de emitidos (que no tiene
  // link de descarga directa). Solo PRODUCCION: el portal donde se consulta
  // es el de produccion, nunca se busca en el ambiente de pruebas.
  WS_AUTORIZACION: {
    PRODUCCION: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    NAMESPACE: 'http://ec.gob.sri.ws.autorizacion',
  },

  // Asistente de devolucion de IVA (personas con discapacidad). Lo usa iva.js
  // (panel flotante en la pagina); no interviene en las descargas.
  IVA: {
    // App de devoluciones (adultos mayores y discapacidad): iva.js solo se
    // carga en estas paginas (ver content_scripts del manifest)
    RUTA_APP: '/devolucionTerceraEdad-internet/',
    TABLA_FACTURAS: "[id$='tblFacturas_data']",                 // tbody de la tabla de facturas
    INPUT_IVA_SOLICITADO: "input[id$='txtIvaSolicitado']",     // input "IVA solicitado" por fila
    SELECT_TIPO_GASTO: "select[id$='cmbTipoGasto_input']",     // select oculto del SelectOneMenu PrimeFaces
    BTN_PROCESAR: "[id$='btnGuardarFacturasSeleccionadas']",   // "Procesar facturas seleccionadas"
    COL_NOMBRE_COMERCIAL: 2,                                    // indice de celda con el nombre comercial
    COL_MONTO_IVA: 5,                                           // indice de celda con el IVA de la factura
    // Values del select de tipo de gasto del SRI
    TIPOS_GASTO: { '1': 'Vestimenta', '2': 'Vivienda', '3': 'Salud', '4': 'Alimentacion', '5': 'Educacion' },
    // Acceso directo: Devoluciones > IVA - Personas con discapacidad
    URL: 'https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=130&idGrupo=127',
  },

  // Dominio para filtrar descargas
  DOMINIO_SRI: 'sri.gob.ec',

  // Organizacion de archivos descargados
  // Ruta: carpetaRaiz / [orden] / [recibidos|emitidos] / tipoDoc / [xml|pdf] / archivo.ext
  // Donde [orden] es 'ruc_fecha' (ruc/anio/mes) o 'fecha_ruc' (anio/mes/ruc)
  ORGANIZACION: {
    HABILITADO: false,
    CARPETA_RAIZ: 'descargas_sri',
    ORDEN: 'ruc_fecha',            // 'ruc_fecha' | 'fecha_ruc'
    FORMATO_NOMBRE: 'claveAcceso', // 'claveAcceso' | 'ruc_serie' | 'razon_serie'
  },
};

/**
 * Normaliza la carpeta raiz de la organizacion a una ruta relativa valida
 * para chrome.downloads (que rechaza rutas absolutas, ".." y caracteres
 * invalidos: el archivo caia en Descargas sin avisar). Admite subcarpetas
 * separadas por / o \. Compartida por popup (al guardar) y background.
 * @param {string} raiz - Texto ingresado por el usuario
 * @returns {string} Ruta relativa segura (nunca vacia)
 */
var sriNormalizarCarpetaRaiz = function (raiz) {
  const segmentos = String(raiz || '')
    .split(/[\\/]+/)
    .map(s => s.replace(/[:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, ''))
    .filter(s => s && s !== '_' && !/^[a-zA-Z]_$/.test(s))
    .map(s => s.substring(0, 100));
  return segmentos.join('/') || 'descargas_sri';
};

} // Fin guard SRI_CONFIG
