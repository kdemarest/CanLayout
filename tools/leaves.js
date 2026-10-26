// Six-cornered leaves for Canopy's trees (docs: Rendering Performance, Leaves). Every leaf is drawn
// as a polygon hugging its texture's leaf instead of the whole quad, so the cutout shader throws
// away fewer pixels.
//   node tools/leaves.js            report what would change
//   node tools/leaves.js --write    write it
// Leaves are drawn two ways:
// - LeafSplit (the Beech, Oak and Maple scenes' trees): GPU-instanced copies of one canonical leaf
//   built in code. Each LeafSplit gets leafOutline, its material's outline in UV, and
//   placementMesh, the original ForestTreeLeaves_Lod0 it places the leaves from (it used to read
//   the LODGroup's LOD0 mesh, which changes below).
// - ForestTreeLeaves_Lod0-2 on MeshRenderers (TreeLeavesLods, GridOak; deactivated in the scenes
//   that use LeafSplit, shown for the tutorial tree and in the Foyer): one mesh set per leaf
//   texture, ForestTreeLeaves<Kind>_Lod0-2, each leaf the outline: Lod0 a fan of 6 triangles from
//   the outline's middle (7 vertices, keeping the leaf's raised center), Lod1 and Lod2 a fan of 4
//   (6 vertices). Every attribute of a new vertex (position, normal, tangent, wind color) is
//   interpolated from the original leaf's triangles at the vertex's UV. Then each MeshFilter, and
//   each prefab-instance override that gives a renderer a leaf material, gets the matching mesh.
// Outlines come from tools/leaf-fit.js (six corners, inside the texture, grown by its margin).
// Generated assets get stable guids (md5 of 'canopy-leaves:' + path), so rerunning rewrites them
// in place.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./scene.js');
const LeafFit = require('./leaf-fit.js');

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
const guidOf = new Map(Object.entries(index).map(([g, e]) => [e.path, g]));
const FOLDER = 'Assets/Meshes/ForestTreeLeavesLods';
const SOURCE = [0, 1, 2].map(n => `${FOLDER}/ForestTreeLeaves_Lod${n}.asset`);
// Leaf textures by kind, and a material of each to fit (the cutoff is the same for a texture's
// mesh and instanced materials).
const KINDS = {
  Beech: { texture: 'LeafBeech.png', material: 'LeafBeechMat' },
  Elm: { texture: 'leafElm2.png', material: 'LeafElmMat' },
  Maple: { texture: 'leafMaple.png', material: 'LeafMaple' },
  Oak: { texture: 'LeafOak2.png', material: 'LeafOakMat' },
  PinOak: { texture: 'LeafPinOak.png', material: 'LeafPinOakMat' }
};
const CORNERS = 6;
const LEAF_SPLIT = 'Assets/Scripts/LeafSplit.cs';

const meshPath = (kind, n) => `${FOLDER}/ForestTreeLeaves${kind}_Lod${n}.asset`;
const meshGuid = p => crypto.createHash('md5').update('canopy-leaves:' + p).digest('hex');
const readRepo = p => {
  const file = path.join(S.REPO, p);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return S.blobs([index[guidOf.get(p)].blob]).get(index[guidOf.get(p)].blob).toString();
};

// The leaf kind a material draws, by its main texture.
const kindCache = new Map();
function kindOfMaterial(guid) {
  if (!kindCache.has(guid)) {
    let kind = null;
    const e = index[guid];
    if (e && e.path.endsWith('.mat')) {
      const mat = S.parseMaterial(readRepo(e.path));
      const tex = mat.map && index[mat.map.guid];
      if (tex) kind = Object.keys(KINDS).find(k => path.basename(tex.path) === KINDS[k].texture) || null;
    }
    kindCache.set(guid, kind);
  }
  return kindCache.get(guid);
}

// ---- meshes ----

