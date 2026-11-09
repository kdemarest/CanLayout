// Moves, copies and renames objects in Canopy's Unity scenes, keeping their place in the world
// (Claude, 2026-11-09: Ken, LumaFuseBox back from HawthornScene to OakScene, so Oak summons Luma,
// with the four clouds its lamps bring into place; a copy of Mushroom's MapleFuseBox as
// Hawthorn's summoner of Oak; Tangle's OakGate renamed for Hawthorn, which it now summons).
//
// A rules file:
//   { "moves": [{ "from": scene, "to": scene, "items": [{ "path", "into" }] }],
//     "copies": [{ "from", "to", "path", "into", "at"?: { "beside": path, "offset": [x, y, z] },
//                  "turn"?: degrees about Y, "names"?: { old: new }, "set"?: [{ "name", "prop", "value" }],
//                  "dropScripts"?: [script names] }],
//     "renames": [{ "scene", "path", "name", "uid"?: true }], "stages": [{ "scene", "path", "stage" }] }
// Paths are object names from a scene's root ("HawthornSceneAnchor/HawthornOutpost/LumaFuseBox").
// A move takes the object and everything under it, every fileID kept, into the other scene's
// object `into`, at the same world placement (its local placement worked out for its new parent,
// and the scenes' rises: tools/scene.js riseOf); nothing outside what moves may refer into it, nor
// it out (but to its parent). A copy gives what it copies new fileIDs (a stripped object's: its
// instance's XOR its source's, as Unity makes them), drops components of the named scripts (the
// lamps' UidHosts: a copy would share the source's saved uids; the game gives lamps theirs), and
// is placed at the same local placement under `into` or, with `at`, so that the object `beside`
// names (in the copy, by its path under the copied root) lands at that object's world place in the
// destination plus offset. Renames set an object's name (a game object's m_Name, an instance's
// m_Name override).
//
// Checks before anything is written: no reference in any scene to a document it no longer has
// (split-scene.js dangling), no fileID used twice, and every moved piece (U.scenePieces) at its
// old world placement.
//
//   node tools/move-object.js <rules.json> [--write]
// Without --write the scenes go to cache/move/; with it, into the Canopy working tree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./unity.js');
const Split = require('./split-scene.js');

const SCENES = path.join(U.REPO, 'Assets', 'Scenes');
const OUT = path.join(__dirname, '..', 'cache', 'move');
const MASK = (1n << 63n) - 1n;

