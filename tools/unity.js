// Unity YAML reading for the scene tools: scenes and prefabs to world placements and mesh parts.
// Positions and rotations stay in Unity's left-handed space; the viewer mirrors X.
const fs = require('fs');
const path = require('path');
const Particles = require('./particles.js');
const Cond = () => require('./conditions.js'); // lazily: it requires this file

const REPO = '/sdcard/Canopy';
// Bump when what this reads from prefabs changes, so imported areas (which bake prefabs' parts in) re-import.
const READER = 14;
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
  return [...body.matchAll(/- target: \{fileID: (-?\d+)(?:, guid: [0-9a-f]+)?[^\n]*\n\s*propertyPath: ([^\n]+)\n\s*value: ([^\n]*)(?:\n\s*objectReference: \{fileID: (-?\d+)(?:, guid: ([0-9a-f]+))?)?/g)]
    .map(m => ({ target: m[1], path: m[2].trim(), value: m[3].trim(), ref: m[4] && m[4] !== '0' && !m[5] ? m[4] : null, guid: m[5] || null }));
}

// Parses one Unity file into transforms, game objects, mesh components, and prefab instances.
function parse(text) {
  const d = documents(text.replace(/\r\n/g, '\n')); // some files have Windows line endings
  const t = {}, go = {}, mesh = {}, inst = {}, strippedT = {}, strippedGo = {}, textId = {}, shown = {}, material = {};
  const lodGroup = {}, rendererGo = {}; // LODGroups by game object; renderer id -> its game object
  const strippedRenderer = {}; // a renderer inside a nested prefab or model -> its prefab instance
  const strippedComponent = {}; // a script inside a nested prefab -> its prefab instance
  const colliders = {}; // game object -> its colliders' kinds (mesh, box, sphere, capsule; trigger, convex)
  const particles = {}; // game object -> [its ParticleSystem's id and document, its renderer's document]
  const scripts = []; // [game object, script guid, body] of every MonoBehaviour
  let takesText = false; // has a script that declares a textId field (Tablet, Sign, Note)
  for (const x of d) {
    // A mesh is drawn only by an enabled MeshRenderer (23) or SkinnedMeshRenderer (137).
    // (a ParticleSystemRenderer, 199, may be a LODGroup's too: its system is drawn only at that level)
    if ((x.cls === 23 || x.cls === 137 || x.cls === 199) && !x.stripped) rendererGo[x.id] = ref(x.body, 'm_GameObject');
    if ((x.cls === 23 || x.cls === 137 || x.cls === 199) && x.stripped) strippedRenderer[x.id] = ref(x.body, 'm_PrefabInstance');
    if (x.cls === 114 && x.stripped) strippedComponent[x.id] = ref(x.body, 'm_PrefabInstance');
    if (x.cls === 198 && !x.stripped) (particles[ref(x.body, 'm_GameObject')] = particles[ref(x.body, 'm_GameObject')] || [null, null])[0] = { id: x.id, body: x.body };
    if (x.cls === 199 && !x.stripped) (particles[ref(x.body, 'm_GameObject')] = particles[ref(x.body, 'm_GameObject')] || [null, null])[1] = { id: x.id, body: x.body };
    if ([64, 65, 135, 136].includes(x.cls) && !x.stripped && !/\n {2}m_Enabled: 0/.test(x.body)) {
      const kind = { 64: 'mesh', 65: 'box', 135: 'sphere', 136: 'capsule' }[x.cls] + (/m_IsTrigger: 1/.test(x.body) ? ' trigger' : '') + (x.cls === 64 && /m_Convex: 1/.test(x.body) ? ' convex' : '');
      (colliders[ref(x.body, 'm_GameObject')] = colliders[ref(x.body, 'm_GameObject')] || []).push(kind);
    }
    // A LODGroup (205): its reference point and size (in its object's space), and per level the
    // screen height it shows down to and its renderers.
    if (x.cls === 205 && !x.stripped && !/\n {2}m_Enabled: 0/.test(x.body)) {
      const levels = x.body.split(/\n {2}- screenRelativeHeight: /).slice(1).map(l => ({
        height: parseFloat(l), renderers: [...l.matchAll(/- renderer: \{fileID: (-?\d+)\}/g)].map(m => m[1])
      }));
      lodGroup[ref(x.body, 'm_GameObject')] = { point: vec(x.body, 'm_LocalReferencePoint') || { x: 0, y: 0, z: 0 }, size: num((/m_Size: (\S+)/.exec(x.body) || [])[1]) || 1, levels };
    }
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
    else if (x.cls === 1) go[x.id] = { name: ((/m_Name: (.*)/.exec(x.body) || [])[1] || '').trim(), active: !/m_IsActive: 0/.test(x.body), layer: +((/m_Layer: (\d+)/.exec(x.body) || [])[1] || 0) };
    else if (x.cls === 33 || x.cls === 137) {
      const r = guidRef(x.body, 'm_Mesh');
      if (r) mesh[ref(x.body, 'm_GameObject')] = r;
    } else if (x.cls === 114) {
      const script = guidRef(x.body, 'm_Script');
      if (script && !x.stripped) scripts.push([ref(x.body, 'm_GameObject'), script.guid, x.body, x.id]);
      if (script && scriptTakesText(script.guid)) takesText = true;
      const m = /\n {2}textId: (.+)/.exec(x.body);
      if (m && m[1].trim()) textId[ref(x.body, 'm_GameObject')] = m[1].trim();
    } else if (x.cls === 1001) {
      const src = guidRef(x.body, 'm_SourcePrefab');
      inst[x.id] = { src: src && src.guid, parent: ref(x.body, 'm_TransformParent'), mods: modifications(x.body) };
    }
  }
  // Scripts added to a prefab instance here sit on its stripped root game object.
  const addedScripts = {}, addedScriptBodies = {};
  for (const [g, guid, body] of scripts) {
    if (!strippedGo[g]) continue;
    (addedScripts[strippedGo[g]] = addedScripts[strippedGo[g]] || []).push(guid);
    (addedScriptBodies[strippedGo[g]] = addedScriptBodies[strippedGo[g]] || []).push({ guid, body });
  }
  return { t, go, mesh, inst, strippedT, strippedGo, textId, material, shown, takesText, lodGroup, rendererGo, strippedRenderer, strippedComponent, colliders, particles, scripts, addedScripts, addedScriptBodies };
}

// ---------- repository lookups ----------
// Does a C# script (by guid) declare a textId field? Its saved data may predate the field.
const scriptText = new Map();
function scriptTakesText(guid) {
  if (!scriptText.has(guid)) {
    const e = index()[guid];
    const file = e && e.path.endsWith('.cs') ? path.join(REPO, e.path) : null;
    scriptText.set(guid, Boolean(file && fs.existsSync(file) && /^[^(\n]*\bstring\s+textId\s*[;=]/m.test(fs.readFileSync(file, 'utf8'))));
  }
  return scriptText.get(guid);
}
const INDEX_FILE = path.join(__dirname, '..', 'cache', 'guid-index.json');
let guidIndex = null, guidIndexTime = 0;
function index() {
  if (!guidIndex) {
    guidIndexTime = fs.statSync(INDEX_FILE).mtimeMs;
    guidIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).entries;
  }
  return guidIndex;
}
// Forgets the index if its file changed since it was read (the server refreshes it when
// uncommitted Canopy files change; scene.js beginRequest calls this for each request).
function refreshIndex() {
  if (guidIndex && fs.statSync(INDEX_FILE).mtimeMs !== guidIndexTime) {
    guidIndex = null;
    scriptText.clear();
    prefabGuids = null; // prefabByName's names, which new prefabs join
    prefabCache.clear(); // its parts hold mesh blobs, which change when a model is rewritten
  }
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
// left out. Meshes a LODGroup draws keep every level (part.lod; result.lodGroups); of sibling
// LOD meshes without one, only the most detailed present is kept.
function prefab(guid, depth = 0, overrides = null) {
  if (!overrides && prefabCache.has(guid)) return prefabCache.get(guid);
  const e = index()[guid];
  if (!e || !e.path.endsWith('.prefab') || depth > 12) return null;
  const file = path.join(REPO, e.path);
  if (!fs.existsSync(file)) return null;
  const f = parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(e.path, '.prefab');
  const result = { name, path: e.path, ...graph(f, depth, overrides, name) };
  // Takes a text id if it or any prefab nested in it has a script with a textId field.
  result.takesText = f.takesText || Object.values(f.inst).some(x => { const s = x.src && prefab(x.src, depth + 1); return Boolean(s && s.takesText); });
  if (!overrides) prefabCache.set(guid, result);
  return result;
}

// A model file (FBX, OBJ) placed directly in a prefab or scene, as a one-part prefab: the whole
// file as one mesh in its root's space (see fbx.js wholeModelToObj). Unity ids its root
// transform and game object with fixed values, older ones 400000 and 100000. The instance's
// changes to objects inside the file are not applied (no game prefab makes any); a material it
// sets on any of them is used for the whole model.
const MODEL_ROOT_T = ['-8679921383154817045', '400000'];
const MODEL_ROOT_GO = ['919132149155446097', '100000'];
function modelInstance(guid, mods) {
  const e = index()[guid];
  if (!e || !MODEL_EXT.test(e.path)) return null;
  const name = path.basename(e.path).replace(MODEL_EXT, '');
  const pick = ids => ids.find(id => mods.some(m => m.target === id)) || ids[0];
  const rootId = pick(MODEL_ROOT_T);
  const ownScale = mods.some(m => m.target === rootId && m.path.startsWith('m_LocalScale'));
  const mat = mods.find(m => /^m_Materials\.Array\.data\[\d+\]$/.test(m.path) && m.guid);
  const mesh = { kind: 'model', whole: true, keepRootScale: !ownScale, name, guid, path: e.path, blob: e.blob };
  return {
    name, path: e.path, model: true, rootId, rootGoId: pick(MODEL_ROOT_GO),
    rootTrs: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } },
    parts: [{ mesh, m: I(), material: mat ? mat.guid : null, object: name, prefab: name, off: false }]
  };
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
      kind: 't', father: alias(t.father), parentT: t.father,
      pos: o ? { ...t.pos, ...o.pos } : t.pos, rot: o ? { ...t.rot, ...o.rot } : t.rot, scl: o ? { ...t.scl, ...o.scl } : t.scl,
      name: g.name, active: ga === undefined ? g.active : ga, go: t.go,
      mesh: f.mesh[t.go] || null, meshOff: !f.shown[t.go], material: f.material[t.go] || null, textId: f.textId[t.go] || null
    };
  }
  for (const [id, x] of Object.entries(f.inst)) {
    let sub = x.src ? prefab(x.src, depth + 1) || modelInstance(x.src, x.mods) : null;
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
      // A setting of a component a stand-in reads (a particle system, its renderer, a stand-in's C#
      // script): kept, by property path, for it (Claude, 2026-10-29: HarvesterJet turns its steam's
      // playOnAwake off). Object references are left out (they name objects in this file).
      if (sub && sub.componentIds && sub.componentIds.has(m.target) && !m.ref) {
        const o = inner[m.target] = inner[m.target] || { pos: {}, rot: {}, scl: {} };
        (o.props = o.props || {})[m.path] = m.guid ? { asset: m.guid } : m.value !== '' && Number.isFinite(+m.value) ? +m.value : m.value;
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
        if (v.props) cur.props = { ...cur.props, ...v.props };
      }
    }
    const overridden = Object.keys(inner).length > 0;
    if (overridden && !sub.model) sub = prefab(x.src, depth + 1, inner);
    // Components added to the instance's stripped root game object (e.g. a MeshFilter).
    const addedGo = Object.keys(f.strippedGo).find(g => f.strippedGo[g] === id);
    n['pi' + id] = { kind: 'pi', father: alias(x.parent), parentT: x.parent, pos, rot, scl, name, active, sub, overridden, mods: x.mods, addedScripts: f.addedScripts[id] || [], addedScriptBodies: f.addedScriptBodies[id] || [], mesh: addedGo ? f.mesh[addedGo] || null : null, meshOff: addedGo ? !f.shown[addedGo] : false, material: addedGo ? f.material[addedGo] || null : null, textId };
  }
  return n;
}

