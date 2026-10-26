// Branch tips in Canopy's trees (docs: Rendering Performance, Trees). MTree never closes a
// branch's last ring (Splines.GenerateMeshData bridges ring to ring and stops), so a tip is an
// open hole and back-face culling shows the branch's inside through it. This finds those tips by
// side count and can close each with a flat fan.
//   node tools/tree-tips.js                     report on the shipped tree
//   node tools/tree-tips.js --cap               also write the capped meshes
//   options: --source <path text> (the uncut tree mesh; default GridForestTreeCollider.asset),
//            --prefab <path> (the chunks cut from it; default StdTreeLods), --scale 10 (mesh units
//            to meters: the trees are placed at 10x), --max-sides 6 and --max-radius 0.5 (meters):
//            larger open rings are not branch tips (the trunk's bottom, slits where it splits)
//            and are listed, not capped
// Beech, Oak, Maple and the tutorial tree all draw StdTreeLods (the GridForestTreeBare2 chunks,
// L0-L2) and collide with GridForestTreeCollider (the Grabbable and Convex MeshColliders), and the
// chunks are that same mesh cut into cubes. So tips are found once, on the uncut mesh: each branch
// is its own piece (connected component), open at its base, which is buried in its parent (a ray
// from the ring's centre crosses the other pieces an odd number of times), and either open or
// closed to a point at its tip. An open ring that is not buried is a tip. In a chunk, an open ring
// is a tip when its centre, in the prefab's space, is on a source tip's centre and it has as many
// sides; tips that a cut splits are left alone.
// A cap is a fan of sides-2 triangles over the ring's own vertices: no vertex is added, so only
// the index buffer and the submesh's index count change, the branch keeps its full thickness to
// the end (nothing sharp to grab), and the end shades with the ring's own (rounded) normals. Each
// fan runs the ring's edges opposite to the triangles beside them, so it faces out like they do.
// Meshes are read from the working tree when checked out (a rerun after --cap finds nothing left
// to cap), else from git. git sees written files only if they are in the sparse checkout
// (git sparse-checkout add).
const fs = require('fs');
const path = require('path');
const S = require('./scene.js');

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}

// The parts of a text Unity Mesh .asset this needs: positions, the index buffer and the submeshes.
function readMesh(text) {
  const num = k => +(new RegExp('\\b' + k + ': (-?\\d+)').exec(text) || [])[1];
  if (num('m_MeshCompression')) throw new Error('compressed mesh not supported');
  const vcount = num('m_VertexCount');
  const channels = [...text.split('m_Channels:')[1].split('m_DataSize:')[0]
    .matchAll(/- stream: (\d+)\s+offset: (\d+)\s+format: (\d+)\s+dimension: (\d+)/g)]
    .map(m => ({ stream: +m[1], offset: +m[2], format: +m[3], dim: +m[4] & 0xf }));
  const SIZE = { 0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2 };
  const strides = [];
  channels.forEach(c => { if (c.dim) strides[c.stream] = Math.max(strides[c.stream] || 0, c.offset + c.dim * SIZE[c.format]); });
  const p = channels[0];
  if (p.stream !== 0 || p.format !== 0) throw new Error('positions are not float in stream 0');
  const data = Buffer.from(/_typelessdata: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const pos = [];
  for (let v = 0; v < vcount; v++) {
    const at = v * strides[0] + p.offset;
    pos.push([data.readFloatLE(at), data.readFloatLE(at + 4), data.readFloatLE(at + 8)]);
  }
  const wide = num('m_IndexFormat') === 1;
  const ib = Buffer.from(/m_IndexBuffer: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const submeshes = [...text.matchAll(/firstByte: (\d+)\r?\n\s+indexCount: (\d+)\r?\n\s+topology: (\d+)\r?\n\s+baseVertex: (\d+)/g)]
    .map(m => ({ firstByte: +m[1], indexCount: +m[2], topology: +m[3], baseVertex: +m[4] }));
  // The buffer can run past the last submesh (16-bit indices are padded to 4 bytes).
  const size = wide ? 4 : 2;
  const end = Math.max(...submeshes.map(s => s.firstByte + s.indexCount * size));
  const indices = [];
  for (let o = 0; o < end; o += size) indices.push(wide ? ib.readUInt32LE(o) : ib.readUInt16LE(o));
  // Weld by position: MTree and the chunker duplicate seam vertices (same place, other UV).
  const key = q => q.map(x => Math.round(x * 1e5)).join();
  const first = new Map(), welded = [];
  pos.forEach((q, i) => {
    const k = key(q);
    if (!first.has(k)) first.set(k, i);
    welded[i] = first.get(k);
  });
  return { pos, indices, wide, submeshes, welded };
}

// Open loops: boundary half-edges (a -> b in the one triangle that has them), joined into rings
// in the order a cap runs them (each edge reversed). ring holds original vertex indices.
function loops(mesh) {
  const { indices, welded } = mesh;
  const half = new Map(); // "a,b" (welded) -> [original a, original b, the triangle's third vertex]
  const count = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k], b = indices[t + (k + 1) % 3];
      const wa = welded[a], wb = welded[b];
      if (wa === wb) continue;
      half.set(`${wa},${wb}`, [a, b, indices[t + (k + 2) % 3]]);
      const u = wa < wb ? `${wa},${wb}` : `${wb},${wa}`;
      count.set(u, (count.get(u) || 0) + 1);
    }
  }
  const capNext = new Map(), original = new Map(), across = new Map();
  let tangled = 0;
  for (const [k, [a, b, c]] of half) {
    const [wa, wb] = k.split(',').map(Number);
    if (count.get(wa < wb ? k : `${wb},${wa}`) !== 1) continue;
    if (capNext.has(wb)) tangled++;
    capNext.set(wb, wa);
    original.set(wa, a);
    original.set(wb, b);
    across.set(wb, c);
  }
  const seen = new Set(), out = [];
  for (const start of capNext.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let at = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      ring.push(at);
      at = capNext.get(at);
    }
    out.push({ ring: ring.map(w => original.get(w)), inner: ring.map(w => across.get(w)), closed: at === start });
  }
  return { loops: out, tangled };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centre = (pos, ring) => [0, 1, 2].map(a => ring.reduce((s, i) => s + pos[i][a], 0) / ring.length);