const sceneFile = name => path.join(SCENES, name + '.unity');
// the unit at a path of names from a scene's root
function unitAt(scene, pathText) {
  const [first, ...rest] = pathText.split('/');
  const roots = [...scene.units.keys()].filter(k => !scene.units.get(k).parentUnit && scene.units.get(k).name === first);
  if (roots.length !== 1) throw new Error(`${pathText}: ${roots.length} roots named ${first}`);
  return rest.length ? Split.find(scene, roots[0], rest.join('/')) : roots[0];
}
function subtree(scene, key) {
  const out = new Set();
  const walk = k => { out.add(k); for (const c of scene.kidsOf.get(k) || []) walk(c); };
  walk(key);
  return out;
}
const idsOf = (scene, units) => new Set(scene.docs.filter(d => units.has(scene.unitOf.get(d.id))).map(d => d.id));
const localRefs = text => [...text.matchAll(/\{fileID: (-?\d+)\}/g)].map(m => m[1]).filter(r => r !== '0');
const textOf = scene => scene.header + scene.docs.map(d => d.text).join('');
// a transform document's text with its parent, place and turn set
function placeTransform(text, parentT, local) {
  return text
    .replace(/\n {2}m_Father: \{fileID: -?\d+\}/, `\n  m_Father: {fileID: ${parentT}}`)
    .replace(/\n {2}m_LocalPosition: \{[^}]*\}/, `\n  m_LocalPosition: ${Split.vec(local.pos)}`)
    .replace(/\n {2}m_LocalRotation: \{[^}]*\}/, `\n  m_LocalRotation: ${Split.vec(local.rot, 'xyzw')}`);
}
// a PrefabInstance's text with its parent, and its root's place and turn, set
function placeInstance(text, parentT, rootSource, local) {
  let out = text.replace(/\n {4}m_TransformParent: \{fileID: -?\d+\}/, `\n    m_TransformParent: {fileID: ${parentT}}`);
  for (const [k, v] of [...'xyz'].map(c => [`m_LocalPosition.${c}`, local.pos[c]]).concat([...'xyzw'].map(c => [`m_LocalRotation.${c}`, local.rot[c]]))) {
    const re = new RegExp(`(- target: \\{fileID: ${rootSource}, guid: [0-9a-f]+, type: 3\\}\\n\\s+propertyPath: ${k.replace('.', '\\.')}\\n\\s+value: )[^\\n]*`);
    if (!re.test(out)) throw new Error(`instance: no ${k} override of its root to set`);
    out = out.replace(re, `$1${Split.num(v)}`);
  }
  return out;
}
// adds or removes a transform id in a parent transform document's m_Children
function withChild(text, child, add) {
  if (add) {
    if (/\n {2}m_Children: \[\]/.test(text)) return text.replace(/\n {2}m_Children: \[\]/, `\n  m_Children:\n  - {fileID: ${child}}`);
    return text.replace(/(\n {2}m_Children:\n(?: {2}- \{fileID: -?\d+\}\n)*)/, `$1  - {fileID: ${child}}\n`);
  }
  const out = text.replace(new RegExp(`\\n {2}- \\{fileID: ${child}\\}(?=\\n)`), '');
  return /\n {2}m_Children:\n(?! {2}- )/.test(out) ? out.replace(/\n {2}m_Children:\n/, '\n  m_Children: []\n') : out;
}
const transformDoc = (scene, unitKey) => scene.byId.get(scene.units.get(unitKey).transform);
// sets a root's parent and local placement (a game object's transform, or an instance's overrides)
function place(scene, key, parentKey, local) {
  const u = scene.units.get(key), parentT = scene.units.get(parentKey).transform;
  if (u.kind === 'go') {
    const d = transformDoc(scene, key);
    d.text = placeTransform(d.text, parentT, local);
  } else {
    const d = scene.byId.get(u.id);
    d.text = placeInstance(d.text, parentT, u.rootSource, local);
  }
  // a parent that is a game object lists its children; one inside an instance doesn't
  if (scene.units.get(parentKey).kind === 'go') {
    const p = transformDoc(scene, parentKey);
    p.text = withChild(p.text, u.transform, true);
  }
}
function unparent(scene, key) {
  const u = scene.units.get(key);
  if (u.parentUnit && scene.units.get(u.parentUnit).kind === 'go') {
    const p = transformDoc(scene, u.parentUnit);
    p.text = withChild(p.text, u.transform, false);
  }
}
// a scene's lift as it rises (its anchor raised to its altitudeSpan max), from its imported area's
// source, if any, else 0
function lift(name) {
  const S = require('./scene.js');
  for (const f of fs.readdirSync(S.AREAS)) {
    if (!f.endsWith('.json')) continue;
    const a = JSON.parse(fs.readFileSync(path.join(S.AREAS, f), 'utf8'));
    if (a.source && a.source.scene === name && !a.source.terrainOnly) return a.source.risen || 0;
  }
  throw new Error(`${name}: no imported area to read its rise from (import one first)`);
}
const relativeWithScale = (p, w) => ({ ...Split.relative(p, w), scl: { x: w.scl.x / p.scl.x, y: w.scl.y / p.scl.x, z: w.scl.z / p.scl.x } });

