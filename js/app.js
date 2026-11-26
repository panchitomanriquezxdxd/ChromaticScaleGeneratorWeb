import { SR, readSound, prepareSound, soundData, analyze, resynth, concatWithGaps, noteFreq } from './dsp.js';
import { encodeWav } from './wav.js';
import { makeZip } from './zip.js';
import { W2D, TPL } from './dwp.js';

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const MAX_RANGE = 60;

const T = {
  es: {
    intro: 'Crea una escala cromática a partir de tus samples: cada nota se afina con el mismo código de Praat que la versión de escritorio y todo corre en tu navegador, sin subir archivos.',
    samples: 'Samples', drop: 'Suelta aquí tus audios (WAV u otros). Se ordenan por nombre: 1.wav, 2.wav… y se repiten en ciclo.',
    files: 'Elegir archivos', folder: 'Elegir carpeta', empty: 'Aún no hay samples.', remove: 'Quitar',
    range: 'Rango', note: 'Nota inicial', oct: 'Octava inicial', rng: 'Cantidad de semitonos', gap: 'Espacio entre samples (segundos)',
    pitched: 'Con pitch', dump: 'Descargar samples pitcheados por separado',
    generate: 'Generar cromática', result: 'Resultado', dlChrom: 'Guardar chromatic.wav', dlZip: 'Guardar samples (ZIP)', dlDir: 'Guardar en una carpeta…',
    saved: (n) => `Guardado: ${n}`, savedDir: (n) => `Guardado en la carpeta (${n} archivos).`,
    caption: (a, b, n, f1, f2) => `${a} a ${b} · ${n} semitonos · ${f1} – ${f2} Hz`,
    noSamples: 'Agrega al menos un sample.', badRange: `El rango debe ser un entero entre 1 y ${MAX_RANGE}.`, badGap: 'El espacio debe ser un número mayor o igual a 0.',
    decoding: 'Leyendo audios…', working: (i, n) => `Generando ${i} de ${n}…`, done: 'Listo.', failed: (m) => `No se pudo leer ${m}.`,
    noPitch: (m) => `No se detectó pitch en "${m}": se dejó sin afinar.`,
    slicex: 'Agregar markers de Slicex al WAV (uno por nota)',
    dwpTitle: 'Programa de DirectWave (.dwp)', dwpIntro: 'Crea un programa de DirectWave con cada nota en su tecla, a partir de la cromática que acabas de generar. No hace falta abrir FL Studio.',
    dwpName: 'Nombre del programa', dwpQ: 'Calidad del audio',
    dwpQhi: 'Alta · loops a 32 bit (pesa el doble)', dwpQstd: 'Estándar · 16 bit', dwpQlo: 'Liviana · mitad de la frecuencia', dwpQmin: 'Mínima · cuarta parte de la frecuencia',
    dwpTrim: 'Recortar silencios (quita el espacio entre samples)', dwpLoop: 'Crear loop automático en los sonidos que se sostienen',
    dwpMake: 'Crear .dwp', dwpSave: 'Guardar .dwp', dwpWorking: (i) => `Creando programa… ${i}%`,
    dwpDone: (n, r, l, sz) => `${n}: ${r} regiones, ${l} con loop · ${sz}`, dwpFail: (m) => `No se pudo crear el .dwp: ${m}`,
    sample: 'sample', footer: 'Port web de Chromatic Scale Generator (GPL-3.0). El código de Praat que usa el programa (To Manipulation, To Pitch ac, resíntesis overlap-add) está portado a JavaScript y da el mismo resultado, muestra por muestra, que Praat.',
  },
  en: {
    intro: 'Build a chromatic scale from your samples. Each note is pitched with the same Praat code as the desktop version, and everything runs in your browser, with no uploads.',
    samples: 'Samples', drop: 'Drop your audio files here (WAV or others). They are sorted by name (1.wav, 2.wav…) and cycled.',
    files: 'Choose files', folder: 'Choose folder', empty: 'No samples yet.', remove: 'Remove',
    range: 'Range', note: 'Starting note', oct: 'Starting octave', rng: 'Number of semitones', gap: 'Sample gap (seconds)',
    pitched: 'Pitched', dump: 'Download individual pitched samples',
    generate: 'Generate chromatic', result: 'Result', dlChrom: 'Save chromatic.wav', dlZip: 'Save samples (ZIP)', dlDir: 'Save to a folder…',
    saved: (n) => `Saved: ${n}`, savedDir: (n) => `Saved to the folder (${n} files).`,
    caption: (a, b, n, f1, f2) => `${a} to ${b} · ${n} semitones · ${f1} – ${f2} Hz`,
    noSamples: 'Add at least one sample.', badRange: `Range must be a whole number from 1 to ${MAX_RANGE}.`, badGap: 'Gap must be a number of 0 or more.',
    decoding: 'Reading audio…', working: (i, n) => `Generating ${i} of ${n}…`, done: 'Done.', failed: (m) => `Could not read ${m}.`,
    noPitch: (m) => `No pitch detected in "${m}": left unpitched.`,
    slicex: 'Add Slicex markers to the WAV (one per note)',
    dwpTitle: 'DirectWave program (.dwp)', dwpIntro: 'Builds a DirectWave program with each note on its own key, from the chromatic you just generated. No need to open FL Studio.',
    dwpName: 'Program name', dwpQ: 'Audio quality',
    dwpQhi: 'High · 32-bit loops (twice the size)', dwpQstd: 'Standard · 16-bit', dwpQlo: 'Light · half the sample rate', dwpQmin: 'Minimum · quarter of the sample rate',
    dwpTrim: 'Trim silences (removes the gap between samples)', dwpLoop: 'Create automatic loops on sustained sounds',
    dwpMake: 'Create .dwp', dwpSave: 'Save .dwp', dwpWorking: (i) => `Building program… ${i}%`,
    dwpDone: (n, r, l, sz) => `${n}: ${r} regions, ${l} looped · ${sz}`, dwpFail: (m) => `Could not create the .dwp: ${m}`,
    sample: 'sample', footer: 'Web port of Chromatic Scale Generator (GPL-3.0). The Praat code the program uses (To Manipulation, To Pitch ac, overlap-add resynthesis) is ported to JavaScript and gives the same result as Praat, sample for sample.',
  },
};

