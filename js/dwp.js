// Núcleo de DWP_Converter.html (WAV con markers -> programa DirectWave .dwp).
// Cambio respecto al original: plan() acepta info.firstNote para fijar la nota
// de la primera región (el original siempre arranca en 60).
export const W2D = (function () {
  'use strict';
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const GUARD = 256, TAIL = 1024, FADE = 32, MAX_REGIONS = 128, BASE_NOTE = 60;

  const noteName = (n) => NOTES[n % 12] + Math.floor(n / 12);

  /* -------- utilidades binarias -------- */
  function b64(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function ascii(str) { const o = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) o[i] = str.charCodeAt(i) & 0x7f; return o; }
  function chunk(tag, data) {
    const h = new Uint8Array(12), dv = new DataView(h.buffer);
    dv.setUint32(0, tag, true); dv.setUint32(4, data.length, true); dv.setUint32(8, 0, true);
    const out = new Uint8Array(12 + data.length); out.set(h, 0); out.set(data, 12); return out;
  }
  function chunkHeader(tag, size) {
    const h = new Uint8Array(12), dv = new DataView(h.buffer);
    dv.setUint32(0, tag, true); dv.setUint32(4, size, true); dv.setUint32(8, 0, true); return h;
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f; if (d > 0.5) return f + 1; return f % 2 === 0 ? f : f + 1;
  }

  /* -------- nombres -------- */
  function cleanName(s) {
    s = (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\.[A-Za-z0-9]{1,4}$/, '');
    s = s.replace(/[^A-Za-z0-9 _-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
    return s || 'programa';
  }

  /* -------- lectura de WAV -------- */
  function parseWav(buf) {
    const dv = new DataView(buf), len = buf.byteLength;
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (len < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('No es un archivo WAV válido.');
    let pos = 12, fmt = null, dataOff = -1, dataLen = 0, cues = [];
    while (pos + 8 <= len) {
      const id = tag(pos); let size = dv.getUint32(pos + 4, true); const body = pos + 8;
      if (body + size > len) size = len - body;
      if (id === 'fmt ' && size >= 16) {
        let t = dv.getUint16(body, true);
        if (t === 0xfffe && size >= 26) t = dv.getUint16(body + 24, true);
        fmt = { tag: t, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      } else if (id === 'data') { dataOff = body; dataLen = size; }
      else if (id === 'cue ' && size >= 4) {
        const n = dv.getUint32(body, true);
        for (let i = 0; i < n && 4 + (i + 1) * 24 <= size; i++) {
          const p = body + 4 + i * 24;
          const position = dv.getUint32(p + 4, true), sampleOffset = dv.getUint32(p + 20, true);
          cues.push(sampleOffset || position);
        }
      }
      pos = body + size + (size & 1);
    }
    if (!fmt || dataOff < 0) throw new Error('El WAV no tiene los bloques fmt y data.');
    const ok = (fmt.tag === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.tag === 3 && [32, 64].includes(fmt.bits));
    if (!ok) throw new Error('Formato de audio no soportado (' + fmt.bits + ' bits, tipo ' + fmt.tag + '). Usá un WAV PCM o float.');
    if (fmt.channels < 1) throw new Error('El WAV no tiene canales.');
    const frameBytes = fmt.channels * fmt.bits / 8;
    const frames = Math.floor(dataLen / frameBytes);
    if (frames < 1) throw new Error('El WAV no tiene audio.');
    const info = { buf, fmt, dataOff, frames, frameBytes };
    const set = [...new Set(cues.filter((c) => c < frames))].sort((a, b) => a - b);
    info.markers = set;
    info.introFrames = set.length && set[0] > 0 ? set[0] : 0;   /* audio anterior al primer marker */
    info.includeIntro = false;                                   /* por defecto se ignora, sin región extra */
    info.read = makeReader(info);
    return info;
  }
  /* devuelve el valor de la muestra en escala "entero de 16 bits x 2^k" (la escala exacta no importa: se normaliza) */
  function makeReader(info) {
    const dv = new DataView(info.buf), { tag, bits, channels } = info.fmt, bps = bits / 8;
    return function (frame, ch) {
      const o = info.dataOff + (frame * channels + Math.min(ch, channels - 1)) * bps;
      if (tag === 3) return (bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true)) * 32768;
      if (bits === 16) return dv.getInt16(o, true);
      if (bits === 24) { let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); return v >= 0x800000 ? v - 0x1000000 : v; }
      if (bits === 32) return dv.getInt32(o, true);
      return (dv.getUint8(o) - 128) * 256;
    };
  }

  /* -------- plan de regiones -------- */
  function plan(info) {
    const m = info.markers;
    const bounds = !m.length ? [0] : (info.includeIntro && m[0] > 0 ? [0].concat(m) : m);
    const n = bounds.length;
    if (n > MAX_REGIONS) throw new Error('Hay ' + n + ' markers; el máximo es ' + MAX_REGIONS + ' (una región por tecla).');
    const first = info.firstNote != null ? Math.max(0, Math.min(info.firstNote, 128 - n)) : (n <= 128 - BASE_NOTE ? BASE_NOTE : 128 - n);
    return bounds.map((start, k) => {
      const end = k + 1 < n ? bounds[k + 1] : info.frames, note = first + k;
      return { start, end, len: end - start, note, name: noteName(note), lo: k === 0 ? 0 : note, hi: k === n - 1 ? 127 : note };
    });
  }

  /* -------- recorte de silencio -------- */
  /* Conserva solo el primer sonido: corta en el primer silencio largo (>= 150 ms por debajo de -55 dB del pico). */
  function trimLength(a, b, rate) {
    const n = a.length, w = Math.max(1, Math.round(rate * 0.005));
    const nw = Math.floor(n / w), env = new Float64Array(nw);
    let pk = 0;
    for (let k = 0; k < nw; k++) {
      let m = 0; for (let i = k * w; i < (k + 1) * w; i++) { const v = Math.max(Math.abs(a[i]), Math.abs(b[i])); if (v > m) m = v; }
      env[k] = m; if (m > pk) pk = m;
    }
    if (pk <= 0) return n;
    const thr = pk * Math.pow(10, -55 / 20), minRun = Math.ceil(0.15 / 0.005);
    let k = 0; while (k < nw && env[k] < thr) k++;             /* saltea el silencio inicial */
    let run = 0, lastLoud = k;
    for (; k < nw; k++) {
      if (env[k] < thr) { run++; if (run >= minRun) return Math.min(n, (k - run + 1 + 2) * w); }
      else { run = 0; lastLoud = k; }
    }
    return Math.min(n, (lastLoud + 3) * w);      /* cola silenciosa corta al final */
  }

  /* -------- loop automático con crossfade (modelo medido sobre un loop real de DirectWave) -------- */
  const XF = [1, 0.9965, 0.986, 0.9685, 0.944, 0.912, 0.872, 0.824, 0.7685, 0.705, 0.6335, 0.556, 0.474, 0.3895, 0.305, 0.224, 0.151, 0.0875, 0.0405, 0.010, 0];
  function xfw(t) { const p = t * 20, i = Math.min(19, Math.floor(p)), f = p - i; return XF[i] + (XF[i + 1] - XF[i]) * f; }
  function nacorr(x, i0, j0, len) {       /* correlación normalizada entre x[i0..] y x[j0..] */
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < len; i++) { const p = x[i0 + i], q = x[j0 + i]; ab += p * q; aa += p * p; bb += q * q; }
    return ab / (Math.sqrt(aa * bb) + 1e-9);
  }
  const rmsOf = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
  /* Devuelve {start, end, cf} o null si el sonido no sirve para loop (corto o que decae). */
  function findLoop(x, rate) {
    const T = x.length;
    if (T < 0.3 * rate) return null;
    const mid = rmsOf(x, Math.floor(T * 0.4), Math.floor(T * 0.6)), tail = rmsOf(x, Math.floor(T * 0.75), Math.floor(T * 0.95));
    if (mid < 1 || tail < 0.5 * mid) return null;
    /* período fundamental: autocorrelación gruesa (diezmada) y refinada */
    const dec = 4, wl = Math.min(16384, Math.floor(T * 0.5)), w0 = Math.floor(T * 0.3);
    const dn = Math.floor(wl / dec), d = new Float64Array(dn);
    for (let i = 0; i < dn; i++) { let s = 0; for (let k = 0; k < dec; k++) s += x[w0 + i * dec + k]; d[i] = s; }
    const minLag = Math.max(2, Math.ceil(rate / 2000 / dec)), maxLag = Math.min(Math.floor(dn / 2), Math.floor(rate / 30 / dec));
    let best = -1, bestLag = 0; const nac = new Float64Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) { nac[lag] = nacorr(d, 0, lag, dn - lag); if (nac[lag] > best) { best = nac[lag]; bestLag = lag; } }
    let P = 0;
    if (best >= 0.5) {
      for (let lag = minLag + 1; lag < maxLag; lag++) if (nac[lag] > nac[lag - 1] && nac[lag] >= nac[lag + 1] && nac[lag] >= 0.9 * best) { bestLag = lag; break; }
      let c = bestLag * dec, bc = -2;
      const wr = Math.min(8192, wl - 3 * dec * bestLag > 0 ? 8192 : 2048);
      for (let L = bestLag * dec - dec * 2; L <= bestLag * dec + dec * 2; L++) { const s = nacorr(x, w0, w0 + L, Math.min(wr, wl - L)); if (s > bc) { bc = s; c = L; } }
      P = c;
    }
    /* largo del loop: múltiplo entero de períodos (potencia de 2), hasta 80 % del sonido */
    const W = Math.min(8192, Math.floor(T * 0.2));
    let L0;
    if (P > 0) { let k = 1; while (k * 2 * P <= 0.8 * T) k *= 2; L0 = Math.round(k * P); }
    else L0 = Math.round(T * 0.5);
    const span = P > 0 ? Math.ceil(P / 2) : Math.floor(T * 0.05), step = P > 0 ? 1 : 4;
    let L = L0, bs = -2;
    for (let c = Math.max(256, L0 - span); c <= Math.min(Math.floor(T * 0.8), L0 + span); c += step) {
      if (T - W - c < 0) continue;
      const s = nacorr(x, T - W, T - W - c, W); if (s > bs) { bs = s; L = c; }
    }
    const S = T - L, cf = Math.min(L, S - FADE);
    if (cf < 512) return null;
    return { start: S, end: T, cf, period: P };
  }
  /* mezcla el final del loop con el material previo al inicio: y[i] = a(t)*x[i] + b(t)*x[i-L] */
  function crossfade(x, lp) {
    const L = lp.end - lp.start, y = Float64Array.from(x), s0 = lp.end - lp.cf;
    for (let i = s0; i < lp.end; i++) { const t = (i - s0) / (lp.cf - 1); y[i] = xfw(t) * x[i] + xfw(1 - t) * x[i - L]; }
    return y;
  }

  /* -------- reducción de la frecuencia de muestreo (filtro pasabajos + decimación) -------- */
  function decimate(x, f) {
    const half = 8 * f, M = 2 * half + 1, fc = 0.45 / f, h = new Float64Array(M);
    let sum = 0;
    for (let k = 0; k < M; k++) {
      const m = k - half, s = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / (M - 1)) + 0.08 * Math.cos(4 * Math.PI * k / (M - 1));
      h[k] = s * w; sum += h[k];
    }
    for (let k = 0; k < M; k++) h[k] /= sum;
    const n = x.length, m = Math.ceil(n / f), y = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      let acc = 0; const c0 = j * f - half;
      const k0 = Math.max(0, -c0), k1 = Math.min(M, n - c0);
      for (let k = k0; k < k1; k++) acc += h[k] * x[c0 + k];
      y[j] = acc;
    }
    return y;
  }

  /* tamaño máximo aproximado del .dwp (antes de recortar silencios) */
  function estimateSize(info, opts) {
    opts = opts || {};
    const div = opts.rateDiv || 1, loopBytes = opts.loop && opts.loopBits === 32 ? 8 : 4;
    let total = 3000;
    for (const r of plan(info)) {
      const frames = Math.ceil(r.len / div);
      total += 1300 + (opts.loop ? frames + 2 * GUARD : frames + TAIL + 2 * GUARD) * loopBytes;
    }
    return total;
  }

  /* -------- construcción del .dwp -------- */
  async function buildDwp(info, programName, tpl, onProgress, opts) {
    opts = opts || {};
    const prefix = b64(tpl.prefix), hdr = b64(tpl.hdr).slice(), rest = b64(tpl.rest);
    const d503 = b64(tpl.d503), d500 = b64(tpl.d500);
    const regs = plan(info), N = regs.length;
    new DataView(hdr.buffer).setUint32(26, N, true);
    const name = cleanName(programName);
    const div = opts.rateDiv || 1, rate = info.fmt.rate / div;
    const regionChunks = [];
    let total = 0, loops = 0, trimmed = 0;
    const progBytes = concat([hdr, chunk(102, ascii(name)), chunk(103, ascii('C:\\samples\\' + name + '.dwp')), rest]);
    const parts = [prefix, null, progBytes];
    total += progBytes.length;
    for (let k = 0; k < N; k++) {
      const r = regs[k];
      const rname = name + '_' + r.name + '_127';
      /* canales */
      const chans = info.fmt.channels > 1 ? [0, 1] : [0, 0];
      const same = chans[1] === chans[0];
      let vals = [new Float64Array(r.len), same ? null : new Float64Array(r.len)];
      for (let i = 0; i < r.len; i++) {
        vals[0][i] = info.read(r.start + i, chans[0]);
        if (vals[1]) vals[1][i] = info.read(r.start + i, chans[1]);
      }
      if (div > 1) vals = [decimate(vals[0], div), same ? null : decimate(vals[1], div)];
      if (!vals[1]) vals[1] = vals[0];
      /* recorte: solo el primer sonido */
      const n1 = vals[0].length; let T = n1;
      if (opts.trim) { T = trimLength(vals[0], vals[1], rate); if (T < n1) trimmed++; }
      /* pico y normalización a 16 bit, sobre el audio conservado */
      let peak = 0;
      for (let i = 0; i < T; i++) { const aa = Math.abs(vals[0][i]); if (aa > peak) peak = aa; if (!same) { const bb = Math.abs(vals[1][i]); if (bb > peak) peak = bb; } }
      if (peak < 1) peak = 1;
      const g = 32767 / peak, f = Math.min(FADE, T >> 2);
      const ramp = (i, up) => f === 1 ? (up ? 0 : 1) : (up ? (i === f - 1 ? 1 : i * (1 / (f - 1))) : (i === f - 1 ? 0 : 1 + i * (-1 / (f - 1))));
      const xi = [new Float64Array(T), same ? null : new Float64Array(T)];
      for (let c = 0; c < (same ? 1 : 2); c++) for (let i = 0; i < T; i++) xi[c][i] = roundHalfEven(vals[c][i] * g);
      if (same) xi[1] = xi[0];
      /* loop automático */
      let lp = null;
      if (opts.loop) lp = findLoop(xi[0], rate);
      /* fundidos de borde: entrada siempre; salida solo si no hay loop (el crossfade ya cierra el final) */
      for (let c = 0; c < (same ? 1 : 2); c++) {
        for (let i = 0; i < f; i++) xi[c][i] *= ramp(i, true);
        if (!lp) for (let i = T - f; i < T; i++) xi[c][i] *= ramp(i - (T - f), false);
        for (let i = 0; i < T; i++) xi[c][i] = Math.trunc(Math.max(-32768, Math.min(32767, xi[c][i])));
      }
      let frames, pcm, bits = 16;
      if (lp) {
        loops++; bits = opts.loopBits === 32 ? 32 : 16; frames = T;
        const bps = bits / 8, blockLen = GUARD + T + GUARD; pcm = new Uint8Array(blockLen * 2 * bps); const fdv = new DataView(pcm.buffer);
        /* el crossfade puede sumar por encima del pico: se baja el nivel solo si hace falta, para que no recorte */
        const ys = [crossfade(xi[0], lp), same ? null : crossfade(xi[1], lp)];
        let ymax = 0; for (const y of ys) if (y) for (let i = 0; i < T; i++) { const a = Math.abs(y[i]); if (a > ymax) ymax = a; }
        const gain = ymax > 32767 ? 32767 / ymax : 1;
        for (let c = 0; c < 2; c++) {
          if (c === 1 && same) { pcm.copyWithin(blockLen * bps, 0, blockLen * bps); break; }
          const y = ys[c], base = c * blockLen * bps;
          if (bits === 32) for (let i = 0; i < T; i++) fdv.setFloat32(base + (GUARD + i) * 4, y[i] * gain / 32768, true);
          else for (let i = 0; i < T; i++) fdv.setInt16(base + (GUARD + i) * 2, Math.max(-32768, Math.min(32767, roundHalfEven(y[i] * gain))), true);
        }
      } else {
        frames = T + TAIL;
        const blockLen = GUARD + T + TAIL + GUARD; pcm = new Uint8Array(blockLen * 4); const pdv = new DataView(pcm.buffer);
        for (let c = 0; c < 2; c++) {
          if (c === 1 && same) { pcm.copyWithin(blockLen * 2, 0, blockLen * 2); break; }
          for (let i = 0; i < T; i++) pdv.setInt16(c * blockLen * 2 + (GUARD + i) * 2, xi[c][i], true);
        }
      }
      const rpath = 'C:\\samples\\' + name + '\\' + rname + '.wav';
      const subs = [];
      let rsize = 0;
      for (const [tag, s] of tpl.region) {
        let d;
        if (tag === 500) { d = d500.slice(); d[0] = r.note; d[1] = r.lo; d[2] = r.hi; d[3] = 0; d[4] = 127; }
        else if (tag === 501) d = ascii(rname);
        else if (tag === 502) d = ascii(rpath);
        else if (tag === 503) {
          d = d503.slice(); const v = new DataView(d.buffer); v.setUint32(0, frames, true); v.setFloat32(16, rate, true);
          if (lp) { v.setUint32(20, 2, true); v.setUint32(24, lp.start, true); v.setUint32(28, lp.end, true); }
          v.setUint32(36, bits, true);
        }
        else if (tag === 517) d = pcm;
        else d = b64(s);
        subs.push(chunkHeader(tag, d.length), d); rsize += 12 + d.length;
      }
      regionChunks.push(chunkHeader(3, rsize), ...subs);
      total += 12 + rsize;
      regs[k].loop = lp; regs[k].kept = T;
      if (onProgress) { onProgress((k + 1) / N); if (opts.yield) await new Promise((res) => setTimeout(res, 0)); }
    }
    const endChunk = chunkHeader(2, 0);
    total += 12;
    parts[1] = chunkHeader(1, total);
    return { parts: parts.concat(regionChunks, [endChunk]), regions: regs, name, loops, trimmed };
  }

  /* -------- ZIP sin compresión (solo para la vista previa, que no deja guardar .dwp) -------- */
  let crcTable = null;
  function crc32(parts) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (const p of parts) for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(filename, parts) {
    const nameB = ascii(filename); let size = 0; for (const p of parts) size += p.length;
    const crc = crc32(parts);
    const lh = new Uint8Array(30 + nameB.length), l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(8, 0, true);
    l.setUint16(10, 0, true); l.setUint16(12, 0x21, true); l.setUint32(14, crc, true); l.setUint32(18, size, true); l.setUint32(22, size, true);
    l.setUint16(26, nameB.length, true); l.setUint16(28, 0, true); lh.set(nameB, 30);
    const cd = new Uint8Array(46 + nameB.length), c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nameB.length, true); cd.set(nameB, 46);
    const eo = new Uint8Array(22), e = new DataView(eo.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, 1, true); e.setUint16(10, 1, true); e.setUint32(12, cd.length, true); e.setUint32(16, lh.length + size, true);
    return [lh].concat(parts, [cd, eo]);
  }

  /* -------- markers automáticos -------- */
  /* Un sonido empieza cuando la señal supera el umbral (dB bajo el pico) tras >= gapMs de silencio. El marker va preMs antes. El primero queda en 0. */
  function detectMarkers(info, o) {
    o = o || {};
    const rate = info.fmt.rate, thrDb = o.thrDb == null ? -50 : o.thrDb, gap = o.gapMs == null ? 120 : o.gapMs, pre = o.preMs == null ? 10 : o.preMs;
    const w = Math.max(1, Math.round(rate * 0.005)), nw = Math.floor(info.frames / w), env = new Float64Array(nw), step = Math.max(1, Math.floor(w / 8)), chs = Math.min(2, info.fmt.channels);
    let pk = 0;
    for (let k = 0; k < nw; k++) {
      let m = 0;
      for (let i = k * w; i < (k + 1) * w; i += step) for (let c = 0; c < chs; c++) { const v = Math.abs(info.read(i, c)); if (v > m) m = v; }
      env[k] = m; if (m > pk) pk = m;
    }
    if (pk <= 0) return [0];
    const thr = pk * Math.pow(10, thrDb / 20), minRun = Math.max(1, Math.ceil(gap / 5)), out = [0];
    let quiet = minRun;                                   /* arranca "en silencio" para que el primer sonido cuente */
    for (let k = 0; k < nw; k++) {
      if (env[k] >= thr) {
        if (quiet >= minRun) { const at = Math.max(0, k * w - Math.round(rate * pre / 1000)); if (at > out[out.length - 1]) out.push(at); }
        quiet = 0;
      } else quiet++;
    }
    return out;
  }
  function equalMarkers(info, n) {
    n = Math.max(1, Math.min(MAX_REGIONS, Math.floor(n)));
    const out = []; for (let i = 0; i < n; i++) { const v = Math.round(i * info.frames / n); if (!out.length || v > out[out.length - 1]) out.push(v); }
    return out;
  }
  /* mueve un punto al cruce por cero / mínimo de amplitud más cercano (+-ms) para que el corte no haga clic */
  function snapMarker(info, at, ms) {
    const r = Math.round(info.fmt.rate * (ms || 4) / 1000); let best = Math.max(0, Math.min(info.frames - 1, at)), bv = Infinity;
    for (let i = Math.max(0, at - r); i <= Math.min(info.frames - 1, at + r); i++) { let v = 0; for (let c = 0; c < Math.min(2, info.fmt.channels); c++) v += Math.abs(info.read(i, c)); if (v < bv) { bv = v; best = i; } }
    return best;
  }

  return { parseWav, plan, buildDwp, detectMarkers, equalMarkers, snapMarker, estimateSize, decimate, findLoop, crossfade, trimLength, zipStore, cleanName, noteName, concat, MAX_REGIONS, BASE_NOTE };
})();

