// Splits a Unity scene in two by its anchor's groups (Claude, 2026-11-02: Hawthorn out of
// OakScene, Ken: "a clean split"). A rules file names the scene, its anchor (the root object
// whose children are the groups), the new scene and its anchor's name, the groups that go to the
// new scene, and the pieces that cross the line: each moved, with everything under it, into a
// group on the other side, its world placement kept (its local position and rotation recomputed
// for its new parent). Groups a rule names under `create` are made, empty, where they are wanted;
// one with `from` and `to` (world points) is made at `to`, and what moves into it keeps its place
// relative to `from`: moved by to - from, unturned (Claude, 2026-11-03: Black Isle, out of Oak's top
// to where Ken probed). `componentsOf` (a path under the anchor, or { path, scripts: [names] })
// gives a made group copies of that object's scripts (all, or those), e.g. WhiteOak's
// FilterOnPopulate or BeechBiome's StageFilter, so what moves out from under it keeps its stage.
// `tracker` ({ name, linkToName }) gives the new scene the root every game scene has beside its
// anchor: a ChunkTracker naming the Region its chunk belongs to (Chunk.GetRegion; ChunkTracker
// allows a scene that and one anchor), first among its roots. `bareAnchor` keeps only the new
// anchor's transform (Game.unity's anchor, World, has a World script, one in the game).
// Both scenes keep the scene's settings (occlusion, render, lightmap and navmesh documents);
// everything else is in exactly one. Every object keeps its fileID (ids are per file), so
// nothing inside either half changes.
//
// Checks, before anything is written: no reference in either file to an object left in the other,
// and every piece (U.scenePieces) in the two halves is one of the original's, with the same world
// placement (moved by to - from in a placed group), activity and game conditions (Cond), and none
// is lost.
//
//   node tools/split-scene.js <rules.json> [--from <scene file>] [--write]
// Without --write the two scenes go to cache/split/; with it, into the Canopy working tree
// (logged in docs/Canopy Changes.md). --from reads the scene to split from a file instead of
// Canopy (a copy taken before an earlier --write, so a split can be redone).
const fs = require('fs');
const path = require('path');
const U = require('./unity.js');

const ROOT = path.join(__dirname, '..');
const SETTINGS = new Set([29, 104, 157, 196, 850595691]); // OcclusionCullingSettings, RenderSettings, LightmapSettings, NavMeshSettings, LightingSettings (Game.unity's)

// ---------- documents ----------
function documents(text) {
  const chunks = text.split(/^--- /m);
  const docs = [];
  for (const chunk of chunks.slice(1)) {
    const m = /^!u!(\d+) &(-?\d+)( stripped)?\n/.exec(chunk);
    if (!m) throw new Error('unreadable document: ' + chunk.slice(0, 60));
    docs.push({ cls: +m[1], id: m[2], stripped: Boolean(m[3]), text: '--- ' + chunk });
  }
  return { header: chunks[0], docs };
}
const ref = (text, key) => (new RegExp(`\\n {2}${key}: \\{fileID: (-?\\d+)`).exec(text) || [])[1] || null;

// ---------- placement math (Unity: world = parent position + parent rotation * (parent scale * local)) ----------
const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
});
const conj = q => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });
const rotate = (q, v) => { const r = qmul(qmul(q, { w: 0, ...v }), conj(q)); return { x: r.x, y: r.y, z: r.z }; };
const compose = (p, local) => {
  const s = { x: local.pos.x * p.scl.x, y: local.pos.y * p.scl.y, z: local.pos.z * p.scl.z };
  const r = rotate(p.rot, s);
  return { pos: { x: p.pos.x + r.x, y: p.pos.y + r.y, z: p.pos.z + r.z }, rot: qmul(p.rot, local.rot), scl: { x: p.scl.x * local.scl.x, y: p.scl.y * local.scl.y, z: p.scl.z * local.scl.z } };
};
// local placement under p of something placed at world w (p's scale must be uniform)
const relative = (p, w) => {
  if (Math.abs(p.scl.x - p.scl.y) > 1e-6 || Math.abs(p.scl.x - p.scl.z) > 1e-6) throw new Error('new parent is not uniformly scaled');
  const d = rotate(conj(p.rot), { x: w.pos.x - p.pos.x, y: w.pos.y - p.pos.y, z: w.pos.z - p.pos.z });
  return { pos: { x: d.x / p.scl.x, y: d.y / p.scl.x, z: d.z / p.scl.x }, rot: qmul(conj(p.rot), w.rot) };
};
const num = v => { const r = +v.toPrecision(8); return Object.is(r, -0) ? 0 : r; };
const vec = (v, keys = 'xyz') => `{${[...keys].map(k => `${k}: ${num(v[k])}`).join(', ')}}`;

