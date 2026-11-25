// Codifica audio mono Float32 como WAV PCM de 16 bits.
// `cues` (opcional): [{ frame, label }] -> bloques "cue " + "LIST/adtl" que
// FL Studio Slicex lee como cortes (un marker por nota).
export function encodeWav(samples, sampleRate, cues = []) {
  const n = samples.length;
  const enc = new TextEncoder();
  const labels = cues.map((c) => enc.encode((c.label || '') + '\0'));
  const cueSize = cues.length ? 8 + 4 + cues.length * 24 : 0;
  let adtlSize = 0;
  if (cues.length) {
    adtlSize = 12 + labels.reduce((a, l) => a + 8 + 4 + l.length + (l.length & 1), 0);
  }
  const dataBytes = n * 2;
  const total = 44 + dataBytes + cueSize + adtlSize;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, total - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let o = 44 + dataBytes;
  if (cues.length) {
    w(o, 'cue '); v.setUint32(o + 4, 4 + cues.length * 24, true); v.setUint32(o + 8, cues.length, true);
    o += 12;
    cues.forEach((c, i) => {
      v.setUint32(o, i + 1, true);          // id
      v.setUint32(o + 4, c.frame, true);    // position
      w(o + 8, 'data');                     // chunk
      v.setUint32(o + 12, 0, true);         // chunk start
      v.setUint32(o + 16, 0, true);         // block start
      v.setUint32(o + 20, c.frame, true);   // sample offset
      o += 24;
    });
    w(o, 'LIST'); v.setUint32(o + 4, adtlSize - 8, true); w(o + 8, 'adtl');
    o += 12;
    labels.forEach((l, i) => {
      w(o, 'labl'); v.setUint32(o + 4, 4 + l.length, true); v.setUint32(o + 8, i + 1, true);
      u8.set(l, o + 12);
      o += 12 + l.length + (l.length & 1);
    });
  }
  return u8;
}
