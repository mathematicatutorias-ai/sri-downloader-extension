# CLAUDE.md - Guia para Claude Code

## Proyecto
Extension de Chrome (Manifest V3) para descargar documentos XML/PDF del SRI Ecuador,
tanto comprobantes RECIBIDOS como EMITIDOS. Organiza archivos en carpetas
configurables, ofrece accesos directos al portal SRI e incluye un asistente
para la devolucion de IVA (adultos mayores / personas con discapacidad).
Version: 1.7.0 | Dominio: `srienlinea.sri.gob.ec` (+ WS `cel.sri.gob.ec`)

## Estructura de archivos
```
sri-downloader-extension/
├── manifest.json      # Manifest V3 config (permisos, service worker, content scripts)
├── config.js          # Constantes compartidas (delays, selectores, timeouts, organizacion)
├── background.js      # Service Worker - descargas, organizacion archivos, navegacion SRI
├── content.js         # Content Script - extractor de datos DOM (~120 lineas)
├── iva.js             # Content Script - panel asistente devolucion de IVA
├── iva.css            # Estilos del panel IVA (inyectado en la pagina del SRI)
├── iva-categorias.js  # Categorias base nombre comercial -> tipo de gasto
├── popup.html         # UI del popup (4 tabs + accesos directos SRI + modal)
├── popup.js           # Logica del popup (menu SRI, config, organizacion, historial)
├── popup.css          # Estilos (light + dark mode + tema verde agua emitidos)
├── icons/             # Iconos PNG y SVG (16, 48, 128)
├── docs/              # Assets de la Chrome Web Store (descripcion + imagenes + mocks/)
├── dist/              # ZIPs para publicar (gitignored, se regeneran)
├── README.md
└── CLAUDE.md
```

## Comandos utiles
- Actualizar extension: `chrome://extensions/` > click en actualizar
- Ver logs background: `chrome://extensions/` > "Service worker" > click para inspeccionar
- Ver logs pagina: F12 en la pagina del SRI
- Empaquetar para la Web Store (PowerShell):
  `Compress-Archive -Path manifest.json, background.js, config.js, content.js, iva.js, iva.css, iva-categorias.js, popup.html, popup.js, popup.css, icons -DestinationPath "dist\sri-downloader-vX.Y.Z.zip" -Force`

## Arquitectura clave

### Config - `config.js`
- Constantes centralizadas: delays, timeouts, selectores, reintentos, organizacion
- Compartido entre background.js (via `importScripts`) y content.js (via content_scripts en manifest)
- Objeto global `SRI_CONFIG` con guard `if (typeof SRI_CONFIG !== 'undefined')` para evitar redeclaracion
- Config de organizacion con estructura fija: `carpetaRaiz / [orden] / recibidos / tipoDoc / xml|pdf / archivo`

### Background (Service Worker) - `background.js`
- **Persistente**: Continua aunque se cierre el popup
- **Doble metodo de descarga**: `mojarra.jsfcljs()` (directo JSF) o click emulado
- Ejecuta descargas con `chrome.scripting.executeScript({ world: 'MAIN' })`
- Verifica descargas reales con `chrome.downloads.onCreated` (ventana de tiempo)
- Intenta aceptar descargas "peligrosas" del SRI con `chrome.downloads.acceptDanger`
  (solo un intento: Chrome exige contexto visible y desde el service worker suele rechazar)
- Guarda historial en `chrome.storage.local` (organizado por RUC)
- Enfoque **secuencial**: espera confirmacion de descarga antes de continuar
- Buffer en memoria durante sesion, escribe a storage al finalizar
- Limpieza automatica de historial >90 dias (`DIAS_HISTORIAL`, configurable)
- Indice Set() para deduplicacion O(1) (distingue XML y PDF por separado)
- Reintentos automaticos (configurable, default 2)
- Espera inteligente de paginacion (polling en vez de delay fijo)
- Detecta tab cerrada y aborta descarga
- Badge en icono con progreso
- Notificacion Chrome al finalizar
- Calcula tiempo estimado restante

### Organizacion de archivos (background.js)
- Usa `chrome.downloads.onDeterminingFilename` para interceptar descargas y asignar ruta organizada
- `downloadMetadataMap`: Map temporal que asocia downloadId con metadata del documento
- Metadata se propaga por la cadena: `ejecutarConReintento` -> `ejecutarDescargaSRI` -> `ejecutarDescargaMojarra`/`ejecutarDescargaClick`
- Ruta fija: `carpetaRaiz / [ruc/anio/mes o anio/mes/ruc] / recibidos|emitidos / tipoDoc / xml|pdf / nombre.ext`
- El segmento `recibidos|emitidos` sale de `metadata.origen`; `xml|pdf` separa tipos de archivo
- Funciones auxiliares: `sanitizarNombreCarpeta`, `parsearFechaSRI`, `limpiarTipoDoc`, `construirNombreArchivo`, `construirRutaArchivo`
- `conflictAction: 'overwrite'` para sobrescribir archivos existentes
- Si deshabilitado, `suggest()` sin parametros = carpeta de descargas por defecto
- Descargas por data URL iniciadas por la extension (XML del WS y PDF por
  fetch en emitidos) no pasan por `onCreated`: su metadata viaja en
  `pendingDataUrlMeta` y el listener la consume al detectar URL `data:`