function readLeafMesh(text) {
  const num = k => +(new RegExp('\\b' + k + ': (-?\\d+)').exec(text) || [])[1];
  const vcount = num('m_VertexCount');
  const data = Buffer.from(/_typelessdata: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const stride = data.length / vcount;
  // Layout of ForestTreeLeaves: position, normal (float3), tangent (float4), color (4 bytes), uv (float2).
  const channels = [...text.split('m_Channels:')[1].split('m_DataSize:')[0].matchAll(/offset: (\d+)\s+format: (\d+)\s+dimension: (\d+)/g)].map(m => m.slice(1).map(Number));
  const expect = [[0, 0, 3], [12, 0, 3], [24, 0, 4], [40, 2, 4], [44, 0, 2]];
  if (stride !== 52 || expect.some((c, i) => c.join() !== channels[i].join())) throw new Error('unexpected leaf mesh vertex layout');
  const f = (o, n) => Array.from({ length: n }, (_, k) => data.readFloatLE(o + 4 * k));
  const verts = Array.from({ length: vcount }, (_, k) => {
    const o = k * stride;
    return { p: f(o, 3), n: f(o + 12, 3), t: f(o + 24, 4), c: [...data.subarray(o + 40, o + 44)], uv: f(o + 44, 2) };
  });
  const ib = Buffer.from(/m_IndexBuffer: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const count = num('indexCount');
  const tris = [];
  for (let i = 0; i < count; i += 3) tris.push([0, 1, 2].map(k => ib.readUInt16LE(2 * (i + k))));
  return { verts, tris };
}

const uvCross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// Every attribute at uv, from the leaf's triangle holding it (the nearest, if just outside).
function sample(verts, tris, uv) {
  let best = null;
  for (const t of tris) {
    const [a, b, c] = t.map(i => verts[i].uv);
    const d = uvCross(a, b, c);
    if (Math.abs(d) < 1e-12) continue;
    const wa = uvCross(uv, b, c) / d, wb = uvCross(a, uv, c) / d, wc = 1 - wa - wb;
    const worst = Math.min(wa, wb, wc);
    if (!best || worst > best.worst) best = { worst, t, w: [wa, wb, wc] };
  }
  const vs = best.t.map(i => verts[i]);
  const mix = k => vs[0][k].map((_, j) => vs.reduce((s, v, i) => s + v[k][j] * best.w[i], 0));
  const unit = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
  const t = mix('t');
  return { p: mix('p'), n: unit(mix('n')), t: [...unit(t.slice(0, 3)), vs[0].t[3]], c: mix('c').map(x => Math.max(0, Math.min(255, Math.round(x)))), uv };
}

// The leaf mesh with each leaf as the outline: with a middle vertex (Lod0) or a plain fan.
function reshape(src, outline, middle) {
  // Leaves: the source vertices in runs of the same size, triangles by their first vertex.
  const per = src.verts.length / (src.tris.length / (middle ? 4 : 2));
  const leaves = src.verts.length / per;
  const byLeaf = Array.from({ length: leaves }, () => []);
  for (const t of src.tris) byLeaf[Math.floor(t[0] / per)].push(t);
  // Keep the source's winding in UV for the front.
  const sign = Math.sign(uvCross(...src.tris[0].map(i => src.verts[i].uv)));
  const ring = Math.sign(outline.reduce((s, a, i) => { const b = outline[(i + 1) % outline.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0));
  const order = ring === sign ? outline : outline.slice().reverse();
  const centre = [0, 1].map(k => order.reduce((s, p) => s + p[k], 0) / order.length);
  const verts = [], tris = [];
  for (let l = 0; l < leaves; l++) {
    const base = verts.length;
    const local = byLeaf[l];
    if (middle) {
      verts.push(sample(src.verts, local, centre));
      for (const uv of order) verts.push(sample(src.verts, local, uv));
      for (let k = 0; k < order.length; k++) tris.push([base, base + 1 + k, base + 1 + (k + 1) % order.length]);
    } else {
      for (const uv of order) verts.push(sample(src.verts, local, uv));
      for (let k = 1; k + 1 < order.length; k++) tris.push([base, base + k, base + k + 1]);
    }
  }
  return { verts, tris };
}

// The source asset's text with this mesh's name, vertices, indices and bounds.
function meshText(template, name, mesh) {
  const vb = Buffer.alloc(mesh.verts.length * 52);
  mesh.verts.forEach((v, k) => {
    const o = k * 52;
    [...v.p, ...v.n, ...v.t].forEach((x, j) => vb.writeFloatLE(x, o + 4 * j));
    v.c.forEach((x, j) => (vb[o + 40 + j] = x));
    v.uv.forEach((x, j) => vb.writeFloatLE(x, o + 44 + 4 * j));
  });
  const idx = mesh.tris.flat();
  if (mesh.verts.length > 65535) throw new Error('too many vertices for 16-bit indices');
  const ib = Buffer.alloc(Math.ceil(idx.length / 2) * 4);
  idx.forEach((x, i) => ib.writeUInt16LE(x, 2 * i));
  const lo = [0, 1, 2].map(a => Math.min(...mesh.verts.map(v => v.p[a])));
  const hi = [0, 1, 2].map(a => Math.max(...mesh.verts.map(v => v.p[a])));
  const v3 = a => `{x: ${+a[0].toPrecision(8)}, y: ${+a[1].toPrecision(8)}, z: ${+a[2].toPrecision(8)}}`;
  const centre = v3(lo.map((x, a) => (x + hi[a]) / 2)), extent = v3(lo.map((x, a) => (hi[a] - x) / 2));
  return template
    .replace(/m_Name: .*/, `m_Name: ${name}`)
    .replace(/indexCount: \d+/, `indexCount: ${idx.length}`)
    .replace(/vertexCount: \d+/, `vertexCount: ${mesh.verts.length}`)
    .replace(/m_VertexCount: \d+/, `m_VertexCount: ${mesh.verts.length}`)
    .replace(/m_DataSize: \d+/, `m_DataSize: ${vb.length}`)
    .replace(/_typelessdata: [0-9a-f]*/, `_typelessdata: ${vb.toString('hex')}`)
    .replace(/m_IndexBuffer: [0-9a-f]*/, `m_IndexBuffer: ${ib.toString('hex')}`)
    .replace(/(localAABB:\r?\n\s+m_Center: ).*(\r?\n\s+m_Extent: ).*/, `$1${centre}$2${extent}`)
    .replace(/(m_LocalAABB:\r?\n\s+m_Center: ).*(\r?\n\s+m_Extent: ).*/, `$1${centre}$2${extent}`);
}

function metaText(guid) {
  return `fileFormatVersion: 2\nguid: ${guid}\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 4300000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
}

// ---- wiring ----

function parseDocs(text) {
  const docs = {};
  for (const d of text.split(/^--- /m)) {
    const m = /^!u!(\d+) &(-?\d+)( stripped)?/.exec(d);
    if (m) docs[m[2]] = { cls: m[1], text: d, stripped: Boolean(m[3]) };
  }
  return docs;
}
const docsCache = new Map();
const docsOf = g => {
  if (!docsCache.has(g)) docsCache.set(g, parseDocs(readRepo(index[g].path)));
  return docsCache.get(g);
};
const xor = (...ids) => BigInt.asIntN(64, ids.reduce((a, b) => a ^ BigInt.asUintN(64, BigInt(b)), 0n)).toString();

// The object a prefab-instance target names: [prefab guid, fileID in that prefab, its own
// document], following nested instances (a nested object's id is its inner id xor the instance's).
function innermost(g, id) {
  const docs = docsOf(g);
  if (docs[id] && !docs[id].stripped) return [g, id, docs[id]];
  for (const [instance, d] of Object.entries(docs)) {
    if (d.cls !== '1001') continue;
    const src = /m_SourcePrefab: \{fileID: \d+, guid: (\w+)/.exec(d.text)[1];
    if (!index[src]) continue;
    const found = innermost(src, xor(id, instance));
    if (found) return found;
  }
  return null;
}
const gameObjectOf = d => (/m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text) || [])[1];
const filterBeside = (docs, go) => Object.entries(docs).find(([, d]) => d.cls === '33' && gameObjectOf(d) === go);

function main() {
  const write = process.argv.includes('--write');
  const changes = [];
  const save = (p, text) => {
    changes.push(p);
    if (write) {
      fs.mkdirSync(path.dirname(path.join(S.REPO, p)), { recursive: true });
      fs.writeFileSync(path.join(S.REPO, p), text);
    }
  };

  // Outlines.
  const outlines = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const fit = LeafFit.fit(k.material);
    const o = fit.outlines.find(x => x.corners === CORNERS) || fit.outlines[fit.outlines.length - 1];
    outlines[kind] = o.uv;
    console.log(`${kind}: ${o.corners} corners, leaf ${(100 * o.share).toFixed(0)}% of the drawn area (quad ${(100 * fit.quad).toFixed(0)}%)`);
  }

  // Meshes.
  const sources = SOURCE.map(p => ({ path: p, guid: guidOf.get(p), text: readRepo(p) }));
  const lodOfMesh = new Map(sources.map((s, n) => [s.guid, n]));
  for (const kind of Object.keys(KINDS)) {
    sources.forEach((s, n) => {
      const p = meshPath(kind, n);
      lodOfMesh.set(meshGuid(p), n);
      const mesh = reshape(readLeafMesh(s.text), outlines[kind], n === 0);
      save(p, meshText(s.text, path.basename(p, '.asset'), mesh));
      save(p + '.meta', metaText(meshGuid(p)));
      if (kind === 'Beech') console.log(`  Lod${n}: ${mesh.verts.length} vertices, ${mesh.tris.length} triangles a texture`);
    });
  }
  const meshRef = (kind, n) => `{fileID: 4300000, guid: ${meshGuid(meshPath(kind, n))}, type: 2}`;

  // Prefabs and scenes that set leaf meshes, leaf materials or LeafSplit.
  const leafSplit = guidOf.get(LEAF_SPLIT);
  const leafMats = Object.entries(index).filter(([g, e]) => e.path.endsWith('.mat') && /\/i?Leaf/.test(e.path) && kindOfMaterial(g)).map(([g]) => g);
  const needles = [...lodOfMesh.keys(), ...leafMats, leafSplit];
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(S.REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(prefab|unity)$/.test(e.name)) files.push(rel);
    }
  })('Assets');
  for (const rel of files) {
    const original = fs.readFileSync(path.join(S.REPO, rel), 'utf8');
    if (!needles.some(n => original.includes(n))) continue;
    const docs = parseDocs(original);
    let text = original;
    const notes = [];
    for (const [id, d] of Object.entries(docs)) {
      let doc = d.text;
      // A MeshFilter showing a leaf mesh: the mesh matching its renderer's material.
      if (d.cls === '33' && !d.stripped) {
        const m = /m_Mesh: \{fileID: 4300000, guid: (\w+), type: 2\}/.exec(doc);
        if (m && lodOfMesh.has(m[1])) {
          const renderer = Object.values(docs).find(x => x.cls === '23' && gameObjectOf(x) === gameObjectOf(d));
          const mat = renderer && (/m_Materials:\r?\n\s+- \{fileID: \d+, guid: (\w+)/.exec(renderer.text) || [])[1];
          const kind = mat && kindOfMaterial(mat);
          if (kind) {
            doc = doc.replace(m[0], `m_Mesh: ${meshRef(kind, lodOfMesh.get(m[1]))}`);
            notes.push(`MeshFilter &${id}: ${kind} Lod${lodOfMesh.get(m[1])}`);
          }
        }
      }
      // A prefab instance giving a leaf renderer a leaf material: the matching mesh beside it.
      if (d.cls === '1001') {
        const mods = [...doc.matchAll(/( *)- target: \{fileID: (-?\d+), guid: (\w+), type: 3\}\r?\n\s+propertyPath: m_Materials\.Array\.data\[0\]\r?\n\s+value: .*\r?\n\s+objectReference: \{fileID: \d+, guid: (\w+), type: 2\}\r?\n/g)];
        for (const m of mods) {
          const kind = kindOfMaterial(m[4]);
          const found = kind && index[m[3]] && innermost(m[3], m[2]);
          if (!found) continue;
          const [g, inner, rdoc] = found;
          const filter = filterBeside(docsOf(g), gameObjectOf(rdoc));
          if (!filter) continue;
          const lod = lodOfMesh.get((/m_Mesh: \{fileID: 4300000, guid: (\w+)/.exec(filter[1].text) || [])[1]);
          if (lod === undefined) continue;
          const target = xor(m[2], inner, filter[0]);
          const entry = `${m[1]}- target: {fileID: ${target}, guid: ${m[3]}, type: 3}\n${m[1]}  propertyPath: m_Mesh\n${m[1]}  value: \n${m[1]}  objectReference: ${meshRef(kind, lod)}\n`;
          const existing = new RegExp(` *- target: \\{fileID: ${target}, guid: ${m[3]}, type: 3\\}\\r?\\n\\s+propertyPath: m_Mesh\\r?\\n\\s+value: .*\\r?\\n\\s+objectReference: .*\\r?\\n`);
          doc = existing.test(doc) ? doc.replace(existing, entry) : doc.replace(m[0], m[0] + entry);
          notes.push(`instance &${id}: ${kind} Lod${lod} mesh override`);
        }
      }
      // LeafSplit: its material's outline and the original leaf placement mesh.
      if (d.cls === '114' && doc.includes(`guid: ${leafSplit}`)) {
        const mat = (/leafMaterial: \{fileID: \d+, guid: (\w+)/.exec(doc) || [])[1];
        const kind = mat && kindOfMaterial(mat);
        if (kind) {
          doc = doc.replace(/ {2}leafOutline:.*\r?\n( {2}- \{x: .*\r?\n)*/, '').replace(/ {2}placementMesh: .*\r?\n/, '');
          const lines = ['  leafOutline:', ...outlines[kind].map(([x, y]) => `  - {x: ${x}, y: ${y}}`), `  placementMesh: {fileID: 4300000, guid: ${sources[0].guid}, type: 2}`];
          doc = doc.replace(/( {2}margin: .*\r?\n)/, `$1${lines.join('\n')}\n`);
          notes.push(`LeafSplit &${id}: ${kind} outline, placement from ForestTreeLeaves_Lod0`);
        }
      }
      if (doc !== d.text) text = text.replace(d.text, doc);
    }
    if (text !== original) {
      save(rel, text);
      console.log(`${rel}:\n  ${notes.join('\n  ')}`);
    }
  }
  console.log(write ? `wrote ${changes.length} files` : `${changes.length} files would change (--write to write them)`);
}

if (require.main === module) main();
