// Chromatic Scale Generator (web) — pipeline de audio
//
// Reproduce chromatic_gen.py del programa original, llamada por llamada.
// El trabajo numérico lo hace praat.js, que es un port del código fuente de Praat
// (ver el encabezado de ese archivo). Sin DOM, así se puede probar en Node.
//
//   parselmouth.Sound(path)                      -> Sound_readFromWav
//   "Resample", 48000, 1                         -> Sound_resample
//   "Convert to mono"                            -> Sound_convertToMono
//   "To Manipulation", 0.05, 60, 600             -> Sound_to_Manipulation
//   "Extract pitch tier" + "Formula" + "Replace" -> PitchTier_setAllValues
//   "Get resynthesis (overlap-add)"              -> Manipulation_getResynthesis_overlapAdd
//   Sound.concatenate                            -> concatWithGaps
import {
  Sound_readFromWav, Sound_fromSamples, Sound_resample, Sound_convertToMono, Sound_toArray,
  Sound_to_Manipulation, PitchTier_setAllValues, Manipulation_getResynthesis_overlapAdd,
} from './praat.js';

export const SR = 48000;

// Nota del semitono `s` (s=0 -> C2), igual que el original:
// 32.703 * (2 ^ ((s + 12) / 12))
export function noteFreq(s) {
  return 32.703 * Math.pow(2, (s + 12) / 12);
}

// Sound de Praat a partir de un archivo. WAV: se lee tal cual (como Praat);
// otros formatos: `decode()` devuelve { channels: Float32Array[], sampleRate }.
export async function readSound(arrayBuffer, decode) {
  try {
    return Sound_readFromWav(arrayBuffer);
  } catch (e) {
    if (!decode) throw e;
    const { channels, sampleRate } = await decode(arrayBuffer);
    return Sound_fromSamples(channels, sampleRate);
  }
}

// "Resample" (48000, 1) + "Convert to mono"
export function prepareSound(sound) {
  return Sound_convertToMono(Sound_resample(sound, SR, 1));
}

// Muestras (0-based) de un Sound mono
export const soundData = Sound_toArray;

// "To Manipulation" (0.05, 60, 600): se calcula una vez por sample.
export function analyze(sound48) {
  const man = Sound_to_Manipulation(sound48, 0.05, 60, 600);
  return { man, voiced: man.pitch.points.length > 0 };
}

// "Formula" + "Replace pitch tier" + "Get resynthesis (overlap-add)" para una frecuencia.
export function resynth(analysis, targetHz) {
  const { man } = analysis;
  const pitch = { xmin: man.pitch.xmin, xmax: man.pitch.xmax, points: man.pitch.points.map((p) => ({ ...p })) };
  PitchTier_setAllValues(pitch, targetHz);
  const out = Manipulation_getResynthesis_overlapAdd({ ...man, pitch });
  return Sound_toArray(out);
}

export function concatWithGaps(parts, gapSamples) {
  let total = 0;
  for (const p of parts) total += p.length + gapSamples;
  const out = new Float64Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length + gapSamples; }
  return out;
}