### Navegacion SRI (background.js)
- Mensaje `navegarYSetearDia`: navega a comprobantes recibidos y setea automaticamente:
  - Dia del periodo = "Todos" (`frmPrincipal:dia` value `0`)
  - Tipo de comprobante segun seleccion (`frmPrincipal:cmbTipoComprobante`)
- Mensaje `navegarAEmitidos`: navega via `accederAplicacion.jspa?redireccion=60&idGrupo=58`
  (handshake SSO; la URL directa al .jsf rebota al login Keycloak), hace click en
  "Comprobantes electronicos emitidos" del menu intermedio (`consultaDocumentoForm`),
  preselecciona el tipo de comprobante y consulta automaticamente con el dia 1 del
  mes (la fecha por defecto del form es HOY y el SRI la rechaza)
- Usa `chrome.tabs.onUpdated` + reintentos cada 1s (hasta 10) para esperar carga JSF

### Comprobantes emitidos (background.js)
- Pantalla: `recuperarComprobantes.jsf`, tabla `frmPrincipal:tablaCompEmitidos_data`
- Por fila SOLO hay link de PDF/RIDE (`lnkPdf`). NO existe `lnkXml`
- **PDF via fetch** (`descargarPorFetch`): el submit del formulario con
  `mojarra.jsfcljs` (y hasta el click manual en RIDE) responde 503 en emitidos;
  el mismo POST (FormData del form + `linkId=linkId`) hecho con `fetch` desde
  la pagina devuelve el PDF en ~100 ms. Se convierte a data URL y se descarga
  con `chrome.downloads.download`; la ruta la decide `onDeterminingFilename`
  via `pendingDataUrlMeta` (mismo mecanismo que el XML del WS). Si en todos
  los intentos no llega un PDF, cae al metodo clasico (mojarra/click)
- **XML via web service**: `consultarXmlAutorizado` hace SOAP al WS publico
  `AutorizacionComprobantesOffline` (cel.sri.gob.ec, SOLO produccion) con la clave de acceso;
  el XML viene escapado con entidades dentro de `<comprobante>` → `desescaparXml`
  → `xmlADataUrl` (base64, el SW no tiene URL.createObjectURL) → `chrome.downloads.download`.
  La ruta organizada NO se pasa como `filename` ahi (el propio listener
  `onDeterminingFilename` la pisaria): se registra en `pendingDataUrlMeta` y el
  listener decide la ruta final
- El formulario consulta UN SOLO DIA (sin rango ni "Todos"):
  - Modo dia: descarga lo consultado en pantalla (flujo normal de paginas)
  - Modo mes (`descargarEmitidosMes`): itera del dia 1 hasta UN DIA ANTES de hoy
    (consultar el dia actual da error), seteando fecha + click Consultar
    (`frmPrincipal:btnConsultar`) por cada dia
- **Antes de consultar cada dia hay que estar en la pagina 1 de la tabla**
  (`asegurarPrimeraPaginaEmitidos`): consultar con el paginador en otra pagina
  hace que el SRI responda HTTP 500 / `ArithmeticException` y deje la vista
  JSF rota (todo lo que sigue falla hasta recargar). Ver "Problemas conocidos"
- Deteccion de fin de AJAX: se marca la tabla y `.ui-messages` con atributo
  `data-sri-esperando` antes del click; el poll (`esperarResultadosEmitidos`)
  devuelve `{resultado: 'datos'|'vacio'|'error'|'timeout', detalle?}`.
  'error' sale de un hook sobre `XMLHttpRequest.send` (instalado en MAIN por
  `setearFechaYConsultar`) que publica en `<html data-sri-ajax-error>` las
  respuestas JSF `<partial-response><error>` o HTTP >= 400; en ese caso el
  mes aborta con mensaje en vez de procesar la tabla vieja
- Tras la espera se verifica que la fecha de emision de la primera fila
  coincide con el dia consultado; si no, aborta (tabla desactualizada)
- Dias sin comprobantes se SALTAN (solo si el mensaje "No existen datos" esta
  presente; otros errores abortan para no enmascararlos)
- Cancelacion: `estadoDescarga.detenido` se consulta en todos los bucles de espera
- `procesarPaginasActuales`: bucle de paginas reutilizable (acumula totales) usado
  por descarga total, seleccionados y modo mes; `procesarDocumento` recibe `origen`
