# Chromatic Scale Generator (web)

Genera una escala cromática a partir de tus samples, directo en el navegador. Port web del programa de escritorio original (carpeta `desktop-python/`).

## Uso

1. Suelta tus audios (o usa **Elegir archivos / carpeta**). Se ordenan por nombre (`1.wav`, `2.wav`…) y se repiten en ciclo si hay menos samples que semitonos.
2. Elige nota inicial, octava inicial, rango (semitonos) y espacio entre samples.
3. **Generar cromática**, escúchala en el reproductor y guárdala con **Guardar chromatic.wav** (en Chrome/Edge de escritorio te deja elegir dónde; en el resto se descarga). Con **Guardar en una carpeta…** (solo Chrome/Edge de escritorio) escribe `chromatic.wav` y `pitched_samples/pitched_N.wav` directo en la carpeta, como el programa original. También hay **Guardar samples (ZIP)**.

Las frecuencias son las mismas que en la versión de escritorio: `32.703 * 2^((semitono + 12) / 12)`, con C2 como nota más grave. Todo se procesa localmente; no se sube ningún archivo.

## Slicex y DirectWave

- **Slicex:** con "Agregar markers de Slicex al WAV" activado, `chromatic.wav` lleva un marker (bloque `cue `) al inicio de cada nota, con la nota como etiqueta. Arrastra el WAV a Slicex y cada nota queda en su propio corte.
- **DWP:** tras generar aparece la sección "Programa de DirectWave". Crea un `.dwp` con una región por nota, cada una en su tecla real (la primera muestra va en la nota MIDI 36 + semitono inicial). Opciones: nombre, calidad, recortar silencios y loop automático.
- El núcleo del `.dwp` (`js/dwp.js`) sale de `DWP_Converter.html`; el único cambio es que la nota de la primera región se puede fijar. DirectWave nombra las notas con C5 = nota 60, así que los nombres de región se ven una octava más alta que en el teclado de la página (C2 = 65,4 Hz aquí, C3 en DirectWave).

## Publicar en GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `(root)`. Para probar en local necesitas un servidor, por ejemplo `python -m http.server` (los módulos ES no cargan desde `file://`).

## Diferencias con la versión de escritorio

El original usa Praat (Parselmouth). En `js/dsp.js` se portó la lógica de Praat que usa el programa: `To Pitch (ac)` con sus parámetros por defecto (autocorrelación normalizada con ventana Hanning, candidatos, costos de octava y de voz/sin voz, camino de Viterbi), pulsos de pitch y resíntesis overlap-add (PSOLA) con pitch fijo. Está escrito a partir del algoritmo publicado, no del código fuente de Praat, así que el resultado es muy parecido pero no idéntico. Si un sample no tiene pitch detectable, se deja sin afinar y se avisa.

## Licencia

GPL-3.0, igual que el programa original.