// ---------- the scene's tree ----------
function readScene(text) {
  const { header, docs } = documents(text);
  const byId = new Map(docs.map(d => [d.id, d]));
  const f = U.parse(text);
  // a unit is what moves as one: a game object (with its components) or a prefab instance
  const unitOfTransform = id => (f.strippedT[id] ? 'pi' + f.strippedT[id] : f.t[id] ? f.t[id].go : null);
  const units = new Map(); // unit -> { name, transform, parent (a transform id or '0'), children: [transform ids], local }
  for (const [id, t] of Object.entries(f.t)) {
    const g = f.go[t.go];
    units.set(t.go, { kind: 'go', id: t.go, name: g ? g.name : '?', transform: id, parent: t.father || '0', local: { pos: t.pos, rot: t.rot, scl: t.scl } });
  }
  for (const [id, x] of Object.entries(f.inst)) {
    const sub = x.src ? U.prefab(x.src, 1) || U.modelInstance(x.src, x.mods) : null;
    if (!sub || !sub.rootId) throw new Error(`prefab instance ${id}: its prefab or model (${x.src}) can't be read`);
    const local = { pos: { ...sub.rootTrs.pos }, rot: { ...sub.rootTrs.rot }, scl: { ...sub.rootTrs.scl } };
    let name = sub.name;
    for (const m of x.mods) {
      const k = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(m.path);
      if (k && m.target === sub.rootId) local[k[1] === 'Position' ? 'pos' : k[1] === 'Rotation' ? 'rot' : 'scl'][k[2]] = parseFloat(m.value);
      if (m.path === 'm_Name' && m.target === sub.rootGoId) name = m.value;
    }
    // its root transform here: the stripped transform standing for the prefab's root
    const root = docs.find(d => d.stripped && (d.cls === 4 || d.cls === 224) && ref(d.text, 'm_PrefabInstance') === id && ref(d.text, 'm_CorrespondingSourceObject') === sub.rootId);
    units.set('pi' + id, { kind: 'pi', id, name, transform: root ? root.id : U.xorId(id, sub.rootId), rootSource: sub.rootId, parent: x.parent || '0', local, sub });
  }
  // which unit each document belongs to
  const unitOf = new Map();
  for (const d of docs) {
    if (SETTINGS.has(d.cls)) continue;
    if (d.cls === 21 || d.cls === 43) continue; // a material or mesh saved in the scene: goes where it is used
    let u;
    if (d.cls === 1001) u = 'pi' + d.id;
    else if (d.stripped) u = 'pi' + ref(d.text, 'm_PrefabInstance');
    else if (d.cls === 1) u = d.id;
    else {
      const go = ref(d.text, 'm_GameObject');
      u = f.strippedGo[go] ? 'pi' + f.strippedGo[go] : go;
    }
    if (!u || !units.has(u)) throw new Error(`document ${d.id} (class ${d.cls}) belongs to no object`);
    unitOf.set(d.id, u);
  }
  for (const u of units.values()) {
    u.parentUnit = u.parent === '0' ? null : unitOfTransform(u.parent);
    // parented to an object inside a prefab instance, not its root: that object's placement in the
    // instance (Claude, 2026-11-03: Thrusters hang from an object inside RuinShaman)
    const inst = f.strippedT[u.parent], sub = inst && units.get('pi' + inst) && units.get('pi' + inst).sub;
    const srcT = sub && U.xorId(u.parent, inst);
    const o = srcT && srcT !== sub.rootId && sub.objectOfT && sub.objects && sub.objects[sub.objectOfT[srcT]];
    if (o) { const d = U.decompose(o.m); u.inner = { pos: d.pos, rot: d.rot, scl: d.scl }; }
  }
  const world = new Map();
  const worldOf = key => {
    if (world.has(key)) return world.get(key);
    const u = units.get(key);
    const p = u.parentUnit && (u.inner ? compose(worldOf(u.parentUnit), u.inner) : worldOf(u.parentUnit));
    const w = p ? compose(p, u.local) : u.local;
    world.set(key, w);
    return w;
  };
  const children = new Map(); // transform id -> its children's transform ids, in order
  for (const d of docs) {
    if ((d.cls === 4 || d.cls === 224) && !d.stripped) {
      const list = (d.text.split('\n  m_Children:')[1] || '').split('\n  m_Father:')[0];
      children.set(d.id, [...list.matchAll(/- \{fileID: (-?\d+)\}/g)].map(m => m[1]));
    }
  }
  // each unit's children, from their parents (objects added under a prefab instance are in no
  // m_Children list)
  const kidsOf = new Map();
  for (const [k, u] of units) if (u.parentUnit) (kidsOf.get(u.parentUnit) || kidsOf.set(u.parentUnit, []).get(u.parentUnit)).push(k);
  return { header, docs, byId, units, unitOf, unitOfTransform, worldOf, children, kidsOf };
}