function move(texts, rule) {
  const src = Split.readScene(texts[rule.from]), dst = Split.readScene(texts[rule.to]);
  const dy = lift(rule.from) - lift(rule.to);
  const dstIds = new Set(dst.docs.map(d => d.id));
  const moving = [];
  for (const item of rule.items) {
    const key = unitAt(src, item.path), ids = idsOf(src, subtree(src, key));
    for (const id of ids) if (dstIds.has(id)) throw new Error(`${item.path}: fileID ${id} is in ${rule.to} already`);
    const w = src.worldOf(key);
    moving.push({ item, key, ids, world: { ...w, pos: { ...w.pos, y: w.pos.y + dy } } });
  }
  // what moves, all of it together: nothing in it may refer to what stays (but each root to its old
  // parent, which it leaves), nor anything that stays into it (but a parent's list of its children)
  const all = new Set(moving.flatMap(m => [...m.ids]));
  const parents = new Set(moving.map(m => src.units.get(src.units.get(m.key).parentUnit).transform));
  const roots = new Set(moving.map(m => src.units.get(m.key).transform));
  for (const d of src.docs) {
    const mine = all.has(d.id);
    for (const r of localRefs(d.text)) {
      if (mine && !all.has(r) && src.byId.has(r) && !parents.has(r)) throw new Error(`${d.id} refers to ${r} (${(src.units.get(src.unitOf.get(r)) || {}).name}), which stays in ${rule.from}`);
      if (!mine && all.has(r) && !((d.cls === 4 || d.cls === 224) && roots.has(r))) throw new Error(`${d.id} (${(src.units.get(src.unitOf.get(d.id)) || {}).name}) in ${rule.from} refers to ${r}, which moves`);
    }
  }
  for (const m of moving) unparent(src, m.key);
  for (const m of moving) {
    const into = unitAt(dst, m.item.into);
    const docs = src.docs.filter(d => m.ids.has(d.id));
    dst.docs.push(...docs);
    for (const d of docs) dst.byId.set(d.id, d);
    // the moved units in dst's tree, for place()
    for (const k of subtree(src, m.key)) dst.units.set(k, { ...src.units.get(k), parentUnit: k === m.key ? into : src.units.get(k).parentUnit });
    place(dst, m.key, into, relativeWithScale(dst.worldOf(into), m.world));
  }
  src.docs = src.docs.filter(d => !moving.some(m => m.ids.has(d.id)));
  texts[rule.from] = textOf(src);
  texts[rule.to] = textOf(dst);
  return moving.map(m => ({ path: m.item.path, into: `${rule.to}: ${m.item.into}`, world: m.world }));
}

