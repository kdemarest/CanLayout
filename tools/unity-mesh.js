// Reads and writes text-serialized Unity Mesh .assets with all their vertex attributes, for tools
// that rebuild meshes (tools/dice.js). Positions stay in Unity's own (left-handed) coordinates.
// A mesh is { channels, attrs, triangles, text }: attrs[channel] is an array of per-vertex arrays
// (null for unused channels), triangles a flat index list (one submesh, triangle topology), text
// the source, kept as the template for writing.
const FORMATS = { 0: 4, 1: 2, 2: 1, 3: 1 }; // float32, float16, unorm8, snorm8

function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
}

function readMesh(text) {
  const num = k => +(new RegExp('\\b' + k + ': (-?\\d+)').exec(text) || [])[1];
  if (num('m_MeshCompression')) throw new Error('compressed mesh not supported');
  const vcount = num('m_VertexCount');
  const channels = [...text.split('m_Channels:')[1].split('m_DataSize:')[0]
    .matchAll(/- stream: (\d+)\s+offset: (\d+)\s+format: (\d+)\s+dimension: (\d+)/g)]
    .map(m => ({ stream: +m[1], offset: +m[2], format: +m[3], dim: +m[4] & 0xf }));
  if (channels.some(c => c.dim && (c.stream !== 0 || !(c.format in FORMATS)))) throw new Error('only one vertex stream of float, half or 8-bit channels is supported');
  const stride = Math.max(...channels.filter(c => c.dim).map(c => c.offset + c.dim * FORMATS[c.format]));
  const data = Buffer.from(/_typelessdata: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const attrs = channels.map(c => {
    if (!c.dim) return null;
    const out = new Array(vcount);
    for (let v = 0; v < vcount; v++) {
      const a = new Array(c.dim);
      for (let d = 0; d < c.dim; d++) {
        const o = v * stride + c.offset + d * FORMATS[c.format];
        a[d] = c.format === 0 ? data.readFloatLE(o) : c.format === 1 ? half(data.readUInt16LE(o)) : c.format === 2 ? data[o] / 255 : data.readInt8(o) / 127;
      }
      out[v] = a;
    }
    return out;
  });
  const submeshes = [...text.matchAll(/firstByte: (\d+)\r?\n\s+indexCount: (\d+)\r?\n\s+topology: (\d+)/g)].map(m => ({ firstByte: +m[1], indexCount: +m[2], topology: +m[3] }));
  if (submeshes.length !== 1 || submeshes[0].topology !== 0) throw new Error('only one triangle submesh is supported');
  const wide = num('m_IndexFormat') === 1;
  const ib = Buffer.from(/m_IndexBuffer: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const triangles = [];
  for (let i = 0; i < submeshes[0].indexCount; i++) triangles.push(wide ? ib.readUInt32LE(4 * i) : ib.readUInt16LE(2 * i));
  return { channels, stride, attrs, triangles, text };
}

const v3 = a => `{x: ${+a[0].toPrecision(8)}, y: ${+a[1].toPrecision(8)}, z: ${+a[2].toPrecision(8)}}`;

// The template's text with this mesh's name, vertices, triangles and bounds (same channel layout).
// pad grows the bounds on every side (strips: their points are branch centres; the shader widens
// them by up to their radius).
function writeMesh(template, name, mesh, pad = 0) {
  const { channels, stride } = template;
  const vcount = mesh.attrs[0].length;
  const data = Buffer.alloc(vcount * stride);
  channels.forEach((c, ci) => {
    if (!c.dim) return;
    const values = mesh.attrs[ci];
    for (let v = 0; v < vcount; v++) {
      for (let d = 0; d < c.dim; d++) {
        const o = v * stride + c.offset + d * FORMATS[c.format];
        const x = values[v][d];
        if (c.format === 0) data.writeFloatLE(x, o);
        else if (c.format === 2) data[o] = Math.max(0, Math.min(255, Math.round(x * 255)));
        else if (c.format === 3) data.writeInt8(Math.max(-127, Math.min(127, Math.round(x * 127))), o);
        else throw new Error('writing half floats is not supported');
      }
    }
  });
  const wide = vcount > 65535;
  const ib = Buffer.alloc(wide ? mesh.triangles.length * 4 : Math.ceil(mesh.triangles.length / 2) * 4);
  mesh.triangles.forEach((x, i) => (wide ? ib.writeUInt32LE(x, 4 * i) : ib.writeUInt16LE(x, 2 * i)));
  const pos = mesh.attrs[0];
  const lo = [0, 1, 2].map(a => (vcount ? Math.min(...pos.map(p => p[a])) : 0));
  const hi = [0, 1, 2].map(a => (vcount ? Math.max(...pos.map(p => p[a])) : 0));
  const centre = v3(lo.map((x, a) => (x + hi[a]) / 2)), extent = v3(lo.map((x, a) => (hi[a] - x) / 2 + (vcount ? pad : 0)));
  return template.text
    .replace(/m_Name: .*/, `m_Name: ${name}`)
    .replace(/indexCount: \d+/, `indexCount: ${mesh.triangles.length}`)
    .replace(/(firstVertex: )\d+/, '$10')
    .replace(/vertexCount: \d+/, `vertexCount: ${vcount}`)
    .replace(/m_IndexFormat: \d+/, `m_IndexFormat: ${wide ? 1 : 0}`)
    .replace(/m_IndexBuffer: [0-9a-f]*/, `m_IndexBuffer: ${ib.toString('hex')}`)
    .replace(/m_VertexCount: \d+/, `m_VertexCount: ${vcount}`)
    .replace(/m_DataSize: \d+/, `m_DataSize: ${data.length}`)
    .replace(/_typelessdata: [0-9a-f]*/, `_typelessdata: ${data.toString('hex')}`)
    .replace(/(localAABB:\r?\n\s+m_Center: ).*(\r?\n\s+m_Extent: ).*/, `$1${centre}$2${extent}`)
    .replace(/(m_LocalAABB:\r?\n\s+m_Center: ).*(\r?\n\s+m_Extent: ).*/, `$1${centre}$2${extent}`);
}

// Tangents the way Unity's import computes them closely enough (MikkTSpace; against the tree's
// imported mesh: median 0.00 degrees off, 99% within 0.64): each triangle's UV tangent and
// bitangent made perpendicular to each corner's normal, unit length, weighted by the corner's
// angle, summed per vertex; w is the handedness (Unity's binormal = cross(normal, tangent) * w).
function tangents(positions, normals, uvs, triangles) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - (q[2] || 0)];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const unit = p => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return [p[0] / l, p[1] / l, p[2] / l]; };
  const perp = (v, n) => unit(sub(v, n.map(x => x * dot(n, v))));
  const t = positions.map(() => [0, 0, 0]), b = positions.map(() => [0, 0, 0]);
  for (let k = 0; k < triangles.length; k += 3) {
    const ids = [triangles[k], triangles[k + 1], triangles[k + 2]];
    const [p0, p1, p2] = ids.map(i => positions[i]), [u0, u1, u2] = ids.map(i => uvs[i]);
    const e1 = sub(p1, p0), e2 = sub(p2, p0);
    const d1 = [u1[0] - u0[0], u1[1] - u0[1]], d2 = [u2[0] - u0[0], u2[1] - u0[1]];
    const r = d1[0] * d2[1] - d2[0] * d1[1];
    if (Math.abs(r) < 1e-12) continue;
    const tt = [0, 1, 2].map(i => (e1[i] * d2[1] - e2[i] * d1[1]) / r), bb = [0, 1, 2].map(i => (e2[i] * d1[0] - e1[i] * d2[0]) / r);
    const P = [p0, p1, p2];
    ids.forEach((v, c) => {
      const n = normals[v];
      const ea = unit(sub(P[(c + 1) % 3], P[c])), eb = unit(sub(P[(c + 2) % 3], P[c]));
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(ea, eb))));
      const tp = perp(tt, n), bp = perp(bb, n);
      for (let i = 0; i < 3; i++) {
        t[v][i] += tp[i] * angle;
        b[v][i] += bp[i] * angle;
      }
    });
  }
  return normals.map((n, v) => {
    const tv = perp(t[v], n);
    const c = [n[1] * tv[2] - n[2] * tv[1], n[2] * tv[0] - n[0] * tv[2], n[0] * tv[1] - n[1] * tv[0]];
    return [...tv, dot(c, b[v]) < 0 ? -1 : 1];
  });
}

module.exports = { readMesh, writeMesh, tangents };