let lang = (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';
const $ = (id) => document.getElementById(id);
const tr = () => T[lang];
const state = { samples: [], urls: [] };

// ---------- textos ----------
function applyLang() {
  const t = tr();
  document.documentElement.lang = lang;
  $('langBtn').textContent = lang === 'es' ? 'EN' : 'ES';
  $('intro').textContent = t.intro;
  $('samplesTitle').textContent = t.samples; $('dropText').textContent = t.drop;
  $('pickFiles').textContent = t.files; $('pickFolder').textContent = t.folder;
  $('rangeTitle').textContent = t.range; $('lblNote').textContent = t.note; $('lblOct').textContent = t.oct;
  $('lblRange').textContent = t.rng; $('lblGap').textContent = t.gap;
  $('lblPitched').textContent = t.pitched; $('lblDump').textContent = t.dump; $('lblSlicex').textContent = t.slicex;
  $('dwpTitle').textContent = t.dwpTitle; $('dwpIntro').textContent = t.dwpIntro; $('lblDwpName').textContent = t.dwpName; $('lblDwpQ').textContent = t.dwpQ;
  for (const q of ['hi', 'std', 'lo', 'min']) $('dwpQuality').querySelector(`option[value=${q}]`).textContent = t['dwpQ' + q];
  $('lblDwpTrim').textContent = t.dwpTrim; $('lblDwpLoop').textContent = t.dwpLoop; $('dwpMake').textContent = t.dwpMake; $('dwpSave').textContent = t.dwpSave;
  $('generate').textContent = t.generate; $('resTitle').textContent = t.result;
  $('dlChromatic').textContent = t.dlChrom; $('dlSamples').textContent = t.dlZip; $('dlFolder').textContent = t.dlDir;
  $('footer').textContent = t.footer;
  renderSamples(); renderKeyboard();
}

// ---------- samples ----------
// Formatos que no son WAV (Praat tampoco los lee: es una extensión de la web).
async function decodeOther(ab, ctx) {
  const buf = await ctx.decodeAudioData(ab);
  return { channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), sampleRate: buf.sampleRate };
}

