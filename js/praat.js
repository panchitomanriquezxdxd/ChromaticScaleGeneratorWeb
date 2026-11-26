// Praat (https://github.com/praat/praat, GPL-3.0+) -> JavaScript
//
// Port línea por línea del código fuente de Praat de las funciones que usa
// ChromaticScaleGenerator a través de Parselmouth:
//
//   Sound(path)                       fon/Sound_files.cpp, melder/melder_audiofiles.cpp
//   Resample (48000, 1)               fon/Sound.cpp: Sound_resample, Sound_upsample
//   Convert to mono                   fon/Sound.cpp: Sound_convertToMono
//   To Manipulation (0.05, 60, 600)   fon/Manipulation.cpp: Sound_to_Manipulation
//       Sound: To Pitch (rawAc)       fon/Sound_to_Pitch.cpp (AC_HANNING), fon/Pitch.cpp: Pitch_pathFinder
//       Sound & Pitch: To PointProc   fon/Pitch_to_PointProcess.cpp: Sound_Pitch_to_PointProcess_cc
//       Pitch: To PitchTier           fon/Pitch_to_PitchTier.cpp
//   PitchTier: Formula                fon/RealTier.cpp (la fórmula del original no depende de `self`)
//   Replace pitch tier                fon/Manipulation.cpp
//   Get resynthesis (overlap-add)     fon/Manipulation.cpp: synthesize_overlapAdd_nodur
//       PitchTier & Pulses -> Pulses  fon/PitchTier_to_PointProcess.cpp
//       Sound_Point_Point_to_Sound    fon/Manipulation.cpp
//   Sounds: Concatenate               fon/Sound.cpp: Sounds_concatenate
//   Sound: Save as WAV file           fon/Sound_files.cpp, melder/melder_audiofiles.cpp
//
// Los nombres siguen a los de Praat (xToLowIndex, nsamp_window, ...). Las
// matrices de Praat empiezan en 1; aquí los Float64Array de un Sound también
// (el elemento 0 no se usa) para que el código se pueda comparar con el original.
// Praat trabaja en doble precisión; aquí también.
//
// Única parte que no es copia literal: la FFT. Praat usa FFTPACK; aquí una FFT
// radix-2 con el mismo formato de salida (los resultados coinciden hasta el
// redondeo de punto flotante).

const NUMpi = Math.PI;
const NUM2pi = 2 * Math.PI;
const NUM_goldenSection = 0.6180339887498948482045868343656381177203;
// NUMfpp -> eps = dlamch ("Epsilon") = 2^-53 (LAPACK, con redondeo)
const NUMfpp_eps = 1.1102230246251565e-16;

const NUM_PEAK_INTERPOLATE_SINC70 = 3;
const NUM_PEAK_INTERPOLATE_SINC700 = 4;
const NUM_VALUE_INTERPOLATE_SINC70 = 70;
const NUM_VALUE_INTERPOLATE_SINC700 = 700;

const MAX_T = 0.02000000001; // fon/Manipulation.cpp: máximo intervalo entre dos pulsos de voz

const ifloor = Math.floor;
const iceiling = Math.ceil;
const iround = (x) => Math.floor(x + 0.5); // Melder_iround = tie up
const NUMlog2e = 1.4426950408889634073599246810018921;
const log2 = (x) => Math.log(x) * NUMlog2e;
const sqr = (x) => x * x;

// ---------------------------------------------------------------------------
// Sound (Sampled + Matrix): z[canal][1..nx]
// ---------------------------------------------------------------------------

export function Sound_create(ny, xmin, xmax, nx, dx, x1) {
  const z = [];
  for (let c = 1; c <= ny; c++) z[c] = new Float64Array(nx + 1);
  return { ny, xmin, xmax, nx, dx, x1, z };
}

const Sampled_indexToX = (me, index) => me.x1 + (index - 1) * me.dx;
const Sampled_xToIndex = (me, x) => (x - me.x1) / me.dx + 1.0;
const Sampled_xToLowIndex = (me, x) => ifloor((x - me.x1) / me.dx + 1.0);
const Sampled_xToHighIndex = (me, x) => iceiling((x - me.x1) / me.dx + 1.0);
const Sampled_xToNearestIndex = (me, x) => iround((x - me.x1) / me.dx + 1.0);

// Suma compensada (Neumaier): emula el `longdouble` que usa Praat en las medias.
function mean1(z, n) {
  let sum = 0, c = 0;
  for (let i = 1; i <= n; i++) {
    const v = z[i], t = sum + v;
    c += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return (sum + c) / n;
}

// ---------------------------------------------------------------------------
// Lectura de WAV (Melder_readAudioToFloat) -> Sound_createSimple
// ---------------------------------------------------------------------------

export function Sound_readFromWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (arrayBuffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let fmt = null, dataStart = -1, dataLen = 0;
  let o = 12;
  while (o + 8 <= arrayBuffer.byteLength) {
    const id = tag(o), len = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = { tag: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
      if (fmt.tag === 0xfffe && len >= 26) fmt.tag = v.getUint16(o + 8 + 24, true); // WAVE_FORMAT_EXTENSIBLE: subformat
    } else if (id === 'data') {
      dataStart = o + 8;
      dataLen = Math.min(len, arrayBuffer.byteLength - dataStart);
      break;
    }
    o += 8 + len + (len & 1);
  }
  if (!fmt || dataStart < 0) throw new Error('Not an audio file.');
  const { ch: numberOfChannels, rate: sampleRate, bits } = fmt;
  const bytes = bits >> 3;
  if (!numberOfChannels || !bytes) throw new Error('Unsupported WAV.');
  const numberOfSamples = Math.floor(dataLen / (bytes * numberOfChannels));
  if (numberOfSamples < 1) throw new Error('Audio file contains 0 samples.');
  const pcm = fmt.tag === 1, flt = fmt.tag === 3;
  if (!(pcm && (bits === 8 || bits === 16 || bits === 24 || bits === 32)) && !(flt && (bits === 32 || bits === 64))) {
    throw new Error('Unsupported WAV encoding.');
  }
  // Sound_createSimple (numberOfChannels, numberOfSamples / sampleRate, sampleRate)
  const duration = numberOfSamples / sampleRate;
  const me = Sound_create(numberOfChannels, 0.0, duration, Math.round(duration * sampleRate), 1.0 / sampleRate, 0.5 / sampleRate);
  let p = dataStart;
  for (let i = 1; i <= numberOfSamples; i++) {
    for (let c = 1; c <= numberOfChannels; c++) {
      let x;
      if (pcm) {
        if (bits === 8) x = v.getUint8(p) * (1.0 / 128) - 1.0;
        else if (bits === 16) x = v.getInt16(p, true) * (1.0 / 32768);
        else if (bits === 24) x = ((v.getInt8(p + 2) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p)) * (1.0 / 32768 / 256);
        else x = v.getInt32(p, true) * (1.0 / 32768 / 65536);
      } else {
        x = bits === 32 ? v.getFloat32(p, true) : v.getFloat64(p, true);
      }
      me.z[c][i] = x;
      p += bytes;
    }
  }
  return me;
}

// Sound a partir de muestras ya decodificadas (para formatos que no son WAV).
export function Sound_fromSamples(channels, sampleRate) {
  const n = channels[0].length;
  const duration = n / sampleRate;
  const me = Sound_create(channels.length, 0.0, duration, Math.round(duration * sampleRate), 1.0 / sampleRate, 0.5 / sampleRate);
  channels.forEach((ch, c) => { for (let i = 0; i < n; i++) me.z[c + 1][i + 1] = ch[i]; });
  return me;
}

// ---------------------------------------------------------------------------
// FFT real (formato de salida de FFTPACK: [X0, Re X1, Im X1, ..., Re X(n/2)])
// ---------------------------------------------------------------------------

const fftCache = new Map();
function fftTable(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / n); sin[k] = Math.sin((2 * Math.PI * k) / n); }
  const rev = new Uint32Array(n);
  let bitsN = 0;
  while ((1 << bitsN) < n) bitsN++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bitsN; b++) if (i & (1 << b)) r |= 1 << (bitsN - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  fftCache.set(n, t);
  return t;
}