const radius = (pos, ring) => {
  const c = centre(pos, ring);
  return ring.reduce((s, i) => s + Math.hypot(...sub(pos[i], c)), 0) / ring.length;
};

// Connected pieces (branches), by welded vertex.
function pieces(mesh) {
  const { indices, welded } = mesh;
  const parent = welded.map((_, i) => i);
  const find = x => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(welded[indices[t]]);
    parent[find(welded[indices[t + 1]])] = a;
    parent[find(welded[indices[t + 2]])] = a;
  }
  return welded.map(w => find(w));
}

// Is the point inside another piece? Ray parity (Moller-Trumbore) on three rays, majority.
const RAYS = [[0.267, 0.534, 0.802], [-0.577, 0.577, -0.577], [0.801, -0.267, 0.535]];
function buried(mesh, pieceOf, point, piece) {
  const { pos, indices } = mesh;
  let odd = 0;
  for (const d of RAYS) {
    let n = 0;
    for (let t = 0; t < indices.length; t += 3) {
      if (pieceOf[indices[t]] === piece) continue;
      const a = pos[indices[t]], e1 = sub(pos[indices[t + 1]], a), e2 = sub(pos[indices[t + 2]], a);
      const p = cross(d, e2), det = dot(e1, p);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(point, a), u = dot(s, p) / det;
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1), v = dot(d, q) / det;
      if (v < 0 || u + v > 1) continue;
      if (dot(e2, q) / det > 0) n++;
    }
    if (n % 2) odd++;
  }
  return odd >= 2;
}

// The uncut tree: its open tips, branch bases, and branches whose tip closes to a point.
function sourceTips(mesh) {
  const pieceOf = pieces(mesh);
  const { loops: all } = loops(mesh);
  const tips = [], bases = [], unclosed = [];
  const withTip = new Set();
  for (const l of all) {
    if (!l.closed || l.ring.length < 3) { unclosed.push(l); continue; }
    const piece = pieceOf[l.ring[0]];
    l.centre = centre(mesh.pos, l.ring);
    l.radius = radius(mesh.pos, l.ring);
    if (buried(mesh, pieceOf, l.centre, piece)) bases.push(l);
    else { tips.push(l); withTip.add(piece); }
  }
  const branches = new Set(pieceOf).size;
  return { tips, bases, unclosed, branches, closedTips: branches - withTip.size };
}