// the unit at a path of names below a unit ("Hawthorn/AirFruitLoci/FruitLocus"); `near` [x, z]
// picks among several of one name the one nearest that point
function find(scene, from, pathText, near) {
  let at = [from];
  for (const name of pathText.split('/')) {
    at = at.flatMap(k => (scene.kidsOf.get(k) || []).filter(c => scene.units.get(c).name === name));
  }
  if (at.length > 1 && near) {
    const d = k => { const w = scene.worldOf(k).pos; return Math.hypot(w.x - near[0], w.z - near[1]); };
    at.sort((a, b) => d(a) - d(b));
    if (d(at[0]) > 1) throw new Error(`${pathText}: none within a meter of ${near}`);
    at = [at[0]];
  }
  if (at.length !== 1) throw new Error(`${pathText}: ${at.length ? at.length + ' objects of that name (give near: [x, z])' : 'not found'}`);
  return at[0];
}

// ---------- the split ----------
function split(text, rules) {
  const scene = readScene(text);
  const roots = [...scene.units.values()].filter(u => !u.parentUnit);
  const anchor = roots.find(u => u.kind === 'go' && u.name === rules.anchor);
  if (!anchor) throw new Error(`no root object ${rules.anchor}`);
  const anchorKey = anchor.id;
  const side = new Map(); // unit -> 'old' | 'new'
  const groupNames = new Set(rules.groups);
  for (const t of scene.children.get(anchor.transform)) {
    const k = scene.unitOfTransform(t);
    side.set(k, groupNames.has(scene.units.get(k).name) ? 'new' : 'old');
    groupNames.delete(scene.units.get(k).name);
  }
  if (groupNames.size) throw new Error(`no group ${[...groupNames].join(', ')} under ${rules.anchor}`);
  for (const r of roots) if (r.id !== anchorKey) side.set(r.kind === 'pi' ? 'pi' + r.id : r.id, (rules.newRoots || []).includes(r.name) ? 'new' : 'old');
  // new groups: plain empty objects at their parent's origin
  let nextId = 1000000001;
  const used = new Set(scene.docs.map(d => d.id));
  const freshId = () => { while (used.has(String(nextId))) nextId++; used.add(String(nextId)); return String(nextId); };
  const created = []; // { side, go, transform, name, parent (unit) }
  // every unit's side: its nearest ancestor (or itself) with one
  const sideOf = k => { for (let x = k; x; x = scene.units.get(x).parentUnit) if (side.has(x) && x !== anchorKey) return side.get(x); return null; };
  // a group on a side: one there already, or one the rules create
  const groupAt = (where, p) => {
    const c = (rules.create || []).find(x => x.path === p && x.side === where);
    if (!c) {
      const k = find(scene, anchorKey, p);
      if (sideOf(k) !== where) throw new Error(`${p} is not in ${where === 'new' ? rules.newScene : rules.scene}`);
      return k;
    }
    const parentPath = p.split('/').slice(0, -1).join('/');
    const parent = parentPath ? groupAt(where, parentPath) : anchorKey;
    const key = 'new:' + p;
    if (!scene.units.has(key)) {
      const g = { kind: 'created', id: freshId(), name: p.split('/').pop(), parentUnit: parent, local: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } } };
      if (c.to) {
        // placed: at `to`; what moves in keeps its place relative to `from`
        const at = v => ({ pos: { x: v[0], y: v[1], z: v[2] }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } });
        if (!c.from) throw new Error(`${p}: to without from`);
        g.local = { ...relative(scene.worldOf(parent), at(c.to)), scl: { x: 1, y: 1, z: 1 } };
        g.frame = at(c.from);
        g.offset = { x: c.to[0] - c.from[0], y: c.to[1] - c.from[1], z: c.to[2] - c.from[2] };
      }
      if (c.componentsOf) {
        const of = typeof c.componentsOf === 'string' ? { path: c.componentsOf } : c.componentsOf;
        const like = find(scene, anchorKey, of.path);
        if (scene.units.get(like).kind !== 'go') throw new Error(`${of.path}: a prefab instance; its scripts aren't in the scene`);
        const wanted = d => !of.scripts || of.scripts.includes(U.scriptName((/m_Script: \{fileID: \d+, guid: ([0-9a-f]+)/.exec(d.text) || [])[1]));
        g.components = scene.docs.filter(d => d.cls === 114 && !d.stripped && scene.unitOf.get(d.id) === like && wanted(d))
          .map(d => ({ id: freshId(), text: d.text.replace(/^--- !u!114 &-?\d+/, '').replace(/\n {2}m_GameObject: \{fileID: -?\d+\}/, `\n  m_GameObject: {fileID: ${g.id}}`) }));
      }
      g.transform = freshId();
      scene.units.set(key, g);
      scene.children.set(g.transform, []);
      side.set(key, where);
      created.push(key);
    }
    return key;
  };
  // moves: each into a group of the other side
  const moves = [];
  for (const [where, list] of [['new', rules.toNew || []], ['old', rules.toOld || []]]) {
    for (const m of list) {
      const k = find(scene, anchorKey, m.path, m.near);
      const to = groupAt(where, m.into);
      moves.push({ key: k, to, where, path: m.path });
      side.set(k, where);
    }
  }
  const movedTo = new Map(moves.map(m => [m.key, m]));
  const tracker = rules.tracker ? { go: freshId(), transform: freshId(), script: freshId(), ...rules.tracker } : null;
  const trackerGuid = tracker && U.scriptGuid('ChunkTracker');
  if (tracker && !trackerGuid) throw new Error('no ChunkTracker script');
  // each half
  const half = which => {
    const kept = new Set(scene.docs.filter(d => SETTINGS.has(d.cls) || (scene.unitOf.get(d.id) === anchorKey) || (scene.unitOf.has(d.id) && sideOf(scene.unitOf.get(d.id)) === which)).map(d => d.id));
    // materials and meshes saved in the scene, in each half that uses them
    for (const d of scene.docs) {
      if (scene.unitOf.has(d.id) || SETTINGS.has(d.cls)) continue;
      const used = scene.docs.some(x => kept.has(x.id) && x.text.includes(`{fileID: ${d.id}}`));
      if (used) kept.add(d.id);
    }
    const keep = d => kept.has(d.id);
    // children lists: what stays, then what moves in
    const kids = new Map();
    for (const [t, list] of scene.children) {
      const owner = [...scene.units.entries()].find(([, u]) => u.transform === t);
      if (!owner) continue;
      const [ok] = owner;
      if (ok !== anchorKey && sideOf(ok) !== which) continue;
      kids.set(t, list.filter(c => { const k = scene.unitOfTransform(c); return sideOf(k) === which && !(movedTo.has(k) && movedTo.get(k).to !== ok); }));
    }
    for (const k of created) if (side.get(k) === which) kids.get(scene.units.get(scene.units.get(k).parentUnit).transform).push(scene.units.get(k).transform);
    for (const m of moves) if (m.where === which) kids.get(scene.units.get(m.to).transform).push(scene.units.get(m.key).transform);
    const order = new Map();
    for (const list of kids.values()) list.forEach((t, i) => order.set(t, i));
    const parentOf = new Map();
    for (const [t, list] of kids) for (const c of list) parentOf.set(c, t);
    const out = [];
    for (const d of scene.docs) {
      if (!keep(d)) continue;
      let text = d.text;
      const k = scene.unitOf.get(d.id);
      const u = k && scene.units.get(k);
      const move = movedTo.get(k);
      const local = move && move.where === which ? relative(scene.units.get(move.to).frame || scene.worldOf(move.to), scene.worldOf(k)) : null;
      if ((d.cls === 4 || d.cls === 224) && !d.stripped) {
        if (kids.has(d.id)) text = text.replace(/\n {2}m_Children:[\s\S]*?\n {2}m_Father:/, '\n  m_Children:' + (kids.get(d.id).length ? kids.get(d.id).map(c => `\n  - {fileID: ${c}}`).join('') : ' []') + '\n  m_Father:');
        if (parentOf.has(d.id)) text = text.replace(/\n {2}m_Father: \{fileID: -?\d+\}/, `\n  m_Father: {fileID: ${parentOf.get(d.id)}}`).replace(/\n {2}m_RootOrder: \d+/, `\n  m_RootOrder: ${order.get(d.id)}`);
        if (local && u.kind === 'go') {
          const e = U.quatToEuler(local.rot);
          text = text.replace(/\n {2}m_LocalRotation: \{[^}]*\}/, `\n  m_LocalRotation: ${vec(local.rot, 'xyzw')}`)
            .replace(/\n {2}m_LocalPosition: \{[^}]*\}/, `\n  m_LocalPosition: ${vec(local.pos)}`)
            .replace(/\n {2}m_LocalEulerAnglesHint: \{[^}]*\}/, `\n  m_LocalEulerAnglesHint: ${vec(e)}`);
        }
      }
      if (k === anchorKey && which === 'new') {
        if (rules.bareAnchor && d.cls !== 1 && d.cls !== 4) continue;
        if (d.cls === 1 && !d.stripped) {
          text = text.replace(/\n {2}m_Name: .*/, `\n  m_Name: ${rules.newAnchor}`);
          if (rules.bareAnchor) text = text.replace(/\n {2}m_Component:\n(?: {2}- component: \{fileID: -?\d+\}\n)+/, m => m.split('\n').slice(0, 3).join('\n') + '\n');
        }
        if (d.cls === 4 && tracker) text = text.replace(/\n {2}m_RootOrder: \d+/, '\n  m_RootOrder: 1');
      }
      if (d.cls === 1001 && u) {
        const t = u.transform;
        if (parentOf.has(t)) {
          text = text.replace(/\n {4}m_TransformParent: \{fileID: -?\d+\}/, `\n    m_TransformParent: {fileID: ${parentOf.get(t)}}`);
          text = setMod(text, u.rootSource, 'm_RootOrder', order.get(t), false);
        }
        if (local) {
          const e = U.quatToEuler(local.rot);
          for (const a of 'xyz') text = setMod(text, u.rootSource, 'm_LocalPosition.' + a, num(local.pos[a]), true);
          for (const a of 'wxyz') text = setMod(text, u.rootSource, 'm_LocalRotation.' + a, num(local.rot[a]), true);
          for (const a of 'xyz') text = setMod(text, u.rootSource, 'm_LocalEulerAnglesHint.' + a, num(e[a]), false);
        }
      }
      out.push(text);
    }
    for (const k of created) {
      if (side.get(k) !== which) continue;
      const g = scene.units.get(k);
      const t = g.transform;
      out.push(`--- !u!1 &${g.id}\nGameObject:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  serializedVersion: 6\n  m_Component:\n  - component: {fileID: ${t}}\n${(g.components || []).map(c => `  - component: {fileID: ${c.id}}\n`).join('')}  m_Layer: 0\n  m_Name: ${g.name}\n  m_TagString: Untagged\n  m_Icon: {fileID: 0}\n  m_NavMeshLayer: 0\n  m_StaticEditorFlags: 0\n  m_IsActive: 1\n`);
      out.push(`--- !u!4 &${t}\nTransform:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_GameObject: {fileID: ${g.id}}\n  m_LocalRotation: ${vec(g.local.rot, 'xyzw')}\n  m_LocalPosition: ${vec(g.local.pos)}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_ConstrainProportionsScale: 0\n  m_Children:${kids.get(t).length ? kids.get(t).map(c => `\n  - {fileID: ${c}}`).join('') : ' []'}\n  m_Father: {fileID: ${parentOf.get(t)}}\n  m_RootOrder: ${order.get(t)}\n  m_LocalEulerAnglesHint: ${vec(U.quatToEuler(g.local.rot))}\n`);
      for (const c of g.components || []) out.push(`--- !u!114 &${c.id}${c.text}`);
    }
    if (tracker && which === 'new') {
      out.push(`--- !u!1 &${tracker.go}\nGameObject:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  serializedVersion: 6\n  m_Component:\n  - component: {fileID: ${tracker.transform}}\n  - component: {fileID: ${tracker.script}}\n  m_Layer: 0\n  m_Name: ${tracker.name}\n  m_TagString: Untagged\n  m_Icon: {fileID: 0}\n  m_NavMeshLayer: 0\n  m_StaticEditorFlags: 0\n  m_IsActive: 1\n`);
      out.push(`--- !u!4 &${tracker.transform}\nTransform:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_GameObject: {fileID: ${tracker.go}}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: {x: 0, y: 0, z: 0}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_ConstrainProportionsScale: 0\n  m_Children: []\n  m_Father: {fileID: 0}\n  m_RootOrder: 0\n  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}\n`);
      out.push(`--- !u!114 &${tracker.script}\nMonoBehaviour:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_GameObject: {fileID: ${tracker.go}}\n  m_Enabled: 1\n  m_EditorHideFlags: 0\n  m_Script: {fileID: 11500000, guid: ${trackerGuid}, type: 3}\n  m_Name: \n  m_EditorClassIdentifier: \n  linkToName: ${tracker.linkToName}\n`);
    }
    return scene.header + out.join('');
  };
  // placed groups, for the checks: { which, id (its game object), path, offset }
  const placed = created.filter(k => scene.units.get(k).offset).map(k => ({ which: side.get(k), id: scene.units.get(k).id, path: k.slice(4), offset: scene.units.get(k).offset }));
  return { old: half('old'), new: half('new'), placed, moves: moves.map(m => `${m.path} -> ${m.where === 'new' ? rules.newScene : rules.scene}: ${m.to.startsWith('new:') ? m.to.slice(4) + ' (new group)' : scene.units.get(m.to).name}`) };
}

