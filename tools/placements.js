// Assemblage placements in Canopy's scenes (Ken, 2026-11-09): a biome scene refers to each instance
// of an assemblage it wants (a Hut ten times over, the Amphitheater once), so loading the scene brings
// them all and nothing else needs checking. Layout writes them where Unity keeps them: one
// PrefabInstance of the assemblage's prefab (Assets/Assemblages/<Name>/<Name>.prefab) under the
// scene's anchor, placed in the anchor's space. Added, moved and deleted from an imported area in
// the page (web/app.js); every change goes into docs/Canopy Changes.md, and the scene's areas are
// patched so nothing needs extracting again.
//   add(scene, prefabName, placement) -> { instance, piece }
//   move(scene, instance, placement)  -> { instance, piece }
//   remove(scene, instance)
// placement: { position, rotation (Unity euler degrees), scale }, in Unity's world, as piece lines.
const fs = require('fs');
const path = require('path');
const U = require('./unity.js');

const AREAS = path.join(__dirname, '..', 'areas');
const CHANGES = path.join(__dirname, '..', '..', 'docs', 'Canopy Changes.md');
const sceneFile = scene => path.join(U.REPO, 'Assets', 'Scenes', scene + '.unity');
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const fmt = v => String(round(v, 6));

function split(text) {
  const parts = text.split(/^(?=--- !u!)/m);
  return { head: parts[0], docs: parts.slice(1) };
}
const idOf = doc => /^--- !u!\d+ &(-?\d+)/.exec(doc)[1];

// The scene's anchor: the root object named <Something>SceneAnchor, its transform and placement.
function anchorOf(docs) {
  for (const d of docs) {
    const m = /^--- !u!1 &(\d+)\nGameObject:\n(?:(?!--- ).*\n)*? {2}m_Name: (\w+SceneAnchor)\n/.exec(d);
    if (!m) continue;
    const t = docs.find(x => x.startsWith('--- !u!4 ') && x.includes(`m_GameObject: {fileID: ${m[1]}}`) && /m_Father: \{fileID: 0\}/.test(x));
    if (!t) continue;
    const vec = k => { const v = new RegExp(`${k}: \\{([^}]*)\\}`).exec(t)[1]; return Object.fromEntries(v.split(',').map(s => s.split(':').map(x => x.trim())).map(([a, b]) => [a, +b])); };
    const rot = vec('m_LocalRotation'), scl = vec('m_LocalScale');
    if (Math.abs(Math.abs(rot.w) - 1) > 1e-6 || [scl.x, scl.y, scl.z].some(s => Math.abs(s - 1) > 1e-6)) throw new Error(`${m[2]} is turned or scaled; placements assume it isn't`);
    return { name: m[2], t: idOf(t), pos: vec('m_LocalPosition') };
  }
  throw new Error('no <Name>SceneAnchor at the root');
}