export const TPL = {"prefix":"RHdQciYAAAAGAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAA","hdr":"ZAAAAB4AAAAAAAAAAAAAAAAAZmbmPgAAAAADAAAAAAAAAAAAAAAAAAAA","rest":"aAAAAAoAAAAAAAAAAAAAAAAAAAAAAGkAAAASAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoAAAARAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAawAAABEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABsAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGwAAAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbQAAAAQAAAAAAAAAAAAAAG0AAAAEAAAAAAAAAAAAAABtAAAABAAAAAAAAAAAAAAAbQAAAAQAAAAAAAAAAAAAAG4AAAANAAAAAAAAAAEAAAAAAACAPwAAAABuAAAADQAAAAAAAAACAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAAwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAAQAAAAAAACAPwAAAABuAAAADQAAAAAAAAAFAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAABgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAAcAAAAAAACAPwAAAABuAAAADQAAAAAAAAAIAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAACQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAAoAAAAAAACAPwAAAABuAAAADQAAAAAAAAALAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAADAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAA0AAAAAAACAPwAAAABuAAAADQAAAAAAAAAOAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAADwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAABAAAAAAAACAPwAAAABuAAAADQAAAAAAAAARAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAEgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAABMAAAAAAACAPwAAAABuAAAADQAAAAAAAAAUAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAFQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAABYAAAAAAACAPwAAAABuAAAADQAAAAAAAAAXAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAGAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAABkAAAAAAACAPwAAAABuAAAADQAAAAAAAAAaAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAGwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAABwAAAAAAACAPwAAAABuAAAADQAAAAAAAAAdAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAHgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAB8AAAAAAACAPwAAAABuAAAADQAAAAAAAAAgAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAIQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAACIAAAAAAACAPwAAAABuAAAADQAAAAAAAAAjAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAJAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAACUAAAAAAACAPwAAAABuAAAADQAAAAAAAAAmAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAJwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAACgAAAAAAACAPwAAAABuAAAADQAAAAAAAAApAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAKgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAACsAAAAAAACAPwAAAABuAAAADQAAAAAAAAAsAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAALQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAC4AAAAAAACAPwAAAABuAAAADQAAAAAAAAAvAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAMAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAADEAAAAAAACAPwAAAABuAAAADQAAAAAAAAAyAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAMwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAADQAAAAAAACAPwAAAABuAAAADQAAAAAAAAA1AAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAANgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAADcAAAAAAACAPwAAAABuAAAADQAAAAAAAAA4AAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAOQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAADoAAAAAAACAPwAAAABuAAAADQAAAAAAAAA7AAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAPAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAD0AAAAAAACAPwAAAABuAAAADQAAAAAAAAA+AAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAPwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAEAAAAAAAACAPwAAAABuAAAADQAAAAAAAABBAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAQgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAEMAAAAAAACAPwAAAABuAAAADQAAAAAAAABEAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAARQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAEYAAAAAAACAPwAAAABuAAAADQAAAAAAAABHAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAASAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAEkAAAAAAACAPwAAAABuAAAADQAAAAAAAABKAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAASwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAEwAAAAAAACAPwAAAABuAAAADQAAAAAAAABNAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAATgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAE8AAAAAAACAPwAAAABuAAAADQAAAAAAAABQAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAUQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAFIAAAAAAACAPwAAAABuAAAADQAAAAAAAABTAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAVAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAFUAAAAAAACAPwAAAABuAAAADQAAAAAAAABWAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAVwAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAFgAAAAAAACAPwAAAABuAAAADQAAAAAAAABZAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAWgAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAFsAAAAAAACAPwAAAABuAAAADQAAAAAAAABcAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAXQAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAF4AAAAAAACAPwAAAABuAAAADQAAAAAAAABfAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAYAAAAAAAAIA/AAAAAG4AAAANAAAAAAAAAGEAAAAAAACAPwAAAABuAAAADQAAAAAAAABiAAAAAAAAgD8AAAAAbgAAAA0AAAAAAAAAYwAAAAAAAIA/AAAAAA==","region":[[500,""],[501,""],[502,""],[503,""],[504,"AAAAPwAAZAA="],[505,"AAAAAAAAAAAAAAAAAAA="],[506,"AAAAAAAAAAAAAAAAAACAPwAAAACQaYoFAAAAAJBpigUAAAAAAQAAAAAAAABAhBQA"],[507,"AAAAAAAAAAAAAAAAAAAAAAAAAAA="],[507,"AAAAAAAAAAAAAAAAAAAAAAAAAAA="],[508,"AAA="],[509,"AAAAAAAAgD8AAIA/7FE4Pg=="],[510,"AAAAAAAAAAAA"],[511,"AAAAAAAAAAAA"],[512,"AAAAAAAAAAAA"],[513,"AAAAAAAAAAAA"],[514,"AAAAAAAAAAAAAAAAAAAAAA=="],[514,"AAAAAAAAAAAAAAAAAAAAAA=="],[515,"AAAAAAAAAAAAAAAAAAAAAAAAAAA="],[515,"AAAAAAAAAAAAAAAAAAAAAAAAAAA="],[516,"AgACAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[516,"AAAAAAAAAAA="],[517,""],[4,""]],"d503":"hFsAAAAAAAACAAAABAAAAABELEcAAAAAAAAAAAAAAAAAAAAAEAAAAA==","d500":"PAA8AH8AAAAAAACAPwAAAD8BAAAAAAIAAA=="};
