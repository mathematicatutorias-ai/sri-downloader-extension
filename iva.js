/**
 * Descargador de Comprobantes SRI - Asistente de devolucion de IVA
 * (personas con discapacidad). Portado de autofill_devolucioniva.
 *
 * Content script que inyecta un panel flotante en la pagina del SRI y, por
 * cada factura de la tabla de devolucion: marca el checkbox, rellena el
 * "IVA solicitado" con el IVA completo y asigna el tipo de gasto segun el
 * nombre comercial del emisor (categorias personalizadas primero, luego las
 * base de iva-categorias.js). El modo automatico recorre todas las paginas
 * y, si todas las facturas quedaron con tipo de gasto, pulsa "Procesar
 * facturas seleccionadas".
 *
 * El panel se abre solo cuando aparece la tabla de facturas en la pagina, o
 * desde el popup (mensaje 'ivaAbrirPanel'). Depende de config.js (SRI_CONFIG.IVA)
 * e iva-categorias.js (IVA_CATEGORIAS_BASE), cargados antes en el manifest.
 */

if (window.SRI_IVA_LOADED) {
  // Ya cargado, ignorar reinyeccion
} else {
  window.SRI_IVA_LOADED = true;

(() => {
  const CFG = SRI_CONFIG.IVA;
  const PANEL_ID = 'sri-iva-panel';
  const STORAGE_KEY = 'ivaCategoriasCustom';
  const STORAGE_AUTO = 'ivaAutoProcesar';

  /** @type {Object<string, string>} nombre comercial (MAYUSCULAS) -> tipo de gasto */
  let categoriasCustom = {};
  /**
   * Si el modo automatico pulsa "Procesar facturas seleccionadas" al terminar
   * (envio al SRI). true por defecto; el usuario puede desactivarlo en el
   * panel para revisar antes de enviar.
   */
  let autoProcesar = true;
  let autoRunning = false;
  let stopRequested = false;
  /** El usuario cerro el panel en esta pagina: no reabrirlo solo */
  let cerradoPorUsuario = false;

  // =====================================================
  // Storage
  // =====================================================

  function cargarCategoriasCustom() {
    chrome.storage.local.get([STORAGE_KEY, STORAGE_AUTO], (data) => {
      categoriasCustom = data?.[STORAGE_KEY] || {};
      autoProcesar = data?.[STORAGE_AUTO] !== false;
      const chk = $('sri-iva-auto-procesar');
      if (chk) chk.checked = autoProcesar;
      renderListaCustom();
    });
  }

  /**
   * Descarga las categorias personalizadas como JSON (respaldo o para
   * pasarlas a otro equipo).
   */
  function exportarCategorias() {
    const blob = new Blob([JSON.stringify(categoriasCustom, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'categorias_devolucion_iva.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Importa categorias desde un JSON {"NOMBRE COMERCIAL": "4", ...} (el
   * formato que exporta este panel y el de categorias.json de la extension
   * anterior). Se SUMAN a las existentes; las entradas invalidas se ignoran.
   * @param {File} archivo
   */
  async function importarCategorias(archivo) {
    try {
      const datos = JSON.parse(await archivo.text());
      if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('formato no valido');
      let agregadas = 0;
      for (const [nombre, valor] of Object.entries(datos)) {
        const clave = String(nombre).trim().toUpperCase();
        const tipo = String(valor);
        if (clave && CFG.TIPOS_GASTO[tipo]) {
          categoriasCustom[clave] = tipo;
          agregadas++;
        }
      }
      guardarCategoriasCustom();
      renderListaCustom();
      log(`Categorias importadas: ${agregadas}`, agregadas > 0 ? 'ok' : 'warn');
    } catch (e) {
      log(`No se pudo importar el archivo: ${e.message}`, 'warn');
    }
  }

  function guardarCategoriasCustom() {
    chrome.storage.local.set({ [STORAGE_KEY]: categoriasCustom });
  }

  // =====================================================
  // Utilidades
  // =====================================================

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function $(id) {
    return document.getElementById(id);
  }

  function log(msg, cls = 'info') {
    const logDiv = $('sri-iva-log');
    if (!logDiv) return;
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = msg;
    logDiv.appendChild(line);
    logDiv.scrollTop = logDiv.scrollHeight;
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
   * Selecciona el tipo de gasto en el SelectOneMenu de PrimeFaces: abre el
   * panel con el trigger y hace click en el item. Fallback: setea el select
   * oculto + el label a mano. Ultimo recurso: un <select> nativo de la fila.
   */
  async function seleccionarTipoGasto(fila, valor) {
    const selectInput = fila.querySelector(CFG.SELECT_TIPO_GASTO);
    if (selectInput) {
      const baseId = selectInput.id.replace(/_input$/, '');
      const menu = document.getElementById(baseId);
      if (menu) {
        const trigger = menu.querySelector('.ui-selectonemenu-trigger') || menu;
        trigger.click();
        await sleep(500);
        const panel = document.getElementById(baseId + '_panel');
        if (panel) {
          const items = panel.querySelectorAll('li.ui-selectonemenu-item');
          const idx = Array.from(selectInput.options).findIndex(o => o.value === valor);
          if (idx >= 0 && idx < items.length) {
            items[idx].click();
            await sleep(400);
            return true;
          }
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
    const nombreComercial = celdas[CFG.COL_NOMBRE_COMERCIAL]?.querySelector('label')?.textContent?.trim() || 'Desconocido';
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
      log(`  SIN CATEGORIA: "${nombreComercial}" - seleccione manualmente`, 'warn');
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

  async function procesarTodasLasPaginas() {
    autoRunning = true;
    stopRequested = false;
    actualizarBotones();
    let pagina = 1;
    let totalFacturas = 0;
    let totalIncompletas = 0;
    setStatus('Procesando...', 'working');

    try {
      // Siempre empezar desde la primera pagina
      await clickPaginadorYEsperar('.ui-paginator-first');

      while (!stopRequested) {
        log(`--- Pagina ${pagina} ---`, 'info');
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
      autoRunning = false;
      stopRequested = false;
      actualizarBotones();
    }
  }

  // =====================================================
  // UI
  // =====================================================

  function mostrarNotificacion(mensaje, tipo = 'ok') {
    $('sri-iva-notificacion')?.remove();
    const notif = document.createElement('div');
    notif.id = 'sri-iva-notificacion';
    notif.className = `sri-iva-notif-${tipo}`;
    notif.textContent = mensaje;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 5000);
  }

  /** Estado puesto por una accion (no se pisa con el estado base) */
  function setStatus(msg, tipo) {
    const status = $('sri-iva-status');
    if (!status) return;
    status.textContent = msg;
    status.className = `sri-iva-status sri-iva-status-${tipo}`;
    delete status.dataset.base;
  }

  /** Estado base segun haya o no tabla; solo si no hay un estado de accion */
  function setStatusBase(forzar = false) {
    const status = $('sri-iva-status');
    if (!status || (!forzar && status.dataset.base !== '1')) return;
    const hay = !!getTbody();
    status.textContent = hay ? 'Listo' : 'Consulte las facturas del periodo para comenzar';
    status.className = `sri-iva-status sri-iva-status-${hay ? 'done' : 'warn'}`;
    status.dataset.base = '1';
  }

  /** Visibilidad/habilitacion de botones segun modo auto y presencia de tabla */
  function actualizarBotones() {
    const panel = $(PANEL_ID);
    if (!panel) return;
    const hayTabla = !!getTbody();
    for (const id of ['sri-iva-btn-fill', 'sri-iva-btn-next', 'sri-iva-btn-auto']) {
      const btn = $(id);
      btn.hidden = autoRunning;
      btn.disabled = !hayTabla;
    }
    $('sri-iva-btn-stop').hidden = !autoRunning;
    $('sri-iva-btn-clear').disabled = autoRunning;
    setStatusBase();
  }

  function renderListaCustom() {
    const lista = $('sri-iva-custom-list');
    if (!lista) return;
    lista.replaceChildren();
    const entries = Object.entries(categoriasCustom);
    if (entries.length === 0) {
      const vacio = document.createElement('div');
      vacio.className = 'sri-iva-empty';
      vacio.textContent = 'No hay categorias personalizadas';
      lista.appendChild(vacio);
      return;
    }
    for (const [nombre, cat] of entries) {
      const item = document.createElement('div');
      item.className = 'sri-iva-custom-item';
      const texto = document.createElement('span');
      texto.textContent = `${nombre} `;
      const small = document.createElement('small');
      small.textContent = `(${getNombreCategoria(cat)})`;
      texto.appendChild(small);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sri-iva-custom-del';
      del.textContent = 'X';
      del.title = 'Eliminar';
      del.addEventListener('click', () => {
        delete categoriasCustom[nombre];
        guardarCategoriasCustom();
        renderListaCustom();
      });
      item.append(texto, del);
      lista.appendChild(item);
    }
  }

  /** Crea un elemento con atributos y texto (construccion DOM segura) */
  function el(tag, attrs = {}, texto) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  function crearPanel() {
    if ($(PANEL_ID)) return;

    const panel = el('div', { id: PANEL_ID });

    const header = el('div', { class: 'sri-iva-header' });
    const btnMin = el('button', { type: 'button', id: 'sri-iva-minimize', title: 'Minimizar' }, '_');
    const btnClose = el('button', { type: 'button', id: 'sri-iva-close', title: 'Cerrar' }, '×');
    header.append(el('h3', {}, 'Asistente Devolucion IVA'), btnMin, btnClose);

    const cuerpo = el('div', { class: 'sri-iva-body' });
    const status = el('div', { id: 'sri-iva-status', class: 'sri-iva-status' });
    status.dataset.base = '1';
    const btnFill = el('button', { type: 'button', id: 'sri-iva-btn-fill' }, 'Rellenar esta pagina');
    const btnNext = el('button', { type: 'button', id: 'sri-iva-btn-next' }, 'Siguiente pagina');
    const btnAuto = el('button', { type: 'button', id: 'sri-iva-btn-auto' }, 'Auto: todas las paginas');
    const btnStop = el('button', { type: 'button', id: 'sri-iva-btn-stop' }, 'Detener');
    const btnClear = el('button', { type: 'button', id: 'sri-iva-btn-clear' }, 'Limpiar log');
    const logDiv = el('div', { id: 'sri-iva-log' });

    // Categorias personalizadas
    const custom = el('div', { id: 'sri-iva-custom-section' });
    const btnToggleCustom = el('button', { type: 'button', id: 'sri-iva-toggle-custom' }, 'Categorias personalizadas');
    const customBody = el('div', { id: 'sri-iva-custom-body' });
    customBody.hidden = true;
    const addRow = el('div', { class: 'sri-iva-add-row' });
    const inputNombre = el('input', { id: 'sri-iva-add-nombre', type: 'text', placeholder: 'Nombre comercial' });
    const selectCat = el('select', { id: 'sri-iva-add-cat' });
    for (const [valor, nombre] of Object.entries(CFG.TIPOS_GASTO)) {
      const opt = el('option', { value: valor }, nombre);
      if (valor === '4') opt.selected = true;
      selectCat.appendChild(opt);
    }
    const btnAdd = el('button', { type: 'button', id: 'sri-iva-add-btn', title: 'Agregar' }, '+');
    addRow.append(inputNombre, selectCat, btnAdd);
    // Respaldo de las categorias personalizadas
    const ioRow = el('div', { class: 'sri-iva-io-row' });
    const btnExport = el('button', { type: 'button', class: 'sri-iva-io-btn', title: 'Guardar las categorias personalizadas en un archivo' }, 'Exportar');
    const btnImport = el('button', { type: 'button', class: 'sri-iva-io-btn', title: 'Agregar categorias desde un archivo JSON' }, 'Importar');
    const inputArchivo = el('input', { type: 'file', accept: '.json,application/json' });
    inputArchivo.hidden = true;
    ioRow.append(btnExport, btnImport, inputArchivo);
    customBody.append(addRow, el('div', { id: 'sri-iva-custom-list' }), ioRow);
    custom.append(btnToggleCustom, customBody);

    // Envio automatico al terminar el modo auto (activado por defecto)
    const autoLabel = el('label', { class: 'sri-iva-auto-label' });
    const chkAuto = el('input', { type: 'checkbox', id: 'sri-iva-auto-procesar' });
    chkAuto.checked = autoProcesar;
    autoLabel.append(chkAuto, document.createTextNode(' Procesar automaticamente al terminar el modo auto'));

    const aviso = el('p', { class: 'sri-iva-aviso' },
      'Revise los datos antes de enviar: el contribuyente es responsable de lo presentado al SRI.');

    cuerpo.append(status, btnFill, btnNext, btnAuto, btnStop, autoLabel, btnClear, logDiv, custom, aviso);
    panel.append(header, cuerpo);
    document.body.appendChild(panel);

    // Eventos
    btnFill.addEventListener('click', async () => {
      if (autoRunning) return;
      autoRunning = true;
      actualizarBotones();
      setStatus('Procesando pagina...', 'working');
      try {
        const r = await procesarPaginaActual();
        if (r.incompletas > 0) {
          setStatus(`${r.incompletas} factura(s) sin categoria`, 'warn');
          mostrarNotificacion(`${r.incompletas} factura(s) sin tipo de gasto. Complete manualmente.`, 'error');
        } else {
          setStatus('Pagina lista - Revise', 'done');
        }
      } finally {
        autoRunning = false;
        stopRequested = false;
        actualizarBotones();
      }
    });

    btnNext.addEventListener('click', () => {
      if (hayPaginaSiguiente()) {
        getPaginador('.ui-paginator-next').click();
        log('Avanzando a siguiente pagina...', 'info');
      } else {
        log('No hay mas paginas', 'warn');
      }
    });

    btnAuto.addEventListener('click', () => {
      if (!autoRunning) procesarTodasLasPaginas();
    });

    btnStop.addEventListener('click', () => {
      stopRequested = true;
      log('Deteniendo...', 'warn');
    });

    btnClear.addEventListener('click', () => {
      logDiv.replaceChildren();
      setStatusBase(true);
    });

    btnMin.addEventListener('click', () => {
      panel.classList.toggle('sri-iva-minimizado');
    });

    btnClose.addEventListener('click', () => {
      stopRequested = true;
      cerradoPorUsuario = true;
      panel.remove();
    });

    btnToggleCustom.addEventListener('click', () => {
      customBody.hidden = !customBody.hidden;
    });

    chkAuto.addEventListener('change', () => {
      autoProcesar = chkAuto.checked;
      chrome.storage.local.set({ [STORAGE_AUTO]: autoProcesar });
    });

    btnExport.addEventListener('click', exportarCategorias);
    btnImport.addEventListener('click', () => inputArchivo.click());
    inputArchivo.addEventListener('change', () => {
      if (inputArchivo.files[0]) importarCategorias(inputArchivo.files[0]);
      inputArchivo.value = '';
    });

    const agregar = () => {
      const nombre = inputNombre.value.trim().toUpperCase();
      if (!nombre) return;
      categoriasCustom[nombre] = selectCat.value;
      guardarCategoriasCustom();
      renderListaCustom();
      inputNombre.value = '';
      log(`Categoria agregada: ${nombre} -> ${getNombreCategoria(selectCat.value)}`, 'ok');
    };
    btnAdd.addEventListener('click', agregar);
    inputNombre.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); agregar(); }
    });

    renderListaCustom();
    actualizarBotones();
  }

  function abrirPanel() {
    cerradoPorUsuario = false;
    crearPanel();
    $(PANEL_ID)?.classList.remove('sri-iva-minimizado');
  }

  // =====================================================
  // Deteccion de la tabla de facturas
  // =====================================================

  /**
   * Abre el panel automaticamente cuando aparece la tabla de facturas (la
   * consulta del SRI es AJAX, no recarga la pagina) y mantiene los botones
   * habilitados segun haya tabla. Debounce para no recorrer el DOM en cada
   * mutacion.
   */
  function revisarTabla() {
    if (getTbody() && !$(PANEL_ID) && !cerradoPorUsuario) crearPanel();
    actualizarBotones();
  }

  let revisionPendiente = null;
  const observer = new MutationObserver(() => {
    if (revisionPendiente) return;
    revisionPendiente = setTimeout(() => {
      revisionPendiente = null;
      revisarTabla();
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // =====================================================
  // Mensajes del popup
  // =====================================================

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ivaEstado') {
      sendResponse({ hayTabla: !!getTbody(), panelAbierto: !!$(PANEL_ID), procesando: autoRunning });
    } else if (request.action === 'ivaAbrirPanel') {
      abrirPanel();
      sendResponse({ ok: true, hayTabla: !!getTbody() });
    }
    // Otras acciones son de content.js: no responder
    return false;
  });

  cargarCategoriasCustom();
  revisarTabla();
})();

} // Fin del bloque if (!window.SRI_IVA_LOADED)