// FFT compleja in situ; sign = -1 (hacia delante) o +1 (hacia atrás), sin normalizar.
function cfft(re, im, n, sign) {
  const { cos, sin, rev } = fftTable(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const wr = cos[tw], wi = sign * sin[tw];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// data: Float64Array de 1..n (1-based, como en Praat). n potencia de dos.
function NUMfft_forward(data, n) {
  if (n === 1) return;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = data[i + 1];
  cfft(re, im, n, -1);
  data[1] = re[0];
  for (let k = 1; k < n / 2; k++) { data[2 * k] = re[k]; data[2 * k + 1] = im[k]; }
  data[n] = re[n / 2];
}

function NUMfft_backward(data, n) {
  if (n === 1) return;
  const re = new Float64Array(n), im = new Float64Array(n);
  re[0] = data[1];
  for (let k = 1; k < n / 2; k++) {
    re[k] = data[2 * k]; im[k] = data[2 * k + 1];
    re[n - k] = data[2 * k]; im[n - k] = -data[2 * k + 1];
  }
  re[n / 2] = data[n];
  cfft(re, im, n, +1);
  for (let i = 0; i < n; i++) data[i + 1] = re[i];
}

// dwsys/NUMFourier.cpp: NUMrealft (con el orden "antiguo": el Nyquist va en data[2])
function NUMrealft(data, n, isign) {
  if (isign === 1) {
    NUMfft_forward(data, n);
    if (n > 1) {
      const tmp = data[n];
      for (let i = n; i > 2; i--) data[i] = data[i - 1];
      data[2] = tmp;
    }
  } else {
    if (n > 1) {
      const tmp = data[2];
      for (let i = 2; i < n; i++) data[i] = data[i + 1];
      data[n] = tmp;
    }
    NUMfft_backward(data, n);
  }
}

function iroundUpToPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// ---------------------------------------------------------------------------
// Sound: upsample / resample / mono / media
// ---------------------------------------------------------------------------

function Sound_upsample(me) {
  const antiTurnAround = 1000, sampleRateFactor = 2, numberOfPaddingSides = 2;
  const nfft = iroundUpToPowerOfTwo(me.nx + antiTurnAround * numberOfPaddingSides);
  const newDx = me.dx / sampleRateFactor;
  const thee = Sound_create(me.ny, me.xmin, me.xmax, me.nx * sampleRateFactor, newDx, me.x1 - 0.5 * (me.dx - newDx));
  for (let ichan = 1; ichan <= me.ny; ichan++) {
    const data = new Float64Array(sampleRateFactor * nfft + 1);
    for (let i = 1; i <= me.nx; i++) data[antiTurnAround + i] = me.z[ichan][i];
    NUMrealft(data, nfft, 1); // sobre data.part (1, nfft)
    const imin = Math.trunc(nfft * 0.95);
    for (let i = imin + 1; i <= nfft; i++) data[i] *= (nfft - i) / (nfft - imin);
    data[2] = 0.0;
    NUMrealft(data, sampleRateFactor * nfft, -1);
    const factor = 1.0 / nfft;
    for (let i = 1; i <= thee.nx; i++) thee.z[ichan][i] = data[i + sampleRateFactor * antiTurnAround] * factor;
  }
  return thee;
}

function copySound(me) {
  const thee = Sound_create(me.ny, me.xmin, me.xmax, me.nx, me.dx, me.x1);
  for (let c = 1; c <= me.ny; c++) thee.z[c].set(me.z[c]);
  return thee;
}

// precision <= 1: interpolación lineal (es lo que usa el original: Resample (48000, 1))
export function Sound_resample(me, samplingFrequency, precision) {
  const upfactor = samplingFrequency * me.dx;
  if (Math.abs(upfactor - 2.0) < 1e-6) return Sound_upsample(me);
  if (Math.abs(upfactor - 1.0) < 1e-6) return copySound(me);
  const numberOfSamples = iround((me.xmax - me.xmin) * samplingFrequency);
  if (numberOfSamples < 1) throw new Error('The resampled Sound would have no samples.');
  let src = me;
  if (upfactor < 1.0) { // hace falta un filtro anti-aliasing
    const antiTurnAround = 1000, numberOfPaddingSides = 2;
    const nfft = iroundUpToPowerOfTwo(me.nx + antiTurnAround * numberOfPaddingSides);
    const filtered = Sound_create(me.ny, me.xmin, me.xmax, me.nx, me.dx, me.x1);
    for (let ichan = 1; ichan <= me.ny; ichan++) {
      const data = new Float64Array(nfft + 1);
      for (let i = 1; i <= me.nx; i++) data[antiTurnAround + i] = me.z[ichan][i];
      NUMrealft(data, nfft, 1);
      for (let i = ifloor(upfactor * nfft); i <= nfft; i++) data[i] = 0.0;
      data[2] = 0.0;
      NUMrealft(data, nfft, -1);
      const factor = 1.0 / nfft;
      for (let i = 1; i <= me.nx; i++) filtered.z[ichan][i] = data[i + antiTurnAround] * factor;
    }
    src = filtered;
  }
  const thee = Sound_create(me.ny, me.xmin, me.xmax, numberOfSamples, 1.0 / samplingFrequency,
    0.5 * (me.xmin + me.xmax - (numberOfSamples - 1) / samplingFrequency));
  if (precision > 1) throw new Error('Only precision <= 1 is ported.');
  for (let ichan = 1; ichan <= me.ny; ichan++) {
    for (let i = 1; i <= numberOfSamples; i++) {
      const x = Sampled_indexToX(thee, i);
      const index = Sampled_xToIndex(src, x);
      const leftSample = ifloor(index);
      const fraction = index - leftSample;
      thee.z[ichan][i] = leftSample < 1 || leftSample >= src.nx ? 0.0 :
        (1 - fraction) * src.z[ichan][leftSample] + fraction * src.z[ichan][leftSample + 1];
    }
  }
  return thee;
}

export function Sound_convertToMono(me) {
  if (me.ny === 1) return copySound(me);
  const thee = Sound_create(1, me.xmin, me.xmax, me.nx, me.dx, me.x1);
  if (me.ny === 2) {
    for (let i = 1; i <= me.nx; i++) thee.z[1][i] = 0.5 * (me.z[1][i] + me.z[2][i]);
  } else {
    for (let i = 1; i <= me.nx; i++) {
      let sum = me.z[1][i] + me.z[2][i] + me.z[3][i];
      for (let c = 4; c <= me.ny; c++) sum += me.z[c][i];
      thee.z[1][i] = sum / me.ny;
    }
  }
  return thee;
}

// Vector_subtractMean: centre_VEC_inout (resta la media de cada canal)
function Vector_subtractMean(me) {
  for (let c = 1; c <= me.ny; c++) {
    const mean = mean1(me.z[c], me.nx);
    for (let i = 1; i <= me.nx; i++) me.z[c][i] -= mean;
  }
}

// ---------------------------------------------------------------------------
// melder/NUMinterpol.cpp
// ---------------------------------------------------------------------------

// y: Float64Array 0-based con `size` elementos (y[k-1] es el elemento k de Praat)
function NUM_interpolate_sinc(y, size, x, maxDepth) {
  const midleft = ifloor(x), midright = midleft + 1;
  let result = 0.0;
  if (size < 1) return NaN;
  if (x < 1) return y[0];
  if (x > size) return y[size - 1];
  if (x === midleft) return y[midleft - 1];
  maxDepth = Math.min(maxDepth, midright - 1);
  maxDepth = Math.min(maxDepth, size - midleft);
  if (maxDepth <= 0) return y[iround(x) - 1];
  if (maxDepth === 1) return y[midleft - 1] + (x - midleft) * (y[midright - 1] - y[midleft - 1]);
  if (maxDepth === 2) {
    const yl = y[midleft - 1], yr = y[midright - 1];
    const dyl = 0.5 * (yr - y[midleft - 2]), dyr = 0.5 * (y[midright] - yl);
    const fil = x - midleft, fir = midright - x;
    return yl * fir + yr * fil - fil * fir * (0.5 * (dyr - dyl) + (fil - 0.5) * (dyl + dyr - 2 * (yr - yl)));
  }
  const left = midright - maxDepth, right = midleft + maxDepth;
  { // mitad izquierda
    const leftDepth = maxDepth + 0.5;
    const windowPhaseStep = NUMpi / leftDepth;
    const sinWindowPhaseStep = Math.sin(windowPhaseStep), cosWindowPhaseStep = Math.cos(windowPhaseStep);
    let leftPhase = NUMpi * (x - midleft);
    let halfSinLeftPhase = 0.5 * Math.sin(leftPhase);
    const windowPhase = leftPhase / leftDepth;
    let sinWindowPhase = Math.sin(windowPhase), cosWindowPhase = Math.cos(windowPhase);
    for (let ix = midleft; ix >= left; ix--) {
      const sincTimesWindow = halfSinLeftPhase / leftPhase * (1.0 + cosWindowPhase);
      result += y[ix - 1] * sincTimesWindow;
      leftPhase += NUMpi;
      halfSinLeftPhase = -halfSinLeftPhase;
      const nextSin = cosWindowPhase * sinWindowPhaseStep + sinWindowPhase * cosWindowPhaseStep;
      const nextCos = cosWindowPhase * cosWindowPhaseStep - sinWindowPhase * sinWindowPhaseStep;
      sinWindowPhase = nextSin; cosWindowPhase = nextCos;
    }
  }
  { // mitad derecha
    const rightDepth = maxDepth + 0.5;
    const windowPhaseStep = NUMpi / rightDepth;
    const sinWindowPhaseStep = Math.sin(windowPhaseStep), cosWindowPhaseStep = Math.cos(windowPhaseStep);
    let rightPhase = NUMpi * (midright - x);
    let halfSinRightPhase = 0.5 * Math.sin(rightPhase);
    const windowPhase = rightPhase / rightDepth;
    let sinWindowPhase = Math.sin(windowPhase), cosWindowPhase = Math.cos(windowPhase);
    for (let ix = midright; ix <= right; ix++) {
      const sincTimesWindow = halfSinRightPhase / rightPhase * (1.0 + cosWindowPhase);
      result += y[ix - 1] * sincTimesWindow;
      rightPhase += NUMpi;
      halfSinRightPhase = -halfSinRightPhase;
      const nextSin = cosWindowPhase * sinWindowPhaseStep + sinWindowPhase * cosWindowPhaseStep;
      const nextCos = cosWindowPhase * cosWindowPhaseStep - sinWindowPhase * sinWindowPhaseStep;
      sinWindowPhase = nextSin; cosWindowPhase = nextCos;
    }
  }
  return result;
}

// dwsys/NUM2.cpp: NUMminimize_brent. Devuelve [x, fx].
function NUMminimize_brent(f, a, b, tol) {
  const golden = 1 - NUM_goldenSection;
  const sqrt_epsilon = Math.sqrt(NUMfpp_eps);
  const itermax = 60;
  let v = a + golden * (b - a);
  let fv = f(v);
  let x = v, w = v;
  let fx = fv;
  let fw = fv;
  for (let iter = 1; iter <= itermax; iter++) {
    const middle_range = (a + b) / 2.0;
    const tol_act = sqrt_epsilon * Math.abs(x) + tol / 3.0;
    const range = b - a;
    if (Math.abs(x - middle_range) + range / 2.0 <= 2.0 * tol_act) return [x, fx];
    let new_step = golden * (x < middle_range ? b - x : a - x);
    if (Math.abs(x - w) >= tol_act) {
      const t = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * t;
      q = 2.0 * (q - t);
      if (q > 0.0) p = -p; else q = -q;
      if (Math.abs(p) < Math.abs(new_step * q) && p > q * (a - x + 2.0 * tol_act) && p < q * (b - x - 2.0 * tol_act)) {
        new_step = p / q;
      }
    }
    if (Math.abs(new_step) < tol_act) new_step = new_step > 0.0 ? tol_act : -tol_act;
    {
      const t = x + new_step;
      const ft = f(t);
      if (ft <= fx) {
        if (t < x) b = x; else a = x;
        v = w; w = x; x = t;
        fv = fw; fw = fx; fx = ft;
      } else {
        if (t < x) a = t; else b = t;
        if (ft <= fw || w === x) {
          v = w; w = t; fv = fw; fw = ft;
        } else if (ft <= fv || v === x || v === w) {
          v = t; fv = ft;
        }
      }
    }
  }
  return [x, fx];
}

// NUMimproveMaximum (y 0-based con `size` elementos). Devuelve [ymax, ixmid_real].
function NUMimproveMaximum(y, size, ixmid, interpolationDepth) {
  if (ixmid <= 1) return [y[0], 1];
  if (ixmid >= size) return [y[size - 1], size];
  if (interpolationDepth <= 0) return [y[ixmid - 1], ixmid];
  if (interpolationDepth === 1) {
    const dy = 0.5 * (y[ixmid] - y[ixmid - 2]);
    const d2y = (y[ixmid - 1] - y[ixmid - 2]) + (y[ixmid - 1] - y[ixmid]);
    return [y[ixmid - 1] + 0.5 * dy * dy / d2y, ixmid + dy / d2y];
  }
  const depth = interpolationDepth === 2 ? 2 : interpolationDepth === NUM_PEAK_INTERPOLATE_SINC70 ? NUM_VALUE_INTERPOLATE_SINC70 : NUM_VALUE_INTERPOLATE_SINC700;
  const [xmid, fx] = NUMminimize_brent((x) => -NUM_interpolate_sinc(y, size, x, depth), ixmid - 1, ixmid + 1, 1e-10);
  return [-fx, xmid];
}

// ---------------------------------------------------------------------------
// fon/Sound_to_Pitch.cpp (método AC_HANNING = rawAc con veryAccurate = false)
// ---------------------------------------------------------------------------

const Pitch_util_frequencyIsVoiced = (f, ceiling) => f > 0.0 && f < ceiling;

function Pitch_Frame_init(maxnCandidates) {
  const candidates = [];
  for (let i = 1; i <= maxnCandidates; i++) candidates[i] = { frequency: 0.0, strength: 0.0 };
  return { intensity: 0.0, nCandidates: 1, candidates };
}

function Sound_into_PitchFrame(me, pitchFrame, t, c) {
  const { pitchFloor, maxnCandidates, voicingThreshold, octaveCost, nsamp_window, halfnsamp_window,
    maximumLag, nsampFFT, nsamp_period, halfnsamp_period, brent_ixmax, brent_depth, globalPeak,
    frame, ac, window, windowR, rb, W, imax } = c;
  const z = me.z[1];
  const leftSample = Sampled_xToLowIndex(me, t), rightSample = leftSample + 1;
  let startSample, endSample;

  // media local: una "periodo más largo" a cada lado
  startSample = rightSample - nsamp_period;
  endSample = leftSample + nsamp_period;
  let localMean = 0.0;
  for (let i = startSample; i <= endSample; i++) localMean += z[i];
  localMean /= 2 * nsamp_period;

  // copia la ventana al frame, quita la media local y aplica la ventana
  startSample = rightSample - halfnsamp_window;
  endSample = leftSample + halfnsamp_window;
  for (let j = 1, i = startSample; j <= nsamp_window; j++) frame[j] = (z[i++] - localMean) * window[j];
  for (let j = nsamp_window + 1; j <= nsampFFT; j++) frame[j] = 0.0;

  // pico local: medio periodo más largo a cada lado
  let localPeak = 0.0;
  if ((startSample = halfnsamp_window + 1 - halfnsamp_period) < 1) startSample = 1;
  if ((endSample = halfnsamp_window + halfnsamp_period) > nsamp_window) endSample = nsamp_window;
  for (let j = startSample; j <= endSample; j++) {
    const value = Math.abs(frame[j]);
    if (value > localPeak) localPeak = value;
  }
  pitchFrame.intensity = localPeak > globalPeak ? 1.0 : localPeak / globalPeak;

  // la FFT de la autocorrelación es el espectro de potencia
  for (let i = 1; i <= nsampFFT; i++) ac[i] = 0.0;
  NUMfft_forward(frame, nsampFFT);
  ac[1] += frame[1] * frame[1];
  for (let i = 2; i < nsampFFT; i += 2) ac[i] += frame[i] * frame[i] + frame[i + 1] * frame[i + 1];
  ac[nsampFFT] += frame[nsampFFT] * frame[nsampFFT];
  NUMfft_backward(ac, nsampFFT);

  // normaliza; r[i] = rb[W + i]
  rb[W] = 1.0;
  for (let i = 1; i <= brent_ixmax; i++) rb[W - i] = rb[W + i] = ac[i + 1] / (ac[1] * windowR[i + 1]);

  // primer candidato: sordo
  pitchFrame.nCandidates = 1;
  pitchFrame.candidates[1].frequency = 0.0;
  pitchFrame.candidates[1].strength = 0.0;
  if (localPeak === 0.0) return;

  // vista de r[-brent_ixmax .. brent_ixmax] como vector de Praat (1-based <-> 0-based)
  const ysize = 2 * brent_ixmax + 1;
  const y = rb.subarray(W - brent_ixmax, W + brent_ixmax + 1);
  const offset = -brent_ixmax - 1;

  imax[1] = 0;
  for (let i = 2; i < maximumLag && i < brent_ixmax; i++) {
    const ri = rb[W + i], rm = rb[W + i - 1], rp = rb[W + i + 1];
    if (ri > 0.5 * voicingThreshold && ri > rm && ri >= rp) {
      let place = 0;
      const dr = 0.5 * (rp - rm);
      const d2r = (ri - rm) + (ri - rp);
      const frequencyOfMaximum = 1.0 / me.dx / (i + dr / d2r);
      let strengthOfMaximum = NUM_interpolate_sinc(y, ysize, 1.0 / me.dx / frequencyOfMaximum - offset, 30);
      if (strengthOfMaximum > 1.0) strengthOfMaximum = 1.0 / strengthOfMaximum;

      if (pitchFrame.nCandidates < maxnCandidates) {
        place = ++pitchFrame.nCandidates;
      } else {
        let weakest = 2.0;
        for (let iweak = 2; iweak <= maxnCandidates; iweak++) {
          const localStrength = pitchFrame.candidates[iweak].strength - octaveCost *
            log2(pitchFloor / pitchFrame.candidates[iweak].frequency);
          if (localStrength < weakest) { weakest = localStrength; place = iweak; }
        }
        if (strengthOfMaximum - octaveCost * log2(pitchFloor / frequencyOfMaximum) <= weakest) place = 0;
      }
      if (place) {
        pitchFrame.candidates[place].frequency = frequencyOfMaximum;
        pitchFrame.candidates[place].strength = strengthOfMaximum;
        imax[place] = i;
      }
    }
  }

  // segunda pasada: maximiza la interpolación sinc
  for (let i = 2; i <= pitchFrame.nCandidates; i++) {
    const cand = pitchFrame.candidates[i];
    if (cand.frequency > 0.0 / me.dx) {
      let [ymid, xmid] = NUMimproveMaximum(y, ysize, imax[i] - offset,
        cand.frequency > 0.3 / me.dx ? NUM_PEAK_INTERPOLATE_SINC700 : brent_depth);
      xmid += offset;
      cand.frequency = 1.0 / me.dx / xmid;
      if (ymid > 1.0) ymid = 1.0 / ymid;
      cand.strength = ymid;
    }
  }
}

// fon/Pitch.cpp: Pitch_pathFinder (Viterbi)
function Pitch_pathFinder(me, silenceThreshold, voicingThreshold, octaveCost, octaveJumpCost, voicedUnvoicedCost, ceiling) {
  const maxnCandidates = me.maxnCandidates;
  const ceiling2 = ceiling; // pullFormants = false
  const timeStepCorrection = 0.01 / me.dx;
  octaveJumpCost *= timeStepCorrection;
  voicedUnvoicedCost *= timeStepCorrection;
  me.ceiling = ceiling;

  const delta = [], psi = [];
  for (let iframe = 1; iframe <= me.nx; iframe++) {
    delta[iframe] = new Float64Array(maxnCandidates + 1);
    psi[iframe] = new Int32Array(maxnCandidates + 1);
    const frame = me.frames[iframe];
    let unvoicedStrength = silenceThreshold <= 0 ? 0.0 : 2.0 - frame.intensity / (silenceThreshold / (1.0 + voicingThreshold));
    unvoicedStrength = voicingThreshold + Math.max(0.0, unvoicedStrength);
    for (let icand = 1; icand <= frame.nCandidates; icand++) {
      const candidate = frame.candidates[icand];
      const voiceless = !Pitch_util_frequencyIsVoiced(candidate.frequency, ceiling2);
      delta[iframe][icand] = voiceless ? unvoicedStrength : candidate.strength - octaveCost * log2(ceiling / candidate.frequency);
    }
  }

  for (let iframe = 2; iframe <= me.nx; iframe++) {
    const prevFrame = me.frames[iframe - 1], curFrame = me.frames[iframe];
    const prevDelta = delta[iframe - 1], curDelta = delta[iframe], curPsi = psi[iframe];
    for (let icand2 = 1; icand2 <= curFrame.nCandidates; icand2++) {
      const f2 = curFrame.candidates[icand2].frequency;
      let maximum = -1e30, place = 0;
      for (let icand1 = 1; icand1 <= prevFrame.nCandidates; icand1++) {
        const f1 = prevFrame.candidates[icand1].frequency;
        let transitionCost;
        const previousVoiceless = !Pitch_util_frequencyIsVoiced(f1, ceiling2);
        const currentVoiceless = !Pitch_util_frequencyIsVoiced(f2, ceiling2);
        if (currentVoiceless) {
          transitionCost = previousVoiceless ? 0.0 : voicedUnvoicedCost;
        } else if (previousVoiceless) {
          transitionCost = voicedUnvoicedCost;
        } else {
          transitionCost = octaveJumpCost * Math.abs(log2(f1 / f2));
        }
        const value = prevDelta[icand1] - transitionCost + curDelta[icand2];
        if (value > maximum) { maximum = value; place = icand1; }
      }
      curDelta[icand2] = maximum;
      curPsi[icand2] = place;
    }
  }

  let place = 1;
  let maximum = delta[me.nx][place];
  for (let icand = 2; icand <= me.frames[me.nx].nCandidates; icand++) {
    if (delta[me.nx][icand] > maximum) { place = icand; maximum = delta[me.nx][place]; }
  }
  for (let iframe = me.nx; iframe >= 1; iframe--) {
    const frame = me.frames[iframe];
    const tmp = frame.candidates[1]; frame.candidates[1] = frame.candidates[place]; frame.candidates[place] = tmp;
    place = psi[iframe][place];
  }
}

// Sound_to_Pitch_any con method = AC_HANNING, periodsPerWindow = 3
export function Sound_to_Pitch(me, dt, pitchFloor, pitchCeiling,
  maxnCandidates = 15, silenceThreshold = 0.03, voicingThreshold = 0.45,
  octaveCost = 0.01, octaveJumpCost = 0.35, voicedUnvoicedCost = 0.14) {
  const periodsPerWindow = 3.0;
  if (maxnCandidates < pitchCeiling / pitchFloor) maxnCandidates = ifloor(pitchCeiling / pitchFloor);
  if (dt <= 0.0) dt = periodsPerWindow / pitchFloor / 4.0;
  const brent_depth = NUM_PEAK_INTERPOLATE_SINC70;
  const interpolation_depth = 0.5;
  const duration = me.dx * me.nx;
  if (pitchFloor < periodsPerWindow / duration) {
    throw new Error(`To analyse this Sound, "pitch floor" must not be less than ${periodsPerWindow / duration} Hz.`);
  }

  const nsamp_period = ifloor(1.0 / me.dx / pitchFloor);
  const halfnsamp_period = Math.trunc(nsamp_period / 2) + 1;
  pitchCeiling = Math.min(pitchCeiling, 0.5 / me.dx);

  const dt_window = periodsPerWindow / pitchFloor;
  let nsamp_window = ifloor(dt_window / me.dx);
  const halfnsamp_window = Math.trunc(nsamp_window / 2) - 1;
  if (halfnsamp_window < 2) throw new Error('Analysis window too short.');
  nsamp_window = halfnsamp_window * 2;

  const minimumLag = Math.max(2, ifloor(1.0 / me.dx / pitchCeiling));
  void minimumLag;
  const maximumLag = Math.min(ifloor(nsamp_window / periodsPerWindow) + 2, nsamp_window);

  // Sampled_shortTermAnalysis
  if (dt_window > duration) throw new Error('The pitch analysis would give zero pitch frames.');
  const numberOfFrames = ifloor((duration - dt_window) / dt) + 1;
  const ourMidTime = me.x1 - 0.5 * me.dx + 0.5 * duration;
  const thyDuration = numberOfFrames * dt;
  const t1 = ourMidTime - 0.5 * thyDuration + 0.5 * dt;

  const thee = { xmin: me.xmin, xmax: me.xmax, nx: numberOfFrames, dx: dt, x1: t1, ceiling: pitchCeiling, maxnCandidates, frames: [] };
  for (let iframe = 1; iframe <= numberOfFrames; iframe++) thee.frames[iframe] = Pitch_Frame_init(maxnCandidates);

  // pico global absoluto (para el umbral de silencio)
  let globalPeak = 0.0;
  {
    const mean = mean1(me.z[1], me.nx);
    for (let i = 1; i <= me.nx; i++) {
      const value = Math.abs(me.z[1][i] - mean);
      if (value > globalPeak) globalPeak = value;
    }
  }
  if (globalPeak === 0.0) return thee;

  let nsampFFT = 1;
  while (nsampFFT < nsamp_window * (1 + interpolation_depth)) nsampFFT *= 2;

  const window = new Float64Array(nsamp_window + 1);
  const windowR = new Float64Array(nsampFFT + 1);
  for (let i = 1; i <= nsamp_window; i++) window[i] = 0.5 - 0.5 * Math.cos(NUM2pi * i / (nsamp_window + 1));
  for (let i = 1; i <= nsamp_window; i++) windowR[i] = window[i];
  NUMfft_forward(windowR, nsampFFT);
  windowR[1] *= windowR[1];
  for (let i = 2; i < nsampFFT; i += 2) {
    windowR[i] = windowR[i] * windowR[i] + windowR[i + 1] * windowR[i + 1];
    windowR[i + 1] = 0.0;
  }
  windowR[nsampFFT] *= windowR[nsampFFT];
  NUMfft_backward(windowR, nsampFFT);
  for (let i = 2; i <= nsamp_window; i++) windowR[i] /= windowR[1];
  windowR[1] = 1.0;

  const brent_ixmax = ifloor(nsamp_window * interpolation_depth);

  const ctx = {
    pitchFloor, maxnCandidates, voicingThreshold, octaveCost, nsamp_window, halfnsamp_window,
    maximumLag, nsampFFT, nsamp_period, halfnsamp_period, brent_ixmax, brent_depth, globalPeak,
    frame: new Float64Array(nsampFFT + 1), ac: new Float64Array(nsampFFT + 1), window, windowR,
    rb: new Float64Array(2 * nsamp_window + 1), W: nsamp_window, imax: new Int32Array(maxnCandidates + 1),
  };
  for (let iframe = 1; iframe <= numberOfFrames; iframe++) {
    const time = Sampled_indexToX(thee, iframe);
    Sound_into_PitchFrame(me, thee.frames[iframe], time, ctx);
  }

  Pitch_pathFinder(thee, silenceThreshold, voicingThreshold, octaveCost, octaveJumpCost, voicedUnvoicedCost, pitchCeiling);
  return thee;
}

// ---------------------------------------------------------------------------
// Pitch: valores en el tiempo (fon/Sampled.cpp, fon/Pitch.cpp)
// ---------------------------------------------------------------------------

const Pitch_isVoiced_i = (me, i) => Pitch_util_frequencyIsVoiced(me.frames[i].candidates[1].frequency, me.ceiling);
const Pitch_valueAtSample = (me, i) => (Pitch_isVoiced_i(me, i) ? me.frames[i].candidates[1].frequency : NaN);

// Sampled_getValueAtX (..., interpolate = true); NaN = undefined
function Pitch_getValueAtTime_linear(me, x) {
  if (x < me.xmin || x > me.xmax) return NaN;
  const index_real = Sampled_xToIndex(me, x);
  const leftIndex = ifloor(index_real);
  let nearIndex, farIndex;
  let phase = index_real - leftIndex;
  if (phase < 0.5) { nearIndex = leftIndex; farIndex = leftIndex + 1; }
  else { farIndex = leftIndex; nearIndex = leftIndex + 1; phase = 1.0 - phase; }
  if (nearIndex < 1 || nearIndex > me.nx) return NaN;
  const nearValue = Pitch_valueAtSample(me, nearIndex);
  if (Number.isNaN(nearValue)) return NaN;
  if (farIndex < 1 || farIndex > me.nx) return nearValue;
  const farValue = Pitch_valueAtSample(me, farIndex);
  if (Number.isNaN(farValue)) return nearValue;
  return nearValue + phase * (farValue - nearValue);
}

// ---------------------------------------------------------------------------
// PointProcess: t[1..nt]
// ---------------------------------------------------------------------------

function PointProcess_create(xmin, xmax) { return { xmin, xmax, nt: 0, t: [0] }; }

function PointProcess_getLowIndex(me, t) {
  if (me.nt === 0 || t < me.t[1]) return 0;
  if (t >= me.t[me.nt]) return me.nt;
  let left = 1, right = me.nt;
  while (left < right - 1) {
    const mid = (left + right) >> 1;
    if (t >= me.t[mid]) left = mid; else right = mid;
  }
  return left;
}

function PointProcess_addPoint(me, t) {
  if (Number.isNaN(t)) throw new Error('Cannot add a point at an undefined time.');
  if (me.nt === 0 || t >= me.t[me.nt]) {
    me.t[++me.nt] = t;
  } else {
    const left = PointProcess_getLowIndex(me, t);
    if (left === 0 || me.t[left] !== t) {
      me.t.splice(left + 1, 0, t);
      me.nt++;
    }
  }
}

function PointProcess_getNearestIndex(me, t) {
  if (me.nt === 0) return 0;
  if (t <= me.t[1]) return 1;
  if (t >= me.t[me.nt]) return me.nt;
  let left = 1, right = me.nt;
  while (left < right - 1) {
    const mid = (left + right) >> 1;
    if (t >= me.t[mid]) left = mid; else right = mid;
  }
  return t - me.t[left] < me.t[right] - t ? left : right;
}

// ---------------------------------------------------------------------------
// fon/Pitch_to_PointProcess.cpp: Sound_Pitch_to_PointProcess_cc
// ---------------------------------------------------------------------------

function Pitch_getVoicedIntervalAfter(me, after, out) {
  let ileft = Sampled_xToHighIndex(me, after), iright;
  if (ileft > me.nx) return false;
  if (ileft < 1) ileft = 1;
  for (; ileft <= me.nx; ileft++) if (Pitch_isVoiced_i(me, ileft)) break;
  if (ileft > me.nx) return false;
  for (iright = ileft; iright <= me.nx; iright++) if (!Pitch_isVoiced_i(me, iright)) break;
  iright--;
  out.tleft = Sampled_indexToX(me, ileft) - 0.5 * me.dx;
  out.tright = Sampled_indexToX(me, iright) + 0.5 * me.dx;
  if (out.tleft >= me.xmax - 0.5 * me.dx) return false;
  if (out.tleft < me.xmin) out.tleft = me.xmin;
  if (out.tright > me.xmax) out.tright = me.xmax;
  if (out.tright <= after) return false;
  return true;
}

// findExtremum_3 con un solo canal; d es el desplazamiento (imin - 1), n el número de muestras
function findExtremum_3(z, d, n, includeMaxima, includeMinima) {
  const includeAll = includeMaxima === includeMinima;
  let imin = 1, imax = 1;
  if (n < 3) {
    if (n <= 0) return 0.0;
    if (n === 1) return 1.0;
    const x1 = z[d + 1], x2 = z[d + 2];
    const xleft = includeAll ? Math.abs(x1) : includeMaxima ? x1 : -x1;
    const xright = includeAll ? Math.abs(x2) : includeMaxima ? x2 : -x2;
    if (xleft > xright) return 1.0;
    if (xleft < xright) return 2.0;
    return 1.5;
  }
  let minimum = z[d + 1], maximum = z[d + 1];
  for (let i = 2; i <= n; i++) {
    const value = z[d + i];
    if (value < minimum) { minimum = value; imin = i; }
    if (value > maximum) { maximum = value; imax = i; }
  }
  if (minimum === maximum) return 0.5 * (n + 1.0);
  const iextr = includeAll ? (Math.abs(minimum) > Math.abs(maximum) ? imin : imax) : includeMaxima ? imax : imin;
  if (iextr === 1) return 1.0;
  if (iextr === n) return n;
  const valueMid = z[d + iextr], valueLeft = z[d + iextr - 1], valueRight = z[d + iextr + 1];
  return iextr + 0.5 * (valueRight - valueLeft) / (2 * valueMid - valueLeft - valueRight);
}

function Sound_findExtremum(me, tmin, tmax, includeMaxima, includeMinima) {
  const imin = Math.max(1, Sampled_xToLowIndex(me, tmin));
  const imax = Math.min(Sampled_xToHighIndex(me, tmax), me.nx);
  const iextremum = findExtremum_3(me.z[1], imin - 1, imax - imin + 1, includeMaxima, includeMinima);
  if (iextremum !== 0.0) return me.x1 + (imin - 1 + iextremum - 1) * me.dx;
  return 0.5 * (tmin + tmax);
}

// Devuelve { correlation, tout, peak }
function Sound_findMaximumCorrelation(me, t1, windowLength, tmin2, tmax2) {
  let maximumCorrelation = -1.0;
  let r1_best = NaN, r3_best = NaN, ir = NaN;
  let r1 = 0.0, r2 = 0.0, r3 = 0.0;
  const z = me.z[1];
  const halfWindowLength = 0.5 * windowLength;
  const ileft1 = Sampled_xToNearestIndex(me, t1 - halfWindowLength);
  const iright1 = Sampled_xToNearestIndex(me, t1 + halfWindowLength);
  const ileft2min = Sampled_xToLowIndex(me, tmin2 - halfWindowLength);
  const ileft2max = Sampled_xToHighIndex(me, tmax2 - halfWindowLength);
  let peak = 0.0;
  let tout = t1; // Praat deja *tout sin tocar (tout es &tmax y t1 == tmax)
  for (let ileft2 = ileft2min; ileft2 <= ileft2max; ileft2++) {
    let norm1 = 0.0, norm2 = 0.0, product = 0.0;
    let localPeak = 0.0;
    for (let i1 = ileft1, i2 = ileft2; i1 <= iright1; i1++, i2++) {
      if (i1 < 1 || i1 > me.nx || i2 < 1 || i2 > me.nx) continue;
      const amp1 = z[i1], amp2 = z[i2];
      norm1 += amp1 * amp1;
      norm2 += amp2 * amp2;
      product += amp1 * amp2;
      if (Math.abs(amp2) > localPeak) localPeak = Math.abs(amp2);
    }
    r1 = r2; r2 = r3;
    if (norm1 === 0.0 || norm2 === 0.0) r3 = 0.0;
    else r3 = product / Math.sqrt(norm1 * norm2);
    if (r2 > maximumCorrelation && r2 >= r1 && r2 >= r3) {
      r1_best = r1; maximumCorrelation = r2; r3_best = r3;
      ir = ileft2 - 1;
      peak = localPeak;
    }
  }
  if (maximumCorrelation > -1.0) {
    let interpolatedPeakHeight = NaN;
    const d2r = (maximumCorrelation - r1_best) + (maximumCorrelation - r3_best);
    if (d2r !== 0.0) {
      const dr = 0.5 * (r3_best - r1_best);
      interpolatedPeakHeight = maximumCorrelation + 0.5 * dr * dr / d2r;
      ir += dr / d2r;
    }
    const peakTime = t1 + (ir - ileft1) * me.dx;
    if (peakTime >= tmin2 && peakTime <= tmax2) {
      tout = peakTime;
      if (!Number.isNaN(interpolatedPeakHeight)) maximumCorrelation = interpolatedPeakHeight;
    } else {
      const middleDistanceToT1 = Math.sqrt(Math.abs((tmin2 - t1) * (tmax2 - t1)));
      tout = tmin2 < t1 ? t1 - middleDistanceToT1 : t1 + middleDistanceToT1;
      if (r3 > maximumCorrelation) maximumCorrelation = r3;
    }
  }
  return { correlation: maximumCorrelation, tout, peak };
}

function Sound_Pitch_to_PointProcess_cc(sound, pitch) {
  const point = PointProcess_create(sound.xmin, sound.xmax);
  let t = pitch.xmin;
  let addedRight = -1e308;
  let globalPeak = 0.0; // Vector_getAbsoluteExtremum (..., NONE): máximo de |x| (un canal)
  for (let i = 1; i <= sound.nx; i++) { const a = Math.abs(sound.z[1][i]); if (a > globalPeak) globalPeak = a; }

  const iv = { tleft: 0, tright: 0 };
  for (;;) {
    if (!Pitch_getVoicedIntervalAfter(pitch, t, iv)) break;
    const { tleft, tright } = iv;
    const tmiddle = 0.5 * (tleft + tright);
    const f0middle = Pitch_getValueAtTime_linear(pitch, tmiddle);
    if (Number.isNaN(f0middle)) throw new Error('Sound_Pitch_to_PointProcess_cc: undefined f0 in the middle of a voiced interval.');
    let tmax = Sound_findExtremum(sound, tmiddle - 0.5 / f0middle, tmiddle + 0.5 / f0middle, true, true);
    PointProcess_addPoint(point, tmax);

    const tsave = tmax;
    for (;;) {
      const f0 = Pitch_getValueAtTime_linear(pitch, tmax);
      if (Number.isNaN(f0)) break;
      const r = Sound_findMaximumCorrelation(sound, tmax, 1.0 / f0, tmax - 1.25 / f0, tmax - 0.8 / f0);
      tmax = r.tout;
      const correlation = r.correlation, peak = r.peak;
      if (correlation === -1.0) tmax -= 1.0 / f0;
      if (tmax < tleft) {
        if (correlation > 0.7 && peak > 0.023333 * globalPeak && tmax - addedRight > 0.8 / f0) PointProcess_addPoint(point, tmax);
        break;
      }
      if (correlation > 0.3 && (peak === 0.0 || peak > 0.01 * globalPeak)) {
        if (tmax - addedRight > 0.8 / f0) PointProcess_addPoint(point, tmax);
      }
    }
    tmax = tsave;
    for (;;) {
      const f0 = Pitch_getValueAtTime_linear(pitch, tmax);
      if (Number.isNaN(f0)) break;
      const r = Sound_findMaximumCorrelation(sound, tmax, 1.0 / f0, tmax + 0.8 / f0, tmax + 1.25 / f0);
      tmax = r.tout;
      const correlation = r.correlation, peak = r.peak;
      if (correlation === -1.0) tmax += 1.0 / f0;
      if (tmax > tright) {
        if (correlation > 0.7 && peak > 0.023333 * globalPeak) { PointProcess_addPoint(point, tmax); addedRight = tmax; }
        break;
      }
      if (correlation > 0.3 && (peak === 0.0 || peak > 0.01 * globalPeak)) {
        PointProcess_addPoint(point, tmax);
        addedRight = tmax;
      }
    }
    t = tright;
  }
  return point;
}

// ---------------------------------------------------------------------------
// fon/Pitch_to_PitchTier.cpp, PitchTier (RealTier): points[{ number, value }]
// ---------------------------------------------------------------------------

export function Pitch_to_PitchTier(me) {
  const you = { xmin: me.xmin, xmax: me.xmax, points: [] };
  for (let i = 1; i <= me.nx; i++) {
    const frequency = me.frames[i].candidates[1].frequency;
    if (Pitch_util_frequencyIsVoiced(frequency, me.ceiling)) {
      you.points.push({ number: Sampled_indexToX(me, i), value: frequency });
    }
  }
  return you;
}

// "Formula" de un PitchTier con una expresión que no depende de `self`: todos los
// puntos pasan a valer `value`.
export function PitchTier_setAllValues(tier, value) {
  for (const p of tier.points) p.value = value;
}

// ---------------------------------------------------------------------------
// fon/PitchTier_to_PointProcess.cpp
// ---------------------------------------------------------------------------

function PitchTier_to_PointProcess(me) {
  const thee = PointProcess_create(me.xmin, me.xmax);
  let area = 0.5; // imagina un evento medio periodo antes del principio
  const size = me.points.length;
  if (size === 0) return thee;
  const P = (k) => me.points[k - 1];
  for (let interval = 0; interval <= size; interval++) {
    const t1 = interval === 0 ? me.xmin : P(interval).number;
    const t2 = interval === size ? me.xmax : P(interval + 1).number;
    const f1 = P(interval === 0 ? 1 : interval).value;
    const f2 = P(interval === size ? size : interval + 1).value;
    area += (t2 - t1) * 0.5 * (f1 + f2);
    while (area >= 1.0) {
      const slope = (f2 - f1) / (t2 - t1);
      area -= 1.0;
      const discriminant = f2 * f2 - 2.0 * area * slope;
      PointProcess_addPoint(thee, t2 - 2.0 * area / (f2 + Math.sqrt(Math.max(0, discriminant)))); // NUMsqrt_0
    }
  }
  return thee;
}

function PointProcess_isVoiced_t(me, t, maximumPeriod) {
  const imid = PointProcess_getNearestIndex(me, t);
  if (imid === 0) return false;
  const tmid = me.t[imid];
  const leftVoiced = imid > 1 && tmid - me.t[imid - 1] <= maximumPeriod;
  const rightVoiced = imid < me.nt && me.t[imid + 1] - tmid <= maximumPeriod;
  if ((leftVoiced && t <= tmid) || (rightVoiced && t >= tmid)) return true;
  if (leftVoiced && t < 1.5 * tmid - 0.5 * me.t[imid - 1]) return true;
  if (rightVoiced && t > 1.5 * tmid - 0.5 * me.t[imid + 1]) return true;
  return false;
}

function PitchTier_Point_to_PointProcess(me, vuv, maximumPeriod) {
  const fullPoint = PitchTier_to_PointProcess(me);
  const thee = PointProcess_create(me.xmin, me.xmax);
  for (let i = 1; i <= fullPoint.nt; i++) {
    const t = fullPoint.t[i];
    if (PointProcess_isVoiced_t(vuv, t, maximumPeriod)) PointProcess_addPoint(thee, t);
  }
  return thee;
}

// ---------------------------------------------------------------------------
// fon/Manipulation.cpp
// ---------------------------------------------------------------------------

export function Sound_to_Manipulation(me, timeStep, pitchFloor, pitchCeiling) {
  const sound = Sound_convertToMono(me);
  Vector_subtractMean(sound);
  const pitch = Sound_to_Pitch(sound, timeStep, pitchFloor, pitchCeiling);
  const pulses = Sound_Pitch_to_PointProcess_cc(sound, pitch);
  const pitchTier = Pitch_to_PitchTier(pitch);
  return { xmin: me.xmin, xmax: me.xmax, sound, pulses, pitch: pitchTier };
}

function copyRise(me, tmin, tmax, thee, tmaxTarget) {
  let imin = Sampled_xToHighIndex(me, tmin);
  if (imin < 1) imin = 1;
  let imax = Sampled_xToHighIndex(me, tmax) - 1;
  if (imax > me.nx) imax = me.nx;
  if (imax < imin) return;
  const imaxTarget = Sampled_xToHighIndex(thee, tmaxTarget) - 1;
  const distance = imaxTarget - imax;
  const dphase = NUMpi / (imax - imin + 1);
  for (let i = imin; i <= imax; i++) {
    const iTarget = i + distance;
    if (iTarget >= 1 && iTarget <= thee.nx) thee.z[1][iTarget] += me.z[1][i] * 0.5 * (1.0 - Math.cos(dphase * (i - imin + 0.5)));
  }
}

function copyFall(me, tmin, tmax, thee, tminTarget) {
  let imin = Sampled_xToHighIndex(me, tmin);
  if (imin < 1) imin = 1;
  let imax = Sampled_xToHighIndex(me, tmax) - 1;
  if (imax > me.nx) imax = me.nx;
  if (imax < imin) return;
  const iminTarget = Sampled_xToHighIndex(thee, tminTarget);
  const distance = iminTarget - imin;
  const dphase = NUMpi / (imax - imin + 1);
  for (let i = imin; i <= imax; i++) {
    const iTarget = i + distance;
    if (iTarget >= 1 && iTarget <= thee.nx) thee.z[1][iTarget] += me.z[1][i] * 0.5 * (1.0 + Math.cos(dphase * (i - imin + 0.5)));
  }
}

function copyBell(me, tmid, leftWidth, rightWidth, thee, tmidTarget) {
  copyRise(me, tmid - leftWidth, tmid, thee, tmidTarget);
  copyFall(me, tmid, tmid + rightWidth, thee, tmidTarget);
}

function copyBell2(me, source, isource, leftWidth, rightWidth, thee, tmidTarget, maxT) {
  const tmid = source.t[isource];
  if (isource > 1 && tmid - source.t[isource - 1] <= maxT) {
    const sourceLeftWidth = tmid - source.t[isource - 1];
    if (sourceLeftWidth < leftWidth) leftWidth = sourceLeftWidth;
  }
  if (isource < source.nt && source.t[isource + 1] - tmid <= maxT) {
    const sourceRightWidth = source.t[isource + 1] - tmid;
    if (sourceRightWidth < rightWidth) rightWidth = sourceRightWidth;
  }
  copyBell(me, tmid, leftWidth, rightWidth, thee, tmidTarget);
}

function copyFlat(me, tmin, tmax, thee, tminTarget) {
  let imin = Sampled_xToHighIndex(me, tmin);
  if (imin < 1) imin = 1;
  let imax = Sampled_xToHighIndex(me, tmax) - 1;
  if (imax > me.nx) imax = me.nx;
  if (imax < imin) return;
  let iminTarget = Sampled_xToHighIndex(thee, tminTarget);
  if (iminTarget < 1) iminTarget = 1;
  const imaxTarget = iminTarget + (imax - imin);
  for (let k = 0; k <= imaxTarget - iminTarget; k++) thee.z[1][iminTarget + k] = me.z[1][imin + k];
}

function Sound_Point_Point_to_Sound(me, source, target, maxT) {
  const thee = Sound_create(1, me.xmin, me.xmax, me.nx, me.dx, me.x1);
  if (source.nt < 2 || target.nt < 2) { // casi todo sordo
    thee.z[1].set(me.z[1]);
    return thee;
  }
  for (let i = 1; i <= target.nt; i++) {
    const tmid = target.t[i];
    const tleft = i > 1 ? target.t[i - 1] : me.xmin;
    const tright = i < target.nt ? target.t[i + 1] : me.xmax;
    let leftWidth = tmid - tleft, rightWidth = tright - tmid;
    const leftVoiced = i > 1 && leftWidth <= maxT;
    const rightVoiced = i < target.nt && rightWidth <= maxT;
    const isource = PointProcess_getNearestIndex(source, tmid);
    if (!leftVoiced) leftWidth = rightWidth;
    if (!rightVoiced) rightWidth = leftWidth;
    if (leftVoiced || rightVoiced) {
      copyBell2(me, source, isource, leftWidth, rightWidth, thee, tmid, maxT);
      if (!leftVoiced) {
        const startOfFlat = i === 1 ? tleft : (tleft + tmid) / 2.0;
        const endOfFlat = tmid - leftWidth;
        copyFlat(me, startOfFlat, endOfFlat, thee, startOfFlat);
        copyFall(me, endOfFlat, tmid, thee, endOfFlat);
      } else if (!rightVoiced) {
        const startOfFlat = tmid + rightWidth;
        const endOfFlat = i === target.nt ? tright : (tmid + tright) / 2.0;
        copyRise(me, tmid, startOfFlat, thee, startOfFlat);
        copyFlat(me, startOfFlat, endOfFlat, thee, startOfFlat);
      }
    } else {
      const startOfFlat = i === 1 ? tleft : (tleft + tmid) / 2.0;
      const endOfFlat = i === target.nt ? tright : (tmid + tright) / 2.0;
      copyFlat(me, startOfFlat, endOfFlat, thee, startOfFlat);
    }
  }
  return thee;
}

// Manipulation_to_Sound (me, Manipulation_OVERLAPADD) sin duration tier
export function Manipulation_getResynthesis_overlapAdd(me) {
  const targetPulses = PitchTier_Point_to_PointProcess(me.pitch, me.pulses, MAX_T);
  return Sound_Point_Point_to_Sound(me.sound, me.pulses, targetPulses, MAX_T);
}

// ---------------------------------------------------------------------------
// fon/Sound.cpp: Create Sound from formula (fórmula "0"), Sounds_concatenate
// ---------------------------------------------------------------------------

export function Sound_createSilence(startTime, endTime, samplingFrequency) {
  const numberOfSamples = Math.round((endTime - startTime) * samplingFrequency);
  if (!(endTime > startTime)) throw new Error('A Sound cannot have a duration of zero.');
  if (numberOfSamples < 1) throw new Error('A Sound cannot have zero samples.');
  return Sound_create(1, startTime, endTime, numberOfSamples, 1.0 / samplingFrequency, 0.5 / samplingFrequency);
}

// overlapTime = 0, como en parselmouth.Sound.concatenate (sounds, overlap=0.0)
export function Sounds_concatenate(list) {
  let total = 0;
  const dx = list[0].dx;
  for (const s of list) total += s.nx;
  const thee = Sound_create(1, 0.0, total * dx, total, dx, 0.5 * dx);
  let offset = 0;
  for (const s of list) { thee.z[1].set(s.z[1].subarray(1, s.nx + 1), offset + 1); offset += s.nx; }
  return thee;
}

// 0-based Float64Array de una Sound mono (copia)
export function Sound_toArray(me) { return me.z[1].slice(1, me.nx + 1); }
