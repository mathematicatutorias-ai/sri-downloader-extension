# Descripcion para la Chrome Web Store

Texto de la ficha de la extension en la Chrome Web Store. Mantener sincronizado
con las funcionalidades reales antes de cada publicacion.

---

Descargador de Comprobantes SRI automatiza la descarga de comprobantes electrónicos (XML y PDF) desde el portal del SRI Ecuador (srienlinea.sri.gob.ec). Funciona con comprobantes recibidos y emitidos, e incluye un asistente para la devolución de IVA de adultos mayores y personas con discapacidad.

Características principales:

- Descarga masiva: Descarga todos los comprobantes de todas las páginas con un solo clic.
- Comprobantes emitidos: Descarga el RIDE (PDF) y el XML autorizado de tus propios comprobantes. El XML se obtiene directamente del web service oficial de autorización del SRI usando la clave de acceso.
- Descarga por día o mes completo: En emitidos, elige entre el día consultado o el mes completo — la extensión consulta día por día automáticamente, saltando los días sin comprobantes.
- Todos los tipos de comprobante: En el mes completo de emitidos puedes descargar de una sola vez facturas, liquidaciones de compra, notas de crédito, notas de débito, guías de remisión y retenciones.
- Consulta automática: Al navegar a emitidos desde el menú, la extensión ejecuta la consulta por ti; no necesitas llenar el formulario.
- Formatos: Elige entre XML, PDF o ambos (recuerda tu última selección).
- Asistente de devolución de IVA: En las pantallas de devolución de IVA para adultos mayores y personas con discapacidad, la extensión marca cada factura, rellena el IVA solicitado y asigna el tipo de gasto (salud, alimentación, vivienda, vestimenta, educación) según el comercio. El modo automático recorre todas las páginas y solo procesa la solicitud si todas las facturas quedaron completas. Se maneja desde la ventana de la extensión, sin paneles que tapen la página, y sigue trabajando aunque la cierres.
- Períodos pendientes: Al llegar a la pantalla de año y período, la ventana de la extensión se abre sola y el asistente busca por ti, empezando por enero, el primer período que todavía no has procesado.
- Comercios que se aprenden solos: Cuando eliges a mano el tipo de gasto de un comercio que el asistente no conocía, lo recuerda para la próxima vez. También puedes agregar tus propios comercios, exportarlos e importarlos, y decidir si el envío final es automático o lo revisas tú antes.
- Accesos directos SRI: Botones "Descargar recibidos" y "Descargar emitidos", más navegación rápida a Devolución de IVA, Declaraciones, RUC, Claves y otras secciones del portal. Pre-configura automáticamente el formulario.
- Entornos diferenciados por color: La interfaz cambia a verde agua cuando trabajas sobre emitidos y azul en recibidos, para que siempre sepas dónde estás.
- Organización de archivos: Organiza las descargas en carpetas automáticamente (RUC/Año/Mes o Año/Mes/RUC), separando recibidos de emitidos, con 3 formatos de nombre de archivo y vista previa en tiempo real.
- Progreso en tiempo real: Barra de progreso por documento (y por día en modo mes) con estimación de tiempo restante y badge en el ícono. Cancela en cualquier momento con "Detener Descarga".
- Descarga confiable: Si el portal del SRI tarda en responder, la extensión espera y reintenta; si no logra avanzar te avisa en lugar de saltarse documentos. Cuando un archivo no baja por el método normal lo intenta por un método alternativo y te lo indica.
- Configuración desde el popup: Ajusta tiempos, método de descarga (Mojarra JSF o click emulado) y reintentos sin editar código.
- Historial de descargas: Consulta qué documentos ya descargaste durante los últimos 3 meses (plazo configurable), con su origen (emitido o recibido), y filtra por exitosos o fallidos.
- Reintentos automáticos: Si una descarga falla por demora del servidor, se reintenta automáticamente (configurable).
- Sin duplicados: No vuelve a descargar documentos que ya tienes (distingue XML y PDF por separado).
- Exportar historial: Exporta el registro de descargas a CSV, con el origen y los valores de cada comprobante (valor sin impuestos, IVA y total).
- Continúa en segundo plano: Si cierras la ventana emergente, la descarga continúa. Recibirás una notificación y sonido al finalizar.
- 4 pestañas integradas: Descargar, Historial, Configuración y Organización.
- Modo oscuro: Se adapta automáticamente al tema de tu sistema operativo.
- Seguro: Se comunica únicamente con los servidores oficiales del SRI (portal y web service de autorización). No recopila ni envía datos a terceros.

Ideal para contadores, asistentes contables y cualquier profesional que necesite descargar grandes volúmenes de comprobantes del SRI, y para quienes presentan su devolución de IVA cada mes.

Cómo usar:
1. Inicia sesión en srienlinea.sri.gob.ec
2. Haz clic en el ícono de la extensión
3. Presiona "Descargar recibidos" o "Descargar emitidos" y elige el tipo de comprobante — la extensión navega y deja la consulta lista
4. Selecciona el tipo de descarga (XML, PDF o Ambos)
5. En emitidos, elige el rango: Mes completo (por defecto) o Día consultado, y si quieres todos los tipos de comprobante
6. Presiona "Descargar TODO"
7. Opcionalmente, configura la organización de archivos para ordenar tus descargas en carpetas

Devolución de IVA:
1. Presiona "Devolución de IVA" y elige Personas con discapacidad o Adultos mayores
2. Acepta las condiciones y elige tu cuenta bancaria; al llegar a la pantalla de año y período el asistente busca solo el primer período pendiente y abre sus facturas
3. En la ventana de la extensión presiona "Auto: todas las páginas" y revisa los datos antes de enviar

Nota: Esta extensión NO está afiliada al SRI. Es una herramienta independiente que interactúa con el portal público. El asistente de devolución de IVA es una ayuda para llenar el formulario: el contribuyente es responsable de revisar la información antes de enviarla.
