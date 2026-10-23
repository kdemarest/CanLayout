// Makes Unity placeholder prefabs from the docs' placeholder shapes (tools/shapes.js), for every
// asset that has Shape lines and no prefab of its own yet:
//   node tools/make-shapes.js           lists what it would write
//   node tools/make-shapes.js --write   writes it into the Canopy working tree
// Everything goes under Assets/Placeholder, which this script owns and rewrites:
//   <Name>.prefab          an empty root holding the models below and any "use" prefabs
//   Models/<Name>.obj      the shapes of one color (<Name>_2.obj ... for more colors)
//   Materials/Shape_<rrggbb>.mat   one material per color, on Canopy/General (Assets/Shaders)
// <Name> is the asset's Unity name: its "as" specifier, else its name in PascalCase (Burl shard
// -> BurlShard). Guids come from each file's path, so rerunning keeps every reference. Once a
// prefab of that name exists elsewhere in the project (real art), the asset is skipped and
// "use" lines nest that prefab instead. To customise a placeholder prefab, move it out of
// Assets/Placeholder first, or it is overwritten on the next run.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./unity.js');
const Shapes = require('./shapes.js');
const Mesh = require('./shape-mesh.js');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const DIR = 'Assets/Placeholder';
const DEFAULT_COLOR = '#c9a66b'; // as web/app.js draws a shape with no color
// A model file with one object: Unity collapses it into its root, with these fixed ids.
const MODEL = { t: '-8679921383154817045', go: '919132149155446097', renderer: '-7635826562936255635' };
// Our own root ids in each placeholder prefab.
const ROOT = { go: '1000000000000000001', t: '1000000000000000002' };
// Canopy/General: texture x detail x _Tint x _Brightness; with no textures, the color is _Tint.
const GENERAL = '70f970fb0365c514d978918d4586c7ae';
const OBJ_META = fs.readFileSync(path.join(__dirname, 'templates', 'obj.meta'), 'utf8');

const guidOf = file => crypto.createHash('md5').update('canopy-placeholder:' + file).digest('hex');
const idOf = (...parts) => (BigInt('0x' + crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 15)) + 1n).toString();
const xorId = (a, b) => ((BigInt(a) ^ BigInt(b)) & ((1n << 63n) - 1n)).toString();
const n6 = x => +(+x).toFixed(6) || 0;