async function decodeFile(file, ctx) {
  const sound = await readSound(await file.arrayBuffer(), (ab) => decodeOther(ab, ctx));
  const sound48 = prepareSound(sound); // Resample (48000, 1) + Convert to mono, como Praat
  return { sound48, data: soundData(sound48) };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|opus)$/i.test(f.name));
  if (!files.length) return;
  $('status').textContent = tr().decoding;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  for (const f of files) {
    try {
      state.samples.push({ name: f.name, ...(await decodeFile(f, ctx)), analysis: null });
    } catch (e) {
      $('status').textContent = tr().failed(f.name);
    }
  }
  ctx.close();
  state.samples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if ($('status').textContent === tr().decoding) $('status').textContent = '';
  renderSamples(); renderKeyboard();
}

function renderSamples() {
  const ol = $('sampleList');
  ol.innerHTML = '';
  if (!state.samples.length) {
    const li = document.createElement('li'); li.textContent = tr().empty; li.style.counterIncrement = 'none';
    li.style.setProperty('--x', 0); li.className = 'emptyrow'; ol.appendChild(li); ol.classList.add('isEmpty');
    return;
  }
  ol.classList.remove('isEmpty');
  state.samples.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="nm"></span><span class="du"></span><button type="button"></button>';
    li.querySelector('.nm').textContent = s.name;
    li.querySelector('.du').textContent = (s.data.length / SR).toFixed(2) + ' s';
    const b = li.querySelector('button'); b.textContent = '×'; b.title = tr().remove; b.setAttribute('aria-label', tr().remove + ' ' + s.name);
    b.onclick = () => { state.samples.splice(i, 1); renderSamples(); renderKeyboard(); };
    ol.appendChild(li);
  });
}

// ---------- teclado ----------
function readParams() {
  return {
    note: $('startNote').selectedIndex, oct: $('startOct').selectedIndex,
    range: Number($('range').value), gap: Number($('gap').value),
    pitched: $('pitched').checked, dump: $('dump').checked, slicex: $('slicex').checked,
  };
}
const noteName = (s) => NOTES[s % 12] + (2 + Math.floor(s / 12));

function renderKeyboard() {
  const p = readParams();
  const kb = $('keyboard');
  const range = Math.min(MAX_RANGE, Math.max(1, Math.round(p.range) || 1));
  const s0 = p.note + 12 * p.oct, s1 = s0 + range - 1;
  const from = Math.floor(s0 / 12) * 12, to = Math.ceil((s1 + 1) / 12) * 12 - 1;
  let whites = 0;
  for (let s = from; s <= to; s++) if (!BLACK.has(s % 12)) whites++;
  const w = 100 / whites, bw = w * 0.6;
  kb.style.minWidth = whites * 26 + 'px';
  kb.innerHTML = '';
  const n = Math.max(1, state.samples.length);
  let wi = 0;
  for (let s = from; s <= to; s++) {
    const el = document.createElement('div');
    const on = s >= s0 && s <= s1;
    const white = !BLACK.has(s % 12);
    el.className = 'key ' + (white ? 'w' : 'b') + (on ? ' on' : '');
    el.title = noteName(s) + (on ? ` · ${tr().sample} ${((s - s0) % n) + 1}` : '');
    if (white) {
      el.style.left = wi * w + '%'; el.style.width = w + '%';
      if (s % 12 === 0) el.textContent = noteName(s);
      wi++;
    } else {
      el.style.left = wi * w - bw / 2 + '%'; el.style.width = bw + '%';
    }
    kb.appendChild(el);
  }
  kb.setAttribute('aria-label', tr().caption(noteName(s0), noteName(s1), range, noteFreq(s0).toFixed(1), noteFreq(s1).toFixed(1)));
  $('kbCaption').textContent = kb.getAttribute('aria-label');
}