// Each MeshFilter's mesh in a prefab, with the offset and scale into the prefab's space (below its
// root; the chunk transforms are unrotated).
function prefabMeshes(file) {
  const text = fs.readFileSync(path.join(S.REPO, file), 'utf8');
  const docs = {};
  for (const d of text.split(/^--- /m)) {
    const m = /^!u!(\d+) &(-?\d+)/.exec(d);
    if (m) docs[m[2]] = { cls: m[1], text: d };
  }
  const v = (t, k) => (new RegExp(k + ': \\{x: (\\S+), y: (\\S+), z: (\\S+?)(?:, w: (\\S+))?\\}').exec(t) || []).slice(1).filter(x => x !== undefined).map(Number);
  const byGo = {}, byId = {};
  for (const [id, d] of Object.entries(docs)) {
    if (d.cls !== '4') continue;
    const t = { id, pos: v(d.text, 'm_LocalPosition'), rot: v(d.text, 'm_LocalRotation'), scale: v(d.text, 'm_LocalScale'), father: /m_Father: \{fileID: (-?\d+)\}/.exec(d.text)[1] };
    byGo[/m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)[1]] = t;
    byId[id] = t;
  }
  const out = [];
  for (const d of Object.values(docs)) {
    if (d.cls !== '33') continue;
    const g = /m_Mesh: \{fileID: -?\d+, guid: (\w+)/.exec(d.text);
    if (!g || !index[g[1]]) continue;
    let offset = [0, 0, 0], scale = [1, 1, 1];
    for (let t = byGo[/m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)[1]]; t && byId[t.father]; t = byId[t.father]) {
      if (Math.abs(t.rot[3]) < 0.9999) throw new Error(`${file}: rotated transforms are not supported`);
      offset = offset.map((x, a) => x * t.scale[a] + t.pos[a]);
      scale = scale.map((x, a) => x * t.scale[a]);
    }
    out.push({ path: index[g[1]].path, blob: index[g[1]].blob, offset, scale });
  }
  return out;
}

// Does the fan over a ring face the way the triangles beside it do? Out along the branch for a cap
// is out from the axis for the side triangles; compare the two windings' normals against those.
function facesOut(pos, l) {
  const c = centre(pos, l.ring), inner = centre(pos, l.inner);
  const along = sub(c, inner);
  const unit = along.map(x => x / Math.hypot(...along));
  let fan = [0, 0, 0];
  for (let k = 1; k + 1 < l.ring.length; k++) {
    const n = cross(sub(pos[l.ring[k]], pos[l.ring[0]]), sub(pos[l.ring[k + 1]], pos[l.ring[0]]));
    fan = fan.map((x, a) => x + n[a]);
  }
  // a side triangle: (ring[1], ring[0], inner[0]), its edge running opposite to the cap's
  const a = pos[l.ring[0]], b = pos[l.ring[1]], x = pos[l.inner[0]];
  const side = cross(sub(a, b), sub(x, b));
  const mid = [0, 1, 2].map(i => (a[i] + b[i] + x[i]) / 3);
  const off = sub(mid, c), radial = sub(off, unit.map(x => x * dot(off, unit))); // out from the axis
  return Math.sign(dot(fan, along)) === Math.sign(dot(side, radial));
}

// The mesh's text with a flat fan over each ring, appended to the submesh's indices.
function capped(text, mesh, rings) {
  if (mesh.submeshes.length !== 1 || mesh.submeshes[0].topology !== 0) throw new Error('only one triangle submesh is supported');
  const add = [];
  for (const ring of rings) for (let k = 1; k + 1 < ring.length; k++) add.push(ring[0], ring[k], ring[k + 1]);
  const all = mesh.indices.concat(add);
  // Keep Unity's padding of a 16-bit buffer to a multiple of 4 bytes.
  const buf = Buffer.alloc(mesh.wide ? all.length * 4 : Math.ceil(all.length / 2) * 4);
  all.forEach((x, i) => (mesh.wide ? buf.writeUInt32LE(x, i * 4) : buf.writeUInt16LE(x, i * 2)));
  return text
    .replace(/(m_IndexBuffer: )[0-9a-f]*/, (m, k) => k + buf.toString('hex'))
    .replace(/(firstByte: \d+\r?\n\s+indexCount: )\d+/, (m, k) => k + all.length);
}