function meta(guid, importer) {
  return `fileFormatVersion: 2\nguid: ${guid}\n${importer}\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
}
const folderMeta = file => `fileFormatVersion: 2\nguid: ${guidOf(file)}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
function material(name, hex) {
  const [r, g, b] = [1, 3, 5].map(i => n6(parseInt(hex.slice(i, i + 2), 16) / 255));
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 6
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_Name: ${name}
  m_Shader: {fileID: 4800000, guid: ${GENERAL}, type: 3}
  m_ShaderKeywords:
  m_LightmapFlags: 4
  m_EnableInstancingVariants: 0
  m_DoubleSidedGI: 0
  m_CustomRenderQueue: -1
  stringTagMap: {}
  disabledShaderPasses: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs: []
    m_Floats:
    - _Brightness: 1
    - _Glossiness: 0
    - _NormalStrength: 1
    m_Colors:
    - _Tint: {r: ${r}, g: ${g}, b: ${b}, a: 1}
`;
}

// One nested prefab or model in a placeholder prefab: { guid, rootT, rootGo, name, at, turn,
// scale, material (a .mat guid, for models) }.
function instance(parentT, order, x) {
  const id = idOf(x.name, order, x.guid), stripped = xorId(id, x.rootT);
  const q = U.eulerToQuat({ x: x.turn[0], y: x.turn[1], z: x.turn[2] });
  const mods = [];
  const mod = (target, prop, value, objectReference = '{fileID: 0}') =>
    mods.push(`    - target: {fileID: ${target}, guid: ${x.guid}, type: 3}\n      propertyPath: ${prop}\n      value: ${value}\n      objectReference: ${objectReference}`);
  mod(x.rootT, 'm_RootOrder', order);
  ['x', 'y', 'z'].forEach((k, i) => mod(x.rootT, `m_LocalPosition.${k}`, n6(x.at[i])));
  for (const k of ['w', 'x', 'y', 'z']) mod(x.rootT, `m_LocalRotation.${k}`, n6(q[k]));
  ['x', 'y', 'z'].forEach((k, i) => mod(x.rootT, `m_LocalEulerAnglesHint.${k}`, n6(x.turn[i])));
  if (x.scale) ['x', 'y', 'z'].forEach((k, i) => mod(x.rootT, `m_LocalScale.${k}`, n6(x.scale[i])));
  mod(x.rootGo, 'm_Name', x.name);
  if (x.material) mod(MODEL.renderer, 'm_Materials.Array.data[0]', '', `{fileID: 2100000, guid: ${x.material}, type: 2}`);
  const removed = (x.remove || []).map(r => `\n    - {fileID: ${r}, guid: ${x.guid}, type: 3}`).join('');
  return {
    stripped,
    yaml: `--- !u!1001 &${id}
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    m_TransformParent: {fileID: ${parentT}}
    m_Modifications:
${mods.join('\n')}
    m_RemovedComponents:${removed || ' []'}
  m_SourcePrefab: {fileID: 100100000, guid: ${x.guid}, type: 3}
--- !u!4 &${stripped} stripped
Transform:
  m_CorrespondingSourceObject: {fileID: ${x.rootT}, guid: ${x.guid}, type: 3}
  m_PrefabInstance: {fileID: ${id}}
  m_PrefabAsset: {fileID: 0}
`
  };
}
function prefabYaml(name, children) {
  const nested = children.map((x, i) => instance(ROOT.t, i, x));
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &${ROOT.go}
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
  - component: {fileID: ${ROOT.t}}
  m_Layer: 0
  m_Name: ${name}
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 1
--- !u!4 &${ROOT.t}
Transform:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: ${ROOT.go}}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_ConstrainProportionsScale: 0
  m_Children:${nested.length ? '\n' + nested.map(x => `  - {fileID: ${x.stripped}}`).join('\n') : ' []'}
  m_Father: {fileID: 0}
  m_RootOrder: 0
  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}
${nested.map(x => x.yaml).join('')}`;
}

// "bare": the ids, as seen from an instance of this prefab, of every component that acts rather
// than shows (scripts, rigidbodies, colliders, audio), in it and in the prefabs nested in it.
const ACTS = new Set([114, 54, 135, 65, 64, 136, 82]); // MonoBehaviour, Rigidbody, colliders, AudioSource
function actingComponents(guid, depth = 0) {
  const e = index[guid];
  if (!e || depth > 8 || !fs.existsSync(path.join(U.REPO, e.path))) return [];
  const text = fs.readFileSync(path.join(U.REPO, e.path), 'utf8');
  const out = [];
  for (const m of text.matchAll(/^--- !u!(\d+) &(-?\d+)( stripped)?[^\n]*\n([\s\S]*?)(?=^--- |(?![\s\S]))/gm)) {
    if (m[3]) continue;
    if (ACTS.has(+m[1])) out.push(m[2]);
    else if (m[1] === '1001') {
      const src = /m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]+)/.exec(m[4]);
      if (src) for (const inner of actingComponents(src[1], depth + 1)) out.push(xorId(m[2], inner));
    }
  }
  return out;
}

// The project's own prefab with this name, outside Assets/Placeholder, or a model file named
// with its extension: { guid, rootT, rootGo, path }.
let index = null;
function realPrefab(name) {
  if (!index) index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
  // A model file by name ("LeafSingle.fbx"): its root has Unity's fixed model ids.
  if (/\.(fbx|obj)$/i.test(name)) {
    const model = Object.entries(index).find(([, e]) => e.path.endsWith('/' + name));
    return model && { guid: model[0], rootT: MODEL.t, rootGo: MODEL.go, path: model[1].path };
  }
  const hit = Object.entries(index).find(([, e]) => e.path.endsWith('/' + name + '.prefab') && !e.path.startsWith(DIR + '/'));
  if (!hit) return null;
  const p = U.prefab(hit[0]);
  return { guid: hit[0], rootT: p && p.rootId, rootGo: p && p.rootGoId, path: hit[1].path };
}