// ---------- generar ----------
const tick = () => new Promise((r) => setTimeout(r, 0));

async function generate() {
  const t = tr(), p = readParams();
  if (!state.samples.length) { $('status').textContent = t.noSamples; return; }
  if (!Number.isInteger(p.range) || p.range < 1 || p.range > MAX_RANGE) { $('status').textContent = t.badRange; return; }
  if (!Number.isFinite(p.gap) || p.gap < 0) { $('status').textContent = t.badGap; return; }

  const btn = $('generate'); btn.disabled = true;
  $('result').hidden = true; $('bar').hidden = false; $('bar').value = 0;
  const n = state.samples.length, startKey = p.note + 12 * p.oct;
  const outs = [], noPitch = new Set();

  try {
    for (let i = 0; i < p.range; i++) {
      $('status').textContent = t.working(i + 1, p.range);
      $('bar').value = i / p.range;
      await tick();
      const s = state.samples[i % n];
      if (!p.pitched) { outs.push(s.data); continue; }
      if (!s.analysis) s.analysis = analyze(s.sound48);
      if (!s.analysis.voiced) noPitch.add(s.name); // Praat devuelve el sample sin pitch (sin componente continua)
      outs.push(resynth(s.analysis, noteFreq(i + startKey)));
    }
    const chromatic = concatWithGaps(outs, Math.round(p.gap * SR));
    state.urls.forEach(URL.revokeObjectURL); state.urls = [];

    const gapN = Math.round(p.gap * SR);
    let at = 0;
    const cues = outs.map((o, i) => { const c = { frame: at, label: noteName(startKey + i) }; at += o.length + gapN; return c; });
    state.chromatic = chromatic; state.cues = cues; state.startKey = startKey;
    const wav = encodeWav(chromatic, SR, p.slicex ? cues : []);
    state.chromBlob = new Blob([wav], { type: 'audio/wav' });
    const chromUrl = URL.createObjectURL(state.chromBlob);
    state.urls.push(chromUrl);
    $('player').src = chromUrl;

    if (p.dump && p.pitched) {
      state.pitchedFiles = outs.map((o, i) => ({ name: `pitched_${i + 1}.wav`, data: encodeWav(o, SR) }));
      state.zipBlob = makeZip(state.pitchedFiles.map((f) => ({ name: 'pitched_samples/' + f.name, data: f.data })));
    } else { state.pitchedFiles = null; state.zipBlob = null; }
    $('dlSamples').hidden = !state.zipBlob;
    $('dlFolder').hidden = !window.showDirectoryPicker;

    const ul = $('warnings'); ul.innerHTML = '';
    noPitch.forEach((name) => { const li = document.createElement('li'); li.textContent = t.noPitch(name); ul.appendChild(li); });
    $('result').hidden = false; $('dwpSection').hidden = false; $('dwpSave').hidden = true; $('dwpStatus').textContent = ''; state.dwpBlob = null; $('bar').value = 1; $('status').textContent = t.done;
  } catch (e) {
    console.error(e); $('status').textContent = String(e.message || e);
  } finally { btn.disabled = false; setTimeout(() => ($('bar').hidden = true), 600); }
}