- Ruta de organizacion usa segmento `recibidos|emitidos` segun `metadata.origen`
- Popup con tema verde agua (`body.modo-emitidos`) cuando trabaja sobre emitidos

### Recibidos: metodo normal + respaldo por fetch
- Prima el metodo normal (mojarra/click con sus reintentos y confirmacion por
  `downloads.onCreated`). Solo si falla, `descargarRecibidoConRespaldo` intenta
  UNA vez `descargarPorFetch` (mismo POST JSF hecho con fetch, validado por
  contenido: `%PDF` o XML que no sea HTML/partial-response)
- Cada archivo logrado asi suma `estadoDescarga.viaAlternativa`, deja `nota` en
  el registro del historial/CSV y genera un aviso al terminar (no verificado en
  vivo contra el SRI: el aviso pide revisar que el archivo abra)

### Emitidos: todos los tipos de comprobante
- Casilla "Todos los tipos de comprobante" (solo modo mes; preferencia
  `emitidosTodosLosTipos`). `descargarEmitidosMes(..., todosLosTipos)` recorre
  `SRI_CONFIG.TIPOS_EMITIDOS`: por cada tipo setea el select
  (`setearTipoComprobanteEmitidos`) y repite el mes con `descargarDiasEmitidos`.
  Un tipo que el select no ofrece se salta. Progreso: `tipoComprobante`,
  `tipoActual`, `totalTipos`

### Sesiones de descarga (background.js)
- `crearEstadoSesion` (sincrono, antes de cualquier await: evita doble inicio),
  `prepararSesion` (buffer, config, limpieza, indice de dedup, marca en
  `storage.session`) y `finalizarSesion` (avisos, guardado, notificaciones) son
  comunes a descarga total, seleccionados y modo mes
- Historial: una clave `hs_<sesionId>` por sesion (ver "Problemas conocidos")
- Registro por documento: ademas de fechas guarda `valorSinImpuestos`, `iva`,
  `importeTotal` (columnas de la tabla) y `nota`

### Popup - `popup.html` / `popup.js` / `popup.css`
- **4 tabs** en grilla 2x2: Descargar | Historial | Configuracion | Organizacion
- Tabs se ocultan cuando no hay tabla de comprobantes (solo se muestran accesos directos),
  salvo en emitidos sin consulta: ahi el area de descarga sigue operativa (modo mes).
  El flag `contentDisponible` (no `documentos.length`) decide que muestra la pestana "Descargar"
- Se comunica con background via `chrome.runtime.sendMessage`
- Al abrir, consulta estado actual con `obtenerEstado`
- **Accesos directos SRI**: menu con submenus para navegar secciones del portal SRI
  - "Descargar comprobantes" tiene submenu con tipos: Facturas, Liquidaciones, Notas Credito/Debito, Retenciones
  - Cada opcion navega y pre-configura dia="Todos" + tipo de comprobante
- Muestra barra de progreso granular (por documento, no por pagina)
- Estimacion de tiempo restante ("~2:30 restantes")
- Confirmacion con modal antes de descarga masiva
- Historial filtrable: todos, exitosos, fallidos
- Exportar historial a CSV
- Boton reintentar fallidos
- Recordar ultimo tipo de descarga (XML/PDF/Ambos)
- Sonido al completar (AudioContext beep), solo cuando la finalizacion llega en vivo por
  mensaje del background (`actualizarUIEstado(estado, enVivo=true)`); la consulta inicial
  `obtenerEstado` al abrir el popup no suena (el background conserva el ultimo estado final)
- Dark mode automatico (prefers-color-scheme)
- Construccion DOM segura (textContent, no innerHTML)
- Alerta al cambiar config de organizacion si hay historial previo

### Content Script - `content.js`
- Solo extractor de datos del DOM (~120 lineas)
- Extrae filas de tabla (recibidos o emitidos) y paginacion; alimenta la lista y el
  estimado del popup. El background tiene su PROPIO extractor (`obtenerDatosPagina`)
  con mas campos: si cambia el DOM del SRI hay que actualizar los dos
- Tiene guard `window.SRI_DOWNLOADER_LOADED` para evitar reinyeccion
- No ejecuta descargas (eso lo hace background)

### Asistente devolucion de IVA - `iva.js` / `iva.css` / `iva-categorias.js`
- Portado de la extension `autofill_devolucioniva` (github.com/rolansor/autofill_devolucioniva)
- Content script SOLO en `/devolucionTerceraEdad-internet/*` (app de devoluciones:
  discapacidad en `pages/personasDiscapacidad/...` y adultos mayores en
  `pages/terceraEdad/procesarDTE.jsf`, verificado en vivo), tras config.js + iva-categorias.js;
  guard `window.SRI_IVA_LOADED`. Selectores en `SRI_CONFIG.IVA`
