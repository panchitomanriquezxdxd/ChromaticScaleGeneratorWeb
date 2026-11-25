// Chromatic Scale Generator (web) — DSP
// Port en JS de la lógica de Praat que usa el programa original:
//   Resample 48000 -> Convert to mono
//   -> To Manipulation (0.05, 60, 600): Sound: To Pitch (ac) + pulsos de pitch
//   -> Formula del pitch tier (frecuencia fija) -> Replace pitch tier
//   -> Get resynthesis (overlap-add) (PSOLA)
// Sin dependencias ni DOM, así se puede probar en Node.
//
// Pitch (ac): Boersma (1993), con los parámetros por defecto de Praat:
// silence 0.03, voicing 0.45, octave cost 0.01, octave jump cost 0.35,
// voiced/unvoiced cost 0.14, 15 candidatos, 3 periodos por ventana (Hanning).
// Escrito a partir del algoritmo publicado, no del código fuente de Praat,
// por eso el resultado es muy parecido pero no bit a bit igual.

export const SR = 48000;
const UNVOICED_HALF = 240; // 5 ms: grano para zonas sin pitch

// Nota del semitono `s` (s=0 -> C2), igual que el original:
// 32.703 * 2^((s + 12) / 12)
export function noteFreq(s) {
  return 32.703 * Math.pow(2, (s + 12) / 12);
}

export function analyzePitch(x, opts = {}) {
  const {
    floor = 60, ceiling = 600, timeStep = 0.05, maxCandidates = 15,
    silenceThreshold = 0.03, voicingThreshold = 0.45,
    octaveCost = 0.01, octaveJumpCost = 0.35, voicedUnvoicedCost = 0.14,
  } = opts;
  const dt = timeStep;
  const duration = x.length / SR;
  const winDur = 3 / floor;
  let nw = Math.round(winDur * SR);
  if (nw % 2) nw++;
  const half = nw / 2;
  const maxLag = Math.min(nw - 2, Math.ceil(SR / floor) + 2);
  const minLag = Math.max(2, Math.floor(SR / ceiling));

  const nFrames = duration >= winDur ? Math.floor((duration - winDur) / dt + 1e-9) + 1 : 0;
  const t0 = nFrames ? (duration - (nFrames - 1) * dt) / 2 : 0;
  const out = { f0: new Float32Array(nFrames), hop: dt, t0, voiced: false };
  if (!nFrames) return out;

  const win = new Float32Array(nw);
  for (let i = 0; i < nw; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / nw);
  const rw = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let j = 0; j + lag < nw; j++) s += win[j] * win[j + lag];
    rw[lag] = s;
  }
  for (let lag = maxLag + 1; lag >= 0; lag--) rw[lag] /= rw[0];

  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  let globalPeak = 0;
  for (let i = 0; i < x.length; i++) globalPeak = Math.max(globalPeak, Math.abs(x[i] - mean));
  if (globalPeak === 0) return out;

  const frame = new Float64Array(nw);
  const r = new Float64Array(maxLag + 2);
  const rn = new Float64Array(maxLag + 2);
  const frames = [];

  for (let k = 0; k < nFrames; k++) {
    const c = Math.round((t0 + k * dt) * SR);
    const s0 = c - half;
    let m = 0;
    for (let i = 0; i < nw; i++) { const v = s0 + i >= 0 && s0 + i < x.length ? x[s0 + i] : 0; frame[i] = v; m += v; }
    m /= nw;
    let localPeak = 0;
    for (let i = 0; i < nw; i++) { frame[i] -= m; localPeak = Math.max(localPeak, Math.abs(frame[i])); frame[i] *= win[i]; }
    let r0 = 0;
    for (let i = 0; i < nw; i++) r0 += frame[i] * frame[i];

    const intensity = localPeak / globalPeak;
    const unvoicedR = voicingThreshold + Math.max(0, 2 - intensity / (silenceThreshold / (1 + voicingThreshold)));
    const cands = [{ f: 0, R: unvoicedR, delta: unvoicedR }];

    if (r0 > 0) {
      for (let lag = 0; lag <= maxLag + 1; lag++) {
        let sum = 0;
        for (let j = 0; j + lag < nw; j++) sum += frame[j] * frame[j + lag];
        r[lag] = sum;
        rn[lag] = (sum / r0) / rw[lag];
      }
      const peaks = [];
      for (let lag = Math.max(minLag, 2); lag <= maxLag; lag++) {
        const v = rn[lag];
        if (v > 0.5 * voicingThreshold && v > rn[lag - 1] && v >= rn[lag + 1]) {
          const a = rn[lag - 1], b = v, cc = rn[lag + 1];
          const den = a - 2 * b + cc;
          let lagF = lag, peak = b;
          if (den !== 0) {
            const sh = 0.5 * (a - cc) / den;
            lagF = lag + sh;
            peak = b - 0.25 * (a - cc) * sh;
          }
          if (peak > 1) peak = 1 / peak;
          const f = SR / lagF;
          if (f >= floor && f <= ceiling) peaks.push({ f, R: peak });
        }
      }
      peaks.sort((p, q) => q.R - p.R);
      for (const p of peaks.slice(0, maxCandidates - 1)) {
        cands.push({ f: p.f, R: p.R, delta: p.R - octaveCost * Math.log2(floor / p.f) });
      }
    }
    frames.push(cands);
  }

  // Viterbi (los costos se escalan por el paso de tiempo, como en Praat)
  const corr = 0.01 / dt;
  const ojc = octaveJumpCost * corr, vuc = voicedUnvoicedCost * corr;
  const trans = (a, b) => {
    if (a.f > 0 && b.f > 0) return ojc * Math.abs(Math.log2(a.f / b.f));
    if (a.f > 0 || b.f > 0) return vuc;
    return 0;
  };
  let score = frames[0].map((c) => c.delta);
  const back = [];
  for (let k = 1; k < nFrames; k++) {
    const ns = [], bk = [];
    for (const cj of frames[k]) {
      let best = -Infinity, bi = 0;
      for (let i = 0; i < frames[k - 1].length; i++) {
        const v = score[i] - trans(frames[k - 1][i], cj);
        if (v > best) { best = v; bi = i; }
      }
      ns.push(best + cj.delta); bk.push(bi);
    }
    score = ns; back.push(bk);
  }
  let bi = 0;
  for (let i = 1; i < score.length; i++) if (score[i] > score[bi]) bi = i;
  for (let k = nFrames - 1; k >= 0; k--) {
    out.f0[k] = frames[k][bi].f;
    if (out.f0[k] > 0) out.voiced = true;
    if (k > 0) bi = back[k - 1][bi];
  }
  return out;
}