// Every file to write, by path under the Unity project: { files, made: [{ name, file }], notes }.
function plan() {
  const docs = Shapes.readDocs(DOCS);
  const files = {}, made = [], notes = [...docs.errors];
  const unityOf = name => Shapes.unityName(name, docs.assets[name] && docs.assets[name].unity);
  const owner = {};
  for (const name of Object.keys(docs.shapes)) {
    const unity = unityOf(name);
    if (owner[unity]) notes.push(`${name} and ${owner[unity]} both make ${unity}; give one an "as" name`);
    owner[unity] = name;
  }
  const put = (file, text) => (files[file] = text);
  for (const f of [DIR, `${DIR}/Models`, `${DIR}/Materials`]) put(f + '.meta', folderMeta(f));
  const materialFor = hex => {
    const file = `${DIR}/Materials/Shape_${hex.slice(1).toLowerCase()}.mat`;
    if (!files[file]) {
      put(file, material(path.basename(file, '.mat'), hex));
      put(file + '.meta', meta(guidOf(file), 'NativeFormatImporter:\n  mainObjectFileID: 2100000'));
    }
    return guidOf(file);
  };
  for (const [name, shapes] of Object.entries(docs.shapes)) {
    const unity = unityOf(name), real = realPrefab(unity);
    if (real) {
      notes.push(`${name}: skipped, ${real.path} exists`);
      continue;
    }
    const children = [];
    // Own shapes, one model per color in order of first use.
    const byColor = new Map();
    for (const s of shapes.filter(s => s.kind !== 'use')) {
      const hex = (s.color || DEFAULT_COLOR).toLowerCase();
      if (!byColor.has(hex)) byColor.set(hex, []);
      byColor.get(hex).push(...Mesh.triangles(s));
    }
    [...byColor].forEach(([hex, tris], i) => {
      const model = byColor.size > 1 ? `${unity}_${i + 1}` : unity, file = `${DIR}/Models/${model}.obj`;
      put(file, Mesh.toObj(tris, model));
      put(file + '.meta', OBJ_META.replace('{{guid}}', guidOf(file)));
      children.push({ guid: guidOf(file), rootT: MODEL.t, rootGo: MODEL.go, name: model, at: [0, 0, 0], turn: [0, 0, 0], material: materialFor(hex) });
    });
    // "use": the other asset's prefab (real or placeholder), or a Unity prefab by name.
    for (const s of shapes.filter(s => s.kind === 'use')) {
      let target = null;
      if (docs.shapes[s.name]) {
        const u = unityOf(s.name);
        target = realPrefab(u) || { guid: guidOf(`${DIR}/${u}.prefab`), rootT: ROOT.t, rootGo: ROOT.go };
        target.name = u;
      } else {
        const p = realPrefab(s.name);
        if (p) target = { ...p, name: s.name.replace(/\.(fbx|obj)$/i, '') };
      }
      if (!target) notes.push(`${name}: uses ${s.name}, which is neither an asset with shapes nor a Unity prefab`);
      else if (!target.rootT || !target.rootGo) notes.push(`${name}: can't nest ${s.name}; its root is itself a prefab instance`);
      else {
        if (s.color) notes.push(`${name}: recolor ${s.name} by hand (${s.color}); nested prefabs keep their materials`);
        const remove = s.bare ? actingComponents(target.guid) : [];
        if (s.bare) notes.push(`${name}: ${s.name} bare, ${remove.length} components removed`);
        children.push({ ...target, at: s.at, turn: s.turn, scale: s.scale, remove });
      }
    }
    const file = `${DIR}/${unity}.prefab`;
    put(file, prefabYaml(unity, children));
    put(file + '.meta', meta(guidOf(file), 'PrefabImporter:'));
    made.push({ name, file });
  }
  return { files, made, notes };
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const { files, made, notes } = plan();
  for (const m of made) console.log(`${m.name} -> ${m.file}`);
  for (const n of notes) console.log('note: ' + n);
  if (!write) {
    console.log(`${Object.keys(files).length} files; run with --write to write them under ${path.join(U.REPO, DIR)}`);
    process.exit(0);
  }
  const keep = new Set(Object.keys(files));
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(U.REPO, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  // Files left from assets that no longer have shapes are listed, not deleted.
  const stale = [];
  (function walk(dir) {
    if (!fs.existsSync(path.join(U.REPO, dir))) return;
    for (const e of fs.readdirSync(path.join(U.REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (!keep.has(rel)) stale.push(rel);
    }
  })(DIR);
  console.log(`wrote ${keep.size} files under ${path.join(U.REPO, DIR)}`);
  for (const s of stale) console.log('stale: ' + s);
}

module.exports = { plan };