- Popup: apartado primario "Devolucion de IVA" (morado) con SOLO dos opciones:
  Personas con discapacidad (`redireccion=130`) y Adultos mayores (`redireccion=129`).
  Solo navegan; no hay logica de background
- La app de discapacidad cae en `devolucionTerceraEdad-internet/pages/personasDiscapacidad/
  procesarPersonasDiscapacidad.jsf`: pantalla de condiciones (Si/No) -> seleccion de
  cuenta bancaria de acreditacion -> periodo -> tabla de facturas
- El panel se abre SOLO cuando aparece `[id$='tblFacturas_data']` (MutationObserver con
  debounce 500 ms; la consulta es AJAX). Si el usuario lo cierra (x) no se reabre solo
  en esa pagina; el popup muestra "Abrir asistente de devolucion IVA" cuando hay tabla
- Por fila: click en `.ui-chkbox-box`, `txtIvaSolicitado` = IVA de la celda 5, tipo de
  gasto via trigger del SelectOneMenu + click en `li` (fallback: select oculto + label)
- Categoria por `includes()` del nombre comercial (celda 2): personalizadas
  (`chrome.storage.local.ivaCategoriasCustom`) primero, luego `IVA_CATEGORIAS_BASE`
- Modo auto: pagina 1 -> todas; si 0 incompletas pulsa `btnGuardarFacturasSeleccionadas`
  (envio al SRI), si hay incompletas avisa y NO envia
- Cambio de pagina: marca la primera fila y espera a que se reemplace (o cambie el
  texto del paginador), luego 1500 ms de margen
- Las categorias personalizadas de la extension vieja NO se migran (otro storage)
- Coincidencia (`coincide`): claves de mas de 4 caracteres por `includes()`;
  claves cortas ("RM", "AKI", "KFC", "ZARA") solo como palabra completa (antes
  "RM" coincidia con "HERMANOS" y clasificaba mal). Compara sin tildes
- Casilla "Procesar automaticamente al terminar el modo auto" (`ivaAutoProcesar`,
  activada por defecto); desactivada deja todo listo sin enviar
- Exportar/Importar categorias personalizadas en JSON `{"NOMBRE": "4"}`
- Probado con tabla simulada (`docs/mocks/iva_page.html`); la tabla real de
  facturas no se ha visto en vivo (se asumen los selectores de la extension vieja)

## Mensajes entre componentes

### Popup -> Background
| Mensaje | Descripcion | Payload |
|---------|-------------|---------|
| `iniciarDescargaTotal` | Inicia descarga de todas las paginas | `{tabId, tipoDescarga, ignorarHistorial, origen}` |
| `iniciarDescargaSeleccionados` | Descarga seleccionados de la pagina actual (sin dedup) | `{tabId, tipoDescarga, claves[], origen}` |
| `iniciarDescargaEmitidosMes` | Descarga emitidos de un mes, consultando dia por dia (y por tipo si `todosLosTipos`) | `{tabId, tipoDescarga, ignorarHistorial, anio, mes, todosLosTipos}` |
| `navegarAEmitidos` | Navega al menu de consultas, hace click en emitidos y auto-consulta | `{tabId, url, tipoComprobante}` |
| `detenerDescarga` | Detiene descarga en progreso | - |
| `obtenerEstado` | Obtiene estado actual | - |
| `obtenerHistorial` | Obtiene historial completo | `{ruc?}` |
| `obtenerFallidos` | Lista documentos fallidos | - |
| `limpiarHistorial` | Limpia storage | - |
| `obtenerConfig` | Obtiene configuracion guardada | - |
| `guardarConfig` | Guarda configuracion | `{config}` |
| `navegarYSetearDia` | Navega a comprobantes y pre-configura formulario | `{tabId, url, tipoComprobante}` |

### Popup -> Content Script
| Mensaje | Descripcion |
|---------|-------------|
| `obtenerDocumentos` | Extrae documentos de la tabla actual (content.js) |
| `ivaEstado` | `{hayTabla, panelAbierto, procesando}` del asistente IVA (iva.js) |
| `ivaAbrirPanel` | Abre el panel del asistente IVA en la pagina (iva.js) |

Cada listener responde SOLO a sus acciones: responder error a acciones ajenas
pisaria la respuesta del otro content script.

### Background -> Popup
| Mensaje | Descripcion |
|---------|-------------|
| `estadoDescarga` | Actualizacion de progreso en tiempo real |