// The assemblage's prefab: its guid and root ids.
function assemblage(prefabName) {
  const p = U.prefabByName(prefabName);
  if (!p || !/^Assets\/Assemblages\//.test(p.path)) throw new Error(`${prefabName} is not an assemblage's prefab`);
  const guid = Object.entries(U.index()).find(([, e]) => e.path === p.path)[0];
  return { guid, rootT: p.rootId, rootGo: p.rootGoId };
}

// The root transform's modifications for a placement in the anchor's space.
function mods(a, anchor, placement, order) {
  const [x, y, z] = placement.position.map((v, i) => v - [anchor.pos.x, anchor.pos.y, anchor.pos.z][i]);
  const q = U.eulerToQuat({ x: placement.rotation[0], y: placement.rotation[1], z: placement.rotation[2] });
  const s = placement.scale || [1, 1, 1];
  const t = (prop, value) => `    - target: {fileID: ${a.rootT}, guid: ${a.guid}, type: 3}\n      propertyPath: ${prop}\n      value: ${value}\n      objectReference: {fileID: 0}\n`;
  return [
    ['m_LocalPosition.x', x], ['m_LocalPosition.y', y], ['m_LocalPosition.z', z],
    ['m_LocalRotation.w', q.w], ['m_LocalRotation.x', q.x], ['m_LocalRotation.y', q.y], ['m_LocalRotation.z', q.z],
    ['m_LocalScale.x', s[0]], ['m_LocalScale.y', s[1]], ['m_LocalScale.z', s[2]],
    ['m_LocalEulerAnglesHint.x', placement.rotation[0]], ['m_LocalEulerAnglesHint.y', placement.rotation[1]], ['m_LocalEulerAnglesHint.z', placement.rotation[2]],
    ...(order === undefined ? [] : [['m_RootOrder', order]])
  ].map(([k, v]) => t(k, typeof v === 'number' ? fmt(v) : v)).join('');
}

function newId(used) {
  for (;;) {
    const id = String(1000000000 + Math.floor(Math.random() * 1100000000));
    if (!used.has(id) && !used.has(String(+id + 1))) return id;
  }
}

// The piece the scene's areas get for a placement (drawn from the assemblage's current prefab).
function piece(anchor, prefabName, instance, placement) {
  return { name: prefabName, path: `${anchor.name}/${prefabName}`, position: placement.position.map(v => round(v, 3)), rotation: placement.rotation.map(v => round(v, 2)), scale: (placement.scale || [1, 1, 1]).map(v => round(v, 3)), extra: '', placement: { instance } };
}

// Every area cut from the scene, its piece for the instance added, replaced or (null) removed.
function patchAreas(scene, instance, newPiece) {
  if (!fs.existsSync(AREAS)) return;
  for (const f of fs.readdirSync(AREAS).filter(n => n.endsWith('.json'))) {
    const file = path.join(AREAS, f);
    const area = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (area.source.scene !== scene || area.source.terrainOnly) continue;
    const i = area.pieces.findIndex(p => p.placement && p.placement.instance === instance);
    if (i >= 0 && newPiece) area.pieces[i] = newPiece;
    else if (i >= 0) area.pieces.splice(i, 1);
    else if (newPiece) area.pieces.push(newPiece);
    fs.writeFileSync(file, JSON.stringify(area, null, 1));
  }
}

// One line in Canopy Changes.md's running list of placements.
function log(text) {
  if (!fs.existsSync(CHANGES)) return;
  const head = '## Assemblage placements by Layout';
  let s = fs.readFileSync(CHANGES, 'utf8');
  if (!s.includes(head)) s = s.replace(/\n*$/, '\n\n') + `${head}\n\nWritten by Layout (tools/placements.js) as Ken places assemblages in an imported area: each a PrefabInstance of the assemblage's prefab under the scene's anchor. Undo: delete the instance (Layout's Delete, or in Unity).\n`;
  s = s.replace(/\n*$/, '\n') + `- ${new Date().toISOString().slice(0, 10)} ${text}\n`;
  fs.writeFileSync(CHANGES, s);
}

const where = p => p.position.map(v => round(v, 2)).join(' ');

function add(scene, prefabName, placement) {
  const file = sceneFile(scene);
  const text = fs.readFileSync(file, 'utf8');
  const { head, docs } = split(text);
  const anchor = anchorOf(docs), a = assemblage(prefabName);
  const used = new Set(docs.map(idOf));
  const instance = newId(used), stripped = String(+instance + 1);
  const at = docs.findIndex(d => idOf(d) === anchor.t);
  const children = /( {2}m_Children:\n)((?: {2}- \{fileID: -?\d+\}\n)*)/.exec(docs[at]);
  const order = children[2].split('\n').filter(Boolean).length;
  docs[at] = docs[at].replace(children[0], children[0] + `  - {fileID: ${stripped}}\n`);
  const nameMod = `    - target: {fileID: ${a.rootGo}, guid: ${a.guid}, type: 3}\n      propertyPath: m_Name\n      value: ${prefabName}\n      objectReference: {fileID: 0}\n`;
  docs.push(`--- !u!1001 &${instance}\nPrefabInstance:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Modification:\n    m_TransformParent: {fileID: ${anchor.t}}\n    m_Modifications:\n${mods(a, anchor, placement, order)}${nameMod}    m_RemovedComponents: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${a.guid}, type: 3}\n`);
  docs.push(`--- !u!4 &${stripped} stripped\nTransform:\n  m_CorrespondingSourceObject: {fileID: ${a.rootT}, guid: ${a.guid}, type: 3}\n  m_PrefabInstance: {fileID: ${instance}}\n  m_PrefabAsset: {fileID: 0}\n`);
  fs.writeFileSync(file, head + docs.join(''));
  const p = piece(anchor, prefabName, instance, placement);
  patchAreas(scene, instance, p);
  log(`${scene}: ${prefabName} placed at ${where(placement)} (PrefabInstance ${instance})`);
  return { instance, piece: p };
}

// The placement's instance doc, checked to be an assemblage's under the anchor.
function instanceAt(docs, instance, anchor) {
  const i = docs.findIndex(d => d.startsWith(`--- !u!1001 &${instance}\n`));
  if (i < 0) throw new Error(`no PrefabInstance ${instance}`);
  if (!docs[i].includes(`m_TransformParent: {fileID: ${anchor.t}}`)) throw new Error(`PrefabInstance ${instance} isn't under ${anchor.name}`);
  const g = /m_SourcePrefab: \{fileID: 100100000, guid: (\w+)/.exec(docs[i]);
  const e = g && U.index()[g[1]];
  if (!e || !/^Assets\/Assemblages\//.test(e.path)) throw new Error(`PrefabInstance ${instance} isn't an assemblage's`);
  return { i, prefabName: path.basename(e.path, '.prefab') };
}

function move(scene, instance, placement) {
  const file = sceneFile(scene);
  const { head, docs } = split(fs.readFileSync(file, 'utf8'));
  const anchor = anchorOf(docs);
  const { i, prefabName } = instanceAt(docs, instance, anchor);
  const a = assemblage(prefabName);
  // its root transform's placement modifications, written again (the rest kept)
  const transformMod = new RegExp(` {4}- target: \\{fileID: ${a.rootT}, guid: ${a.guid}, type: 3\\}\\n {6}propertyPath: m_Local(?:Position|Rotation|Scale|EulerAnglesHint)\\.[wxyz]\\n {6}value: [^\\n]*\\n {6}objectReference: \\{fileID: 0\\}\\n`, 'g');
  const kept = docs[i].replace(transformMod, '');
  docs[i] = kept.replace(/( {4}m_Modifications:\n)/, `$1${mods(a, anchor, placement)}`);
  fs.writeFileSync(file, head + docs.join(''));
  const p = piece(anchor, prefabName, instance, placement);
  patchAreas(scene, instance, p);
  log(`${scene}: ${prefabName} (PrefabInstance ${instance}) moved to ${where(placement)}`);
  return { instance, piece: p };
}

function remove(scene, instance) {
  const file = sceneFile(scene);
  const { head, docs } = split(fs.readFileSync(file, 'utf8'));
  const anchor = anchorOf(docs);
  const { prefabName } = instanceAt(docs, instance, anchor);
  // the instance, its stripped objects, and anything added to them (we add none; refuse if so)
  const stripped = docs.filter(d => / stripped\n/.test(d.split('\n')[0] + '\n') && d.includes(`m_PrefabInstance: {fileID: ${instance}}`)).map(idOf);
  const gone = new Set([instance, ...stripped]);
  for (const d of docs) {
    if (gone.has(idOf(d))) continue;
    const refs = [...d.matchAll(/\{fileID: (-?\d+)\}/g)].map(m => m[1]).filter(r => gone.has(r));
    const onlyChild = d.startsWith(`--- !u!4 &${anchor.t}\n`);
    if (refs.length && !onlyChild) throw new Error(`${prefabName} (${instance}) has something else attached in ${scene}; delete it in Unity`);
  }
  const kept = docs.filter(d => !gone.has(idOf(d))).map(d => (idOf(d) === anchor.t ? stripped.reduce((x, s) => x.replace(`  - {fileID: ${s}}\n`, ''), d) : d));
  fs.writeFileSync(file, head + kept.join(''));
  patchAreas(scene, instance, null);
  log(`${scene}: ${prefabName} (PrefabInstance ${instance}) deleted`);
}

module.exports = { add, move, remove };