// a prefab instance's modification of its root transform: its value replaced, or added (needed:
// one placement must have it)
function setMod(text, target, prop, value, needed) {
  const re = new RegExp(`(\\n {4}- target: \\{fileID: ${target}, guid: [0-9a-f]+, type: 3\\}\\n {6}propertyPath: ${prop.replace('.', '\\.')}\\n {6}value: )[^\\n]*`);
  if (re.test(text)) return text.replace(re, `$1${value}`);
  if (!needed) return text;
  const guid = /\n {2}m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]+)/.exec(text)[1];
  return text.replace(/\n {4}m_Modifications:\n/, `\n    m_Modifications:\n    - target: {fileID: ${target}, guid: ${guid}, type: 3}\n      propertyPath: ${prop}\n      value: ${value}\n      objectReference: {fileID: 0}\n`);
}

// ---------- checks ----------
// references (fileIDs without a guid) to objects not in the file
function dangling(text) {
  const ids = new Set([...text.matchAll(/^--- !u!\d+ &(-?\d+)/gm)].map(m => m[1]));
  const bad = new Set();
  for (const m of text.matchAll(/\{fileID: (-?\d+)\}/g)) if (m[1] !== '0' && !ids.has(m[1])) bad.add(m[1]);
  return [...bad];
}
const signature = p => [p.piece, ...['x', 'y', 'z'].map(a => p.pos[a].toFixed(3)), ...['x', 'y', 'z', 'w'].map(a => Math.abs(p.rot[a]).toFixed(4)), ...['x', 'y', 'z'].map(a => p.scl[a].toFixed(3)), p.active, JSON.stringify(p.game || null)].join('|');
// shiftOf(half index, piece): how far a placed group moved it, or null
function samePieces(before, halves, shiftOf = () => null) {
  const count = new Map();
  for (const p of before) count.set(signature(p), (count.get(signature(p)) || 0) + 1);
  const extra = [];
  for (const [i, h] of halves.entries()) {
    for (const p of h) {
      const o = shiftOf(i, p);
      const s = signature(o ? { ...p, pos: { x: p.pos.x - o.x, y: p.pos.y - o.y, z: p.pos.z - o.z } } : p);
      if (count.get(s)) count.set(s, count.get(s) - 1); else extra.push(p.path);
    }
  }
  const lost = before.filter(p => count.get(signature(p)) > 0 && count.set(signature(p), count.get(signature(p)) - 1)).map(p => p.path);
  return { extra, lost };
}

