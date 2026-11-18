/**
 * Descargador de Comprobantes SRI - Asistente de devolucion de IVA
 * (adultos mayores / personas con discapacidad). Portado de autofill_devolucioniva.
 *
 * Content script SIN interfaz propia: la interfaz vive en el popup de la
 * extension (seccion "Asistente devolucion IVA"), que lo controla por mensajes
 * y consulta su estado (ivaEstado). Aqui queda el trabajo sobre la pagina:
 * por cada factura de la tabla de devolucion marca el checkbox, rellena el
 * "IVA solicitado" con el IVA completo y asigna el tipo de gasto segun el
 * nombre comercial del emisor (categorias personalizadas primero, luego las
 * base de iva-categorias.js). El modo automatico recorre todas las paginas
 * y, si todas las facturas quedaron con tipo de gasto, pulsa "Procesar
 * facturas seleccionadas".
 *
 * Ademas aprende: cuando el usuario elige a mano el tipo de gasto de una
 * factura cuyo proveedor no tiene categoria, la guarda como categoria
 * personalizada (ver revisarSelecciones).
 *
 * Y busca los periodos pendientes: al llegar a la pantalla de anio/periodo
 * consulta periodo por periodo hasta dar con uno que todavia no se ha
 * procesado (ver buscarPeriodosPendientes).
 *
 * El proceso corre en la pagina y no depende de que el popup siga abierto.
 * Depende de config.js (SRI_CONFIG.IVA) e iva-categorias.js
 * (IVA_CATEGORIAS_BASE), cargados antes en el manifest.
 */