// C# scripts (MonoBehaviours) for layout's stand-ins (Ken, 2026-10-29): a script whose class has a
// JS stand-in, layout/scripts/<Name>.js, gets its saved fields; any other is only named (a probe
// lists them). Keys of objects and components are their fileIDs in this file, behind
// "<instance>/" for each prefab instance they sit inside.
const STANDINS = path.join(__dirname, '..', 'scripts');
const scriptName = guid => { const e = index()[guid]; return e && e.path.endsWith('.cs') ? path.basename(e.path, '.cs') : null; };
const hasStandIn = name => Boolean(name) && fs.existsSync(path.join(STANDINS, name + '.js'));
// Scripts layout doesn't run but reads when importing, to do what they do as the game starts
// (Ken, 2026-10-29): GemLocus and Gem, for the gem each locus makes (tools/gems.js). Their entries
// (with fields, and instances' overrides of them) are a graph's read, not its scripts.
const READ = new Set(['GemLocus', 'Gem']);
// A MonoBehaviour's own fields (its top-level lines, not Unity's m_ ones): numbers, vectors and
// colors ({x, y, z, w} or {r, g, b, a}), references ({ ref: key } to an object or component in
// this file, { asset: guid } to an asset, null for none) and the rest as text. Lists and
// nested structs are left out.
function scriptFields(body) {
  const out = {};
  for (const m of body.matchAll(/^ {2}([A-Za-z_]\w*): (.*)$/gm)) {
    if (m[1].startsWith('m_')) continue;
    const v = m[2].trim();
    const r = /^\{fileID: (-?\d+)(?:, guid: ([0-9a-f]+), type: \d+)?\}$/.exec(v);
    if (r) out[m[1]] = r[2] ? { asset: r[2] } : r[1] === '0' ? null : { ref: r[1] };
    else if (/^\{[xyzwrgba]: /.test(v)) out[m[1]] = Object.fromEntries([...v.matchAll(/(\w): ([^,}]+)/g)].map(x => [x[1], +x[2]]));
    else if (v !== '' && Number.isFinite(+v)) out[m[1]] = +v;
    else out[m[1]] = unquote(v);
  }
  return out;
}
// A YAML scalar's text: Unity quotes one that starts with a YAML sign ('!SkyIsle', "a: b").
function unquote(v) {
  if (v.length > 1 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  return v;
}
// A script description: { name, id, go, off, fields? }, its keys behind prefix.
function scriptEntry(guid, body, id, go, off, prefix = '', f = null, props = null) {
  const name = scriptName(guid) || `script ${guid}`;
  const s = { name, id: prefix + id, go: prefix + go, off: off || /\n {2}m_Enabled: 0/.test(body) };
  if (hasStandIn(name) || READ.has(name)) {
    const fields = { ...scriptFields(body) };
    for (const [k, v] of Object.entries(props || {})) if (!k.includes('.') && k !== 'm_Enabled') fields[k] = v; // an instance's settings
    s.fields = prefixRefs(f ? localRefs(fields, f) : fields, prefix);
  }
  if (props && 'm_Enabled' in props) s.off = off || props.m_Enabled === 0;
  return s;
}
// A field naming an object or script inside a nested prefab names it by a stripped id (the
// instance's id XOR the object's in its source): as a key, "<instance>/<its id there>".
function localRefs(fields, f) {
  const key = id => {
    const inst = f.strippedGo[id] || f.strippedComponent[id];
    return inst ? `${inst}/${xorId(id, inst)}` : id;
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v && v.ref ? { ref: key(v.ref) } : v]));
}
const prefixRefs = (fields, prefix) => (prefix ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v && v.ref ? { ref: prefix + v.ref } : v])) : fields);

