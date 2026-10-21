// Converts a text-serialized Unity Mesh .asset to OBJ (positions, normals, uv0; triangles).
// Unity is left-handed: x is negated and winding reversed, which Unity's OBJ importer undoes.
// usage: node tools/asset-mesh.js in.asset out.obj, or require() it for assetToObj(text, label).
const fs = require('fs');

function assetToObj(t, label) {
const num = k => +(new RegExp('\\b' + k + ': (-?\\d+)').exec(t) || [])[1];
if (num('m_MeshCompression')) throw new Error('compressed mesh not supported');
const vcount = num('m_VertexCount');
const channels = [...t.split('m_Channels:')[1].split('m_DataSize:')[0]
  .matchAll(/- stream: (\d+)\s+offset: (\d+)\s+format: (\d+)\s+dimension: (\d+)/g)]
  .map(m => ({ stream: +m[1], offset: +m[2], format: +m[3], dim: +m[4] & 0xf }));
const hex = k => Buffer.from((new RegExp(k + ': ([0-9a-f]*)').exec(t) || ['', ''])[1], 'hex');
const data = hex('_typelessdata'), ib = hex('m_IndexBuffer');

const SIZE = { 0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2 };
// per stream: stride = sum of its channel sizes; streams are laid out in order, 16-byte aligned
const streams = [];
channels.forEach(c => { if (c.dim) { const s = streams[c.stream] = streams[c.stream] || { stride: 0 }; s.stride = Math.max(s.stride, c.offset + c.dim * SIZE[c.format]); } });
let base = 0;
streams.forEach(s => { if (!s) return; s.base = base; base += s.stride * vcount; base = (base + 15) & ~15; });

const half = h => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };
function read(ci) {
  const c = channels[ci]; if (!c || !c.dim) return null;
  const s = streams[c.stream], out = [];
  for (let v = 0; v < vcount; v++) {
    const at = s.base + v * s.stride + c.offset, a = [];
    for (let d = 0; d < c.dim; d++) {
      const o = at + d * SIZE[c.format];
      a.push(c.format === 0 ? data.readFloatLE(o) : c.format === 1 ? half(data.readUInt16LE(o))
        : c.format === 2 ? data[o] / 255 : c.format === 3 ? data.readInt8(o) / 127 : NaN);
    }
    out.push(a);
  }
  return out;
}
const pos = read(0), nrm = read(1), uv = read(4);
const wide = num('m_IndexFormat') === 1;
const idx = []; for (let i = 0; i < ib.length; i += wide ? 4 : 2) idx.push(wide ? ib.readUInt32LE(i) : ib.readUInt16LE(i));

// submeshes: only triangle topology (0)
const tris = [];
for (const m of t.matchAll(/firstByte: (\d+)\s+indexCount: (\d+)\s+topology: (\d+)\s+baseVertex: (\d+)/g)) {
  if (+m[3] !== 0) continue;
  const first = +m[1] / (wide ? 4 : 2), n = +m[2], bv = +m[4];
  for (let i = first; i < first + n; i += 3) tris.push([idx[i] + bv, idx[i + 1] + bv, idx[i + 2] + bv]);
}

const f6 = x => +x.toFixed(6);
const L = ['# from ' + label];
pos.forEach(p => L.push('v ' + [-p[0], p[1], p[2]].map(f6).join(' ')));
if (uv) uv.forEach(u => L.push('vt ' + [u[0], u[1]].map(f6).join(' ')));
if (nrm) nrm.forEach(n => L.push('vn ' + [-n[0], n[1], n[2]].map(f6).join(' ')));
const ref = i => (i + 1) + '/' + (uv ? i + 1 : '') + '/' + (nrm ? i + 1 : '');
tris.forEach(([a, b, c]) => L.push('f ' + [a, c, b].map(ref).join(' ')));
if (!tris.length) throw new Error('no triangles');
return L.join('\n') + '\n';
}

if (require.main === module) {
  const [, , inPath, outPath] = process.argv;
  const obj = assetToObj(fs.readFileSync(inPath, 'utf8'), inPath.split('/').pop());
  fs.writeFileSync(outPath, obj);
  console.log(outPath.split('/').pop() + ':', obj.split('\nf ').length - 1, 'tris');
}

module.exports = { assetToObj };