// Canopy's uid from a name (UidGenerator.FromString: its last 11 characters, base 64), as a Gate's
// (alwaysSetUidToName) is
const UID_CHARS = '_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$';
function uidOfName(name) {
  let r = 0n;
  for (let i = 0, j = name.length - 1; i < 11; i++, j--) {
    const k = j >= 0 ? UID_CHARS.indexOf(name[j]) : 0;
    if (k < 0) throw new Error(`${name}: ${name[j]} can't be in a uid`);
    r |= BigInt(k) << BigInt(6 * i);
  }
  return BigInt.asIntN(64, r).toString();
}
// the UidHost documents on a unit's own object (a game object's, or an instance's root's)
function uidHostsOf(docs, unit, idOf = x => x) {
  const g = U.scriptGuid('UidHost');
  const own = unit.kind === 'go' ? new Set([idOf(unit.id)]) : new Set(docs.filter(d => d.stripped && d.cls === 1 && Split.ref(d.text, 'm_PrefabInstance') === idOf(unit.id) && (/m_CorrespondingSourceObject: \{fileID: (-?\d+)/.exec(d.text) || [])[1] === unit.sub.rootGoId).map(d => d.id));
  return docs.filter(d => d.cls === 114 && d.text.includes(g) && own.has(Split.ref(d.text, 'm_GameObject')));
}
const setUid = (d, name) => { d.text = d.text.replace(/(\n {4}uidLong: )-?\d+/, `$1${uidOfName(name)}`); };
function freshId(taken) {
  for (;;) {
    const v = BigInt('0x' + crypto.randomBytes(8).toString('hex')) & MASK;
    const s = v.toString();
    if (v > 1000000n && !taken.has(s)) { taken.add(s); return s; }
  }
}
function copy(texts, rule) {
  const src = Split.readScene(texts[rule.from]), dst = Split.readScene(texts[rule.to]);
  const key = unitAt(src, rule.path), units = subtree(src, key), ids = idsOf(src, units);
  const parentT = src.units.get(src.units.get(key).parentUnit).transform;
  for (const d of src.docs) if (ids.has(d.id)) for (const r of localRefs(d.text)) if (!ids.has(r) && src.byId.has(r) && r !== parentT) throw new Error(`${rule.path}: refers to ${r} (${(src.units.get(src.unitOf.get(r)) || {}).name}), outside the copy`);
  // uids: { name: true }, the copied objects (by their names in the copy) keeping their UidHost, its
  // uid that of the name (a Gate's); the rest of the dropped scripts go
  const keep = new Map(); // UidHost doc id -> the name its uid is made from
  for (const [name] of Object.entries(rule.uids || {})) {
    const old = Object.entries(rule.names || {}).find(([, to]) => to === name);
    const unitKey = [...units].find(k => src.units.get(k).name === (old ? old[0] : name));
    if (!unitKey) throw new Error(`copy: no object named ${name} for its uid`);
    const hosts = uidHostsOf(src.docs, src.units.get(unitKey));
    if (hosts.length !== 1) throw new Error(`copy: ${name} has ${hosts.length} UidHosts`);
    keep.set(hosts[0].id, name);
  }
  const drop = new Set((rule.dropScripts || []).map(n => U.scriptGuid(n)));
  const dropped = new Set(src.docs.filter(d => ids.has(d.id) && d.cls === 114 && !keep.has(d.id) && drop.has((/m_Script: \{fileID: \d+, guid: ([0-9a-f]+)/.exec(d.text) || [])[1])).map(d => d.id));
  const taken = new Set([...dst.docs.map(d => d.id), ...src.docs.map(d => d.id)]);
  const map = new Map();
  for (const d of src.docs) if (ids.has(d.id) && !d.stripped) map.set(d.id, freshId(taken));
  for (const d of src.docs) {
    if (!ids.has(d.id) || !d.stripped) continue;
    const inst = Split.ref(d.text, 'm_PrefabInstance'), source = (/m_CorrespondingSourceObject: \{fileID: (-?\d+)/.exec(d.text) || [])[1];
    const id = ((BigInt(map.get(inst)) ^ BigInt(source)) & MASK).toString();
    if (taken.has(id)) throw new Error(`copy: the stripped id ${id} is taken`);
    taken.add(id);
    map.set(d.id, id);
  }
  const remap = text => text.replace(/^(--- !u!\d+ &)(-?\d+)/, (m, a, id) => a + (map.get(id) || id)).replace(/\{fileID: (-?\d+)\}/g, (m, id) => `{fileID: ${map.get(id) || id}}`);
  let docs = src.docs.filter(d => ids.has(d.id) && !dropped.has(d.id)).map(d => ({ ...d, id: map.get(d.id), text: remap(d.text) }));
  for (const [oldId, name] of keep) setUid(docs.find(d => d.id === map.get(oldId)), name);
  // a dropped component leaves its game object's list
  for (const id of dropped) docs = docs.map(d => ({ ...d, text: d.text.replace(new RegExp(`\\n {2}- component: \\{fileID: ${map.get(id)}\\}(?=\\n)`), '') }));
  // names
  for (const [from, to] of Object.entries(rule.names || {})) {
    let hits = 0;
    docs = docs.map(d => {
      const t = d.text.replace(new RegExp(`(\\n {2}m_Name: )${from}(?=\\n)`), (m, a) => { hits++; return a + to; })
        .replace(new RegExp(`(propertyPath: m_Name\\n\\s+value: )${from}(?=\\n)`), (m, a) => { hits++; return a + to; });
      return { ...d, text: t };
    });
    if (!hits) throw new Error(`copy: no object named ${from} to rename`);
  }
  // settings: an instance's override (by the instance's name) of prop
  for (const s of rule.set || []) {
    const inst = docs.find(d => d.cls === 1001 && new RegExp(`propertyPath: m_Name\\n\\s+value: ${s.name}\\n`).test(d.text));
    if (!inst) throw new Error(`copy: no instance named ${s.name} to set ${s.prop} on`);
    const re = new RegExp(`(propertyPath: ${s.prop.replace(/\./g, '\\.')}\\n\\s+value: )[^\\n]*`);
    if (!re.test(inst.text)) throw new Error(`copy: ${s.name} has no ${s.prop} override to set`);
    inst.text = inst.text.replace(re, `$1${s.value}`);
  }
  // into the destination, read again with the copy in it, then placed
  const into = unitAt(dst, rule.into);
  const root = src.units.get(key);
  const newRoot = root.kind === 'go' ? map.get(root.id) : 'pi' + map.get(root.id);
  dst.docs.push(...docs);
  let scene = Split.readScene(textOf(dst));
  let local = { ...root.local };
  if (rule.at) {
    const beside = scene.worldOf(unitAt(scene, rule.at.beside));
    // where the copied object at rule.at.under (by its path under the copied root) is, relative to that root
    const inner = Split.find(scene, newRoot, rule.at.under);
    const r = scene.worldOf(newRoot), i = scene.worldOf(inner);
    const want = { x: beside.pos.x + rule.at.offset[0] - (i.pos.x - r.pos.x), y: beside.pos.y + rule.at.offset[1] - (i.pos.y - r.pos.y), z: beside.pos.z + rule.at.offset[2] - (i.pos.z - r.pos.z) };
    local = relativeWithScale(scene.worldOf(into), { pos: want, rot: r.rot, scl: r.scl });
  }
  scene.units.set(newRoot, { ...scene.units.get(newRoot), parentUnit: into });
  place(scene, newRoot, into, local);
  texts[rule.to] = textOf(scene);
  return { path: rule.path, into: `${rule.to}: ${rule.into}`, docs: docs.length, dropped: dropped.size };
}

// stages: [{ scene, path, stage }]: every stage filter (FilterOnStage, FilterOnPopulate,
// FilterWithStageData) on the object and under it set to the stage, by its name (a summoner moved
// or copied to another stage's scene keeps its old stage's filter)
function setStage(texts, rule) {
  const C = require('./conditions.js'), ids = C.stageIds();
  if (!(rule.stage in ids)) throw new Error(`${rule.stage}: no such stage (StageId.cs)`);
  const scene = Split.readScene(texts[rule.scene]);
  const units = subtree(scene, unitAt(scene, rule.path));
  const filters = new Set(['FilterOnStage', 'FilterOnPopulate', 'FilterWithStageData'].map(n => U.scriptGuid(n)).filter(Boolean));
  let n = 0;
  for (const d of scene.docs) {
    if (d.cls !== 114 || !units.has(scene.unitOf.get(d.id)) || !filters.has((/m_Script: \{fileID: \d+, guid: ([0-9a-f]+)/.exec(d.text) || [])[1])) continue;
    if (!/\n {2}stageId: \d+/.test(d.text)) throw new Error(`${rule.path}: a stage filter (${d.id}) without a stageId`);
    d.text = d.text.replace(/(\n {2}stageId: )\d+/, `$1${ids[rule.stage]}`);
    n++;
  }
  if (!n) throw new Error(`${rule.path}: no stage filter to set`);
  texts[rule.scene] = textOf(scene);
  return { path: rule.path, stage: rule.stage, filters: n };
}
function rename(texts, rule) {
  const scene = Split.readScene(texts[rule.scene]);
  const key = unitAt(scene, rule.path), u = scene.units.get(key), old = u.name;
  const d = u.kind === 'go' ? scene.byId.get(u.id) : scene.byId.get(u.id);
  const re = u.kind === 'go' ? new RegExp(`(\\n {2}m_Name: )${old}(?=\\n)`) : new RegExp(`(propertyPath: m_Name\\n\\s+value: )${old}(?=\\n)`);
  if (!re.test(d.text)) throw new Error(`${rule.path}: its name isn't where it should be`);
  d.text = d.text.replace(re, `$1${rule.name}`);
  // uid: its UidHost's uid made from the new name (a Gate's: alwaysSetUidToName)
  if (rule.uid) {
    const hosts = uidHostsOf(scene.docs, u);
    if (hosts.length !== 1) throw new Error(`${rule.path}: ${hosts.length} UidHosts`);
    setUid(hosts[0], rule.name);
  }
  texts[rule.scene] = textOf(scene);
  return { path: rule.path, name: rule.name };
}

function main() {
  const [rulesFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!rulesFile) throw new Error('usage: node tools/move-object.js <rules.json> [--write]');
  const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
  const names = new Set([...(rules.moves || []).flatMap(r => [r.from, r.to]), ...(rules.copies || []).flatMap(r => [r.from, r.to]), ...(rules.renames || []).map(r => r.scene), ...(rules.stages || []).map(r => r.scene)]);
  const texts = {}, before = {};
  for (const n of names) texts[n] = before[n] = fs.readFileSync(sceneFile(n), 'utf8');
  const report = [];
  for (const r of rules.moves || []) report.push(...move(texts, r).map(m => `moved ${m.path} into ${m.into}`));
  for (const r of rules.copies || []) { const c = copy(texts, r); report.push(`copied ${c.path} into ${c.into}: ${c.docs} documents, ${c.dropped} components dropped`); }
  for (const r of rules.renames || []) { const c = rename(texts, r); report.push(`renamed ${c.path} to ${c.name}`); }
  for (const r of rules.stages || []) { const c = setStage(texts, r); report.push(`${c.path}: ${c.filters} stage filter(s) set to ${c.stage}`); }
  // checks
  fs.mkdirSync(OUT, { recursive: true });
  for (const n of names) {
    const bad = Split.dangling(texts[n]);
    if (bad.length) throw new Error(`${n}: refers to documents it doesn't have: ${bad.slice(0, 5).join(', ')}`);
    const ids = Split.documents(texts[n]).docs.map(d => d.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${n}: a fileID used twice`);
    fs.writeFileSync(path.join(OUT, n + '.unity'), texts[n]);
  }
  for (const r of rules.moves || []) {
    const was = U.scenePieces(sceneFile(r.from)), now = U.scenePieces(path.join(OUT, r.to + '.unity'));
    const dy = lift(r.from) - lift(r.to);
    for (const item of r.items) {
      const leaf = item.path.split('/').pop();
      const old = was.filter(p => p.path.includes('/' + leaf + '/') || p.path.endsWith('/' + leaf));
      for (const p of old) {
        const tail = p.path.slice(p.path.indexOf('/' + leaf));
        const twin = now.find(q => q.path.endsWith(tail) && Math.hypot(q.pos.x - p.pos.x, q.pos.y - (p.pos.y + dy), q.pos.z - p.pos.z) < 1e-3);
        if (!twin) throw new Error(`${item.path}: ${p.path} isn't where it was in ${r.to}`);
      }
      report.push(`  ${old.length} pieces of ${leaf} where they were`);
    }
  }
  console.log(report.join('\n'));
  if (process.argv.includes('--write')) {
    for (const n of names) if (texts[n] !== before[n]) fs.writeFileSync(sceneFile(n), texts[n]);
    console.log(`written: ${[...names].filter(n => texts[n] !== before[n]).join(', ')}`);
  } else console.log(`(dry run: the scenes are in ${path.relative(process.cwd(), OUT)}; --write puts them into Canopy)`);
}

if (require.main === module) main();
module.exports = { move, copy, rename, uidOfName };