function graph(f, depth, overrides = null, prefabName = '') {
  const n = nodes(f, depth, overrides);
  const children = {};
  let root = null;
  for (const [id, x] of Object.entries(n)) {
    if (x.father === '0') root = root || id;
    else (children[x.father] = children[x.father] || []).push(id);
  }
  if (!root) return { rootId: null, rootGoId: null, rootTrs: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } }, parts: [], lodGroups: {} };
  const parts = [];
  const lods = []; // [part, parent id, group name, lod index] for this file's own meshes
  // LODGroups, by key (this file's transform id, or instance id / key inside a nested prefab):
  // { center (prefab space), size (its world size there), heights (each level's lowest screen
  // height, a fraction) }; a part drawn by one carries lod: { key, levels }.
  // lodOfInstance: a LODGroup's levels for the renderer inside a nested prefab or model
  // instance (by instance id), as modl's prefabs (a LODGroup over nested models) have them.
  const lodGroups = {}, lodOf = {}, lodOfInstance = {};
  // Scripts, and the objects they may name (each one's name, parent, place in the prefab, off).
  const scripts = [], objects = {}, scriptsOf = {}, read = [];
  // a transform's id -> its object's key, as objects are added: this file's own, and each nested
  // prefab's (at any depth) by the id Unity gives it here, the instance's id XOR its id there
  const goOfT = {};
  const addScript = s => (READ.has(s.name) ? read : scripts).push(s);
  for (const [g, guid, body, sid] of f.scripts) (scriptsOf[g] = scriptsOf[g] || []).push([guid, body, sid]);
  // Conditions (tools/conditions.js): each part's gate in the game, from its objects' rules here and,
  // for a nested prefab's parts, theirs there.
  const rules = Cond().rulesOf(f);
  const visit = (id, m, parentOff, parentTerms) => {
    const x = n[id];
    const off = parentOff || !x.active;
    const terms = parentTerms.concat(Cond().nodeTerms(rules, id, x.active));
    // its parent object's key; one parented inside a nested prefab (a variant's Gem05Lods under its
    // base's Model) by that object's key there (the instance's id XOR the transform's)
    let father = n[x.father] ? n[x.father].go || null : null;
    if (!father && f.strippedT[x.parentT]) father = goOfT[x.parentT] || null;
    if (x.kind === 't') {
      const g = f.go[x.go] || {};
      goOfT[id] = x.go;
      objects[x.go] = { name: x.name, father, m, off, layer: g.layer || 0, ...(f.colliders[x.go] ? { colliders: f.colliders[x.go] } : {}) };
      const propsOf = id => (overrides && overrides[id] && overrides[id].props) || null;
      for (const [guid, body, sid] of scriptsOf[x.go] || []) addScript(scriptEntry(guid, body, sid, x.go, off, '', f, propsOf(sid)));
      // A particle system, for the ParticleSystem stand-in (tools/particles.js describes it): only one
      // that plays by itself (on awake); the rest wait for game events layout doesn't run, and the
      // Tangle has some 1400 of them.
      const ps = f.particles[x.go];
      if (ps && ps[0] && hasStandIn('ParticleSystem')) {
        const props = propsOf(ps[0].id), rprops = ps[1] && propsOf(ps[1].id);
        const plays = props && 'playOnAwake' in props ? props.playOnAwake !== 0 : !/\n {2}playOnAwake: 0/.test(ps[0].body);
        if (plays) scripts.push({ name: 'ParticleSystem', id: ps[0].id, go: x.go, off, renderer: ps[1] ? ps[1].id : null, fields: Particles.describe(ps[0].body, ps[1] && ps[1].body, props, rprops), ...(lodOf[x.go] ? { lod: lodOf[x.go] } : {}) });
      }
    }
    const g = x.kind === 't' && f.lodGroup[x.go];
    if (g) {
      lodGroups[id] = { center: apply(m, g.point), size: g.size * maxScale(m), scale: maxScale(m), heights: g.levels.map(l => l.height) };
      g.levels.forEach((l, level) => {
        for (const r of l.renderers) {
          const rgo = f.rendererGo[r];
          const pi = !rgo && f.strippedRenderer[r];
          if (pi) {
            const o = lodOfInstance[pi] = lodOfInstance[pi] || { key: id, levels: [] };
            if (o.key === id) o.levels.push(level);
          }
          if (!rgo) continue;
          const o = lodOf[rgo] = lodOf[rgo] || { key: id, levels: [] };
          if (o.key === id) o.levels.push(level);
        }
      });
    }
    if (x.mesh) {
      const mesh = describeMesh(x.mesh);
      // off: not drawn (an inactive object, or no enabled renderer); rendererOff: no enabled
      // renderer, which is all GridRender checks (it draws a tree's chunks under its inactive Parts).
      const part = { mesh, m, material: x.material, object: x.name, prefab: prefabName, off: off || x.meshOff, rendererOff: Boolean(x.meshOff), go: x.go, ...Cond().gameFields(terms, x.meshOff || rules.hidden.has(id)) };
      if (lodOf[x.go]) part.lod = lodOf[x.go];
      else {
        // LODs are named on the object (Lod0, ring_LOD1) or on the mesh (Rock_Lod2).
        const lod = lodIndex(x.name) >= 0 ? lodIndex(x.name) : lodIndex(mesh.name);
        if (lod >= 0) lods.push([part, x.father, (x.name || '').replace(/(?:^|[_ ])l(?:od)?\d+$/i, ''), lod]);
      }
      parts.push(part);
    }
    if (x.kind === 'pi' && x.sub) {
      const inst = id.slice(2);
      const outer = lodOfInstance[inst];
      for (const p of x.sub.parts) parts.push({ ...withoutGame(p), ...Cond().gameFields(terms.concat(p.when || []), Boolean(p.never)), m: mul(m, p.m), off: off || p.off, ...(p.go ? { go: inst + '/' + p.go } : {}), ...(p.lod ? { lod: { key: inst + '/' + p.lod.key, levels: p.lod.levels } } : outer ? { lod: { key: outer.key, levels: outer.levels } } : {}) });
      const prefix = inst + '/';
      for (const s of x.sub.read || []) read.push({ ...s, id: prefix + s.id, go: prefix + s.go, off: off || s.off, fields: prefixRefs(s.fields || {}, prefix) });
      for (const s of x.sub.scripts || []) scripts.push({ ...s, id: prefix + s.id, go: prefix + s.go, off: off || s.off, ...(s.fields ? { fields: prefixRefs(s.fields, prefix) } : {}), ...(s.lod ? { lod: { key: prefix + s.lod.key, levels: s.lod.levels } } : outer ? { lod: { key: outer.key, levels: outer.levels } } : {}) });
      for (const [k, o] of Object.entries(x.sub.objects || {})) objects[prefix + k] = { ...o, father: o.father ? prefix + o.father : father, m: mul(m, o.m), off: off || o.off };
      for (const [t, k] of Object.entries(x.sub.objectOfT || {})) goOfT[xorId(inst, t)] = prefix + k;
      // Scripts added to the instance's root here: on that root (inside the instance), but their
      // fields name objects in this file, so they aren't prefixed (Flamer's Flamer and HcFaceTarget
      // sit on its nested Harvester's root and point at Flamer's own Spinner and StraightUp).
      for (const { guid, body } of x.addedScriptBodies || []) {
        const s = scriptEntry(guid, body, prefix + 'added' + scripts.length, prefix + (x.sub.rootGoId || 'root'), off, '', f);
        addScript(s);
      }
      for (const [k, sg] of Object.entries(x.sub.lodGroups || {})) lodGroups[inst + '/' + k] = { center: apply(m, sg.center), size: sg.size * maxScale(m), scale: sg.scale * maxScale(m), heights: sg.heights };
    }
    for (const c of children[id] || []) visit(c, mul(m, trs(n[c].pos, n[c].rot, n[c].scl)), off, terms);
  };
  visit(root, I(), false, []);
  // Of sibling LODs no LODGroup covers, keep the most detailed present (a prefab may hold only its Lod3).
  const best = {};
  for (const [, parent, group, lod] of lods) best[parent + '|' + group] = Math.min(best[parent + '|' + group] ?? Infinity, lod);
  const drop = new Set(lods.filter(([, parent, group, lod]) => lod > best[parent + '|' + group]).map(l => l[0]));
  const kept = parts.filter(p => !drop.has(p));
  parts.length = 0;
  parts.push(...kept);
  const r = n[root];
  const instId = r.kind === 'pi' ? root.slice(2) : null;
  // A variant's root (an instance of its base): its ids are the instance's XOR the base root's, as
  // Unity derives them; a stripped id in the file may be another object of the instance (one that
  // was given children), so it is only the fallback (Claude, 2026-10-29: Fleer's Bag5Amber kept
  // its 133 m saved height because its position override missed).
  const rootId = r.kind === 't' ? root : ((r.sub && r.sub.rootId ? xorId(instId, r.sub.rootId) : null) || Object.keys(f.strippedT).find(s => 'pi' + f.strippedT[s] === root) || null);
  const rootGoId = r.kind === 't' ? r.go : ((r.sub && r.sub.rootGoId ? xorId(instId, r.sub.rootGoId) : null) || Object.keys(f.strippedGo).find(g => 'pi' + f.strippedGo[g] === root) || null);
  // Objects and parts' object keys only matter to stand-ins (a prefab nesting this one may have
  // some); tools/scene.js leaves them out of what it serves when a piece has none.
  // The components stand-ins read, by their ids in this file (a nested one's: its instance's id
  // XOR its own there), so overrides of their settings from further out can be kept.
  const fileId = key => key.split('/').reduceRight((id, k) => (id === null ? k : xorId(k, id)), null);
  const componentIds = new Set([...scripts, ...read].filter(s => s.fields && !/\/added|^added/.test(s.id)).flatMap(s => [s.id, s.renderer ? (s.id.includes('/') ? s.id.split('/').slice(0, -1).join('/') + '/' + s.renderer : s.renderer) : null]).filter(Boolean).map(fileId));
  return { rootId, rootGoId, rootTrs: { pos: r.pos, rot: r.rot, scl: r.scl }, parts, lodGroups, scripts, objects, componentIds, read, objectOfT: goOfT };
}
const withoutGame = ({ when, never, ...rest }) => rest;
// A point through a row-major 4x4 matrix, and the matrix's largest axis scale.
const apply = (m, p) => { const [x, y, z] = Array.isArray(p) ? p : [p.x, p.y, p.z]; return [0, 1, 2].map(r => m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + m[r * 4 + 3]); };
const maxScale = m => Math.max(...[0, 1, 2].map(c => Math.hypot(m[c], m[4 + c], m[8 + c])));