// ---------- guardar ----------
async function saveBlob(blob, name, mime, ext) {
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: name, accept: { [mime]: [ext] } }] });
      const w = await h.createWritable();
      await w.write(blob); await w.close();
      $('status').textContent = tr().saved(name); return;
    } catch (e) { if (e.name === 'AbortError') return; /* otro error: usa la descarga normal */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  $('status').textContent = tr().saved(name);
}

async function saveToFolder() {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const put = async (d, name, data) => {
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(data); await w.close();
    };
    await put(dir, 'chromatic.wav', state.chromBlob);
    let count = 1;
    if (state.pitchedFiles) {
      const sub = await dir.getDirectoryHandle('pitched_samples', { create: true });
      for (const f of state.pitchedFiles) { await put(sub, f.name, f.data); count++; }
    }
    $('status').textContent = tr().savedDir(count);
  } catch (e) { if (e.name !== 'AbortError') $('status').textContent = String(e.message || e); }
}

// ---------- DWP (DirectWave) ----------
async function makeDwp() {
  const t = tr();
  if (!state.chromatic) return;
  const btn = $('dwpMake'), bar = $('dwpBar'), st = $('dwpStatus');
  btn.disabled = true; $('dwpSave').hidden = true; state.dwpBlob = null;
  bar.hidden = false; bar.value = 0; st.textContent = t.dwpWorking(0);
  try {
    await tick();
    // Se arma un WAV con un marker por nota y se pasa por el núcleo de DWP_Converter.
    const wav = encodeWav(state.chromatic, SR, state.cues);
    const info = W2D.parseWav(wav.buffer);
    info.firstNote = 36 + state.startKey; // nota MIDI real de la primera muestra (C2 = 36)
    const q = $('dwpQuality').value;
    const opts = {
      trim: $('dwpTrim').checked, loop: $('dwpLoop').checked,
      rateDiv: q === 'lo' ? 2 : q === 'min' ? 4 : 1, loopBits: q === 'hi' ? 32 : 16, yield: true,
    };
    const res = await W2D.buildDwp(info, $('dwpName').value || 'Chromatic', TPL, (f) => {
      bar.value = f; st.textContent = t.dwpWorking(Math.round(f * 100));
    }, opts);
    state.dwpBlob = new Blob(res.parts, { type: 'application/octet-stream' });
    state.dwpFile = res.name + '.dwp';
    const mb = state.dwpBlob.size / 1048576;
    st.textContent = t.dwpDone(state.dwpFile, res.regions.length, res.loops, mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(state.dwpBlob.size / 1024)) + ' KB');
    $('dwpSave').hidden = false;
  } catch (e) {
    console.error(e); st.textContent = t.dwpFail(e.message || e);
  } finally { btn.disabled = false; setTimeout(() => (bar.hidden = true), 600); }
}

// ---------- eventos ----------
NOTES.forEach((n) => { const o = document.createElement('option'); o.textContent = n; $('startNote').appendChild(o); });
['startNote', 'startOct', 'range'].forEach((id) => $(id).addEventListener('input', renderKeyboard));
$('pitched').addEventListener('change', () => { $('dump').disabled = !$('pitched').checked; });
$('pickFiles').onclick = () => $('filesInput').click();
$('pickFolder').onclick = () => $('folderInput').click();
$('filesInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('folderInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('generate').onclick = generate;
$('dwpMake').onclick = makeDwp;
$('dwpSave').onclick = () => state.dwpBlob && saveBlob(state.dwpBlob, state.dwpFile, 'application/octet-stream', '.dwp');
$('dlChromatic').onclick = () => state.chromBlob && saveBlob(state.chromBlob, 'chromatic.wav', 'audio/wav', '.wav');
$('dlSamples').onclick = () => state.zipBlob && saveBlob(state.zipBlob, 'pitched_samples.zip', 'application/zip', '.zip');
$('dlFolder').onclick = () => state.chromBlob && saveToFolder();
$('langBtn').onclick = () => { lang = lang === 'es' ? 'en' : 'es'; applyLang(); };
applyLang();
