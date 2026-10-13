// proto.mjs — minimal protobuf wire-format codec (tags are varint-encoded: field 16+ needs 2 bytes)
export const encVarint = (n) => { let v = BigInt(n); const b = []; do { let x = Number(v & 0x7fn); v >>= 7n; if (v) x |= 0x80; b.push(x); } while (v); return Buffer.from(b); };
export const tag = (f, wt) => encVarint((f << 3) | wt);
export const str = (f, s) => Buffer.concat([tag(f, 2), encVarint(Buffer.byteLength(s)), Buffer.from(s)]);
export const num = (f, v) => Buffer.concat([tag(f, 0), encVarint(v)]);

export function decode(buf) {
  let i = 0; const out = [];
  const rv = () => { let v = 0n, s = 0n; while (true) { const b = buf[i++]; v |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7n; } };
  while (i < buf.length) {
    const t = Number(rv()); const f = t >> 3, wt = t & 7;
    if (wt === 0) out.push({ f, v: rv().toString() });
    else if (wt === 2) { const l = Number(rv()); out.push({ f, l, b: buf.slice(i, i + l), s: buf.slice(i, i + l).toString('utf8') }); i += l; }
    else if (wt === 5) { out.push({ f, v: 'f32' }); i += 4; }
    else if (wt === 1) { out.push({ f, v: 'f64' }); i += 8; }
    else break;
  }
  return out;
}
