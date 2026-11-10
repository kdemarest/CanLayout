// Unity YAML reading for the scene tools: scenes and prefabs to world placements and mesh parts.
// Positions and rotations stay in Unity's left-handed space; the viewer mirrors X.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Particles = require('./particles.js');
const Cond = () => require('./conditions.js'); // lazily: it requires this file
const Config = () => require('./config.js');

const REPO = '/sdcard/Canopy';
// Bump when what this reads from prefabs changes, so imported areas (which bake prefabs' parts in) re-import.
const READER = 57;
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
// A row-major matrix's translation, rotation (from its axes, normalized) and per-axis (lossy) scale.
function decompose(m) {
  const scl = [0, 1, 2].map(c => Math.hypot(m[c], m[4 + c], m[8 + c]) || 1);
  const r = (row, c) => m[row * 4 + c] / scl[c];
  const tr = r(0, 0) + r(1, 1) + r(2, 2);
  let q;
  if (tr > 0) { const k = Math.sqrt(tr + 1) * 2; q = { w: k / 4, x: (r(2, 1) - r(1, 2)) / k, y: (r(0, 2) - r(2, 0)) / k, z: (r(1, 0) - r(0, 1)) / k }; }
  else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) { const k = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2; q = { w: (r(2, 1) - r(1, 2)) / k, x: k / 4, y: (r(0, 1) + r(1, 0)) / k, z: (r(0, 2) + r(2, 0)) / k }; }
  else if (r(1, 1) > r(2, 2)) { const k = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2; q = { w: (r(0, 2) - r(2, 0)) / k, x: (r(0, 1) + r(1, 0)) / k, y: k / 4, z: (r(1, 2) + r(2, 1)) / k }; }
  else { const k = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2; q = { w: (r(1, 0) - r(0, 1)) / k, x: (r(0, 2) + r(2, 0)) / k, y: (r(1, 2) + r(2, 1)) / k, z: k / 4 }; }
  return { pos: { x: m[3], y: m[7], z: m[11] }, rot: q, scl: { x: scl[0], y: scl[1], z: scl[2] } };
}
// An object inside a prefab instance that another object here is parented to (not its root): its
// placement relative to the instance's root, and whether it is off, from the instance's prefab
// (graph's objects); null for the root, or when it can't be found.
// A stripped object's id in its instance's prefab.
const sourceIn = (f, id, inst) => (process.env.XOR_ONLY ? null : f.sourceOf && f.sourceOf[id]) || xorId(id, inst);
function innerParent(f, n, parentT) {
  const inst = f.strippedT[parentT];
  const x = inst && n['pi' + inst];
  if (!x || !x.sub || !x.sub.objectOfT) return null;
  const srcT = sourceIn(f, parentT, inst);
  if (srcT === x.sub.rootId) return null;
  const o = x.sub.objects && x.sub.objects[x.sub.objectOfT[srcT]];
  return o ? { ...decompose(o.m), off: o.off } : null;
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

// A Light component (108) as Canopy's lights take it (CanopyLights.cs; Claude, 2026-11-08, More
// Lights phase 4: Unity's point and spot Lights, sorted Canopy's way): its color (sRGB, as saved),
// intensity, range and culling mask (the layers it lights: the ForLighting layer's dedicated lights
// reach only it), and a spot's angles (spot: outer, inner, degrees; it shines along its object's
// +Z, which graph() gives as dir), or null for any other kind, a switched-off one, or one that
// lights nothing.
function lightOf(body) {
  const num = k => parseFloat((new RegExp('\\n {2}' + k + ': (\\S+)').exec(body) || [])[1]);
  const type = num('m_Type');
  if ((type !== 2 && type !== 0) || /\n {2}m_Enabled: 0/.test(body)) return null;
  const c = /\n {2}m_Color: \{r: ([^,]+), g: ([^,]+), b: ([^,]+)/.exec(body);
  const mask = +((/m_CullingMask:\n\s+serializedVersion: \d+\n\s+m_Bits: (\d+)/.exec(body) || [])[1] ?? 4294967295);
  const light = { color: c ? [+c[1], +c[2], +c[3]] : [1, 1, 1], intensity: num('m_Intensity') || 0, range: num('m_Range') || 0, mask };
  if (type === 0) {
    const outer = num('m_SpotAngle') || 30;
    light.spot = [outer, Math.min(num('m_InnerSpotAngle') || outer * 0.75, outer - 0.1)];
  }
  return light.intensity > 0 && light.range > 0 && mask !== 0 ? light : null;
}

// Parses one Unity file into transforms, game objects, mesh components, and prefab instances.
function parse(text) {
  const d = documents(text.replace(/\r\n/g, '\n')); // some files have Windows line endings
  const meshFilter = {}, renderer = {}; // game object -> its MeshFilter's and renderer's ids (an instance may remove them)
  const t = {}, go = {}, mesh = {}, inst = {}, strippedT = {}, strippedGo = {}, sourceGo = {}, sourceOf = {}, textId = {}, shown = {}, material = {}, materials = {}, hiddenMaterial = {};
  const lodGroup = {}, rendererGo = {}; // LODGroups by game object; renderer id -> its game object
  const strippedRenderer = {}; // a renderer inside a nested prefab or model -> its prefab instance
  const strippedComponent = {}; // a script inside a nested prefab -> its prefab instance
  const colliders = {}; // game object -> its colliders' kinds (mesh, box, sphere, capsule; trigger, convex)
  const particles = {}; // game object -> [its ParticleSystem's id and document, its renderer's document]
  const lights = {}; // game object -> its point Light, as lightOf describes it (More Lights phase 4)
  const scripts = []; // [game object, script guid, body] of every MonoBehaviour
  let takesText = false; // has a script that declares a textId field (Tablet, Sign, Note)
  for (const x of d) {
    // A mesh is drawn only by an enabled MeshRenderer (23) or SkinnedMeshRenderer (137).
    // (a ParticleSystemRenderer, 199, may be a LODGroup's too: its system is drawn only at that level)
    if ((x.cls === 23 || x.cls === 137 || x.cls === 199) && !x.stripped) rendererGo[x.id] = ref(x.body, 'm_GameObject');
    if ((x.cls === 23 || x.cls === 137 || x.cls === 199) && x.stripped) strippedRenderer[x.id] = ref(x.body, 'm_PrefabInstance');
    if (x.cls === 114 && x.stripped) strippedComponent[x.id] = ref(x.body, 'm_PrefabInstance');
    if (x.cls === 198 && !x.stripped) (particles[ref(x.body, 'm_GameObject')] = particles[ref(x.body, 'm_GameObject')] || [null, null])[0] = { id: x.id, body: x.body };
    if (x.cls === 108 && !x.stripped) { const l = lightOf(x.body); if (l) lights[ref(x.body, 'm_GameObject')] = l; }
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
    if ((x.cls === 23 || x.cls === 137) && !x.stripped) renderer[ref(x.body, 'm_GameObject')] = x.id;
    // a switched-off renderer's first material (a collision stand-in's: graph's proxyMaterial)
    if ((x.cls === 23 || x.cls === 137) && !x.stripped && /\n {2}m_Enabled: 0/.test(x.body)) {
      const m = /m_Materials:\n\s+- \{fileID: -?\d+, guid: ([0-9a-f]+)/.exec(x.body);
      if (m) hiddenMaterial[ref(x.body, 'm_GameObject')] = m[1];
    }
    if ((x.cls === 23 || x.cls === 137) && !x.stripped && !/\n {2}m_Enabled: 0/.test(x.body)) {
      shown[ref(x.body, 'm_GameObject')] = true;
      // The first material, and all of them when there are several: slot i draws submesh i.
      const m = /m_Materials:\n\s+- \{fileID: -?\d+, guid: ([0-9a-f]+)/.exec(x.body);
      if (m) material[ref(x.body, 'm_GameObject')] = m[1];
      const slots = /m_Materials:\n((?:\s+- \{.*\}\n)+)/.exec(x.body);
      const list = slots ? [...slots[1].matchAll(/- \{fileID: -?\d+(?:, guid: ([0-9a-f]+))?/g)].map(s => s[1] || null) : [];
      if (list.length > 1) materials[ref(x.body, 'm_GameObject')] = list;
    }
    // a stripped object's id in its instance's prefab: Unity's newer files make the stripped id the
    // instance's XOR it, older ones (TangleScene) small numbers, so read it (Claude, 2026-11-08)
    if (x.stripped) sourceOf[x.id] = ref(x.body, 'm_CorrespondingSourceObject');
    if ((x.cls === 4 || x.cls === 224) && x.stripped) strippedT[x.id] = ref(x.body, 'm_PrefabInstance');
    else if (x.cls === 4 || x.cls === 224) {
      t[x.id] = {
        go: ref(x.body, 'm_GameObject'), father: ref(x.body, 'm_Father'),
        pos: vec(x.body, 'm_LocalPosition') || { x: 0, y: 0, z: 0 },
        rot: vec(x.body, 'm_LocalRotation') || { x: 0, y: 0, z: 0, w: 1 },
        scl: vec(x.body, 'm_LocalScale') || { x: 1, y: 1, z: 1 }
      };
    } else if (x.cls === 1 && x.stripped) {
      strippedGo[x.id] = ref(x.body, 'm_PrefabInstance');
      sourceGo[x.id] = ref(x.body, 'm_CorrespondingSourceObject'); // its id in the instance's prefab
    }
    else if (x.cls === 1) go[x.id] = { name: ((/m_Name: (.*)/.exec(x.body) || [])[1] || '').trim(), active: !/m_IsActive: 0/.test(x.body), layer: +((/m_Layer: (\d+)/.exec(x.body) || [])[1] || 0), editorOnly: /m_TagString: EditorOnly\b/.test(x.body) };
    else if (x.cls === 33 || x.cls === 137) {
      const r = guidRef(x.body, 'm_Mesh');
      if (r) mesh[ref(x.body, 'm_GameObject')] = r;
      if (!x.stripped) meshFilter[ref(x.body, 'm_GameObject')] = x.id;
    } else if (x.cls === 114) {
      const script = guidRef(x.body, 'm_Script');
      if (script && !x.stripped) scripts.push([ref(x.body, 'm_GameObject'), script.guid, x.body, x.id]);
      if (script && scriptTakesText(script.guid)) takesText = true;
      const m = /\n {2}textId: (.+)/.exec(x.body);
      if (m && m[1].trim()) textId[ref(x.body, 'm_GameObject')] = m[1].trim();
    } else if (x.cls === 1001) {
      const src = guidRef(x.body, 'm_SourcePrefab');
      // m_RemovedComponents: components of the source the instance removes (by their ids there)
      const removed = [...((/\n {4}m_RemovedComponents:\n((?: {4}- \{[^\n]*\n)*)/.exec(x.body) || [])[1] || '').matchAll(/fileID: (-?\d+)/g)].map(m => m[1]);
      inst[x.id] = { src: src && src.guid, parent: ref(x.body, 'm_TransformParent'), mods: modifications(x.body), removed };
    }
  }
  // Spinners an EffectEnable turns on, by their text: drawn as on (Ken, 2026-11-07: a Cairn's pieces
  // spin once its portal is bought; layout treats it as paid).
  const turnedOn = new Set(scripts.filter(s => scriptName(s[1]) === 'EffectEnable' && !/\n {2}setToState: 0/.test(s[2])).map(s => (/\n {2}componentToEnable: \{fileID: (-?\d+)/.exec(s[2]) || [])[1]));
  const enabledSpinners = new Set(scripts.filter(s => turnedOn.has(s[3]) && scriptName(s[1]) === 'Spinner').map(s => s[2]));
  // Scripts added to a prefab instance here sit on its stripped root game object.
  const addedScripts = {}, addedScriptBodies = {};
  for (const [g, guid, body, sid] of scripts) {
    if (!strippedGo[g]) continue;
    (addedScripts[strippedGo[g]] = addedScripts[strippedGo[g]] || []).push(guid);
    (addedScriptBodies[strippedGo[g]] = addedScriptBodies[strippedGo[g]] || []).push({ guid, body, sid });
  }
  return { lights, meshFilter, renderer, t, go, mesh, inst, strippedT, strippedGo, sourceGo, sourceOf, textId, material, materials, hiddenMaterial, enabledSpinners, shown, takesText, lodGroup, rendererGo, strippedRenderer, strippedComponent, colliders, particles, scripts, addedScripts, addedScriptBodies };
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
// Only scenes changed (Layout placing an assemblage, an edit in a scene): the prefabs read stay, as
// nothing in a prefab comes from a scene (Ken, 2026-11-09: every such change cost the next load its
// seconds of prefab reading); the changed scenes are read again.
function refreshIndex() {
  if (guidIndex && fs.statSync(INDEX_FILE).mtimeMs !== guidIndexTime) {
    const old = guidIndex;
    guidIndex = null;
    const now = index(), changed = [];
    for (const [g, e] of Object.entries(now)) if (!old[g] || old[g].blob !== e.blob || old[g].path !== e.path) changed.push(e.path);
    for (const g of Object.keys(old)) if (!now[g]) changed.push(old[g].path);
    if (changed.every(p => /\.unity$/.test(p || ''))) {
      for (const p of changed) sceneCache.delete(path.join(REPO, p));
      return;
    }
    scriptText.clear();
    prefabGuids = null; // prefabByName's names, which new prefabs join
    prefabCache.clear(); // its parts hold mesh blobs, which change when a model is rewritten
    sceneCache.clear(); // and scenes hold those prefabs
    parsedPrefabs.clear();
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
// Prefabs as read (parse), by file; null for none. An instance with overrides is built afresh from
// its prefab, and this is shared storage, where each file call costs about a millisecond: OakScene
// read 593 files 3547 times, 57% of its 21 s import (Ken, 2026-11-07).
const parsedPrefabs = new Map();
function parsedPrefab(file) {
  if (!parsedPrefabs.has(file)) parsedPrefabs.set(file, fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : null);
  return parsedPrefabs.get(file);
}
// The last scenes read, for the areas cut from one scene (a few seconds to a quarter of a minute
// each to read; 2 on a phone's memory). By file; a changed file is read again.
const sceneCache = new Map();
const SCENES_KEPT = 2;
// Flattens a prefab (by guid) to { name, path, rootId, rootGoId, rootTrs, parts }, where each
// part is { mesh, m, material, materials (when not the one slot), object, prefab, off } with m relative to the prefab root (the
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
  const f = parsedPrefab(path.join(REPO, e.path));
  if (!f) return null;
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

// A renderer's materials by slot, after an instance's overrides (o.slots by index, o.slotCount for
// m_Materials.Array.size), or null for the usual single slot.
function materialSlots(own, first, o) {
  const count = o && o.slotCount !== undefined ? o.slotCount : own ? own.length : 1;
  const list = Array.from({ length: count }, (_, i) => (o && o.slots && o.slots[i]) || (i === 0 ? first : (own && own[i]) || null));
  return own || list.length > 1 ? list : null;
}
// Builds the transform tree of a parsed file. Nodes are transform ids or 'pi<id>' for
// prefab instances; stripped transforms alias to their instance node.
// unity.json's "substitute" (defaults): a nested prefab read as another inside the prefabs or scenes
// named (Ken, 2026-11-09: the flamers' mounted FireObject read as Canopy's ManaFire item, real fire
// mana to take, as Canopy should have it: docs Flamer; Game's ManaShow slots as Abstract Mana).
// [{ prefab, with, in: [prefab or scene names], scale?: the new prefab's size there, why }]
let substituteKept = null;
function substitutes() {
  const file = path.join(__dirname, '..', 'unity.json'), stamp = fs.statSync(file).mtimeMs;
  if (!substituteKept || substituteKept.stamp !== stamp) substituteKept = { stamp, list: (JSON.parse(fs.readFileSync(file, 'utf8')).defaults || {}).substitute || [] };
  return substituteKept.list;
}
// An instance (f.inst's) as read in fileName: its source swapped by a substitute rule, keeping only
// its root's settings (its place, name, active), moved onto the new source's root.
function substituteOf(x, fileName) {
  if (!x.src || !fileName) return x;
  const e = index()[x.src];
  const from = e && e.path.endsWith('.prefab') ? path.basename(e.path, '.prefab') : null;
  const rule = from && substitutes().find(r => r.prefab === from && (r.in || []).includes(fileName));
  const withGuid = rule && prefabGuidOf(rule.with);
  const orig = withGuid && prefab(x.src), sub = withGuid && prefab(withGuid);
  if (!orig || !sub) return x;
  // its place and turn, name and active; not its scale: the new prefab keeps its own size (ManaFire, a
  // rock drawn at 13, isn't built as FireObject, a mesh at 0.2)
  const map = { [orig.rootId]: sub.rootId, [orig.rootGoId]: sub.rootGoId };
  if (rule.scale !== undefined && !(rule.scale > 0)) throw new Error(`unity.json substitute ${rule.prefab} -> ${rule.with}: scale must be a number above 0`);
  return { ...x, src: withGuid, mods: x.mods.filter(m => m.target in map && !/^m_LocalScale\./.test(m.path)).map(m => ({ ...m, target: map[m.target] })), removed: [], origRoot: { rootId: orig.rootId, rootGoId: orig.rootGoId }, ...(rule.scale !== undefined ? { substituteScale: rule.scale } : {}) };
}
function nodes(f, depth, overrides = null, fileName = '') {
  const n = {};
  const alias = id => (f.strippedT[id] ? 'pi' + f.strippedT[id] : id);
  for (const [id, t] of Object.entries(f.t)) {
    const g = f.go[t.go] || { name: '', active: true };
    const o = overrides && overrides[id];
    const ga = overrides && overrides[t.go] ? overrides[t.go].active : undefined;
    // a MeshFilter or renderer an instance further out removes (m_RemovedComponents): no mesh drawn
    // (Claude, 2026-11-03: NoteLore removes its NoteBase's paper cube)
    const gone = c => c && overrides && overrides[c] && overrides[c].removed;
    const removedMesh = gone(f.meshFilter[t.go]) || gone(f.renderer[t.go]);
    const onRenderer = overrides && f.renderer[t.go] && overrides[f.renderer[t.go]];
    const material = (onRenderer && onRenderer.material) || f.material[t.go] || null;
    n[id] = {
      kind: 't', father: alias(t.father), parentT: t.father,
      pos: o ? { ...t.pos, ...o.pos } : t.pos, rot: o ? { ...t.rot, ...o.rot } : t.rot, scl: o ? { ...t.scl, ...o.scl } : t.scl,
      name: overrides && overrides[t.go] && overrides[t.go].name !== undefined ? overrides[t.go].name : g.name, active: ga === undefined ? g.active : ga, go: t.go, editorOnly: Boolean(g.editorOnly),
      mesh: removedMesh ? null : f.mesh[t.go] || null, meshOff: !f.shown[t.go], material, materials: materialSlots(f.materials[t.go], material, onRenderer), textId: f.textId[t.go] || null
    };
  }
  for (const [id, x0] of Object.entries(f.inst)) {
    const x = substituteOf(x0, fileName);
    let sub = x.src ? prefab(x.src, depth + 1) || modelInstance(x.src, x.mods) : null;
    const pos = { ...(sub ? sub.rootTrs.pos : { x: 0, y: 0, z: 0 }) };
    const rot = { ...(sub ? sub.rootTrs.rot : { x: 0, y: 0, z: 0, w: 1 }) };
    const scl = { ...(sub ? sub.rootTrs.scl : { x: 1, y: 1, z: 1 }) };
    let name = sub ? sub.name : '?', active = true, textId = null, editorOnly = false;
    // This instance's root, as ids in this file (a variant's own root has no stripped game object).
    // (one substituted: settings from further out still name the original's root)
    const roots = x.origRoot || sub;
    const rootT = roots && roots.rootId ? xorId(id, roots.rootId) : null;
    const rootGo = roots && roots.rootGoId ? xorId(id, roots.rootGoId) : null;
    const inner = {}; // modifications of objects inside the instance, by their fileID in its source
    for (const r of x.removed || []) (inner[r] = inner[r] || { pos: {}, rot: {}, scl: {} }).removed = true;
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
      // the instance's own name, not one given to an object inside it (Claude, 2026-11-02: HawthornOutpost
      // showed as OutpostSkyBeamPfx, a child's)
      // An object inside it renamed here keeps that name (Claude, 2026-11-09: each Outpost's portal is
      // renamed Portal-LumaToTemple and the like, the name the Temple's portal leads to).
      if (m.path === 'm_Name') {
        if (!sub || !sub.rootGoId || m.target === sub.rootGoId) name = m.value;
        else (inner[m.target] = inner[m.target] || { pos: {}, rot: {}, scl: {} }).name = m.value;
        continue;
      }
      // A material set on a renderer inside the instance (Claude, 2026-11-06: 180 Canopy files set
      // one, the eggs' and the portals' among them): that renderer draws in it, in that slot.
      const slot = /^m_Materials\.Array\.data\[(\d+)\]$/.exec(m.path);
      if (sub && !sub.model && slot && m.guid) {
        const o = inner[m.target] = inner[m.target] || { pos: {}, rot: {}, scl: {} };
        if (slot[1] === '0') o.material = m.guid;
        else o.slots = { ...o.slots, [slot[1]]: m.guid };
      }
      if (sub && !sub.model && m.path === 'm_Materials.Array.size') (inner[m.target] = inner[m.target] || { pos: {}, rot: {}, scl: {} }).slotCount = +m.value;
      if (m.path === 'textId' && m.value) textId = m.value;
      if (m.path === 'm_IsActive' && sub && m.target === sub.rootGoId) active = m.value !== '0';
      if (m.path === 'm_TagString' && (!sub || !sub.rootGoId || m.target === sub.rootGoId)) editorOnly = m.value === 'EditorOnly';
      const k = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(m.path);
      if (k && sub && m.target === sub.rootId) (k[1] === 'Position' ? pos : k[1] === 'Rotation' ? rot : scl)[k[2]] = parseFloat(m.value);
    }
    // Overrides from further out: those aimed at this instance's root change its placement;
    // the rest are passed inside, translated to the source prefab's ids.
    if (overrides) {
      const o = rootT && overrides[rootT];
      if (o) { Object.assign(pos, o.pos); Object.assign(rot, o.rot); if (!x.origRoot) Object.assign(scl, o.scl); }
      if (rootGo && overrides[rootGo] && overrides[rootGo].active !== undefined) active = overrides[rootGo].active;
      if (rootGo && overrides[rootGo] && overrides[rootGo].name !== undefined) name = overrides[rootGo].name;
      for (const [k, v] of Object.entries(overrides)) {
        if (k === rootT || k === rootGo) continue;
        const inside = xorId(id, k);
        const cur = inner[inside] = inner[inside] || { pos: {}, rot: {}, scl: {} };
        Object.assign(cur.pos, v.pos); Object.assign(cur.rot, v.rot); Object.assign(cur.scl, v.scl);
        if (v.active !== undefined) cur.active = v.active;
        if (v.name !== undefined) cur.name = v.name;
        if (v.props) cur.props = { ...cur.props, ...v.props };
        if (v.material) cur.material = v.material;
        if (v.slots) cur.slots = { ...cur.slots, ...v.slots };
        if (v.slotCount !== undefined) cur.slotCount = v.slotCount;
        if (v.removed) cur.removed = true;
      }
    }
    const overridden = Object.keys(inner).length > 0;
    if (overridden && sub && !sub.model) sub = prefab(x.src, depth + 1, inner); // (an unreadable source: none)
    // Components added to the instance's stripped root game object (e.g. a MeshFilter).
    const addedGo = Object.keys(f.strippedGo).find(g => f.strippedGo[g] === id);
    if (x.substituteScale) for (const k of ['x', 'y', 'z']) scl[k] *= x.substituteScale;
    n['pi' + id] = { kind: 'pi', father: alias(x.parent), parentT: x.parent, pos, rot, scl, name, active, sub, overridden, mods: x.mods, addedScripts: f.addedScripts[id] || [], addedScriptBodies: f.addedScriptBodies[id] || [], mesh: addedGo ? f.mesh[addedGo] || null : null, meshOff: addedGo ? !f.shown[addedGo] : false, material: addedGo ? f.material[addedGo] || null : null, materials: addedGo ? f.materials[addedGo] || null : null, textId, editorOnly };
  }
  return n;
}

// C# scripts (MonoBehaviours) for layout's stand-ins (Ken, 2026-10-29): a script whose class has a
// JS stand-in, layout/scripts/<Name>.js, gets its saved fields; any other is only named (a probe
// lists them). Keys of objects and components are their fileIDs in this file, behind
// "<instance>/" for each prefab instance they sit inside.
const STANDINS = path.join(__dirname, '..', 'scripts');
const scriptName = guid => { const e = index()[guid]; return e && e.path.endsWith('.cs') ? path.basename(e.path, '.cs') : null; };
// Listed once: a stand-in added or removed restarts the server (dev.js).
let standIns = null;
const hasStandIn = name => {
  if (!standIns) standIns = new Set(fs.existsSync(STANDINS) ? fs.readdirSync(STANDINS) : []);
  return Boolean(name) && standIns.has(name + '.js');
};
// Scripts layout doesn't run but reads when importing, to do what they do as the game starts
// (Ken, 2026-10-29): GemLocus and Gem, for the gem each locus makes (tools/gems.js); GateMini and
// Lamp, for the lamps a gate shows (scenePieces). Their entries (with fields, and instances'
// overrides of them) are a graph's read, not its scripts.
const { keep: Keep } = require('./keep.js');
const READ = new Set(['EffectPod', 'HcGuard', 'GemLocus', 'Gem', 'GateMini', 'Lamp', 'Portal', 'CrossSceneReference', 'Payment', 'Payee', 'PaymentScheduleArray', 'HcHealth', 'Vacancy']); // Vacancy: its shadowMaterial (game mode) // HcHealth: a harvester's healthMax (game mode: a fire-empowered stab on red armor does 1) // Payee and its schedule: what a portal costs (game mode) // Payment: its marker, value and the amber it makes (game mode) // Portal and its CrossSceneReference: where a portal leads (game mode)
const STAGE_FILTERS = new Set(['FilterWithStageData', 'FilterOnStage', 'FilterOnPopulate']);
// Canopy's Items (Ken, 2026-11-08: game mode takes any Item): Item.cs's class and every class
// deriving from it, at any depth (Ring, Gem, Dagger, Battery, Fuel, Amber, Mana...), read once from
// the class lines of Assets/Scripts. The few fields game mode uses come along (web/play.js).
// A Firefly is an Interactable, not an Item, but game mode takes it as one (Ken, 2026-11-08: tapping
// a firefly puts it on the hand crystal). So is a RingPhantom, a finger ring locus's stand-in ring
// (Ken, 2026-11-09: tapping one takes its ring and the phantom goes; the game's carry to a RingHarbor,
// an unfinished experiment, is skipped): taken as the finger ring it gives.
const ITEM_ROOTS = ['Item', 'Firefly', 'RingPhantom'];
let itemClasses = null;
const itemParent = {};
// The class lines are kept on disk (tools/keep.js), keyed by every script's blob in the guid index
// (Ken, 2026-11-09: their grep took 1.6 s of a restarted server's first load).
const keptClasses = Keep('canopy-classes');
function classParents() {
  const scripts = Object.values(index()).filter(e => e.path && e.path.startsWith('Assets/Scripts/') && e.path.endsWith('.cs')).map(e => `${e.path} ${e.blob || ''}`).sort();
  const key = require('crypto').createHash('sha1').update(scripts.join('\n')).digest('hex');
  const k = keptClasses.get();
  if (k.key === key && k.parent && k.gravitic) return k;
  let text = '';
  try {
    text = execFileSync('grep', ['-rhoE', '\\bclass\\s+\\w+\\s*:\\s*\\w+', '--include=*.cs', path.join(REPO, 'Assets', 'Scripts')], { maxBuffer: 1 << 26 }).toString();
  } catch (error) {
    if (error.status !== 1) throw error; // 1: none
  }
  const parent = {};
  for (const m of text.matchAll(/class\s+(\w+)\s*:\s*(\w+)/g)) parent[m[1]] = m[2];
  // each class's own isGravitic (Interactable.isGravitic: false, Goop's and PartBase's true), by its
  // file's name, Canopy's one class a file: whether a thrown item falls (game mode)
  let grav = '';
  try {
    grav = execFileSync('grep', ['-rHE', 'bool\\s+isGravitic\\s*=>\\s*(true|false)', '--include=*.cs', path.join(REPO, 'Assets', 'Scripts')], { maxBuffer: 1 << 24 }).toString();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const gravitic = {};
  for (const m of grav.matchAll(/([^/\n]+)\.cs:.*isGravitic\s*=>\s*(true|false)/g)) gravitic[m[1]] = m[2] === 'true';
  Object.assign(k, { key, parent, gravitic });
  keptClasses.save();
  return k;
}
let graviticOf = {};
function isItemClass(name) {
  if (!itemClasses) {
    const parent = itemParent;
    const c = classParents();
    Object.assign(parent, c.parent);
    graviticOf = c.gravitic;
    itemClasses = new Set(ITEM_ROOTS);
    for (const name of Object.keys(parent)) {
      for (let k = name, i = 0; k && i < 20; k = parent[k], i++) if (ITEM_ROOTS.includes(k)) { itemClasses.add(name); break; }
    }
  }
  return Boolean(name) && itemClasses.has(name);
}
// Canopy's harvesters (Ken, 2026-11-09: in game mode a tap kills one): Harvester.cs's class and
// every class deriving from it, from the same class lines.
function isHarvesterClass(name) {
  isItemClass(''); // reads the class lines
  for (let k = name, i = 0; k && i < 20; k = itemParent[k], i++) if (k === 'Harvester') return true;
  return false;
}
const ITEM_FIELDS = ['amberToAdd', 'fuelSecondsToAdd', 'power', 'isThumbRing', 'abilityId'];
// the kinds game mode treats apart; a class deriving from one is taken as it (ManaFire as Mana)
const ITEM_KINDS = new Set(['Amber', 'Mana', 'Fuel', 'Fruit', 'Ring', 'Gem', 'Dagger', 'Thruster', 'Booster', 'Headlamp', 'Battery', 'Firefly']);
function itemOf(name, body, props) {
  const fields = { ...scriptFields(body), ...(props || {}) };
  let kind = name;
  for (let k = name, i = 0; k && i < 20; k = itemParent[k], i++) if (ITEM_KINDS.has(k)) { kind = k; break; }
  if (name === 'RingPhantom') return { kind: 'Ring', class: 'RingPhantom', isThumbRing: 0 }; // its ring (ringToGive) is a finger ring
  // falls when thrown: the nearest isGravitic up its class chain
  let falls = false;
  for (let k = name, i = 0; k && i < 20; k = itemParent[k], i++) if (k in graviticOf) { falls = graviticOf[k]; break; }
  const out = { kind, ...(kind !== name ? { class: name } : {}), ...(falls ? { gravitic: 1 } : {}) };
  for (const k of ITEM_FIELDS) if (typeof fields[k] === 'number') out[k] = fields[k];
  return out;
}
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
  const s = { name, id: prefix + id, go: prefix + go, off: off || (/\n {2}m_Enabled: 0/.test(body) && !(f && f.enabledSpinners.has(body))) };
  // a spinner a purchase switches on (a Cairn's): drawn spinning, but in game mode only once paid
  if (/\n {2}m_Enabled: 0/.test(body) && f && f.enabledSpinners.has(body)) s.byPurchase = true;
  if (hasStandIn(name) || READ.has(name)) {
    const fields = { ...scriptFields(body) };
    for (const [k, v] of Object.entries(props || {})) if (!k.includes('.') && k !== 'm_Enabled') fields[k] = v; // an instance's settings
    // a cross-scene reference names its target object (CrossSceneLookup: by the object's name)
    // a payment schedule's prices (PaymentScheduleArray.priceList), a list, with an instance's settings of it
    if (name === 'PaymentScheduleArray') {
      const block = /\n {2}priceList:\n((?: {2}- [^\n]*\n?)*)/.exec(body);
      let list = block ? [...block[1].matchAll(/ {2}- ([^\n]*)/g)].map(m => +m[1]) : [];
      if (props) {
        if ('priceList.Array.size' in props) list = list.slice(0, +props['priceList.Array.size']).concat(Array(Math.max(0, +props['priceList.Array.size'] - list.length)).fill(0));
        for (const [k, v] of Object.entries(props)) { const m = /^priceList\.Array\.data\[(\d+)\]$/.exec(k); if (m) list[+m[1]] = +v; }
      }
      fields.priceList = list;
    }
    if (name === 'CrossSceneReference') fields.target = props && 'componentReference.nameOfGameObject' in props ? String(props['componentReference.nameOfGameObject']) : ((/\n {2}componentReference:\n {4}nameOfGameObject: ([^\n]*)/.exec(body) || [])[1] || '').trim();
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
    return inst ? `${inst}/${sourceIn(f, id, inst)}` : id;
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v && v.ref ? { ref: key(v.ref) } : v]));
}
const prefixRefs = (fields, prefix) => (prefix ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v && v.ref ? { ref: prefix + v.ref } : v])) : fields);

function graph(f, depth, overrides = null, prefabName = '') {
  const n = nodes(f, depth, overrides, prefabName);
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
  const items = {}; // an object's key -> the Item on it: { kind, and the fields game mode uses }
  // each Item's component key, so a setting of it from further out is kept (Claude, 2026-11-09:
  // Amber10, a variant setting Amber's amberToAdd to 10, read as 1)
  const itemComponents = [];
  const lights = []; // its point Lights that are on: { at (prefab space), color, intensity, range, mask }
  // a transform's id -> its object's key, as objects are added: this file's own, and each nested
  // prefab's (at any depth) by the id Unity gives it here, the instance's id XOR its id there
  const goOfT = {};
  const addScript = s => (READ.has(s.name) ? read : scripts).push(s);
  for (const [g, guid, body, sid] of f.scripts) (scriptsOf[g] = scriptsOf[g] || []).push([guid, body, sid]);
  // Conditions (tools/conditions.js): each part's gate in the game, from its objects' rules here and,
  // for a nested prefab's parts, theirs there.
  const rules = Cond().rulesOf(f);
  // a stripped transform's object key when its id isn't the instance's XOR the source's (Layout's
  // linked assemblages keep the ids they had in the scene; Claude, 2026-11-09: Black Isle's Ejectors
  // lost their parents, so a tap couldn't tell what it was on): by its source, as innerParent does
  const innerFather = parentT => {
    const inst = f.strippedT[parentT], x = inst && n['pi' + inst];
    if (!x || !x.sub) return null;
    const src = sourceIn(f, parentT, inst);
    const k = (x.sub.objectOfT && x.sub.objectOfT[src]) || (src === x.sub.rootId ? Object.keys(x.sub.objects || {}).find(o => o.split('/').reduceRight((v, i) => (v === null ? i : xorId(i, v)), null) === x.sub.rootGoId) : null);
    return k ? inst + '/' + k : null;
  };
  const visit = (id, m, parentOff, parentTerms) => {
    const x = n[id];
    const off = parentOff || !x.active;
    const terms = parentTerms.concat(Cond().nodeTerms(rules, id, x.active));
    // its parent object's key; one parented inside a nested prefab (a variant's Gem05Lods under its
    // base's Model) by that object's key there (the instance's id XOR the transform's)
    let father = n[x.father] ? n[x.father].go || null : null;
    if (!father && f.strippedT[x.parentT]) father = goOfT[x.parentT] || innerFather(x.parentT);
    if (x.kind === 't') {
      const g = f.go[x.go] || {};
      goOfT[id] = x.go;
      // a collision stand-in: a collider with its renderer switched off (the Daisy's SawCollision, in
      // C_Blade_D, beside the blade drawn in SawBladeMat): what a strike on what's drawn beside it
      // meets, so its material is the one the dagger checks (tools/scene.js gameThings)
      const proxy = f.colliders[x.go] && f.hiddenMaterial[x.go] && !f.shown[x.go] ? { proxyMaterial: f.hiddenMaterial[x.go] } : {};
      objects[x.go] = { name: x.name, father, m, off, layer: g.layer || 0, ...(f.colliders[x.go] ? { colliders: f.colliders[x.go] } : {}), ...proxy };
      const propsOf = id => (overrides && overrides[id] && overrides[id].props) || null;
      for (const [guid, body, sid] of scriptsOf[x.go] || []) {
        addScript(scriptEntry(guid, body, sid, x.go, off, '', f, propsOf(sid)));
        if (isItemClass(scriptName(guid))) { items[x.go] = itemOf(scriptName(guid), body, propsOf(sid)); itemComponents.push(sid); }
      }
      if (f.lights[x.go] && !off) lights.push({ at: apply(m, [0, 0, 0]).map(v => round3(v)), ...f.lights[x.go], ...(f.lights[x.go].spot ? { dir: turn(m, [0, 0, 0], [0, 0, 1]) } : {}) });
      // A particle system, for the ParticleSystem stand-in (tools/particles.js describes it): only one
      // that plays by itself (on awake); the rest wait for game events layout doesn't run, and the
      // Tangle has some 1400 of them.
      const ps = f.particles[x.go];
      if (ps && ps[0] && hasStandIn('ParticleSystem')) {
        const props = propsOf(ps[0].id), rprops = ps[1] && propsOf(ps[1].id);
        const plays = props && 'playOnAwake' in props ? props.playOnAwake !== 0 : !/\n {2}playOnAwake: 0/.test(ps[0].body);
        // or one an EffectBoolFade on its object fades in when its trigger's condition holds (Ken,
        // 2026-11-10: the Tangle's DeviceSkyPfx, on while DaggerCount<1): fades, it plays while a gate
        // on it or its piece holds, and waits with none (scripts/ParticleSystem.js)
        const fades = !plays && (scriptsOf[x.go] || []).some(([g]) => scriptName(g) === 'EffectBoolFade');
        // its gate, as its object's (Ken, 2026-11-10: the Tangle's dagger beacon goes out at DaggerCount 1;
        // web/tickable.js switches it off while the gate doesn't hold)
        if (plays || fades) scripts.push({ name: 'ParticleSystem', id: ps[0].id, go: x.go, off, renderer: ps[1] ? ps[1].id : null, fields: { ...Particles.describe(ps[0].body, ps[1] && ps[1].body, props, rprops), ...(fades ? { playOnAwake: true, fades: true } : {}) }, ...(lodOf[x.go] ? { lod: lodOf[x.go] } : {}), ...Cond().gameFields(terms, rules.hidden.has(id)) });
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
      const part = { mesh, m, material: x.material, ...(x.materials ? { materials: x.materials } : {}), object: x.name, prefab: prefabName, off: off || x.meshOff, rendererOff: Boolean(x.meshOff), go: x.go, ...((f.go[x.go] || {}).layer ? { layer: f.go[x.go].layer } : {}), ...Cond().gameFields(terms, x.meshOff || rules.hidden.has(id)) };
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
      if (!off) for (const l of x.sub.lights || []) if (!l.off) lights.push({ ...l, at: apply(m, l.at).map(v => round3(v)), ...(l.dir ? { dir: turn(m, l.at, l.dir) } : {}) });
      // a read component's field this file sets to one of its own objects (Cairn.prefab and PortalMain
      // set their nested PortalBase's Portal.bubble to their TeleBubble; Claude, 2026-11-09: only the
      // bubble teleports, Ken): kept, by that object's key here
      const keyId = k => k.split('/').reduceRight((v, i) => (v === null ? i : xorId(i, v)), null);
      const here = id => { const i2 = f.strippedGo[id] || f.strippedComponent[id]; return i2 ? `${i2}/${sourceIn(f, id, i2)}` : id; };
      for (const s of x.sub.read || []) {
        const set = {};
        for (const m of x.mods) if (m.ref && !m.path.includes('.') && m.target === keyId(s.id)) set[m.path] = { ref: here(m.ref) };
        read.push({ ...s, id: prefix + s.id, go: prefix + s.go, off: off || s.off, fields: { ...prefixRefs(s.fields || {}, prefix), ...set } });
      }
      for (const s of x.sub.scripts || []) scripts.push({ ...withoutGame(s), ...(s.name === 'ParticleSystem' ? Cond().gameFields(terms.concat(s.when || []), Boolean(s.never)) : {}), id: prefix + s.id, go: prefix + s.go, off: off || s.off, ...(s.fields ? { fields: prefixRefs(s.fields, prefix) } : {}), ...(s.lod ? { lod: { key: prefix + s.lod.key, levels: s.lod.levels } } : outer ? { lod: { key: outer.key, levels: outer.levels } } : {}) });
      // its root object goes by the instance's name, as in Unity (a portal's, how CrossSceneLookup finds it)
      // (a key inside a nested prefab is a path of ids: its file id is them XORed)
      const rootKey = Object.keys(x.sub.objects || {}).find(k => k.split('/').reduceRight((v, i) => (v === null ? i : xorId(i, v)), null) === x.sub.rootGoId);
      for (const [k, o] of Object.entries(x.sub.objects || {})) objects[prefix + k] = { ...o, ...(k === rootKey ? { name: x.name } : {}), father: o.father ? prefix + o.father : father, m: mul(m, o.m), off: off || o.off };
      for (const [k, it] of Object.entries(x.sub.items || {})) items[prefix + k] = it;
      for (const c of x.sub.itemComponents || []) itemComponents.push(prefix + c);
      for (const [t, k] of Object.entries(x.sub.objectOfT || {})) goOfT[xorId(inst, t)] = prefix + k;
      // Scripts added to the instance's root here: on that root (inside the instance), but their
      // fields name objects in this file, so they aren't prefixed (Flamer's Flamer and HcFaceTarget
      // sit on its nested Harvester's root and point at Flamer's own Spinner and StraightUp).
      // An added one is a component of this file, by its own id here, so a setting of it from further
      // out reaches it (Claude, 2026-11-09: the Outposts' CrossSceneReference, added to PortalMain's
      // nested PortalBase, lost each scene's Portal-TempleTo* and led nowhere).
      for (const { guid, body, sid } of x.addedScriptBodies || []) {
        const s = scriptEntry(guid, body, sid || prefix + 'added' + scripts.length, prefix + (x.sub.rootGoId || 'root'), off, '', f, sid && overrides && overrides[sid] ? overrides[sid].props || null : null);
        addScript(s);
        if (isItemClass(s.name)) {
          items[prefix + (x.sub.rootGoId || 'root')] = itemOf(s.name, body, sid && overrides && overrides[sid] ? overrides[sid].props || null : null);
          if (sid) itemComponents.push(sid);
        }
      }
      for (const [k, sg] of Object.entries(x.sub.lodGroups || {})) lodGroups[inst + '/' + k] = { center: apply(m, sg.center), size: sg.size * maxScale(m), scale: sg.scale * maxScale(m), heights: sg.heights };
    }
    for (const c of children[id] || []) {
      // one parented to an object inside this nested instance (NoteLore's stone, under its NoteBase's
      // paper) hangs from that object, its placement and scale (Claude, 2026-11-03: it hung from the
      // instance's root, unflattened, three meters long)
      let pm = m, poff = off;
      if (x.kind === 'pi' && x.sub && f.strippedT[n[c].parentT] === id.slice(2)) {
        const key = x.sub.objectOfT && x.sub.objectOfT[sourceIn(f, n[c].parentT, id.slice(2))];
        const o = key && x.sub.objects && x.sub.objects[key];
        if (o) { pm = mul(m, o.m); poff = off || o.off; }
      }
      visit(c, mul(pm, trs(n[c].pos, n[c].rot, n[c].scl)), poff, terms);
    }
  };
  visit(root, I(), false, []);
  // Of sibling LODs no LODGroup covers, keep the most detailed present (a prefab may hold only its Lod3).
  const best = {};
  for (const [, parent, group, lod] of lods) best[parent + '|' + group] = Math.min(best[parent + '|' + group] ?? Infinity, lod);
  const drop = new Set(lods.filter(([, parent, group, lod]) => lod > best[parent + '|' + group]).map(l => l[0]));
  const kept = parts.filter(p => !drop.has(p));
  parts.length = 0;
  parts.push(...kept);
  // Each part of an Item (its object or one under it) carries it, as item: { kind, key (the Item's
  // object), fields }; under an Item inside another (a ring's gem), the outermost, taken whole.
  for (const p of parts) {
    delete p.item;
    let found = null;
    for (let k = p.go, i = 0; k && i < 200; k = objects[k] && objects[k].father, i++) if (items[k]) found = k;
    if (found) p.item = { ...items[found], key: found };
  }
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
  // A thruster's particle systems (its jets' latent flames, its steam) play only while it is worn and
  // thrusting (Thruster and JetFlame stop them at inception; Ken, 2026-11-10), which Layout doesn't
  // do: they are left out.
  const thrusterGos = new Set(scripts.filter(sc => sc.name === 'Thruster').map(sc => sc.go));
  if (thrusterGos.size) {
    const underThruster = go => { for (let k = go, i = 0; k && i < 200; k = objects[k] && objects[k].father, i++) if (thrusterGos.has(k)) return true; return false; };
    for (let i = scripts.length - 1; i >= 0; i--) if (scripts[i].name === 'ParticleSystem' && underThruster(scripts[i].go)) scripts.splice(i, 1);
  }
  const componentIds = new Set([...[...scripts, ...read].filter(s => s.fields && !/\/added|^added/.test(s.id)).flatMap(s => [s.id, s.renderer ? (s.id.includes('/') ? s.id.split('/').slice(0, -1).join('/') + '/' + s.renderer : s.renderer) : null]), ...itemComponents].filter(Boolean).map(fileId));
  return { rootId, rootGoId, rootTrs: { pos: r.pos, rot: r.rot, scl: r.scl }, parts, lodGroups, scripts, objects, componentIds, read, objectOfT: goOfT, lights, items, itemComponents };
}
const round3 = v => Math.round(v * 1000) / 1000;
// A direction at a point, through a matrix: where the point plus it lands, less where the point
// lands, made unit length.
const turn = (m, at, dir) => {
  const a = apply(m, at), b = apply(m, [at[0] + dir[0], at[1] + dir[1], at[2] + dir[2]]);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...d) || 1;
  return d.map(v => round3(v / n));
};
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
  const { mtimeMs, size } = fs.statSync(sceneFile), stamp = `${mtimeMs}:${size}`;
  const kept = sceneCache.get(sceneFile);
  if (kept && kept.stamp === stamp) return kept.pieces;
  const pieces = readScenePieces(sceneFile);
  sceneCache.delete(sceneFile);
  sceneCache.set(sceneFile, { stamp, pieces });
  if (sceneCache.size > SCENES_KEPT) sceneCache.delete(sceneCache.keys().next().value);
  return pieces;
}
function readScenePieces(sceneFile) {
  const f = parse(fs.readFileSync(sceneFile, 'utf8'));
  const n = nodes(f, 0, null, path.basename(sceneFile, '.unity')); // a scene's name, for unity.json's substitutes
  const rules = Cond().rulesOf(f);
  // What a Pod delivers (under its Revealer's revealRoot) isn't gated on the Pod's trigger: Layout
  // shows it revealed, the Pod landed (landedPods; Ken, 2026-11-10). rules.reveals still names them.
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
    let p = x.father === '0' ? null : world(x.father, alt);
    // parented to an object inside a prefab instance (Thrusters under RuinShaman's): it hangs from
    // that object, not the instance's root (Claude, 2026-11-03); the path stays the instance's
    const inner = p && innerParent(f, n, x.parentT);
    if (inner) p = { ...p, ...compose(p, inner, p.path, p.active && !inner.off) };
    let w = !p ? { pos: x.pos, rot: x.rot, scl: x.scl, path: x.name, active: x.active } : compose(p, x, p.path + '/' + x.name, p.active && x.active);
    // tagged EditorOnly, or under something that is: Unity leaves it out of the game (Tags.IsEditorOnly)
    w.editorOnly = Boolean(x.editorOnly || (p && p.editorOnly));
    w.terms = (p ? p.terms : []).concat(Cond().nodeTerms(rules, id, x.active));
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
  const guards = {}, guarding = {};
  for (const [id, x] of Object.entries(n)) {
    if (x.kind !== 'pi' || !world(id).active) continue;
    for (const m of x.mods) if (m.path === 'thingGuarded' && m.ref && f.strippedComponent[m.ref]) {
      guards['pi' + f.strippedComponent[m.ref]] = (guards['pi' + f.strippedComponent[m.ref]] || 0) + 1;
      guarding[id] = 'pi' + f.strippedComponent[m.ref]; // game mode: killing the guard counts down the cage's
    }
  }
  // The instance a piece hangs under (parentInstance, the nearest one up its parents) and, when it hangs
  // from an object inside that instance, that object's key there (parentObject; Canopy's Vacancy finds
  // its piece in its parent: game mode's vacancies, tools/scene.js)
  const parentOf = x => {
    let k = x.father, parentObject = null;
    if (f.strippedT[x.parentT]) {
      const inst = f.strippedT[x.parentT], sub = n['pi' + inst] && n['pi' + inst].sub;
      const src = sourceIn(f, x.parentT, inst);
      if (sub && src !== sub.rootId) parentObject = (sub.objectOfT || {})[src] || null;
    }
    for (let i = 0; k && k !== '0' && i < 200; k = n[k] && n[k].father, i++) if (String(k).startsWith('pi')) return { parentInstance: k.slice(2), ...(parentObject ? { parentObject } : {}) };
    return {};
  };
  const out = [], pieceOf = {};
  for (const [id, x] of Object.entries(n)) {
    // a plain object with a point Light and no mesh: a piece that is only its light
    if (x.kind === 't' && !x.mesh && f.lights[x.go] && world(id).active) { const w = world(id); out.push({ piece: x.name || 'Light', lightOnly: true, lights: [{ at: [0, 0, 0], ...f.lights[x.go], ...(f.lights[x.go].spot ? { dir: [0, 0, 1] } : {}) }], object: x.name, go: x.go, ...w, game: game(id) }); continue; }
    if (x.kind === 't' && !x.mesh) continue;
    const w = world(id);
    // instance and go: the piece's PrefabInstance or GameObject id in the scene file (tools/uses.js --live)
    if (x.kind === 'pi') out.push(pieceOf[id] = { piece: x.sub ? x.sub.name : x.name, prefab: x.sub, instance: id.slice(2), overridden: x.overridden, mods: x.mods, addedScripts: x.addedScripts, addedScriptBodies: x.addedScriptBodies, ...w, textId: x.textId, guards: guards[id] || 0, game: game(id), ...parentOf(x) });
    else {
      const mesh = describeMesh(x.mesh);
      if (isLodBeyondZero(mesh.name)) continue;
      out.push({ piece: mesh.name, mesh, layer: (f.go[x.go] || {}).layer || 0, material: x.material, ...(x.materials ? { materials: x.materials } : {}), object: x.name, go: x.go, meshOff: x.meshOff, ...w, textId: x.textId, game: game(id, x.meshOff || rules.hidden.has(id)), ...parentOf(x) });
    }
  }
  for (const [id, target] of Object.entries(guarding)) if (pieceOf[id] && pieceOf[target]) pieceOf[id].guarding = pieceOf[target].path;
  guardBeams(guarding, pieceOf);
  landedPods(n, world, out);
  sceneChildScripts(f, n, pieceOf);
  gateLamps(f, n, pieceOf, sceneFile);
  lociStages(f, n, pieceOf, sceneFile);
  return out;
}

// Guard beams (Ken, 2026-11-10; HcGuard.Register and Update): a guard outside its cage grows its
// beamPrefab (GuardBeam) at its beamOrigin, turned to the cage (LookAt) and its particles living
// the distance less 0.2 m, or lifetimeOverride (they go 1 m/s), so the beam reaches the cage. The
// cage's own Wardens have none, in Canopy as here. It is a particle system of the guard's, under
// its beamOrigin (game mode stops it when the guard is killed): piece.beam, a script entry whose
// fields carry aim (the cage, in the guard's prefab axes, Unity's: scripts/ParticleSystem.js).
const vrot = (q, v) => { const r = qmul(qmul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w }); return { x: r.x, y: r.y, z: r.z }; };
function guardBeams(guarding, pieceOf) {
  for (const [id, target] of Object.entries(guarding)) {
    const g = pieceOf[id], cage = pieceOf[target];
    if (!g || !cage) continue; // as guarding above: one of them isn't a piece here
    const hc = ((g.prefab && g.prefab.read) || []).find(sc => sc.name === 'HcGuard' && !sc.off);
    if (!hc) throw new Error(`${g.path} guards ${cage.path} but has no HcGuard read (tools/unity.js READ)`);
    const asset = hc.fields.beamPrefab && hc.fields.beamPrefab.asset;
    if (!asset) continue; // a guard with no beamPrefab draws none, as in Canopy
    const origin = hc.fields.beamOrigin && hc.fields.beamOrigin.ref;
    const o = origin && g.prefab.objects[origin];
    if (!o) throw new Error(`${g.path}: its HcGuard's beamOrigin (${JSON.stringify(hc.fields.beamOrigin)}) isn't one of its objects`);
    const ps = (prefab(asset).scripts || []).find(sc => sc.name === 'ParticleSystem' && sc.fields);
    if (!ps) throw new Error(`${g.path}: its beamPrefab (${(index()[asset] || {}).path || asset}) has no particle system that plays`);
    const at = { x: o.m[3], y: o.m[7], z: o.m[11] }; // beamOrigin, in the guard's prefab axes
    const toCage = { x: cage.pos.x - g.pos.x, y: cage.pos.y - g.pos.y, z: cage.pos.z - g.pos.z };
    const local = vrot({ x: -g.rot.x, y: -g.rot.y, z: -g.rot.z, w: g.rot.w }, toCage);
    const aim = [local.x / g.scl.x, local.y / g.scl.y, local.z / g.scl.z];
    const fromWorld = vrot(g.rot, { x: at.x * g.scl.x, y: at.y * g.scl.y, z: at.z * g.scl.z });
    const distance = Math.hypot(toCage.x - fromWorld.x, toCage.y - fromWorld.y, toCage.z - fromWorld.z);
    const lifetime = hc.fields.lifetimeOverride > 0 ? hc.fields.lifetimeOverride : distance - 0.2;
    g.beam = { name: 'ParticleSystem', id: `${hc.id}/beam`, go: origin, off: false, fields: { ...ps.fields, lifetime: { mode: 0, scalar: lifetime }, aim: aim.map(v => Math.round(v * 1000) / 1000) } };
  }
}

// Pods (Ken, 2026-11-10; EffectPod, Pod.OnArrival): when a PodRequest's trigger fires, a Pod from
// the Game's PodLauncher lands on its EffectPod's targetObject (its PodTarget), turned to (-90, 0, 0)
// at its own scale, its Revealer shows what it hid under its revealRoot, and the Pod flies home.
// Layout draws each Pod landed, a piece of its own (<request>/Pod), always, and what it delivers
// revealed (no reveal gate, above).
function landedPods(n, world, out) {
  let pod = null;
  for (const [id, x] of Object.entries(n)) {
    if (x.kind !== 'pi' || !x.sub) continue;
    const w = world(id);
    if (!w.active || w.editorOnly) continue;
    for (const r of x.sub.read || []) {
      if (r.name !== 'EffectPod' || r.off) continue;
      const key = r.fields.targetObject && r.fields.targetObject.ref;
      const o = key && x.sub.objects[key];
      if (!o) throw new Error(`${w.path}: its EffectPod's targetObject (${JSON.stringify(r.fields.targetObject)}) isn't one of its objects`);
      pod = pod || prefabByName('Pod');
      if (!pod) throw new Error('no Pod prefab (Assets/Prefabs/Harvesters/Pod.prefab) for a landed pod');
      const at = apply(trs(w.pos, w.rot, w.scl), [o.m[3], o.m[7], o.m[11]]);
      out.push({ piece: 'Pod', prefab: pod, instance: `${id.slice(2)}/pod`, overridden: false, mods: [], addedScripts: [], addedScriptBodies: [], pos: { x: at[0], y: at[1], z: at[2] }, rot: eulerToQuat({ x: -90, y: 0, z: 0 }), scl: pod.rootTrs.scl, path: `${w.path}/Pod`, active: true, terms: [], movedBy: [], guards: 0, game: null });
    }
  }
}

// Gem and ring loci, for fast-forwarding (Ken, 2026-11-08; web/play.js): an instance holding a
// GemLocus or a RingLocus carries locus: { kind, appear (its appearStageId's name), keep (a
// RingLocus's keepDuringFastForward) }. Starting a stage by fast-forwarding, a ring locus of an
// earlier stage is gone (RingLocus.OnStage) and a gem locus holds a gem only in its own stage
// (GemLocus.OnStage, shouldMakeGemOnStage).
function lociStages(f, n, pieceOf, sceneFile) {
  const stageOf = stageFinder(f, n, sceneFile);
  for (const [id, x] of Object.entries(n)) {
    const piece = pieceOf[id];
    if (!piece || !x.sub) continue;
    const gem = (x.sub.read || []).some(sc => sc.name === 'GemLocus' && !sc.off);
    const ring = !gem && (x.sub.scripts || []).some(sc => sc.name === 'RingLocus' && !sc.off);
    if (!gem && !ring) continue;
    const keep = x.mods.find(m => m.path === 'keepDuringFastForward');
    piece.locus = { kind: gem ? 'GemLocus' : 'RingLocus', appear: stageOf(id), ...(ring && keep && +keep.value ? { keep: true } : {}) };
  }
}

// A stand-in script on a mesh-less game object a scene hangs under a prefab instance (Claude,
// 2026-11-08: TangleScene's Dagger has a child "Spinner" whose Spinner turns the dagger) joins that
// instance's scripts, on the object it hangs from. Its references into the instance (stripped ids)
// become the prefab's own keys, as the instance's other scripts use.
function sceneChildScripts(f, n, pieceOf) {
  const nodeOfGo = {};
  for (const x of Object.values(n)) if (x.kind === 't') nodeOfGo[x.go] = x;
  for (const [g, guid, body, sid] of f.scripts) {
    const x = nodeOfGo[g];
    if (!x || x.mesh || !hasStandIn(scriptName(guid))) continue;
    const inst = f.strippedT[x.parentT], piece = inst && pieceOf['pi' + inst];
    if (!piece || !piece.prefab) continue;
    const sub = piece.prefab, srcT = sourceIn(f, x.parentT, inst);
    const on = srcT === sub.rootId ? sub.rootGoId : sub.objectOfT && sub.objectOfT[srcT];
    if (!on) continue;
    const s = scriptEntry(guid, body, 'scene' + sid, on, !x.active, '', f);
    if (s.fields) {
      s.fields = Object.fromEntries(Object.entries(s.fields).map(([k, v]) => {
        const [i, inner] = v && v.ref ? v.ref.split('/') : [];
        return [k, inner && i === inst ? { ref: inner } : v];
      }));
    }
    piece.prefab = { ...sub, scripts: [...(sub.scripts || []), s] };
  }
}

// A GateMini's lamps in the game (Ken, 2026-11-03: the spikes on the Approach's gate): only its
// first depositsRequired lamps (the Lamps under its lampParent, in order) show, each unlit (its
// lampOn off), and only while the gate runs, in its own stage (GateMini.OnStateRunning,
// FindLamps); dormant before it and complete after, it hides them all. The gate's stage is its
// appearStageId: its nearest stage filter's, else (Reliable.appearStageId) Stage.First in
// Game.unity, and in a biome's scene that scene's stage (the filter the scene's region has). The
// lamps' parts get these as game fields, on the piece holding the lampParent (a scene may point it
// at an object of another instance: the Approach's BeechGate at its BeechMini's flowers).
// An object's appearStageId (Reliable.appearStageId) by its node, as a stage name: its nearest
// stage filter's, else the scene's stage (a biome's scene), else Stage.First (Game.unity).
function stageFinder(f, n, sceneFile) {
  const C = Cond(), stages = C.stageIds(), scene = path.basename(sceneFile, '.unity');
  const nameOf = id => Object.keys(stages).find(k => stages[k] === id);
  return id => {
    for (let k = id, i = 0; k && k !== '0' && n[k] && i < 200; k = n[k].father, i++) {
      const x = n[k];
      const filter = x.kind === 't' && f.scripts.find(([g, guid]) => g === x.go && STAGE_FILTERS.has(scriptName(guid)));
      if (filter) return nameOf(+((/\n {2}stageId: (\d+)/.exec(filter[2]) || [])[1] || 0));
    }
    const own = Config().load(scene).stage || (C.sceneStage(scene, stages) || {}).name;
    return own || nameOf(0);
  };
}
function gateLamps(f, n, pieceOf, sceneFile) {
  const stageOf = stageFinder(f, n, sceneFile);
  for (const [id, x] of Object.entries(n)) {
    // (GateMini sits on its prefab's root, a Gate instance's, added there: the scene's settings of it
    // are this instance's mods)
    const gate = x.kind === 'pi' && x.sub && (x.sub.read || []).find(s => s.name === 'GateMini');
    if (!gate) continue;
    const mod = x.mods.find(m => m.path === 'lampParent' && m.ref), count = x.mods.find(m => m.path === 'depositsRequired');
    const inst = mod && f.strippedGo[mod.ref];
    // lampParent a plain object of the scene, the lamps pieces placed under it (Tangle's OakGate, its
    // ForestMini's flower BadLamps; Hawthorn's LumaGate, its CloudMini's; Claude, 2026-11-09: they
    // showed in every stage): each such piece holding a Lamp, in the scene's order, gated the same way
    if (mod && !inst) {
      const top = Object.keys(n).find(k => n[k].kind === 't' && n[k].go === mod.ref);
      if (!top) throw new Error(`${sceneFile}: the GateMini at ${(pieceOf[id] || {}).path || id} names a lampParent (${mod.ref}) that isn't an object of the scene`);
      const under = k => { for (let i = 0; k && k !== '0' && n[k] && i < 200; k = n[k].father, i++) if (k === top) return true; return false; };
      const lampPieces = Object.keys(n).filter(k => n[k].kind === 'pi' && pieceOf[k] && pieceOf[k].prefab && under(k) && (pieceOf[k].prefab.read || []).some(r => r.name === 'Lamp'));
      const shown = Number(count ? count.value : gate.fields.depositsRequired) || 0, running = `StageName="${stageOf(id)}"`;
      lampPieces.forEach((k, i) => {
        const piece = pieceOf[k], sub = piece.prefab, objects = sub.objects || {};
        const lamp = sub.read.find(r => r.name === 'Lamp');
        const lampOn = lamp.fields.lampOn && lamp.fields.lampOn.ref;
        const chain = key => { const out = []; for (let q = key, j = 0; q && j < 200; q = objects[q] && objects[q].father, j++) out.push(q); return out; };
        piece.prefab = { ...sub, parts: sub.parts.map(p => (p.never || i >= shown || (lampOn && chain(p.go).includes(lampOn)) ? { ...withoutGame(p), never: true } : { ...p, when: (p.when || []).concat(running) })) };
      });
      continue;
    }
    const holder = pieceOf[inst ? 'pi' + inst : id];
    const lampParent = inst ? f.sourceGo[mod.ref] : gate.fields.lampParent && gate.fields.lampParent.ref;
    if (!holder || !holder.prefab || !lampParent) continue;
    const sub = holder.prefab, objects = sub.objects || {};
    const chain = key => { const out = []; for (let k = key, i = 0; k && i < 200; k = objects[k] && objects[k].father, i++) out.push(k); return out; };
    const lamps = (sub.read || []).filter(s => s.name === 'Lamp' && chain(s.go).includes(lampParent));
    const shown = Number(count ? count.value : gate.fields.depositsRequired) || 0, running = `StageName="${stageOf(id)}"`;
    const parts = sub.parts.map(p => {
      const up = chain(p.go);
      if (!up.includes(lampParent)) return p;
      const lamp = lamps.findIndex(l => up.includes(l.go));
      const lampOn = lamp >= 0 && lamps[lamp].fields.lampOn && lamps[lamp].fields.lampOn.ref;
      if (p.never || lamp >= shown || (lampOn && up.includes(lampOn))) return { ...withoutGame(p), never: true };
      return { ...p, when: (p.when || []).concat(running) };
    });
    holder.prefab = { ...sub, parts };
  }
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
function prefabGuidOf(name) {
  prefabByName(null); // the names, read
  const hits = prefabGuids.get(name) || [];
  return hits.length ? hits[0][0] : null;
}
function prefabByName(name) {
  if (!prefabGuids) {
    prefabGuids = new Map();
    for (const [guid, e] of Object.entries(index())) {
      if (!e.path.endsWith('.prefab')) continue;
      const base = path.basename(e.path, '.prefab');
      prefabGuids.set(base, [...(prefabGuids.get(base) || []), [guid, e]]);
    }
  }
  if (name === null) return null;
  const hits = prefabGuids.get(name) || [];
  if (hits.length > 1) console.warn(`several prefabs named ${name}; using ${hits[0][1].path}`);
  return hits.length ? prefab(hits[0][0]) : null;
}

module.exports = { isHarvesterClass, decompose, innerParent, REPO, READER, index, scriptName, scriptFields, xorId, refreshIndex, I, mul, trs, qmul, eulerToQuat, quatToEuler, parse, prefab, prefabByName, modelInstance, scenePieces, describeMesh, isLodBeyondZero, gridSettings, maxScale, scriptGuid };