// Pitch en la muestra n: interpola entre cuadros con pitch; 0 si no hay.
function f0At(a, n) {
  const u = (n / SR - a.t0) / a.hop;
  const k = Math.round(u);
  if (k < 0 || k >= a.f0.length || !(a.f0[k] > 0)) return 0;
  const k0 = Math.floor(u), k1 = k0 + 1;
  if (k0 >= 0 && k1 < a.f0.length && a.f0[k0] > 0 && a.f0[k1] > 0) {
    return a.f0[k0] + (a.f0[k1] - a.f0[k0]) * (u - k0);
  }
  return a.f0[k];
}

// Marcas de pitch (pulsos) en los tramos con pitch.
export function findMarks(x, a) {
  const { f0, hop, t0 } = a;
  const marks = [];
  const n = x.length;
  let k = 0, seg = 0;
  while (k < f0.length) {
    if (!(f0[k] > 0)) { k++; continue; }
    let k2 = k;
    while (k2 < f0.length && f0[k2] > 0) k2++;
    const start = Math.max(0, Math.round((t0 + (k - 0.5) * hop) * SR));
    const end = Math.min(n - 1, Math.round((t0 + (k2 - 0.5) * hop) * SR));

    let mx = 0, mn = 0;
    for (let i = start; i <= end; i++) { if (x[i] > mx) mx = x[i]; if (x[i] < mn) mn = x[i]; }
    const pol = mx >= -mn ? 1 : -1;
    const argpeak = (lo, hi) => {
      let best = lo, bv = -Infinity;
      for (let i = lo; i <= hi; i++) { const v = pol * x[i]; if (v > bv) { bv = v; best = i; } }
      return best;
    };

    let T = SR / f0[k];
    let pos = argpeak(start, Math.min(end, Math.round(start + T)));
    marks.push({ pos, T, seg });
    for (;;) {
      const fl = f0At(a, pos);
      if (fl > 0) T = SR / fl;
      const nominal = pos + T;
      if (nominal > end) break;
      const lo = Math.max(pos + 1, Math.round(nominal - 0.3 * T));
      const hi = Math.min(n - 1, Math.round(nominal + 0.3 * T));
      if (hi < lo) break;
      pos = argpeak(lo, hi);
      marks.push({ pos, T, seg });
    }
    seg++;
    k = k2;
  }
  // Ancho del grano: del pulso anterior al siguiente (ventana Hanning asimétrica)
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const p = marks[i - 1], q = marks[i + 1];
    m.L = p && p.seg === m.seg ? m.pos - p.pos : m.T;
    m.R = q && q.seg === m.seg ? q.pos - m.pos : m.T;
  }
  return marks;
}

function addGrain(out, x, c, p, L, R, g) {
  const n = x.length, m = out.length;
  for (let j = -L; j <= R; j++) {
    const si = c + j, di = p + j;
    if (si < 0 || si >= n || di < 0 || di >= m) continue;
    const w = 0.5 * (1 + Math.cos((Math.PI * j) / (j < 0 ? L : R)));
    out[di] += w * x[si] * g;
  }
}

// PSOLA con pitch objetivo constante (equivale a reemplazar el pitch tier
// por una frecuencia fija). La duración se mantiene.
export function resynth(x, analysis, marks, targetHz) {
  const n = x.length;
  const out = new Float32Array(n);
  const Ts = SR / targetHz;
  let ts = 0, mi = 0;
  while (ts < n) {
    const f = f0At(analysis, ts);
    if (f > 0 && marks.length) {
      while (mi + 1 < marks.length &&
             Math.abs(marks[mi + 1].pos - ts) <= Math.abs(marks[mi].pos - ts)) mi++;
      const m = marks[mi];
      let center, L, R;
      if (Math.abs(m.pos - ts) <= m.T) { center = m.pos; L = m.L; R = m.R; }
      else { center = Math.round(ts); L = R = SR / f; }
      // Grano de a lo sumo dos periodos de salida: subir el pitch recorta el
      // grano (ventanas que suman 1), bajarlo deja el grano completo.
      const hl = Math.max(2, Math.round(Math.min(L, Ts)));
      const hr = Math.max(2, Math.round(Math.min(R, Ts)));
      addGrain(out, x, center, Math.round(ts), hl, hr, 1);
      ts += Ts;
    } else {
      const c = Math.round(ts);
      addGrain(out, x, c, c, UNVOICED_HALF, UNVOICED_HALF, 1);
      ts += UNVOICED_HALF;
    }
  }
  return out;
}

export function concatWithGaps(parts, gapSamples) {
  let total = 0;
  for (const p of parts) total += p.length + gapSamples;
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length + gapSamples; }
  return out;
}
