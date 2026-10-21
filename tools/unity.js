// Unity YAML reading for the scene tools: scenes and prefabs to world placements and mesh parts.
// Positions and rotations stay in Unity's left-handed space; the viewer mirrors X.
const fs = require('fs');
const path = require('path');

const REPO = '/sdcard/Canopy';
const BUILTIN_GUID = '0000000000000000e000000000000000';
const BUILTIN = { 10202: 'Cube', 10206: 'Cylinder', 10207: 'Sphere', 10208: 'Capsule', 10209: 'Plane', 10210: 'Quad' };
const MODEL_EXT = /\.(fbx|obj|blend|dae|3ds|max)$/i;

// ---------- math (quaternions {x,y,z,w}; matrices row-major arrays of 16) ----------
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  }
  return o;
}
function trs(p, q, s) {
  const { x, y, z, w } = q;
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
  ];
  return [
    r[0] * s.x, r[1] * s.y, r[2] * s.z, p.x,
    r[3] * s.x, r[4] * s.y, r[5] * s.z, p.y,
    r[6] * s.x, r[7] * s.y, r[8] * s.z, p.z,
    0, 0, 0, 1
  ];
}
const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
});
const deg = Math.PI / 180;
// Unity euler angles (degrees): Z, then X, then Y, i.e. q = qy * qx * qz.
function eulerToQuat(e) {
  const h = v => v * deg / 2;
  const qx = { x: Math.sin(h(e.x)), y: 0, z: 0, w: Math.cos(h(e.x)) };
  const qy = { x: 0, y: Math.sin(h(e.y)), z: 0, w: Math.cos(h(e.y)) };
  const qz = { x: 0, y: 0, z: Math.sin(h(e.z)), w: Math.cos(h(e.z)) };
  return qmul(qmul(qy, qx), qz);
}
function quatToEuler(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  const x = q.x / n, y = q.y / n, z = q.z / n, w = q.w / n;
  const m02 = 2 * (x * z + w * y), m12 = 2 * (y * z - w * x), m22 = 1 - 2 * (x * x + y * y);
  const m10 = 2 * (x * y + w * z), m11 = 1 - 2 * (x * x + z * z), m00 = 1 - 2 * (y * y + z * z), m20 = 2 * (x * z - w * y);
  const ex = Math.asin(Math.max(-1, Math.min(1, -m12)));
  let ey, ez;
  if (Math.abs(m12) < 0.9999999) {
    ey = Math.atan2(m02, m22);
    ez = Math.atan2(m10, m11);
  } else {
    ey = Math.atan2(-m20, m00);
    ez = 0;
  }
  const d = v => ((v / deg) % 360 + 360) % 360;
  return { x: d(ex), y: d(ey), z: d(ez) };
}