function main() {
  const sourceText = option('--source', 'GridForestTreeCollider.asset');
  const prefab = option('--prefab', 'Assets/Prefabs/Trees/StdTreeLods.prefab');
  const scale = +option('--scale', 10);
  const cap = process.argv.includes('--cap');
  const maxSides = +option('--max-sides', 6), maxRadius = +option('--max-radius', 0.5);
  const source = Object.values(index).find(e => e.path.includes(sourceText) && e.path.endsWith('.asset'));
  const chunks = prefab === 'none' ? [] : prefabMeshes(prefab);
  // The working tree's copy when there is one (so a rerun sees the caps), else git's.
  const all = [source, ...chunks];
  const onDisk = new Map(all.filter(e => fs.existsSync(path.join(S.REPO, e.path))).map(e => [e.path, fs.readFileSync(path.join(S.REPO, e.path), 'utf8')]));
  const blobs = S.blobs(all.filter(e => !onDisk.has(e.path)).map(e => e.blob));
  const textOf = e => onDisk.get(e.path) || blobs.get(e.blob).toString();
  const srcText = textOf(source);
  const mesh = readMesh(srcText);
  const found = sourceTips(mesh);
  const openings = found.tips.filter(t => t.ring.length > maxSides || t.radius * scale > maxRadius);
  found.tips = found.tips.filter(t => !openings.includes(t));
  const q = (a, f) => a[Math.floor(f * (a.length - 1))];
  console.log(`${source.path}: ${found.branches} branches; ${found.tips.length} open tips, ${found.closedTips} closed to a point, ${found.bases.length} open bases (buried; left open)${found.unclosed.length ? `, ${found.unclosed.length} other open edges` : ''}`);
  console.log(`open tips by side count (radius in m at ${scale}x):`);
  const facing = found.tips.filter(t => facesOut(mesh.pos, t)).length;
  const bySides = {};
  for (const t of found.tips) (bySides[t.ring.length] = bySides[t.ring.length] || []).push(t.radius * scale);
  for (const [n, rs] of Object.entries(bySides).sort((a, b) => a[0] - b[0])) {
    rs.sort((a, b) => a - b);
    console.log(`  ${n} sides: ${rs.length}  radius median ${q(rs, 0.5).toFixed(3)}, 90% ${q(rs, 0.9).toFixed(3)}, max ${q(rs, 1).toFixed(3)}`);
  }
  console.log(`  caps facing out like the bark beside them: ${facing} of ${found.tips.length}`);
  if (openings.length) {
    console.log(`other openings, not capped (over ${maxSides} sides or ${maxRadius} m):`);
    for (const t of openings) console.log(`  ${t.ring.length} sides, radius ${(t.radius * scale).toFixed(2)} m, at ${t.centre.map(x => x.toFixed(2)).join(', ')}`);
  }
  const plans = [{ entry: source, text: srcText, mesh, rings: found.tips.map(t => t.ring) }];
  if (chunks.length) {
    const levels = {};
    let wrongWay = 0;
    for (const c of chunks) {
      const text = textOf(c);
      const m = readMesh(text);
      const rings = [];
      for (const l of loops(m).loops) {
        if (!l.closed || l.ring.length < 3) continue;
        const at = centre(m.pos, l.ring).map((x, a) => x * c.scale[a] + c.offset[a]);
        // same place and side count (a tip on a cut joins the cut's loop: left open)
        if (!found.tips.some(t => t.ring.length === l.ring.length && Math.hypot(...sub(at, t.centre)) <= t.radius * 0.5 + 1e-4)) continue;
        rings.push(l.ring);
        if (!facesOut(m.pos, l)) wrongWay++;
      }
      const level = ((/_(L\d)\.asset$/.exec(c.path)) || [])[1] || 'other';
      const r = levels[level] = levels[level] || { meshes: 0, withTips: 0, tips: 0, tris: 0 };
      r.meshes++;
      r.tips += rings.length;
      r.tris += rings.reduce((s, ring) => s + ring.length - 2, 0);
      if (rings.length) r.withTips++;
      plans.push({ entry: c, text, mesh: m, rings });
    }
    console.log(`${prefab}: ${chunks.length} chunk meshes`);
    for (const [l, r] of Object.entries(levels).sort()) console.log(`  ${l}: ${r.tips} tips in ${r.withTips} of ${r.meshes} meshes; caps add ${r.tris} triangles`);
    console.log(`  caps facing the wrong way: ${wrongWay}`);
  }
  const srcTris = found.tips.reduce((s, t) => s + t.ring.length - 2, 0);
  console.log(`  ${source.path.split('/').pop()}: caps add ${srcTris} triangles to its ${mesh.indices.length / 3}`);
  if (cap) {
    let written = 0;
    for (const p of plans) {
      if (!p.rings.length) continue;
      fs.writeFileSync(path.join(S.REPO, p.entry.path), capped(p.text, p.mesh, p.rings));
      written++;
    }
    console.log(`capped: wrote ${written} meshes`);
  }
}

if (require.main === module) main();

module.exports = { readMesh, loops, pieces, sourceTips, prefabMeshes, facesOut, capped };