if (window.SRI_IVA_LOADED) {
  // Ya cargado, ignorar reinyeccion
} else {
  window.SRI_IVA_LOADED = true;

(() => {
  const CFG = SRI_CONFIG.IVA;
  const NOTIF_ID = 'sri-iva-notificacion';
  const STORAGE_KEY = 'ivaCategoriasCustom';
  const STORAGE_AUTO = 'ivaAutoProcesar';
  const STORAGE_BUSCAR = 'ivaAutoBuscar';
  /** Clave de sessionStorage con el avance de la busqueda de periodos */
  const SESSION_BUSQUEDA = 'sriIvaBusqueda';
  /** Una busqueda guardada mas vieja que esto se descarta (ms) */
  const VIGENCIA_BUSQUEDA = 60 * 60 * 1000;
  /** Lineas de log que se conservan para el popup */
  const MAX_LOG = 500;

  /** @type {Object<string, string>} nombre comercial (MAYUSCULAS) -> tipo de gasto */
  let categoriasCustom = {};
  /**
   * Si el modo automatico pulsa "Procesar facturas seleccionadas" al terminar
   * (envio al SRI). true por defecto; el usuario puede desactivarlo en el
   * popup para revisar antes de enviar.
   */
  let autoProcesar = true;
  /**
   * Si al llegar a la pantalla de anio/periodo se buscan solos los periodos
   * pendientes. true por defecto; se desactiva desde el popup.
   */
  let autoBuscar = true;
  /** Las preferencias ya se leyeron de storage (no auto-buscar antes de saberlo) */
  let preferenciasCargadas = false;
  /** Rellenando facturas (pagina o modo auto) */
  let autoRunning = false;
  /** Buscando periodos pendientes o abriendo uno */
  let buscando = false;
  let stopRequested = false;

  // Estado que consulta el popup (ivaEstado). El log se entrega de forma
  // incremental: logGen identifica el log actual (cambia al limpiarlo o al
  // recargar la pagina) y logBase cuenta las lineas ya descartadas por MAX_LOG
  /** @type {Array<{msg: string, cls: string}>} */
  let logLineas = [];
  let logGen = Date.now();
  let logBase = 0;
  /** @type {{msg: string, tipo: string}|null} Estado puesto por una accion; null = estado base */
  let statusAccion = null;

  // =====================================================
  // Storage
  // =====================================================

  function cargarPreferencias() {
    chrome.storage.local.get([STORAGE_KEY, STORAGE_AUTO, STORAGE_BUSCAR], (data) => {
      categoriasCustom = data?.[STORAGE_KEY] || {};
      autoProcesar = data?.[STORAGE_AUTO] !== false;
      autoBuscar = data?.[STORAGE_BUSCAR] !== false;
      preferenciasCargadas = true;
      revisarTabla();
    });
  }

  function guardarCategoriasCustom() {
    chrome.storage.local.set({ [STORAGE_KEY]: categoriasCustom });
  }

  // El popup edita las categorias y las casillas (envio y busqueda
  // automaticos) directamente en storage: mantener la copia en memoria al dia
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) categoriasCustom = changes[STORAGE_KEY].newValue || {};
    if (changes[STORAGE_AUTO]) autoProcesar = changes[STORAGE_AUTO].newValue !== false;
    if (changes[STORAGE_BUSCAR]) autoBuscar = changes[STORAGE_BUSCAR].newValue !== false;
  });

  // =====================================================
  // Utilidades
  // =====================================================

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(msg, cls = 'info') {
    logLineas.push({ msg, cls });
    if (logLineas.length > MAX_LOG) {
      const sobran = logLineas.length - MAX_LOG;
      logLineas.splice(0, sobran);
      logBase += sobran;
    }
  }

  function limpiarLog() {
    logLineas = [];
    logBase = 0;
    logGen++;
    statusAccion = null;
  }

  function getNombreCategoria(valor) {
    return CFG.TIPOS_GASTO[valor] || 'desconocido';
  }

  /** Mayusculas y sin tildes/dieresis, para comparar nombres comerciales */
  function normalizar(texto) {
    return String(texto).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  /**
   * true si el nombre comercial (ya normalizado) coincide con la clave.
   * - Claves de mas de 4 caracteres: basta con que el nombre las CONTENGA
   *   ("FARMACIA" coincide con "FARMACIAS" o "POLICLINICA" con "CLINICA").
   * - Claves cortas (hasta 4: "RM", "AKI", "KFC", "ZARA"...): deben aparecer
   *   como palabra completa. Con el simple "contiene", "RM" coincidia con
   *   cualquier nombre que tuviera esas letras ("HERMANOS", "TERMINAL") y lo
   *   clasificaba mal sin avisar.
   */
  function coincide(nombre, clave) {
    const c = normalizar(clave);
    if (!c) return false;
    if (c.length > 4) return nombre.includes(c);
    let desde = 0;
    for (;;) {
      const i = nombre.indexOf(c, desde);
      if (i === -1) return false;
      const antes = i === 0 ? '' : nombre[i - 1];
      const despues = nombre[i + c.length] || '';
      if (!/[A-Z0-9]/.test(antes) && !/[A-Z0-9]/.test(despues)) return true;
      desde = i + 1;
    }
  }

  /**
   * Busca el tipo de gasto del nombre comercial: primero en las categorias
   * personalizadas y luego en las base (ver coincide).
   * @returns {string|null} value del select de tipo de gasto o null
   */
  function detectarCategoria(nombreComercial) {
    const nombre = normalizar(nombreComercial);
    for (const fuente of [categoriasCustom, IVA_CATEGORIAS_BASE]) {
      for (const [clave, valor] of Object.entries(fuente)) {
        if (coincide(nombre, clave)) return valor;
      }
    }
    return null;
  }

  function getTbody() {
    return document.querySelector(CFG.TABLA_FACTURAS);
  }

  function getFilas() {
    const tbody = getTbody();
    return tbody ? Array.from(tbody.querySelectorAll('tr[data-ri]')) : [];
  }

  /** Texto de una celda de la tabla (el SRI lo pone dentro de un label) */
  function textoCelda(celda) {
    return (celda?.querySelector('label')?.textContent ?? celda?.textContent ?? '').trim();
  }

  function getNombreComercial(fila) {
    return textoCelda(fila.querySelectorAll('td')[CFG.COL_NOMBRE_COMERCIAL]);
  }

  /** Select del tipo de gasto de la fila: el oculto de PrimeFaces o uno nativo */
  function getSelectTipoGasto(fila) {
    return fila.querySelector(CFG.SELECT_TIPO_GASTO) ||
           fila.querySelector("select[id*='cmbTipoGasto']") ||
           fila.querySelector('select');
  }

  /**
   * Busca un elemento del paginador de la tabla de facturas (la pagina puede
   * tener otros paginadores); si no lo encuentra en la tabla, en el documento.
   */
  function getPaginador(selector) {
    const contenedor = getTbody()?.closest('.ui-datatable');
    return contenedor?.querySelector(selector) || document.querySelector(selector);
  }

  function hayPaginaSiguiente() {
    const btn = getPaginador('.ui-paginator-next');
    return !!btn && !btn.classList.contains('ui-state-disabled');
  }

  /**
   * Hace click en un boton del paginador y espera a que la tabla cambie:
   * marca la primera fila y espera a que desaparezca (PrimeFaces re-renderiza
   * las filas) o cambie el texto del paginador. Timeout 10 s.
   * @returns {Promise<boolean>} false si el boton no existe o esta deshabilitado
   */
  async function clickPaginadorYEsperar(selector) {
    const btn = getPaginador(selector);
    if (!btn || btn.classList.contains('ui-state-disabled')) return false;

    const filaVieja = getFilas()[0];
    if (filaVieja) filaVieja.dataset.sriIvaVieja = '1';
    const textoPaginador = getPaginador('.ui-paginator-current')?.textContent;

    btn.click();

    const limite = Date.now() + 10000;
    while (Date.now() < limite && !stopRequested) {
      await sleep(200);
      const primera = getFilas()[0];
      const textoActual = getPaginador('.ui-paginator-current')?.textContent;
      if ((primera && !primera.dataset.sriIvaVieja) || textoActual !== textoPaginador) break;
    }
    // Margen para que PrimeFaces termine de enlazar los componentes de las filas
    await sleep(1500);
    return true;
  }

  // =====================================================
  // Interaccion con las filas (PrimeFaces)
  // =====================================================

  async function clickCheckbox(fila) {
    const chkBox = fila.querySelector('.ui-chkbox-box');
    const input = fila.querySelector("input[type='checkbox']");
    if (!chkBox || !input) return false;
    if (input.checked) return true;
    chkBox.click();
    await sleep(800);
    // Al marcar la fila el SRI habilita por AJAX su "IVA solicitado" y su
    // tipo de gasto (verificado en vivo): esperar si el servidor va lento
    await esperarA(() => !fila.querySelector('.ui-selectonemenu.ui-state-disabled'), 3000);
    return true;
  }

  function rellenarIvaSolicitado(fila) {
    const celdas = fila.querySelectorAll('td');
    const montoIva = celdas[CFG.COL_MONTO_IVA]?.querySelector('label')?.textContent.trim();
    const inputIva = fila.querySelector(CFG.INPUT_IVA_SOLICITADO);
    if (!montoIva || !inputIva) return false;
    inputIva.value = montoIva;
    // Los eventos deben burbujear para que PrimeFaces los detecte
    for (const tipo of ['input', 'change', 'blur']) {
      inputIva.dispatchEvent(new Event(tipo, { bubbles: true }));
    }
    return true;
  }

  /**
   * Elige una opcion en un SelectOneMenu de PrimeFaces como lo haria el
   * usuario: abre el panel con el trigger y hace click en el item (asi
   * PrimeFaces dispara su propio "change" y los AJAX asociados). Verificado
   * en vivo con los menus de anio y periodo.
   * @param {HTMLSelectElement} select - select oculto (id terminado en _input)
   * @param {string} valor - value de la opcion
   * @returns {Promise<boolean>} false si no se encontro el menu o la opcion
   */
  async function elegirEnMenu(select, valor) {
    const baseId = select.id.replace(/_input$/, '');
    const menu = document.getElementById(baseId);
    if (!menu) return false;
    const idx = Array.from(select.options).findIndex(o => o.value === valor);
    if (idx < 0) return false;
    (menu.querySelector('.ui-selectonemenu-trigger') || menu).click();
    // PrimeFaces crea los <li> del panel recien al abrirlo por primera vez
    // (tras cada re-render AJAX el panel vuelve a estar vacio): esperar a
    // que esten todos antes de elegir
    let items = [];
    const limite = Date.now() + 2000;
    do {
      await sleep(250);
      items = document.getElementById(baseId + '_panel')?.querySelectorAll('li.ui-selectonemenu-item') || [];
    } while (items.length <= idx && Date.now() < limite);
    if (items.length <= idx) return false;
    items[idx].click();
    return true;
  }

  /**
   * Selecciona el tipo de gasto en el SelectOneMenu de PrimeFaces (ver
   * elegirEnMenu). Fallback: setea el select oculto + el label a mano.
   * Ultimo recurso: un <select> nativo de la fila.
   */
  async function seleccionarTipoGasto(fila, valor) {
    const selectInput = fila.querySelector(CFG.SELECT_TIPO_GASTO);
    if (selectInput) {
      const baseId = selectInput.id.replace(/_input$/, '');
      const menu = document.getElementById(baseId);
      if (menu) {
        if (await elegirEnMenu(selectInput, valor)) {
          await sleep(400);
          return true;
        }
        selectInput.value = valor;
        const labelEl = document.getElementById(baseId + '_label') ||
                        menu.querySelector('.ui-selectonemenu-label');
        const opt = Array.from(selectInput.options).find(o => o.value === valor);
        if (labelEl && opt) {
          labelEl.textContent = opt.textContent;
          labelEl.classList.remove('ui-selectonemenu-label-empty');
        }
        selectInput.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(200);
        return true;
      }
    }
    const nativo = fila.querySelector("select[id*='cmbTipoGasto']") || fila.querySelector('select');
    if (nativo) {
      nativo.value = valor;
      nativo.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(200);
      return true;
    }
    return false;
  }

  /** @returns {Promise<boolean>} true si la fila quedo completa */
  async function procesarFila(fila, index) {
    const celdas = fila.querySelectorAll('td');
    const nombreComercial = getNombreComercial(fila) || 'Desconocido';
    const montoIva = celdas[CFG.COL_MONTO_IVA]?.querySelector('label')?.textContent?.trim() || '0';
    log(`Fila ${index + 1}: ${nombreComercial.substring(0, 30)}...`);

    if (!await clickCheckbox(fila)) {
      log('  No se pudo seleccionar', 'warn');
      return false;
    }

    await sleep(300);
    if (rellenarIvaSolicitado(fila)) {
      log(`  IVA: $${montoIva}`, 'ok');
    }

    const categoria = detectarCategoria(nombreComercial);
    if (!categoria) {
      log(`  SIN CATEGORIA: "${nombreComercial}" - seleccione manualmente (se guardara para la proxima vez)`, 'warn');
      return false;
    }
    if (!await seleccionarTipoGasto(fila, categoria)) {
      log('  No se pudo asignar tipo de gasto', 'warn');
      return false;
    }
    log(`  Gasto: ${getNombreCategoria(categoria)}`, 'ok');
    return true;
  }

  /** @returns {Promise<{procesadas: number, incompletas: number}>} */
  async function procesarPaginaActual() {
    const filas = getFilas();
    if (filas.length === 0) {
      log('No se encontraron facturas en esta pagina', 'warn');
      return { procesadas: 0, incompletas: 0 };
    }
    log(`Procesando ${filas.length} facturas...`, 'info');
    let incompletas = 0;
    for (let i = 0; i < filas.length; i++) {
      if (stopRequested) {
        log('Detenido por el usuario', 'warn');
        return { procesadas: i, incompletas };
      }
      if (!await procesarFila(filas[i], i)) incompletas++;
      await sleep(200);
    }
    log(`Pagina completada: ${filas.length} facturas`, 'ok');
    return { procesadas: filas.length, incompletas };
  }

  async function clickProcesar() {
    const btn = document.querySelector(CFG.BTN_PROCESAR);
    if (!btn) {
      log('No se encontro el boton de procesar', 'warn');
      return false;
    }
    log('Procesando facturas seleccionadas...', 'info');
    setStatus('Enviando...', 'working');
    btn.click();
    await sleep(5000);
    const errores = document.querySelectorAll('.ui-messages-error-detail, .ui-message-error-detail');
    if (errores.length > 0) {
      log(`Error: ${errores[0].textContent.trim()}`, 'warn');
      mostrarNotificacion('Error al procesar facturas', 'error');
      setStatus('Error - Revise los mensajes', 'warn');
      return false;
    }
    log('Facturas procesadas correctamente', 'done');
    mostrarNotificacion('Facturas procesadas correctamente', 'ok');
    setStatus('Procesado correctamente', 'done');
    return true;
  }

  /**
   * Cierra un proceso (pagina o modo auto): deja registrados los tipos de
   * gasto que puso el asistente ANTES de bajar autoRunning, para que
   * revisarSelecciones no los tome despues por elecciones del usuario.
   */
  function terminarProceso() {
    revisarSelecciones();
    autoRunning = false;
    stopRequested = false;
  }

  /** Rellena solo la pagina visible de la tabla (no envia nada al SRI) */
  async function rellenarPagina() {
    if (autoRunning || buscando) return;
    autoRunning = true;
    stopRequested = false;
    setStatus('Procesando pagina...', 'working');
    try {
      const r = await procesarPaginaActual();
      if (stopRequested) {
        setStatus('Detenido por el usuario', 'warn');
      } else if (r.incompletas > 0) {
        setStatus(`${r.incompletas} factura(s) sin categoria`, 'warn');
        mostrarNotificacion(`${r.incompletas} factura(s) sin tipo de gasto. Complete manualmente.`, 'error');
      } else {
        setStatus('Pagina lista - Revise', 'done');
      }
    } catch (e) {
      log(`Error inesperado: ${e.message}`, 'warn');
      setStatus('Error inesperado', 'warn');
    } finally {
      terminarProceso();
    }
  }

  function siguientePagina() {
    if (autoRunning || buscando) return;
    if (hayPaginaSiguiente()) {
      getPaginador('.ui-paginator-next').click();
      log('Avanzando a siguiente pagina...', 'info');
    } else {
      log('No hay mas paginas', 'warn');
    }
  }

  async function procesarTodasLasPaginas() {
    if (autoRunning || buscando) return;
    autoRunning = true;
    stopRequested = false;
    let pagina = 1;
    let totalFacturas = 0;
    let totalIncompletas = 0;
    setStatus('Procesando...', 'working');

    try {
      // Siempre empezar desde la primera pagina
      await clickPaginadorYEsperar('.ui-paginator-first');

      while (!stopRequested) {
        log(`--- Pagina ${pagina} ---`, 'info');
        setStatus(`Procesando pagina ${pagina}...`, 'working');
        const r = await procesarPaginaActual();
        totalFacturas += r.procesadas;
        totalIncompletas += r.incompletas;
        if (stopRequested || !hayPaginaSiguiente()) break;
        log('Avanzando a siguiente pagina...', 'info');
        await clickPaginadorYEsperar('.ui-paginator-next');
        pagina++;
      }

      if (stopRequested) {
        setStatus('Detenido por el usuario', 'warn');
      } else {
        log('=== TERMINADO ===', 'done');
        log(`Total: ${totalFacturas} facturas, ${totalIncompletas} sin categoria`, 'done');
        if (totalIncompletas > 0) {
          log(`Complete ${totalIncompletas} factura(s) manualmente antes de procesar`, 'warn');
          mostrarNotificacion(`${totalIncompletas} factura(s) sin tipo de gasto. Complete manualmente antes de procesar.`, 'error');
          setStatus(`${totalIncompletas} factura(s) pendientes`, 'warn');
        } else if (totalFacturas > 0 && !autoProcesar) {
          // El usuario prefiere revisar y pulsar "Procesar" el mismo
          log('Facturas listas. Revise y pulse "Procesar facturas seleccionadas".', 'done');
          mostrarNotificacion('Facturas listas. Revise y pulse "Procesar facturas seleccionadas".', 'ok');
          setStatus('Listo para procesar - Revise', 'done');
        } else if (totalFacturas > 0) {
          await clickProcesar();
        } else {
          setStatus('No se encontraron facturas', 'warn');
        }
      }
    } catch (e) {
      log(`Error inesperado: ${e.message}`, 'warn');
      setStatus('Error inesperado', 'warn');
    } finally {
      terminarProceso();
    }
  }

  // =====================================================
  // Aprendizaje de categorias (eleccion manual del usuario)
  // =====================================================

  /**
   * Ultimo tipo de gasto visto por fila. La clave es estable aunque
   * PrimeFaces re-renderice la fila (id JSF del select + nombre + IVA).
   * @type {Map<string, string>}
   */
  const tiposVistos = new Map();

  function claveFila(fila, select) {
    const celdas = fila.querySelectorAll('td');
    return [select.id || fila.dataset.ri, getNombreComercial(fila), textoCelda(celdas[CFG.COL_MONTO_IVA])].join('|');
  }

  /**
   * Compara el tipo de gasto de cada fila con el ultimo visto. Un cambio que
   * no hizo el asistente (autoRunning) es una eleccion manual del usuario y
   * se pasa a aprenderCategoria.
   *
   * Se detecta comparando valores y no con el evento "change" porque
   * PrimeFaces lo dispara con jQuery (.trigger), que no llega a los listeners
   * nativos de un content script. La primera vez que se ve una fila solo se
   * anota su valor (puede venir ya rellenada por el SRI).
   */
  function revisarSelecciones() {
    for (const fila of getFilas()) {
      const select = getSelectTipoGasto(fila);
      if (!select) continue;
      const clave = claveFila(fila, select);
      const actual = select.value;
      const previo = tiposVistos.get(clave);
      if (previo === actual) continue;
      tiposVistos.set(clave, actual);
      if (previo === undefined || autoRunning) continue;
      aprenderCategoria(getNombreComercial(fila), actual);
    }
  }

  /**
   * Guarda como categoria personalizada el tipo de gasto que el usuario
   * eligio a mano, para que la proxima vez ese proveedor se rellene solo.
   * - Proveedor sin categoria: se registra con su nombre comercial completo.
   * - Proveedor que ya se registro con ese mismo nombre: se actualiza (el
   *   usuario corrigio su eleccion).
   * - Proveedor cubierto por otra categoria (base o personalizada parcial):
   *   no se toca; una eleccion puntual distinta no cambia la regla general.
   */
  function aprenderCategoria(nombreComercial, valor) {
    if (!CFG.TIPOS_GASTO[valor]) return;
    const clave = nombreComercial.trim().toUpperCase();
    if (!clave) return;
    const existente = categoriasCustom[clave];
    if (existente === valor) return;
    if (existente === undefined && detectarCategoria(nombreComercial)) return;

    categoriasCustom[clave] = valor;
    guardarCategoriasCustom();
    const accion = existente === undefined ? 'guardada' : 'actualizada';
    log(`Categoria ${accion}: ${clave} -> ${getNombreCategoria(valor)}`, 'ok');
    mostrarNotificacion(`Categoria ${accion}: ${clave} → ${getNombreCategoria(valor)}`, 'mini');
  }

  // =====================================================
  // Busqueda de periodos pendientes
  // =====================================================
  // Pantalla "Facturas electronicas" (anio + periodo + Buscar). Verificado en
  // vivo (2026-11, discapacidad):
  // - Elegir el anio recarga el panel por AJAX (selects nuevos) y llena los
  //   periodos de ese anio.
  // - Buscar (AJAX, ~0.3 s) muestra la tabla de facturas si el periodo esta
  //   pendiente, o la pantalla "No se puede continuar con la carga de
  //   informacion" con el motivo ("Ya esta en tramite un proceso de devolucion
  //   de IVA por el periodo solicitado..." / "Para el periodo X no se
  //   encontraron facturas...") y el boton "Volver a intentar".
  // - "Volver a intentar" RECARGA la pagina (vuelve a anio/periodo conservando
  //   la seleccion) y este script se reinicia: por eso el avance vive en
  //   sessionStorage y la busqueda se reanuda sola al cargar.

  /**
   * Avance de la busqueda (persistido en sessionStorage, por pestana).
   * @type {{usuario: string, ts: number, activa: boolean, detenida: boolean,
   *   completa: boolean, todos: boolean, hayMasAnios: boolean,
   *   anios: string[], aniosCompletos: string[], abierto: string|null,
   *   resultados: Object<string, {anio: string, periodo: string, nombre: string,
   *     estado: 'tramite'|'sinFacturas'|'pendiente'|'otro', msg: string}>}|null}
   */
  let busqueda = leerBusqueda();

  function getUsuario() {
    return document.querySelector(SRI_CONFIG.SELECTORES.RUC_USUARIO)?.textContent.trim() || '';
  }

  /** Busqueda guardada, si es de este usuario y reciente; si no, null */
  function leerBusqueda() {
    try {
      const b = JSON.parse(sessionStorage.getItem(SESSION_BUSQUEDA));
      if (b && b.usuario === getUsuario() && Date.now() - b.ts < VIGENCIA_BUSQUEDA) return b;
    } catch (e) { /* sin acceso a sessionStorage o JSON invalido */ }
    return null;
  }

  function guardarBusqueda() {
    try {
      busqueda.ts = Date.now();
      sessionStorage.setItem(SESSION_BUSQUEDA, JSON.stringify(busqueda));
    } catch (e) { /* sin sessionStorage la busqueda no sobrevive a la recarga */ }
  }

  function nuevaBusqueda(todos) {
    busqueda = {
      usuario: getUsuario(), ts: Date.now(), activa: true, detenida: false, completa: false,
      todos, hayMasAnios: false, anios: [], aniosCompletos: [], abierto: null, resultados: {}
    };
    guardarBusqueda();
  }

  function visible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight);
  }

  function botonPorTexto(raiz, patron) {
    return Array.from((raiz || document).querySelectorAll('button'))
      .find(b => visible(b) && patron.test(b.textContent)) || null;
  }

  /**
   * Selectores de anio/periodo y boton Buscar. OJO: siguen en pantalla
   * cuando debajo esta la tabla de facturas de un periodo (misma pantalla);
   * para "solo periodos, sin tabla" usar enSoloPeriodos.
   * @returns {{anio: HTMLSelectElement, periodo: HTMLSelectElement, buscar: HTMLElement}|null}
   */
  function getPantallaPeriodos() {
    const anio = document.querySelector(CFG.SELECT_ANIO);
    const periodo = document.querySelector(CFG.SELECT_PERIODO);
    if (!anio || !periodo) return null;
    const buscar = document.querySelector(CFG.BTN_BUSCAR) || botonPorTexto(anio.closest('form'), /^\s*buscar\s*$/i);
    return visible(buscar) ? { anio, periodo, buscar } : null;
  }

  /** Pantalla de anio/periodo SIN tabla de facturas (aun no se abrio un periodo) */
  function enSoloPeriodos() {
    return !getTbody() && !!getPantallaPeriodos();
  }

  /** Boton "Volver a intentar" de la pantalla de error del SRI, si esta a la vista */
  function getBotonVolverError() {
    const porId = document.querySelector(CFG.BTN_VOLVER_ERROR);
    return visible(porId) ? porId : botonPorTexto(document, /volver a intentar/i);
  }

  function getMensajeSri() {
    return Array.from(document.querySelectorAll('.ui-messages-error-summary, .ui-messages-error-detail, .ui-messages-warn-summary, .ui-messages-info-summary'))
      .filter(visible).map(e => e.textContent.trim()).filter(Boolean).join(' ');
  }

  /** Espera (sondeando) a que cond() devuelva algo; null si se agota el tiempo */
  async function esperarA(cond, timeout) {
    const limite = Date.now() + timeout;
    for (;;) {
      const r = cond();
      if (r) return r;
      if (Date.now() >= limite) return null;
      await sleep(200);
    }
  }

  /**
   * Deja elegido el anio en la pantalla de periodos y espera a que el SRI
   * recargue el panel con los periodos de ese anio.
   * @returns {Promise<boolean>}
   */
  async function seleccionarAnio(anio) {
    const pantalla = getPantallaPeriodos();
    if (!pantalla) return false;
    if (pantalla.anio.value === anio) return pantalla.periodo.options.length > 1;

    // Esperar a que el AJAX REEMPLACE el select de periodos: PrimeFaces pone
    // el anio en el select viejo al instante, antes de que llegue la respuesta
    const viejo = pantalla.periodo;
    if (!await elegirEnMenu(pantalla.anio, anio)) return false;
    return !!await esperarA(() => {
      const p = getPantallaPeriodos();
      return p && p.periodo !== viejo && p.anio.value === anio && p.periodo.options.length > 1;
    }, 8000);
  }

  /**
   * Consulta un periodo (elige anio y periodo, pulsa Buscar) y clasifica la
   * respuesta del SRI. Si el periodo esta pendiente la tabla de facturas
   * queda en pantalla.
   * @returns {Promise<{estado: 'tramite'|'sinFacturas'|'pendiente'|'otro'|'fallo', msg: string}>}
   *   'otro' = pantalla de error con un motivo no reconocido; 'fallo' = no se
   *   pudo consultar (no llega al SRI o no responde)
   */
  async function consultarPeriodo(anio, periodo) {
    if (!await seleccionarAnio(anio)) return { estado: 'fallo', msg: `No se pudo elegir el anio ${anio}` };
    let pantalla = getPantallaPeriodos();
    if (pantalla.periodo.value !== periodo) {
      if (!await elegirEnMenu(pantalla.periodo, periodo)) return { estado: 'fallo', msg: `No se pudo elegir el periodo ${periodo}` };
      await sleep(600);
    }
    pantalla = getPantallaPeriodos();
    if (!pantalla || pantalla.anio.value !== anio || pantalla.periodo.value !== periodo) {
      return { estado: 'fallo', msg: 'La pantalla no quedo en el periodo pedido' };
    }

    // Si ya habia una tabla (de otro periodo) en pantalla, la respuesta es
    // una tabla NUEVA: el AJAX reemplaza el tbody
    const tbodyViejo = getTbody();
    pantalla.buscar.click();
    const respuesta = await esperarA(() => {
      const tbody = getTbody();
      if (tbody && tbody !== tbodyViejo) return { estado: 'pendiente', msg: '' };
      if (getBotonVolverError()) return { estado: 'error', msg: getMensajeSri() };
      // Mensaje sin salir de la pantalla de periodos (validacion del SRI)
      const msg = getPantallaPeriodos() && getMensajeSri();
      return msg ? { estado: 'fallo', msg } : null;
    }, 15000);

    if (!respuesta) return { estado: 'fallo', msg: 'El SRI no respondio a la consulta' };
    if (respuesta.estado !== 'error') return respuesta;
    const msg = normalizar(respuesta.msg);
    if (msg.includes('EN TRAMITE')) return { estado: 'tramite', msg: respuesta.msg };
    if (msg.includes('NO SE ENCONTRARON FACTURAS')) return { estado: 'sinFacturas', msg: respuesta.msg };
    return { estado: 'otro', msg: respuesta.msg || 'El SRI no permitio continuar' };
  }

  /**
   * Siguiente periodo sin consultar: empieza por el anio mas reciente y,
   * dentro de cada anio, va de enero en adelante (las devoluciones se
   * presentan en orden); luego sigue con el anio anterior. Los periodos de
   * un anio solo se conocen al elegirlo, asi que puede cambiar el anio en
   * pantalla. Sin `todos` se limita a los CFG.ANIOS_BUSQUEDA anios mas
   * recientes.
   * @returns {Promise<{anio: string, periodo: string, nombre: string}|null|false>}
   *   null = no queda ninguno; false = no se pudo leer la pantalla
   */
  async function siguientePeriodo() {
    const pantalla = getPantallaPeriodos();
    if (!pantalla) return false;
    const anios = Array.from(pantalla.anio.options).map(o => o.value).filter(Boolean)
      .sort((a, b) => Number(b) - Number(a));
    busqueda.anios = busqueda.todos ? anios : anios.slice(0, CFG.ANIOS_BUSQUEDA);
    busqueda.hayMasAnios = busqueda.anios.length < anios.length;

    for (const anio of busqueda.anios) {
      if (busqueda.aniosCompletos.includes(anio)) continue;
      if (!await seleccionarAnio(anio)) return false;
      const libre = Array.from(getPantallaPeriodos().periodo.options)
        .filter(o => o.value)
        .sort((a, b) => Number(a.value) - Number(b.value))
        .find(o => !busqueda.resultados[`${anio}-${o.value}`]);
      if (libre) return { anio, periodo: libre.value, nombre: `${libre.textContent.trim()} ${anio}` };
      busqueda.aniosCompletos.push(anio);
      guardarBusqueda();
    }
    return null;
  }

  function contarResultados(estado) {
    return Object.values(busqueda?.resultados || {}).filter(r => r.estado === estado).length;
  }

  /** Cierra la busqueda en curso (queda guardada para el popup) */
  function terminarBusqueda(msg, tipo, cambios = {}) {
    Object.assign(busqueda, { activa: false }, cambios);
    guardarBusqueda();
    setStatus(msg, tipo);
    log(msg, tipo === 'done' ? 'done' : 'warn');
    mostrarNotificacion(msg, 'mini', 7000);
  }

  /**
   * Recorre los periodos (desde enero del anio mas reciente) hasta encontrar
   * uno pendiente: ahi se detiene con la tabla de facturas en pantalla,
   * lista para rellenar. Los que estan en tramite o sin facturas se anotan y
   * se sigue con el siguiente.
   *
   * Requiere busqueda.activa; se llama al iniciarla y cada vez que la pagina
   * vuelve a la pantalla de periodos (ver revisarPeriodos). Si el usuario
   * regresa a esa pantalla tras un periodo pendiente, primero se vuelve a
   * consultar ESE periodo una vez (si ya lo proceso pasa a "en tramite").
   */
  async function buscarPeriodosPendientes() {
    if (buscando || autoRunning || !busqueda?.activa) return;
    buscando = true;
    stopRequested = false;
    try {
      for (;;) {
        if (stopRequested || !busqueda.activa) {
          terminarBusqueda('Busqueda de periodos detenida', 'warn', { detenida: true });
          return;
        }
        // Las interrupciones quedan como "detenida": sin eso revisarPeriodos
        // la reanudaria sola y reintentaria lo mismo sin fin
        if (!await esperarA(getPantallaPeriodos, 10000)) {
          terminarBusqueda('La busqueda de periodos se interrumpio: no esta la pantalla de anio y periodo', 'warn', { detenida: true });
          return;
        }

        // Periodo pendiente que quedo abierto: comprobar (una sola vez) si ya
        // se proceso. Si sigue pendiente su tabla vuelve a quedar en pantalla;
        // la proxima vez se sigue de largo con los periodos anteriores
        const abierto = busqueda.abierto && busqueda.resultados[busqueda.abierto];
        busqueda.abierto = null;
        const reverificar = !!abierto && !abierto.reverificado;
        const sig = reverificar ? abierto : await siguientePeriodo();
        if (sig === false) {
          terminarBusqueda('La busqueda de periodos se interrumpio: no se pudo leer la pantalla', 'warn', { detenida: true });
          return;
        }
        if (!sig) {
          const pendientes = Object.values(busqueda.resultados).filter(r => r.estado === 'pendiente');
          const alcance = busqueda.anios.join(', ');
          terminarBusqueda(pendientes.length > 0
            ? `Periodos pendientes (${alcance}): ${pendientes.map(r => r.nombre).join(', ')}`
            : `No hay periodos pendientes en ${alcance} (${contarResultados('tramite')} en tramite, ${contarResultados('sinFacturas')} sin facturas)`,
          'done', { completa: true });
          return;
        }

        const progreso = `Buscando periodos pendientes: ${sig.nombre}...`;
        setStatus(progreso, 'working');
        mostrarNotificacion(`${progreso} (abra la extension para detener)`, 'mini', 0);

        const r = await consultarPeriodo(sig.anio, sig.periodo);
        if (r.estado === 'fallo') {
          terminarBusqueda(`La busqueda de periodos se interrumpio en ${sig.nombre}: ${r.msg}`, 'warn', { detenida: true });
          return;
        }
        const clave = `${sig.anio}-${sig.periodo}`;
        busqueda.resultados[clave] = {
          anio: sig.anio, periodo: sig.periodo, nombre: sig.nombre, estado: r.estado, msg: r.msg,
          reverificado: reverificar || undefined
        };
        if (r.estado === 'pendiente') {
          avisoTablaMostrado = true;
          terminarBusqueda(`Periodo pendiente: ${sig.nombre}. Abra la extension para rellenar las facturas.`, 'done', { abierto: clave });
          pedirPopup();
          return;
        }
        // En tramite, sin facturas u otro motivo: guardar ANTES de volver
        // (la pagina se recarga y este script se reinicia)
        guardarBusqueda();
        getBotonVolverError()?.click();
        // Normalmente no se llega mas alla: tras la recarga, revisarPeriodos
        // reanuda. Si el SRI volviera sin recargar, el bucle sigue aqui
        await esperarA(() => !getBotonVolverError(), 10000);
      }
    } catch (e) {
      terminarBusqueda(`Error inesperado en la busqueda de periodos: ${e.message}`, 'warn', { detenida: true });
    } finally {
      buscando = false;
      stopRequested = false;
    }
  }

  /**
   * Inicia la busqueda desde el popup.
   * @param {boolean} todos - false: busqueda nueva en los anios recientes;
   *   true: sigue la actual incluyendo todos los anios que ofrece el SRI
   */
  function iniciarBusquedaPeriodos(todos) {
    if (buscando || autoRunning) return;
    if (!getPantallaPeriodos()) {
      log('Para buscar periodos vaya a la pantalla de anio y periodo (Ingresar facturas electronicas)', 'warn');
      return;
    }
    if (todos && busqueda) {
      Object.assign(busqueda, { activa: true, detenida: false, completa: false, todos: true, abierto: null });
      guardarBusqueda();
    } else {
      nuevaBusqueda(todos);
    }
    buscarPeriodosPendientes();
  }

  /** Abre desde el popup un periodo de la lista (deja su tabla en pantalla) */
  async function abrirPeriodo(anio, periodo) {
    if (buscando || autoRunning) return;
    if (!getPantallaPeriodos()) {
      log('Para abrir un periodo vaya a la pantalla de anio y periodo (Ingresar facturas electronicas)', 'warn');
      return;
    }
    buscando = true;
    try {
      const clave = `${anio}-${periodo}`;
      const nombre = busqueda?.resultados[clave]?.nombre || `${periodo}/${anio}`;
      setStatus(`Abriendo ${nombre}...`, 'working');
      const r = await consultarPeriodo(String(anio), String(periodo));
      if (r.estado === 'pendiente') {
        setStatus(`Facturas de ${nombre} en pantalla`, 'done');
        if (busqueda) busqueda.abierto = clave;
      } else {
        setStatus(`${nombre}: ${r.msg || 'no se pudo abrir'}`, 'warn');
        log(`${nombre}: ${r.msg || 'no se pudo abrir'}`, 'warn');
      }
      if (busqueda?.resultados[clave] && r.estado !== 'fallo') {
        Object.assign(busqueda.resultados[clave], { estado: r.estado, msg: r.msg });
      }
      if (busqueda) guardarBusqueda();
    } catch (e) {
      setStatus('Error inesperado', 'warn');
      log(`Error inesperado: ${e.message}`, 'warn');
    } finally {
      buscando = false;
    }
  }

  /**
   * Al aparecer la pantalla de anio/periodo: reanuda la busqueda en curso
   * (venimos de la recarga de "Volver a intentar") o, con la busqueda
   * automatica activada, la inicia o la continua. No hace nada si el usuario
   * la detuvo o si ya termino: desde ahi manda el popup.
   */
  function revisarPeriodos() {
    // Con la tabla de un periodo en pantalla no se busca solo: cambiar de
    // periodo descartaria lo que el usuario lleva seleccionado
    if (buscando || autoRunning || !enSoloPeriodos()) return;
    if (busqueda?.activa) {
      buscarPeriodosPendientes();
      return;
    }
    if (!preferenciasCargadas) return;
    const terminada = !!busqueda && (busqueda.detenida || busqueda.completa);
    // El popup se abre solo al llegar a la pantalla (una vez por carga de
    // pagina), listo para buscar o ya buscando
    if (!terminada && !popupPedido) {
      popupPedido = true;
      pedirPopup();
    }
    if (!autoBuscar || terminada) return;
    if (!busqueda) {
      nuevaBusqueda(false);
    } else {
      busqueda.activa = true;
      guardarBusqueda();
    }
    buscarPeriodosPendientes();
  }

  let popupPedido = false;

  /**
   * Pide al background que abra el popup de la extension sobre esta pestana
   * (chrome.action.openPopup, Chrome 127+). Si no se puede (navegador
   * antiguo, ventana sin foco, popup ya abierto) no pasa nada: los avisos
   * de la pagina indican que hay que abrir la extension.
   */
  function pedirPopup() {
    try {
      chrome.runtime.sendMessage?.({ action: 'ivaAbrirPopup' }, () => void chrome.runtime.lastError);
    } catch (e) { /* extension recargada: el script quedo huerfano */ }
  }

  // Respaldo de la revision por mutaciones del DOM: tras una interaccion
  // real del usuario (click en el item del menu, teclado, select nativo)
  let revisionSeleccion = null;
  function programarRevisionSelecciones(e) {
    if (!e.isTrusted || revisionSeleccion) return;
    revisionSeleccion = setTimeout(() => {
      revisionSeleccion = null;
      revisarSelecciones();
    }, 400);
  }
  for (const tipo of ['click', 'keyup', 'change']) {
    document.addEventListener(tipo, programarRevisionSelecciones, true);
  }

  // =====================================================
  // Avisos en la pagina y estado para el popup
  // =====================================================

  /**
   * Aviso flotante en la pagina (lo unico que el asistente dibuja en ella).
   * @param {string} mensaje
   * @param {'ok'|'error'|'mini'} tipo - ok/error: centrado, para el resultado
   *   de un proceso; mini: discreto, abajo (categoria guardada, sugerencias,
   *   avance de la busqueda de periodos)
   * @param {number} [duracion] - ms a la vista; 0 = hasta el siguiente aviso
   */
  function mostrarNotificacion(mensaje, tipo = 'ok', duracion = tipo === 'mini' ? 4000 : 5000) {
    document.getElementById(NOTIF_ID)?.remove();
    const notif = document.createElement('div');
    notif.id = NOTIF_ID;
    notif.className = `sri-iva-notif-${tipo}`;
    notif.textContent = mensaje;
    document.body.appendChild(notif);
    if (duracion > 0) setTimeout(() => notif.remove(), duracion);
  }

  /** Estado puesto por una accion (tiene prioridad sobre el estado base) */
  function setStatus(msg, tipo) {
    statusAccion = { msg, tipo };
  }

  /**
   * Estado completo para el popup. El log va desde la linea que el popup ya
   * tiene (request.logDesde) si sigue siendo el mismo log (request.logGen).
   */
  function estadoParaPopup(request) {
    const hayTabla = !!getTbody();
    const enPeriodos = !!getPantallaPeriodos();
    const total = logBase + logLineas.length;
    const pedido = request.logGen === logGen ? (Number(request.logDesde) || 0) : 0;
    const desde = Math.min(Math.max(pedido, logBase), total);
    let base = { msg: 'Consulte las facturas del periodo para comenzar', tipo: 'warn' };
    if (hayTabla) base = { msg: 'Listo', tipo: 'done' };
    else if (enPeriodos) base = { msg: 'Elija el periodo o busque los pendientes', tipo: 'done' };
    return {
      hayTabla,
      enPeriodos,
      procesando: autoRunning || buscando,
      hayPaginaSiguiente: hayPaginaSiguiente(),
      status: statusAccion || base,
      // Busqueda de periodos pendientes (null si no se ha buscado), con los
      // periodos consultados en el orden en que se recorren
      busqueda: busqueda && {
        activa: busqueda.activa,
        completa: busqueda.completa,
        hayMasAnios: busqueda.hayMasAnios,
        anios: busqueda.anios,
        resultados: Object.values(busqueda.resultados)
          .sort((a, b) => (Number(b.anio) - Number(a.anio)) || (Number(a.periodo) - Number(b.periodo)))
      },
      logGen,
      logDesde: desde,
      logTotal: total,
      log: logLineas.slice(desde - logBase)
    };
  }

  // =====================================================
  // Deteccion de la tabla de facturas
  // =====================================================

  let avisoTablaMostrado = false;

  /**
   * Cuando aparece la tabla de facturas (la consulta del SRI es AJAX, no
   * recarga la pagina) avisa una vez que el asistente esta disponible en la
   * extension, y revisa los tipos de gasto de las filas. En la pantalla de
   * anio/periodo arranca o reanuda la busqueda de pendientes. Debounce para
   * no recorrer el DOM en cada mutacion.
   */
  function revisarTabla() {
    if (getTbody() && !avisoTablaMostrado) {
      avisoTablaMostrado = true;
      mostrarNotificacion('Facturas detectadas: abra la extension para usar el asistente de devolucion de IVA', 'mini');
    }
    revisarSelecciones();
    revisarPeriodos();
  }

  let revisionPendiente = null;
  const observer = new MutationObserver(() => {
    if (revisionPendiente) return;
    revisionPendiente = setTimeout(() => {
      revisionPendiente = null;
      revisarTabla();
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // =====================================================
  // Mensajes del popup
  // =====================================================

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'ivaEstado':
        break;
      case 'ivaRellenarPagina':
        rellenarPagina();
        break;
      case 'ivaSiguientePagina':
        siguientePagina();
        break;
      case 'ivaAuto':
        procesarTodasLasPaginas();
        break;
      case 'ivaDetener':
        if (autoRunning || buscando) {
          stopRequested = true;
          log('Deteniendo...', 'warn');
        }
        // La busqueda se marca detenida tambien en sessionStorage: si la
        // pagina se esta recargando, la siguiente carga no la reanuda
        if (busqueda?.activa) {
          Object.assign(busqueda, { activa: false, detenida: true });
          guardarBusqueda();
        }
        break;
      case 'ivaLimpiarLog':
        // Durante un proceso el estado "Procesando..." debe seguir visible
        if (!autoRunning && !buscando) limpiarLog();
        break;
      case 'ivaBuscarPeriodos':
        iniciarBusquedaPeriodos(request.todos === true);
        break;
      case 'ivaAbrirPeriodo':
        abrirPeriodo(request.anio, request.periodo);
        break;
      default:
        // Otras acciones son de content.js: no responder
        return false;
    }
    // Todas las acciones del asistente responden con el estado actualizado
    sendResponse(estadoParaPopup(request));
    return false;
  });

  cargarPreferencias();
  revisarTabla();
})();

} // Fin del bloque if (!window.SRI_IVA_LOADED)