// ---------- YAML documents ----------
function documents(text) {
  const out = [];
  const re = /^--- !u!(\d+) &(-?\d+)( stripped)?[^\n]*$/gm;
  let m, last = null;
  while ((m = re.exec(text))) {
    if (last) last.body = text.slice(last.start, m.index);
    last = { cls: +m[1], id: m[2], stripped: !!m[3], start: re.lastIndex };
    out.push(last);
  }
  if (last) last.body = text.slice(last.start);
  return out;
}
const num = s => (s === undefined ? undefined : parseFloat(s));
function vec(body, key) {
  const m = new RegExp(key + ': \\{x: ([^,]+), y: ([^,]+), z: ([^,}]+)(?:, w: ([^}]+))?\\}').exec(body);
  return m ? { x: num(m[1]), y: num(m[2]), z: num(m[3]), w: num(m[4]) } : null;
}
const ref = (body, key) => { const m = new RegExp(key + ': \\{fileID: (-?\\d+)').exec(body); return m ? m[1] : '0'; };
const guidRef = (body, key) => { const m = new RegExp(key + ': \\{fileID: (-?\\d+), guid: ([0-9a-f]+)').exec(body); return m ? { fileID: m[1], guid: m[2] } : null; };
function modifications(body) {
  return [...body.matchAll(/- target: \{fileID: (-?\d+)(?:, guid: [0-9a-f]+)?[^\n]*\n\s*propertyPath: ([^\n]+)\n\s*value: ([^\n]*)/g)]
    .map(m => ({ target: m[1], path: m[2].trim(), value: m[3].trim() }));
}

// Parses one Unity file into transforms, game objects, mesh components, and prefab instances.
function parse(text) {
  const d = documents(text.replace(/\r\n/g, '\n')); // some files have Windows line endings
  const t = {}, go = {}, mesh = {}, inst = {}, strippedT = {}, strippedGo = {}, textId = {}, shown = {}, material = {};
  for (const x of d) {
    // A mesh is drawn only by an enabled MeshRenderer (23) or SkinnedMeshRenderer (137).
    if ((x.cls === 23 || x.cls === 137) && !x.stripped && !/\n {2}m_Enabled: 0/.test(x.body)) {
      shown[ref(x.body, 'm_GameObject')] = true;
      // The first material; meshes with several submeshes use only it for now.
      const m = /m_Materials:\n\s+- \{fileID: -?\d+, guid: ([0-9a-f]+)/.exec(x.body);
      if (m) material[ref(x.body, 'm_GameObject')] = m[1];
    }
    if ((x.cls === 4 || x.cls === 224) && x.stripped) strippedT[x.id] = ref(x.body, 'm_PrefabInstance');
    else if (x.cls === 4 || x.cls === 224) {
      t[x.id] = {
        go: ref(x.body, 'm_GameObject'), father: ref(x.body, 'm_Father'),
        pos: vec(x.body, 'm_LocalPosition') || { x: 0, y: 0, z: 0 },
        rot: vec(x.body, 'm_LocalRotation') || { x: 0, y: 0, z: 0, w: 1 },
        scl: vec(x.body, 'm_LocalScale') || { x: 1, y: 1, z: 1 }
      };
    } else if (x.cls === 1 && x.stripped) strippedGo[x.id] = ref(x.body, 'm_PrefabInstance');
    else if (x.cls === 1) go[x.id] = { name: ((/m_Name: (.*)/.exec(x.body) || [])[1] || '').trim(), active: !/m_IsActive: 0/.test(x.body) };
    else if (x.cls === 33 || x.cls === 137) {
      const r = guidRef(x.body, 'm_Mesh');
      if (r) mesh[ref(x.body, 'm_GameObject')] = r;
    } else if (x.cls === 114) {
      const m = /\n {2}textId: (.+)/.exec(x.body);
      if (m && m[1].trim()) textId[ref(x.body, 'm_GameObject')] = m[1].trim();
    } else if (x.cls === 1001) {
      const src = guidRef(x.body, 'm_SourcePrefab');
      inst[x.id] = { src: src && src.guid, parent: ref(x.body, 'm_TransformParent'), mods: modifications(x.body) };
    }
  }
  return { t, go, mesh, inst, strippedT, strippedGo, textId, material, shown };
}

// ---------- repository lookups ----------
let guidIndex = null;
function index() {
  if (!guidIndex) guidIndex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
  return guidIndex;
}
// A mesh reference ({fileID, guid}) described for the viewer and the mesh fetcher.
function describeMesh(r) {
  if (r.guid === BUILTIN_GUID) return { kind: 'builtin', name: BUILTIN[r.fileID] || `builtin ${r.fileID}` };
  const e = index()[r.guid];
  if (!e) return { kind: 'missing', name: `guid ${r.guid}` };
  const base = path.basename(e.path).replace(/\.[^.]+$/, '');
  if (e.path.endsWith('.asset')) return { kind: 'asset', name: base, path: e.path, blob: e.blob };
  // listed: the mesh name came from the .meta's table (else it is just the file name)
  if (MODEL_EXT.test(e.path)) return { kind: 'model', name: (e.meshes && e.meshes[r.fileID]) || base, listed: Boolean(e.meshes && e.meshes[r.fileID]), fileID: r.fileID, guid: r.guid, path: e.path, blob: e.blob };
  return { kind: 'other', name: base, path: e.path };
}
const isLodBeyondZero = name => /[_ ]?lod[1-9]\d*$/i.test(name);
// LOD index from a name ending in LODn, else -1.
// Matches Lod2, _LOD2, L2 and _L2 (the tree grid chunks use L0..L5).
const lodIndex = name => { const m = /(?:^|[_ ])l(?:od)?(\d+)$/i.exec(name || ''); return m ? +m[1] : -1; };
// Unity's id for an object inside a prefab instance, as written in the file that holds the
// instance: (instance id XOR the object's id in its source prefab), as 63 bits.
const MASK = (1n << 63n) - 1n;
const xorId = (a, b) => ((BigInt(a) ^ BigInt(b)) & MASK).toString();

// ---------- prefabs ----------
const prefabCache = new Map();
// Flattens a prefab (by guid) to { name, path, rootId, rootGoId, rootTrs, parts }, where each
// part is { mesh, m, material, object, prefab, off } with m relative to the prefab root (the
// root's own transform excluded); prefab is the prefab whose file holds the object, and off
// marks objects switched off (inactive, or no enabled renderer), which callers drop unless a
// show rule names them (tools/config.js).
// Nested prefabs and variants are followed. overrides (fileID -> { pos, rot, scl, active })
// changes objects in this prefab, as a prefab instance's modifications do, including objects
// inside its nested prefabs (their ids are XOR-combined; see xorId). Inactive objects are
// left out, and of sibling LOD meshes only the most detailed one present is kept.
function prefab(guid, depth = 0, overrides = null) {
  if (!overrides && prefabCache.has(guid)) return prefabCache.get(guid);
  const e = index()[guid];
  if (!e || !e.path.endsWith('.prefab') || depth > 12) return null;
  const file = path.join(REPO, e.path);
  if (!fs.existsSync(file)) return null;
  const f = parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(e.path, '.prefab');
  const result = { name, path: e.path, ...graph(f, depth, overrides, name) };
  if (!overrides) prefabCache.set(guid, result);
  return result;
}

// Builds the transform tree of a parsed file. Nodes are transform ids or 'pi<id>' for
// prefab instances; stripped transforms alias to their instance node.
function nodes(f, depth, overrides = null) {
  const n = {};
  const alias = id => (f.strippedT[id] ? 'pi' + f.strippedT[id] : id);
  for (const [id, t] of Object.entries(f.t)) {
    const g = f.go[t.go] || { name: '', active: true };
    const o = overrides && overrides[id];
    const ga = overrides && overrides[t.go] ? overrides[t.go].active : undefined;
    n[id] = {
      kind: 't', father: alias(t.father),
      pos: o ? { ...t.pos, ...o.pos } : t.pos, rot: o ? { ...t.rot, ...o.rot } : t.rot, scl: o ? { ...t.scl, ...o.scl } : t.scl,
      name: g.name, active: ga === undefined ? g.active : ga, go: t.go,
      mesh: f.mesh[t.go] || null, meshOff: !f.shown[t.go], material: f.material[t.go] || null, textId: f.textId[t.go] || null
    };
  }
  for (const [id, x] of Object.entries(f.inst)) {
    let sub = x.src ? prefab(x.src, depth + 1) : null;
    const pos = { ...(sub ? sub.rootTrs.pos : { x: 0, y: 0, z: 0 }) };
    const rot = { ...(sub ? sub.rootTrs.rot : { x: 0, y: 0, z: 0, w: 1 }) };
    const scl = { ...(sub ? sub.rootTrs.scl : { x: 1, y: 1, z: 1 }) };
    let name = sub ? sub.name : '?', active = true, textId = null;
    // This instance's root, as ids in this file (a variant's own root has no stripped game object).
    const rootT = sub && sub.rootId ? xorId(id, sub.rootId) : null;
    const rootGo = sub && sub.rootGoId ? xorId(id, sub.rootGoId) : null;
    const inner = {}; // modifications of objects inside the instance, by their fileID in its source
    for (const m of x.mods) {
      const k2 = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(m.path);
      if (sub && m.target !== sub.rootId && m.target !== sub.rootGoId && (k2 || m.path === 'm_IsActive')) {
        const o = inner[m.target] = inner[m.target] || { pos: {}, rot: {}, scl: {} };
        if (k2) o[k2[1] === 'Position' ? 'pos' : k2[1] === 'Rotation' ? 'rot' : 'scl'][k2[2]] = parseFloat(m.value);
        else o.active = m.value !== '0';
      }
      if (m.path === 'm_Name') { name = m.value; continue; }
      if (m.path === 'textId' && m.value) textId = m.value;
      if (m.path === 'm_IsActive' && sub && m.target === sub.rootGoId) active = m.value !== '0';
      const k = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(m.path);
      if (k && sub && m.target === sub.rootId) (k[1] === 'Position' ? pos : k[1] === 'Rotation' ? rot : scl)[k[2]] = parseFloat(m.value);
    }
    // Overrides from further out: those aimed at this instance's root change its placement;
    // the rest are passed inside, translated to the source prefab's ids.
    if (overrides) {
      const o = rootT && overrides[rootT];
      if (o) { Object.assign(pos, o.pos); Object.assign(rot, o.rot); Object.assign(scl, o.scl); }
      if (rootGo && overrides[rootGo] && overrides[rootGo].active !== undefined) active = overrides[rootGo].active;
      for (const [k, v] of Object.entries(overrides)) {
        if (k === rootT || k === rootGo) continue;
        const inside = xorId(id, k);
        const cur = inner[inside] = inner[inside] || { pos: {}, rot: {}, scl: {} };
        Object.assign(cur.pos, v.pos); Object.assign(cur.rot, v.rot); Object.assign(cur.scl, v.scl);
        if (v.active !== undefined) cur.active = v.active;
      }
    }
    const overridden = Object.keys(inner).length > 0;
    if (overridden) sub = prefab(x.src, depth + 1, inner);
    // Components added to the instance's stripped root game object (e.g. a MeshFilter).
    const addedGo = Object.keys(f.strippedGo).find(g => f.strippedGo[g] === id);
    n['pi' + id] = { kind: 'pi', father: alias(x.parent), pos, rot, scl, name, active, sub, overridden, mesh: addedGo ? f.mesh[addedGo] || null : null, meshOff: addedGo ? !f.shown[addedGo] : false, material: addedGo ? f.material[addedGo] || null : null, textId };
  }
  return n;
}

function graph(f, depth, overrides = null, prefabName = '') {
  const n = nodes(f, depth, overrides);
  const children = {};
  let root = null;
  for (const [id, x] of Object.entries(n)) {
    if (x.father === '0') root = root || id;
    else (children[x.father] = children[x.father] || []).push(id);
  }
  if (!root) return { rootId: null, rootGoId: null, rootTrs: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } }, parts: [] };
  const parts = [];
  const lods = []; // [part, parent id, group name, lod index] for this file's own meshes
  const visit = (id, m, parentOff) => {
    const x = n[id];
    const off = parentOff || !x.active;
    if (x.mesh) {
      const mesh = describeMesh(x.mesh);
      const part = { mesh, m, material: x.material, object: x.name, prefab: prefabName, off: off || x.meshOff };
      // LODs are named on the object (Lod0, ring_LOD1) or on the mesh (Rock_Lod2).
      const lod = lodIndex(x.name) >= 0 ? lodIndex(x.name) : lodIndex(mesh.name);
      if (lod >= 0) lods.push([part, x.father, (x.name || '').replace(/(?:^|[_ ])l(?:od)?\d+$/i, ''), lod]);
      parts.push(part);
    }
    if (x.kind === 'pi' && x.sub) for (const p of x.sub.parts) parts.push({ ...p, m: mul(m, p.m), off: off || p.off });
    for (const c of children[id] || []) visit(c, mul(m, trs(n[c].pos, n[c].rot, n[c].scl)), off);
  };
  visit(root, I(), false);
  // Of sibling LODs keep the most detailed present (a prefab may hold only its Lod3).
  const best = {};
  for (const [, parent, group, lod] of lods) best[parent + '|' + group] = Math.min(best[parent + '|' + group] ?? Infinity, lod);
  const drop = new Set(lods.filter(([, parent, group, lod]) => lod > best[parent + '|' + group]).map(l => l[0]));
  const kept = parts.filter(p => !drop.has(p));
  parts.length = 0;
  parts.push(...kept);
  const r = n[root];
  const instId = r.kind === 'pi' ? root.slice(2) : null;
  const rootId = r.kind === 't' ? root : (Object.keys(f.strippedT).find(s => 'pi' + f.strippedT[s] === root) || (r.sub && r.sub.rootId ? xorId(instId, r.sub.rootId) : null));
  const rootGoId = r.kind === 't' ? r.go : (Object.keys(f.strippedGo).find(g => 'pi' + f.strippedGo[g] === root) || (r.sub && r.sub.rootGoId ? xorId(instId, r.sub.rootGoId) : null));
  return { rootId, rootGoId, rootTrs: { pos: r.pos, rot: r.rot, scl: r.scl }, parts };
}

