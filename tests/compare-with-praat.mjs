// Compara js/praat.js con Praat real, muestra por muestra (int16).
//   node tests/compare-with-praat.mjs
// Las referencias de tests/fixtures/ref se generaron con Praat (compilado desde
// github.com/praat/praat) y tests/reference.praat, que repite las llamadas de chromatic_gen.py.
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SR, readSound, prepareSound, analyze, resynth, noteFreq } from '../js/dsp.js';
import { Sound_readFromWav } from '../js/praat.js';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const ab = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
let failed = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.wav')).sort()) {
  const name = f.replace('.wav', '');
  const a = analyze(prepareSound(await readSound(ab(dir + f))));
  for (const n of [12, 40]) {
    const out = resynth(a, 32.703 * Math.pow(2, n / 12));
    const ref = Sound_readFromWav(ab(`${dir}ref/${name}_${n}.wav`));
    let bad = out.length !== ref.nx ? 1 : 0;
    for (let i = 0; i < out.length && !bad; i++) {
      const q = Math.max(-32768, Math.min(32767, Math.floor(out[i] * 32768 + 0.5)));
      if (q !== Math.round(ref.z[1][i + 1] * 32768)) bad++;
    }
    console.log(bad ? 'FAIL' : 'ok  ', name, 'nota', n, out.length, 'muestras');
    failed += bad;
  }
}
process.exit(failed ? 1 : 0);