## Flujo de descarga
1. Popup muestra modal con estimado de documentos
2. Envia `iniciarDescargaTotal` a background con `tabId`, `tipoDescarga` e `ignorarHistorial`
3. Background carga config usuario y construye indice Set de descargados previos (O(1) lookup)
4. Ejecuta `chrome.scripting.executeScript` para obtener datos de pagina
5. Por cada documento: verifica deduplicacion (distingue XML/PDF), construye `docMeta`
6. Ejecuta descarga con `ejecutarConReintento` -> `ejecutarDescargaSRI` -> mojarra o click
7. `chrome.downloads.onCreated` guarda metadata en `downloadMetadataMap`
8. `chrome.downloads.onDeterminingFilename` intercepta y asigna ruta organizada
9. Espera inteligente (polling paginador) entre cambios de pagina
10. Actualiza badge, calcula tiempo estimado, notifica popup
11. Al finalizar: guarda buffer en storage, limpia downloadMetadataMap, notificacion Chrome

## Organizacion de archivos - Estructura de ruta
```
carpetaRaiz / [orden configurable] / recibidos|emitidos / tipoDoc / xml|pdf / nombre.ext
```

### Orden configurable (2 opciones):
- `ruc_fecha`: `ruc / anio / mes` (default)
- `fecha_ruc`: `anio / mes / ruc`

### Niveles fijos (no configurables):
- `recibidos` o `emitidos` segun la pantalla de origen (`metadata.origen`).
  El `ruc` del orden es siempre el del usuario logueado; en emitidos, ademas,
  `metadata.ruc` (emisor) es ese mismo RUC y no hay razon social (`razon_serie`
  cae al RUC)
- Tipo de documento: `factura`, `notas_de_credito`, `comprobante_de_retencion`, etc.
- Tipo de archivo: `xml` o `pdf`

### Extraccion de serie:
- La celda 2 de la tabla contiene tipo + serie juntos (ej: "Factura  001-006-055715817")
- Se extrae la serie con regex `\d{3}-\d{3}-\d+` (ej: "001-006-055715817")

### Formatos de nombre de archivo:
| Formato | Ejemplo |
|---------|---------|
| `claveAcceso` (default) | `0103202601179184765200120010010347004903470049013.xml` |
| `ruc_serie` | `1791847652001_001001034700490.xml` |
| `razon_serie` | `SETEL_S.A._001001034700490.xml` |

### Ejemplo de ruta completa:
```
descargas_sri/0930808662001/2026/03/recibidos/factura/xml/0103202601...013.xml
descargas_sri/0930808662001/2026/03/recibidos/factura/pdf/0103202601...013.pdf
```

## Configuracion (`config.js`)
```javascript
SRI_CONFIG = {
  DELAY_DESCARGA: 300,       // ms entre descargas
  DELAY_PAGINA: 1500,        // ms fallback cambio pagina
  DELAY_REINTENTO: 1000,     // ms entre reintentos
  TIMEOUT_DESCARGA: 5000,    // ms max por descarga
  TIMEOUT_PAGINA: 10000,     // ms max esperando cambio pagina
  TIMEOUT_WS: 15000,         // ms max esperando al WS de autorizacion (no expuesto en UI)
  MAX_REINTENTOS: 2,         // reintentos por descarga
  DIAS_HISTORIAL: 90,        // auto-limpieza (~3 meses)
  SELECTORES: { ... },       // selectores CSS del SRI
  DOMINIO_SRI: 'sri.gob.ec', // filtro para downloads.onCreated
  ORGANIZACION: {
    HABILITADO: false,
    CARPETA_RAIZ: 'descargas_sri',
    ORDEN: 'ruc_fecha',            // 'ruc_fecha' | 'fecha_ruc'
    FORMATO_NOMBRE: 'claveAcceso'  // 'claveAcceso' | 'ruc_serie' | 'razon_serie'
  }
}
```

## Selectores importantes del SRI
```javascript
'#frmPrincipal\\:tablaCompRecibidos_data'  // Tabla de documentos
'.ui-paginator-current'                      // Info paginacion "(X of Y)"
'.ui-paginator-next:not(.ui-state-disabled)' // Boton siguiente
'.ui-paginator-first:not(.ui-state-disabled)'// Boton primera pagina
'[id$=":lnkXml"]'                            // Links de descarga XML
'[id$=":lnkPdf"]'                            // Links de descarga PDF
'.area-usuario-blue span'                    // RUC del usuario logueado
'frmPrincipal:dia'                           // Select de dia (value "0" = Todos)
'frmPrincipal:cmbTipoComprobante'            // Select tipo comprobante (1-6)
```

## Tipos de comprobante del SRI
| Value | Tipo |
|-------|------|
| 1 | Factura |
| 2 | Liquidacion de compra |
| 3 | Notas de Credito |
| 4 | Notas de Debito |
| 6 | Comprobante de Retencion |

## Funcion de descarga del SRI
```javascript
// Metodo mojarra (directo JSF)
mojarra.jsfcljs(
  document.getElementById('frmPrincipal'),
  { 'linkId': 'linkId' },
  ''
);
// Metodo click emulado
document.getElementById(linkId).click();
```