// ---------- scenes ----------
// Every scene object that is a piece: each prefab instance, and each plain object with a mesh,
// with its world position, rotation, and (lossy) scale, hierarchy path, and active state.
function scenePieces(sceneFile) {
  const f = parse(fs.readFileSync(sceneFile, 'utf8'));
  const n = nodes(f, 0);
  const memo = {};
  const world = id => {
    if (memo[id]) return memo[id];
    const x = n[id];
    if (!x) return { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 }, path: '', active: true };
    memo[id] = { pos: x.pos, rot: x.rot, scl: x.scl, path: '(cycle)', active: true };
    const p = x.father === '0' ? null : world(x.father);
    let w;
    if (!p) w = { pos: x.pos, rot: x.rot, scl: x.scl, path: x.name, active: x.active };
    else {
      const m = trs(p.pos, p.rot, p.scl);
      const v = x.pos;
      w = {
        pos: { x: m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3], y: m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7], z: m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11] },
        rot: qmul(p.rot, x.rot),
        scl: { x: p.scl.x * x.scl.x, y: p.scl.y * x.scl.y, z: p.scl.z * x.scl.z },
        path: p.path + '/' + x.name, active: p.active && x.active
      };
    }
    return (memo[id] = w);
  };
  const out = [];
  for (const [id, x] of Object.entries(n)) {
    if (x.kind === 't' && !x.mesh) continue;
    const w = world(id);
    if (x.kind === 'pi') out.push({ piece: x.sub ? x.sub.name : x.name, prefab: x.sub, overridden: x.overridden, ...w, textId: x.textId });
    else {
      const mesh = describeMesh(x.mesh);
      if (isLodBeyondZero(mesh.name)) continue;
      out.push({ piece: mesh.name, mesh, material: x.material, object: x.name, meshOff: x.meshOff, ...w, textId: x.textId });
    }
  }
  return out;
}

// The prefab with this name (file basename), or null; warns when several share it.
function prefabByName(name) {
  const hits = Object.entries(index()).filter(([, e]) => e.path.endsWith('/' + name + '.prefab'));
  if (hits.length > 1) console.warn(`several prefabs named ${name}; using ${hits[0][1].path}`);
  return hits.length ? prefab(hits[0][0]) : null;
}

module.exports = { REPO, I, mul, trs, qmul, eulerToQuat, quatToEuler, parse, prefab, prefabByName, scenePieces, describeMesh, isLodBeyondZero };