// every object (pieces and empty ones alike) placed in the world where it was, and every document
// of the original in exactly one half (the settings, the anchor and shared materials in both)
// (moved by its offset under a placed group: [{ which: 0 or 1, id, offset }])
function sameObjects(text, halves, anchorName, placed = []) {
  const before = readScene(text);
  const problems = [];
  const seen = new Map();
  for (const [i, h] of halves.entries()) {
    const after = readScene(h);
    for (const d of after.docs) seen.set(d.id, (seen.get(d.id) || 0) + 1);
    const offsetOf = k => { for (let x = k; x; x = after.units.get(x).parentUnit) { const g = placed.find(q => q.which === i && q.id === x); if (g) return g.offset; } return { x: 0, y: 0, z: 0 }; };
    for (const k of after.units.keys()) {
      if (!before.units.has(k)) continue; // a group the split made
      const a = before.worldOf(k), b = after.worldOf(k), o = offsetOf(k);
      const far = Math.hypot(a.pos.x + o.x - b.pos.x, a.pos.y + o.y - b.pos.y, a.pos.z + o.z - b.pos.z);
      const turn = 1 - Math.abs(a.rot.w * b.rot.w + a.rot.x * b.rot.x + a.rot.y * b.rot.y + a.rot.z * b.rot.z);
      if (far > 1e-3 || turn > 1e-6) problems.push(`${before.units.get(k).name} moved ${far.toFixed(4)} m`);
    }
  }
  const anchor = [...before.units.values()].find(u => !u.parentUnit && u.kind === 'go' && u.name === anchorName);
  const shared = d => SETTINGS.has(d.cls) || d.cls === 21 || d.cls === 43 || before.unitOf.get(d.id) === anchor.id;
  for (const d of before.docs) {
    const n = seen.get(d.id) || 0;
    if (n === 0 || (n > 1 && !shared(d))) problems.push(`document ${d.id} is in ${n} halves`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
  const rulesFile = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--from');
  if (!rulesFile) { console.error('usage: node tools/split-scene.js <rules.json> [--from <scene file>] [--write]'); process.exit(2); }
  const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
  const scenes = path.join(U.REPO, 'Assets', 'Scenes');
  const source = from || path.join(scenes, rules.scene + '.unity');
  const text = fs.readFileSync(source, 'utf8');
  const out = split(text, rules);
  for (const m of out.moves) console.log('moved', m);
  const dir = path.join(ROOT, 'cache', 'split');
  fs.mkdirSync(dir, { recursive: true });
  const files = { old: path.join(dir, rules.scene + '.unity'), new: path.join(dir, rules.newScene + '.unity') };
  fs.writeFileSync(files.old, out.old);
  fs.writeFileSync(files.new, out.new);
  let ok = true;
  for (const k of ['old', 'new']) {
    const bad = dangling(out[k]);
    if (bad.length) { ok = false; console.log(`${path.basename(files[k])}: references to objects not in it: ${bad.join(', ')}`); }
  }
  const before = U.scenePieces(source);
  const halves = [U.scenePieces(files.old), U.scenePieces(files.new)];
  const placed = out.placed.map(g => ({ ...g, which: g.which === 'old' ? 0 : 1 }));
  const anchors = [rules.anchor, rules.newAnchor];
  const shiftOf = (i, p) => (placed.find(g => g.which === i && p.path.startsWith(`${anchors[i]}/${g.path}/`)) || {}).offset || null;
  const { extra, lost } = samePieces(before, halves, shiftOf);
  if (extra.length || lost.length) { ok = false; console.log('pieces changed:', { extra, lost }); }
  for (const g of placed) console.log(`placed ${g.path}: moved by ${vec(g.offset)}`);
  const problems = sameObjects(text, [out.old, out.new], rules.anchor, placed);
  if (problems.length) { ok = false; console.log(problems.join('\n')); }
  console.log(`${rules.scene}: ${halves[0].length} pieces, ${rules.newScene}: ${halves[1].length} (of ${before.length})`);
  if (!ok) { console.log('not written'); process.exit(1); }
  if (!write) { console.log(`checked; written to ${dir} (--write puts them in Canopy)`); return; }
  fs.writeFileSync(path.join(scenes, rules.scene + '.unity'), out.old);
  fs.writeFileSync(path.join(scenes, rules.newScene + '.unity'), out.new);
  console.log(`written to ${scenes}`);
}

if (require.main === module) main();
module.exports = { split, dangling, sameObjects };