// ---------- scenes ----------
// Every scene object that is a piece: each prefab instance, and each plain object with a mesh,
// with its world position, rotation, and (lossy) scale, hierarchy path, and active state; game:
// its gate in the game (tools/conditions.js gameFields); moved: where the effects its triggers
// play put it ({ when, pos, rot, scl }), when any do.
function scenePieces(sceneFile) {
  const f = parse(fs.readFileSync(sceneFile, 'utf8'));
  const n = nodes(f, 0);
  const rules = Cond().rulesOf(f);
  const revealOf = {}; // a node under a Pod's revealRoot (its root's children): the Pod's trigger
  for (const r of rules.reveals) for (const [id, x] of Object.entries(n)) if (r.root && x.father === r.root) (revealOf[id] = revealOf[id] || []).push(r.when);
  const compose = (p, x, path, active) => {
    const m = trs(p.pos, p.rot, p.scl);
    const v = x.pos;
    return {
      pos: { x: m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3], y: m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7], z: m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11] },
      rot: qmul(p.rot, x.rot),
      scl: { x: p.scl.x * x.scl.x, y: p.scl.y * x.scl.y, z: p.scl.z * x.scl.z },
      path, active
    };
  };
  // moved: the placement with the moves of its own and its parents' triggers done (world 'alt').
  const memo = {}, memoAlt = {};
  const world = (id, alt = false) => {
    const cache = alt ? memoAlt : memo;
    if (cache[id]) return cache[id];
    const x = n[id];
    if (!x) return { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 }, path: '', active: true, terms: [], movedBy: [] };
    cache[id] = { pos: x.pos, rot: x.rot, scl: x.scl, path: '(cycle)', active: true, terms: [], movedBy: [] };
    const p = x.father === '0' ? null : world(x.father, alt);
    let w = !p ? { pos: x.pos, rot: x.rot, scl: x.scl, path: x.name, active: x.active } : compose(p, x, p.path + '/' + x.name, p.active && x.active);
    w.terms = (p ? p.terms : []).concat(Cond().nodeTerms(rules, id, x.active), revealOf[id] || []);
    w.movedBy = p ? p.movedBy : [];
    if (alt && rules.moves[id]) {
      for (const mv of rules.moves[id]) {
        if (mv.scale) w = { ...w, ...compose(p || { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } }, { ...x, scl: { x: mv.scale.x ?? 1, y: mv.scale.y ?? 1, z: mv.scale.z ?? 1 } }, w.path, w.active) };
        if (mv.to) {
          const to = world(mv.to, true);
          w = { ...w, pos: to.pos, ...(mv.toScale ? { scl: to.scl } : {}) };
        }
      }
      w.movedBy = w.movedBy.concat(rules.moves[id].map(mv => mv.when));
    }
    return (cache[id] = w);
  };
  const game = (id, gone = false) => {
    const w = world(id), a = world(id, true);
    const out = Cond().gameFields(w.terms, gone);
    if (a.movedBy.length) out.moved = { when: [...new Set(a.movedBy)], pos: a.pos, rot: a.rot, scl: a.scl };
    return out;
  };
  // Guards (Ken, 2026-10-29): an active instance whose thingGuarded (HcGuard's field) names a script
  // of another instance guards that instance, as HcGuard registers with it when the scene starts
  // (a Cage shows its live material while it has any).
  const guards = {};
  for (const [id, x] of Object.entries(n)) {
    if (x.kind !== 'pi' || !world(id).active) continue;
    for (const m of x.mods) if (m.path === 'thingGuarded' && m.ref && f.strippedComponent[m.ref]) guards['pi' + f.strippedComponent[m.ref]] = (guards['pi' + f.strippedComponent[m.ref]] || 0) + 1;
  }
  const out = [];
  for (const [id, x] of Object.entries(n)) {
    if (x.kind === 't' && !x.mesh) continue;
    const w = world(id);
    if (x.kind === 'pi') out.push({ piece: x.sub ? x.sub.name : x.name, prefab: x.sub, overridden: x.overridden, mods: x.mods, addedScripts: x.addedScripts, addedScriptBodies: x.addedScriptBodies, ...w, textId: x.textId, guards: guards[id] || 0, game: game(id) });
    else {
      const mesh = describeMesh(x.mesh);
      if (isLodBeyondZero(mesh.name)) continue;
      out.push({ piece: mesh.name, mesh, material: x.material, object: x.name, meshOff: x.meshOff, ...w, textId: x.textId, game: game(id, x.meshOff || rules.hidden.has(id)) });
    }
  }
  return out;
}