## Problemas conocidos y soluciones

### CSP bloquea scripts inline
- **Solucion**: Usar `chrome.scripting.executeScript` con `world: 'MAIN'`

### Popup se cierra al perder focus
- **Solucion**: Logica de descarga en background service worker

### Descargas "falsas" (marca OK pero no descargo)
- **Solucion**: Verificar con `chrome.downloads.onCreated` con ventana de tiempo

### Content script se reinyecta
- **Solucion**: Guard `if (window.SRI_DOWNLOADER_LOADED)` al inicio

### Tab cerrada durante descarga
- **Solucion**: Listener `chrome.tabs.onRemoved` aborta descarga

### Descargas fallidas por timeout transitorio
- **Solucion**: Reintentos automaticos (2 por default)

### Paginacion con servidor lento
- **Solucion**: Polling inteligente del paginador con fallback a delay fijo

### Chrome marca descargas como peligrosas
- **Solucion (parcial)**: se intenta `chrome.downloads.acceptDanger` para URLs del
  SRI, pero Chrome exige llamarlo desde un contexto visible (pestana/popup); desde
  el service worker normalmente rechaza (se captura). Si el navegador bloquea el
  archivo, el usuario debe conservarlo desde la barra de descargas

### Deduplicacion no distinguia XML de PDF
- **Solucion**: `exitoXml`/`exitoPdf` usan `null` = no se intento ese formato,
  `true`/`false` = resultado real. El indice de dedup exige `=== true` y que
  la sesion haya cubierto ese formato (`tipoDescarga` de la sesion), lo que
  tambien neutraliza registros viejos que guardaban `true` por defecto

### Campo de config vacio generaba NaN y rompia los reintentos
- **Solucion**: `leerConfigNum` en popup.js (Number.isNaN → default, clamp min/max)

### Service worker MV3 puede morir a mitad de descarga larga
- **Solucion**: guardado incremental del buffer por pagina (`guardarBufferAlStorage(false)`)

### Descargas ajenas del usuario contaban como exito
- **Solucion**: `downloads.onCreated` filtra por origen ademas de la ventana
  de tiempo (dominio SRI, `blob:` o URL vacia; rechaza otros sitios)

### tipoDoc incluia la serie en la ruta
- **Solucion**: `limpiarTipoDoc()` extrae solo el tipo sin la serie usando regex

### Setear dia="Todos" al navegar a comprobantes
- **Solucion**: Logica en background.js con `chrome.tabs.onUpdated` + reintentos, no en popup (que se cierra)

### La organizacion en carpetas no aplicaba al XML de emitidos (web service)
- **Causa**: el `filename` pasado a `chrome.downloads.download` NO sobrevive si
  la extension tiene un listener `onDeterminingFilename` que llama `suggest` con
  nombre (lo pisa). La descarga por data URL no pasa por `onCreated`, no habia
  metadata en `downloadMetadataMap` y el listener caia en la rama de "descarga
  ajena" sugiriendo el nombre generico del data URL en la raiz de Descargas.
- **Solucion**: `descargarXmlEmitido` registra la metadata en `pendingDataUrlMeta`
  antes de llamar `downloads.download`; el listener la consume (detecta URL
  `data:`) y construye la ruta organizada, o el nombre `claveAcceso.xml` si la
  organizacion esta deshabilitada.

### El WS de autorizacion colgado bloqueaba la sesion y el boton Detener
- **Solucion**: `fetch` con `AbortSignal.timeout(TIMEOUT_WS)`; ademas los bucles
  de reintento (`ejecutarConReintento`, `descargarXmlEmitidoConReintento`)
  cortan si `estadoDescarga.detenido`

### Estimado de documentos erroneo si se iniciaba desde la ultima pagina
- **Causa**: "docs por pagina" se media en la pagina actual, que puede estar
  incompleta si el usuario estaba parado en la ultima
- **Solucion**: `procesarPaginasActuales` navega primero a la pagina 1 y recien
  ahi mide `docsPorPagina`

### Modo mes de emitidos solo descargaba el primer dia (y tardaba mucho)
- **Causa 1** (verificada en vivo 2026-11): tras procesar el dia 1 la tabla
  queda en su ultima pagina. Pulsar Consultar con el paginador en una pagina
  distinta de la 1 hace que el SRI responda HTTP 500 / `ArithmeticException`
  y la vista JSF queda rota: todas las peticiones siguientes (incluso volver
  a la pagina 1) fallan hasta recargar. PrimeFaces no refleja el error en el
  DOM, asi que cada dia agotaba `TIMEOUT_PAGINA` (10 s) + `DELAY_PAGINA` y
  luego procesaba la tabla vieja (todo "omitido" por dedup).
