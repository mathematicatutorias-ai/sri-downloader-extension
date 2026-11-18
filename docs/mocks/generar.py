"""Regenera las imagenes de la Chrome Web Store (capturas + promocionales).

Renderiza el popup REAL de la extension (y iva.js REAL rellenando una pantalla
de devolucion simulada) sobre un portal con datos FICTICIOS (nunca capturas de
una sesion real), usando Chrome en modo headless, y deja los PNG en docs/ como
RGB de 24 bits sin alfa.

Uso (desde la raiz del repo):
    python docs/mocks/generar.py

Requiere Google Chrome instalado y Pillow (pip install pillow).
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

MOCKS = Path(__file__).resolve().parent
RAIZ = MOCKS.parents[1]
DOCS = RAIZ / 'docs'

CHROME_CANDIDATOS = [
    Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
    Path(r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'),
    Path('/usr/bin/google-chrome'),
    Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
]

# (ancho, alto, pagina del mock, archivo destino en docs/)
IMAGENES = [
    (1280, 800, 'stage.html?scene=recibidos', 'captura-1-descarga-recibidos.png'),
    (1280, 800, 'stage.html?scene=emitidos', 'captura-2-emitidos-mes.png'),
    (1280, 800, 'stage.html?scene=menu', 'captura-3-menu.png'),
    (1280, 800, 'stage.html?scene=historial', 'captura-4-historial.png'),
    (1280, 800, 'stage.html?scene=iva', 'captura-5-devolucion-iva.png'),
    (1400, 560, 'promo.html?tipo=marquesina', 'promo-marquesina-1400x560.png'),
    (440, 280, 'promo.html?tipo=pequena', 'promo-pequena-440x280.png'),
]


def main():
    chrome = next((c for c in CHROME_CANDIDATOS if c.exists()), None)
    if not chrome:
        sys.exit('No se encontro Google Chrome')

    version = json.loads((RAIZ / 'manifest.json').read_text(encoding='utf-8'))['version']

    with tempfile.TemporaryDirectory(prefix='sri-mocks-') as tmp:
        tmp = Path(tmp)
        trabajo = tmp / 'mock'
        trabajo.mkdir()

        # Archivos reales de la extension + mocks
        for nombre in ['popup.css', 'popup.js', 'config.js', 'iva.css', 'iva.js', 'iva-categorias.js']:
            shutil.copy(RAIZ / nombre, trabajo / nombre)
        for nombre in ['stage.html', 'iva_page.html', 'promo.html']:
            shutil.copy(MOCKS / nombre, trabajo / nombre)
        mock_js = (MOCKS / 'mock_chrome.js').read_text(encoding='utf-8').replace('__VERSION__', version)
        (trabajo / 'mock_chrome.js').write_text(mock_js, encoding='utf-8')

        # popup.html real con el mock de chrome.* cargado antes que sus scripts
        popup = (RAIZ / 'popup.html').read_text(encoding='utf-8')
        marca = '<script src="config.js"></script>'
        if marca not in popup:
            sys.exit('popup.html ya no carga config.js: actualizar generar.py')
        popup = popup.replace(marca, '<script src="mock_chrome.js"></script>\n  ' + marca)
        (trabajo / 'popup_mock.html').write_text(popup, encoding='utf-8')

        for ancho, alto, pagina, destino in IMAGENES:
            salida = tmp / destino
            subprocess.run([
                str(chrome), '--headless=new', '--disable-gpu', '--hide-scrollbars',
                '--force-device-scale-factor=1', '--lang=es',
                f'--window-size={ancho},{alto}',
                # El asistente de IVA usa esperas reales entre acciones
                '--virtual-time-budget=30000',
                f'--user-data-dir={tmp / "perfil"}',
                '--allow-file-access-from-files',
                f'--screenshot={salida}',
                (trabajo / pagina.split('?')[0]).as_uri() + '?' + pagina.split('?')[1],
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            imagen = Image.open(salida).convert('RGB')  # 24 bits sin alfa
            if imagen.size != (ancho, alto):
                sys.exit(f'{destino}: tamano {imagen.size}, se esperaba {(ancho, alto)}')
            imagen.save(DOCS / destino, optimize=True)
            print(f'{destino}  {ancho}x{alto}')


if __name__ == '__main__':
    main()