// A gridded tree's LOD settings, from the prefab file holding its chunks (by name): its GridGroup's
// objectSize and cutoffArray (percent of screen height per level), and whether a GridRender draws
// the chunks itself (Canopy's GridRender.TestLoDs) instead of their LODGroups. A scene's instance
// may override GridGroup's values (mods) or add the GridRender (addedScripts).
const scriptGuid = name => Object.entries(index()).find(([, e]) => e.path === `Assets/Scripts/${name}.cs`)?.[0];
function gridSettings(prefabName, mods = [], addedScripts = []) {
  const e = Object.values(index()).find(x => x.path.endsWith('/' + prefabName + '.prefab'));
  if (!e) return null;
  const f = parse(fs.readFileSync(path.join(REPO, e.path), 'utf8'));
  const group = scriptGuid('GridGroup'), render = scriptGuid('GridRender');
  const g = f.scripts.find(x => x[1] === group);
  if (!g) return null;
  const body = g[2];
  let objectSize = num((/\n {2}objectSize: (\S+)/.exec(body) || [])[1]) ?? 1;
  const list = /\n {2}cutoffArray:\n((?: {2}- .*\n)*)/.exec(body);
  const cutoffs = list ? [...list[1].matchAll(/- (\S+)/g)].map(m => parseFloat(m[1])) : [];
  for (const m of mods) {
    if (m.path === 'objectSize') objectSize = parseFloat(m.value);
    const k = /^cutoffArray\.Array\.data\[(\d+)\]$/.exec(m.path);
    if (k) cutoffs[+k[1]] = parseFloat(m.value);
  }
  const manual = f.scripts.some(x => x[1] === render && !/\n {2}m_Enabled: 0/.test(x[2]) && !/\n {2}useManualRender: 0/.test(x[2])) || addedScripts.includes(render);
  return { objectSize, cutoffs, manual, prefab: e.path };
}

// The prefab with this name (file basename), or null; warns when several share it.
// Prefab guids by file name (several prefabs may share one), built once with the index.
let prefabGuids = null;
function prefabByName(name) {
  if (!prefabGuids) {
    prefabGuids = new Map();
    for (const [guid, e] of Object.entries(index())) {
      if (!e.path.endsWith('.prefab')) continue;
      const base = path.basename(e.path, '.prefab');
      prefabGuids.set(base, [...(prefabGuids.get(base) || []), [guid, e]]);
    }
  }
  const hits = prefabGuids.get(name) || [];
  if (hits.length > 1) console.warn(`several prefabs named ${name}; using ${hits[0][1].path}`);
  return hits.length ? prefab(hits[0][0]) : null;
}

module.exports = { REPO, READER, index, scriptName, scriptFields, xorId, refreshIndex, I, mul, trs, qmul, eulerToQuat, quatToEuler, parse, prefab, prefabByName, modelInstance, scenePieces, describeMesh, isLodBeyondZero, gridSettings, maxScale, scriptGuid };