- **Causa 2**: en emitidos el submit del formulario para el PDF (mojarra
  o click) responde 503, asi que cada PDF costaba 3 intentos x 5 s de
  timeout y terminaba fallido; el mismo POST por `fetch` funciona.
- **Solucion**: `asegurarPrimeraPaginaEmitidos` antes de cada consulta;
  hook de XHR que detecta errores JSF/HTTP y aborta con mensaje claro;
  verificacion de que la tabla muestra el dia consultado; PDF de emitidos
  via `descargarPorFetch`. Con esto 6 dias se consultan en ~1 s.
- Nota: la URL directa `recuperarComprobantes.jsf` SI funciona cuando la
  sesion de la app JSF ya fue inicializada (via accederAplicacion); solo
  rebota al login si no lo fue.

### La carpeta anio/mes de recibidos usaba la fecha de autorizacion
- **Causa**: `obtenerDatosPagina` tomaba `celdas[4]` como fecha de emision y
  `celdas[5]` como autorizacion (asi desde v1.0.0). Verificado en vivo
  (2026-09): el orden real es "Fecha y hora de autorizacion" (col 4) y
  "Fecha emision" (col 5), igual que en emitidos.
- **Solucion**: indices corregidos. Efecto: la carpeta `anio/mes` y las
  columnas de fecha del historial/CSV ahora son correctas; los registros
  previos del historial tienen ambas fechas intercambiadas (solo difiere en
  comprobantes autorizados en un mes distinto al de emision).

### Guardar la pestana Configuracion desactivaba la organizacion en carpetas
- **Causa**: `guardarConfig` del popup enviaba la config sin `ORGANIZACION` y el
  background reemplazaba `sriConfig` entero; al reiniciarse el service worker la
  organizacion volvia al default (deshabilitada). "Restaurar" hacia lo mismo.
- **Solucion**: el handler `guardarConfig` conserva la `ORGANIZACION` guardada
  cuando el mensaje no la trae; `resetConfig` ya no la envia.

### Cambio de pagina lento saltaba documentos en silencio
- **Causa**: tras el timeout de `esperarCambioPagina` el bucle seguia sin
  comprobar la pagina: reprocesaba la anterior (todo "omitido") y la ultima
  pagina real nunca se descargaba.
- **Solucion**: `irAPagina` confirma con el paginador que la tabla llego a la
  pagina esperada (hasta 3 intentos, el click solo se repite si el paginador
  sigue en la pagina anterior); si no, `procesarPaginasActuales` aborta con un
  error visible. Ademas cada pagina verifica `paginacion.actual === pag`.

### El historial podia dejar de guardarse sin aviso (limite de 10 MB)
- **Causa**: todo el historial vivia en la clave `historialDescargas` y cada
  pagina lo reescribia completo; al pasar la cuota el `set` fallaba en un catch
  vacio y la deduplicacion dejaba de funcionar.
- **Solucion**: una clave por sesion (`hs_<sesionId>`), permiso
  `unlimitedStorage`, y si guardar falla se agrega un aviso visible
  (`estadoDescarga.avisos`). `limpiarHistorialAntiguo` migra el formato anterior
  y `leerHistorial` entiende ambos.

### Avisos de sesion
- `estadoDescarga.avisos` (array de textos) no aborta la descarga: el popup los
  muestra en amarillo y persistentes, y van en la notificacion final. Usos:
  archivos de recibidos bajados por el metodo alternativo (fetch) e historial
  que no se pudo guardar.

### Service worker reiniciado a mitad de descarga
- `prepararSesion` deja la marca `sesionEnCurso` en `chrome.storage.session` y
  `finalizarSesion` la quita. Si al arrancar el service worker la marca sigue
  ahi, se notifica que la descarga se interrumpio (lo guardado por pagina ya
  esta en el historial y se omite al reiniciar).

## Permisos requeridos (manifest.json)
- `activeTab` - Acceso a la tab activa
- `scripting` - Ejecutar scripts en paginas
- `downloads` - Monitorear descargas + `onDeterminingFilename` para organizar archivos
- `storage` - Almacenamiento local para historial y configuracion
- `notifications` - Notificacion al finalizar descarga
- Host: `https://srienlinea.sri.gob.ec/*`

## Publicacion en la Chrome Web Store

### Que se sube
Un ZIP con SOLO los archivos de la extension (nunca el repo entero):
`manifest.json`, `background.js`, `config.js`, `content.js`, `iva.js`,
`iva.css`, `iva-categorias.js`, `popup.html`, `popup.js`, `popup.css` e `icons/`. Excluir: `docs/`, `dist/`, `README.md`,
`CLAUDE.md`, `.git`. Generar con el comando de empaquetar de "Comandos utiles";
queda en `dist/sri-downloader-vX.Y.Z.zip` (carpeta gitignored).

### Checklist antes de publicar
1. Subir la version en `manifest.json` (el footer del popup la lee del
   manifest; la Web Store exige version mayor a la publicada) y en la linea
   "Version" de este archivo
2. Verificar sintaxis de los JS (no hay Node instalado: servir el proyecto con
   `python -m http.server` y validar con `new Function(src)` en una pestana
   de Chrome; esprima de Python NO sirve, no soporta `?.` de ES2020)
3. Probar el ZIP: descomprimirlo aparte y cargarlo con "Cargar descomprimida"
4. Actualizar `docs/descripcion-webstore.md` si cambiaron las funcionalidades

### Pasos en el Developer Dashboard
1. chrome.google.com/webstore/devconsole > la extension
2. Paquete > "Subir nuevo paquete" > arrastrar el ZIP de `dist/`
3. Ficha del producto: descripcion desde `docs/descripcion-webstore.md`
4. Imagenes (todas en `docs/`, PNG 24 bits SIN alfa, generadas con datos
   ficticios — nunca subir capturas con datos de sesion reales):
   - Promocional pequena 440x280: `promo-pequena-440x280.png`
   - Marquesina 1400x560: `promo-marquesina-1400x560.png`
   - Capturas 1280x800 (max 5): `captura-1..5-*.png` (recibidos, emitidos mes,
     menu, historial, devolucion IVA)
5. Enviar para revision

### Justificacion de permisos (seccion de privacidad del dashboard)
El `host_permission` de `cel.sri.gob.ec` (agregado en v1.5.0; `celcer` se quito
en v1.7.0 porque ya no se consulta el ambiente de pruebas). Justificacion usada:
"Se usan para consultar el web service publico de autorizacion de comprobantes
del SRI (AutorizacionComprobantesOffline) y obtener el XML autorizado de los
comprobantes emitidos, que el portal no ofrece como descarga directa. Solo se
envia la clave de acceso del comprobante; no se transmiten datos a terceros."
`unlimitedStorage` (agregado en v1.7.0, no muestra advertencia al usuario).
Justificacion: "El historial local de descargas (usado para no volver a descargar
comprobantes) puede superar el limite de 10 MB de chrome.storage.local en
usuarios con muchos comprobantes; se guarda solo en el equipo del usuario."
Nota: los cambios de permisos alargan la revision (dias en vez de horas).

### Regenerar las imagenes promocionales
`python docs/mocks/generar.py` (requiere Chrome y Pillow). Renderiza con Chrome
headless el popup y el panel de IVA REALES sobre un portal simulado con datos
ficticios (RUC 1790012345001, "COMERCIAL EJEMPLO S.A."; nunca capturas de sesion
real) y deja en `docs/` los PNG en RGB 24 bits sin alfa, al tamano exacto.
- `docs/mocks/stage.html`: marco de navegador + portal ficticio + popup en iframe
  (`?scene=recibidos|emitidos|menu|historial|iva`)
- `docs/mocks/mock_chrome.js`: mock de `chrome.*` con los datos de cada escena
- `docs/mocks/iva_page.html`: pantalla de devolucion simulada con `iva.js` real
- `docs/mocks/promo.html`: marquesina y promocional pequena (`?tipo=`)
Si cambia la UI basta volver a ejecutar el script; si cambian los mensajes que
usa el popup (`obtenerEstado`, `obtenerHistorial`...) hay que ajustar el mock.

## Testing
1. Ir a srienlinea.sri.gob.ec
2. Verificar accesos directos SRI cuando no hay tabla (menu con submenus)
3. Click en "Descargar comprobantes" > "Facturas" - verificar que navega y setea dia="Todos" + tipo="Factura"
4. Ejecutar consulta para tener documentos en la tabla
5. Abrir popup - verificar que aparecen los 4 tabs y controles de descarga
6. Verificar que recuerda ultimo tipo de descarga
7. Probar "Descargar TODO" - verificar modal con estimado
8. Verificar progreso granular y estimacion de tiempo
9. Verificar badge en icono de extension
10. Cerrar popup y verificar que continua (ver logs del service worker)
11. Verificar que archivos se organizan en carpetas correctas (ruc/anio/mes/recibidos/tipo/)
12. Verificar notificacion Chrome al finalizar
13. Descargar XML, luego descargar PDF - verificar que no los omite
14. Reabrir popup y verificar historial en tab "Historial"
15. Probar filtros de historial (exitosos/fallidos)
16. Probar "Exportar" (genera CSV)
17. Probar "Reintentar fallidos"
18. Probar "Limpiar historial"
19. Tab Configuracion: cambiar tiempos, metodo descarga, reintentos
20. Tab Organizacion: cambiar orden carpetas, formato nombre, verificar preview
21. Cambiar config de organizacion con historial existente - verificar alerta
22. Verificar dark mode (cambiar tema del OS)
