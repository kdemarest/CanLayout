// Linked assemblages (Ken, 2026-11-09): a landmark or outland made of existing Canopy objects (Black
// Isle) keeps all of its Unity data, every override, child, added component and Canopy uid, in its
// prefab, Assets/Assemblages/<Name>/<Name>.prefab, the one source of truth for everything but where
// things are. Its scene in docs/scenes ("assemblage: linked") lists one piece line per object, each
// carrying `link <fileID>` (its PrefabInstance, or its Transform for a plain object, in the prefab)
// and `in <fileID>` (its nearest linked ancestor, so the page moves children with their parent).
// Rebuilding (the server, on save) changes only placements: each linked object's local placement is
// worked out again so it lands where its line says, under its parent's new placement; a line with no
// link becomes a new PrefabInstance of that prefab (its link written back); a link no line names any
// more is deleted, unless something else refers to it.
//   node tools/linked.js migrate <Scene> <Group> "<Name>" [--write]
//     moves a group (an anchor's child, with everything under and attached to it) out of a Canopy
//     scene into the new prefab, fileIDs kept, and writes the scene file: Origin at the group's
//     place, one line per piece. The group's stage filter goes (an outland or landmark takes its
//     place's stage). Refuses if anything outside the group refers into it, or the other way.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./unity.js');
const S = require('./scene.js');

const SCENES = path.join(__dirname, '..', '..', 'docs', 'scenes');
const BASE = 'Assets/Assemblages';
const HEADER = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';
const pascal = name => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const guidOf = file => crypto.createHash('md5').update('canopy-assemblage:' + file).digest('hex');
const folderMeta = file => `fileFormatVersion: 2\nguid: ${guidOf(file)}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
const prefabMeta = guid => `fileFormatVersion: 2\nguid: ${guid}\nPrefabImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
const isLinked = text => /^---\n[\s\S]*?^assemblage:\s*linked\s*$[\s\S]*?^---$/m.test(String(text || '').replace(/\r\n/g, '\n'));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- documents ----------
function split(text) {
  const parts = text.split(/^(?=--- !u!)/m);
  return { head: parts[0], docs: parts.slice(1) };
}
const idOf = doc => /^--- !u!\d+ &(-?\d+)/.exec(doc)[1];
const isStripped = doc => / stripped$/.test(doc.split('\n')[0]);
const refsOf = doc => new Set([...doc.matchAll(/\{fileID: (-?\d+)\}(?!,)/g)].map(m => m[1]).filter(r => r !== '0'));
const parentRefs = doc => [...doc.matchAll(/^\s*(?:m_GameObject|m_Father|m_TransformParent): \{fileID: (-?\d+)\}/gm)].map(m => m[1]);

// Everything belonging to the objects `roots` (game objects): their components, their children
// down, prefab instances and their stripped objects, and whatever is attached to those.
function subtree(by, roots) {
  const ids = new Set();
  const comps = go => [...by.get(go).matchAll(/- component: \{fileID: (-?\d+)\}/g)].map(m => m[1]);
  const stack = [...roots];
  while (stack.length) {
    const go = stack.pop();
    if (ids.has(go)) continue;
    ids.add(go);
    for (const c of comps(go)) ids.add(c);
  }
  for (;;) {
    const add = new Set();
    for (const [k, d] of by) {
      if (ids.has(k)) continue;
      if (!parentRefs(d).some(r => ids.has(r))) continue;
      add.add(k);
      if (d.startsWith('--- !u!4 ') && !isStripped(d)) {
        const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d)[1];
        add.add(go);
        for (const c of comps(go)) add.add(c);
      }
      if (d.startsWith('--- !u!1001 ')) for (const [x, y] of by) if (isStripped(y) && y.includes(`m_PrefabInstance: {fileID: ${k}}`)) add.add(x);
    }
    for (const [x, y] of by) if (!ids.has(x) && isStripped(y) && [...ids].some(i => y.includes(`m_PrefabInstance: {fileID: ${i}}`))) add.add(x);
    if (![...add].some(a => !ids.has(a))) break;
    for (const a of add) ids.add(a);
  }
  return ids;
}

// ---------- matrices (row-major 4x4) ----------
function inverse(m) {
  const a = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const inv = [
    [(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
    [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
    [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det]
  ];
  const t = [m[3], m[7], m[11]];
  const it = inv.map(r => -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]));
  return [inv[0][0], inv[0][1], inv[0][2], it[0], inv[1][0], inv[1][1], inv[1][2], it[1], inv[2][0], inv[2][1], inv[2][2], it[2], 0, 0, 0, 1];
}
const lineMatrix = (p, origin) => U.trs({ x: p.position[0] - origin[0], y: p.position[1] - origin[1], z: p.position[2] - origin[2] }, U.eulerToQuat({ x: p.rotation[0], y: p.rotation[1], z: p.rotation[2] }), { x: p.scale[0], y: p.scale[1], z: p.scale[2] });
const pieceMatrix = p => U.trs(p.pos, p.rot, p.scl);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

// ---------- a linked object's local placement in the prefab text ----------
const vecOf = (doc, k) => {
  const m = new RegExp(`${k}: \\{([^}]*)\\}`).exec(doc);
  return m ? Object.fromEntries(m[1].split(',').map(s => s.split(':').map(x => x.trim())).map(([a, b]) => [a, +b])) : null;
};
const fmt = v => String(round(v, 6));
// { kind: 't' | 'pi', doc index, root (an instance's source root transform and guid) }
function localOf(docs, id) {
  const i = docs.findIndex(d => idOf(d) === id);
  if (i < 0) return null;
  const d = docs[i];
  if (d.startsWith('--- !u!4 ')) {
    return { i, kind: 't', m: U.trs(vecOf(d, 'm_LocalPosition'), vecOf(d, 'm_LocalRotation'), vecOf(d, 'm_LocalScale')) };
  }
  const src = /m_SourcePrefab: \{fileID: \d+, guid: (\w+)/.exec(d)[1];
  const sub = U.prefab(src);
  const rootT = sub.rootId;
  const trs = sub.rootTrs || { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scl: { x: 1, y: 1, z: 1 } };
  const pos = { ...trs.pos }, rot = { ...trs.rot }, scl = { ...trs.scl };
  for (const m of d.matchAll(new RegExp(` {4}- target: \\{fileID: ${rootT}, guid: ${src}, type: 3\\}\\n {6}propertyPath: m_Local(Position|Rotation|Scale)\\.([wxyz])\\n {6}value: ([^\\n]*)\\n`, 'g'))) {
    (m[1] === 'Position' ? pos : m[1] === 'Rotation' ? rot : scl)[m[2]] = parseFloat(m[3]);
  }
  return { i, kind: 'pi', m: U.trs(pos, rot, scl), rootT, src };
}
function setLocal(docs, at, m) {
  const { pos, rot, scl } = U.decompose(m);
  const e = U.quatToEuler(rot);
  const d = docs[at.i];
  if (at.kind === 't') {
    docs[at.i] = d.replace(/m_LocalRotation: \{[^}]*\}/, `m_LocalRotation: {x: ${fmt(rot.x)}, y: ${fmt(rot.y)}, z: ${fmt(rot.z)}, w: ${fmt(rot.w)}}`)
      .replace(/m_LocalPosition: \{[^}]*\}/, `m_LocalPosition: {x: ${fmt(pos.x)}, y: ${fmt(pos.y)}, z: ${fmt(pos.z)}}`)
      .replace(/m_LocalScale: \{[^}]*\}/, `m_LocalScale: {x: ${fmt(scl.x)}, y: ${fmt(scl.y)}, z: ${fmt(scl.z)}}`)
      .replace(/m_LocalEulerAnglesHint: \{[^}]*\}/, `m_LocalEulerAnglesHint: {x: ${fmt(e.x)}, y: ${fmt(e.y)}, z: ${fmt(e.z)}}`);
    return;
  }
  const t = (prop, value) => `    - target: {fileID: ${at.rootT}, guid: ${at.src}, type: 3}\n      propertyPath: ${prop}\n      value: ${fmt(value)}\n      objectReference: {fileID: 0}\n`;
  const old = new RegExp(` {4}- target: \\{fileID: ${at.rootT}, guid: ${at.src}, type: 3\\}\\n {6}propertyPath: m_Local(?:Position|Rotation|Scale|EulerAnglesHint)\\.[wxyz]\\n {6}value: [^\\n]*\\n {6}objectReference: \\{fileID: 0\\}\\n`, 'g');
  const mods = [['m_LocalPosition.x', pos.x], ['m_LocalPosition.y', pos.y], ['m_LocalPosition.z', pos.z], ['m_LocalRotation.w', rot.w], ['m_LocalRotation.x', rot.x], ['m_LocalRotation.y', rot.y], ['m_LocalRotation.z', rot.z], ['m_LocalScale.x', scl.x], ['m_LocalScale.y', scl.y], ['m_LocalScale.z', scl.z], ['m_LocalEulerAnglesHint.x', e.x], ['m_LocalEulerAnglesHint.y', e.y], ['m_LocalEulerAnglesHint.z', e.z]].map(([k, v]) => t(k, v)).join('');
  docs[at.i] = d.replace(old, '').replace(/( {4}m_Modifications:\n)/, `$1${mods}`);
}

// The prefab's pieces (U.scenePieces reads a prefab as a scene), each with its link id: its
// PrefabInstance, or the Transform of its plain object.
function prefabPieces(file, docs) {
  const tOf = go => { const d = docs.find(x => x.startsWith('--- !u!4 ') && x.includes(`m_GameObject: {fileID: ${go}}`)); return d ? idOf(d) : null; };
  return U.scenePieces(file).map(p => ({ ...p, link: p.instance || tOf(p.go) })).filter(p => p.link);
}
// Each piece's nearest linked ancestor, by path.
function ancestry(pieces) {
  const byPath = new Map(pieces.map(p => [p.path, p]));
  const out = new Map();
  for (const p of pieces) {
    const parts = p.path.split('/');
    for (let k = parts.length - 1; k > 0; k--) {
      const a = byPath.get(parts.slice(0, k).join('/'));
      if (a) { out.set(p.link, a.link); break; }
    }
  }
  return out;
}
const linkOf = extra => ((/(?:^|, )link (-?\d+)/.exec(extra || '') || [])[1] || null);
const setting = (extra, k, v) => [...String(extra || '').split(', ').filter(s => s && !s.startsWith(k + ' ')), ...(v ? [`${k} ${v}`] : [])].join(', ');

// ---------- migrate ----------
function migrate(sceneName, group, name, write) {
  const file = path.join(U.REPO, 'Assets', 'Scenes', sceneName + '.unity');
  const text = fs.readFileSync(file, 'utf8');
  const { head, docs } = split(text);
  const by = new Map(docs.map(d => [idOf(d), d]));
  const goDoc = docs.find(d => d.startsWith('--- !u!1 ') && new RegExp(`^  m_Name: ${group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(d));
  if (!goDoc) throw new Error(`no object ${group} in ${sceneName}`);
  const go = idOf(goDoc);
  const ids = subtree(by, [go]);
  const rootT = [...ids].find(i => by.get(i).startsWith('--- !u!4 ') && by.get(i).includes(`m_GameObject: {fileID: ${go}}`));
  const fatherT = /m_Father: \{fileID: (-?\d+)\}/.exec(by.get(rootT))[1];
  const out = [...ids].flatMap(i => [...refsOf(by.get(i))].filter(r => !ids.has(r) && r !== fatherT));
  const into = docs.filter(d => !ids.has(idOf(d))).flatMap(d => [...refsOf(d)].filter(r => ids.has(r) && !(r === rootT && idOf(d) === fatherT)));
  if (out.length || into.length) throw new Error(`${group} refers out (${out.slice(0, 3)}) or is referred to (${into.slice(0, 3)})`);
  // where it is: its father (the anchor) and its own place, unturned and unscaled
  const father = by.get(fatherT);
  const fpos = vecOf(father, 'm_LocalPosition'), pos = vecOf(by.get(rootT), 'm_LocalPosition');
  const origin = [fpos.x + pos.x, fpos.y + pos.y, fpos.z + pos.z].map(v => round(v, 3));
  if (!/m_Father: \{fileID: 0\}/.test(father) || Math.abs(vecOf(father, 'm_LocalRotation').w) < 0.999999 || Math.abs(vecOf(by.get(rootT), 'm_LocalRotation').w) < 0.999999) throw new Error(`${group} or its parent is turned, or its parent isn't a root`);
  // the prefab: the group's documents, its root unparented at the origin, its stage filter gone
  const stageScripts = ['FilterOnPopulate', 'FilterOnStage', 'FilterWithStageData'].map(n => U.scriptGuid(n)).filter(Boolean);
  const dropped = new Set([...ids].filter(i => {
    const d = by.get(i);
    return d.startsWith('--- !u!114 ') && d.includes(`m_GameObject: {fileID: ${go}}`) && stageScripts.some(g => d.includes(`guid: ${g}`));
  }));
  const kept = docs.filter(d => ids.has(idOf(d)) && !dropped.has(idOf(d))).map(d => {
    let x = d;
    if (idOf(d) === rootT) x = x.replace(/m_Father: \{fileID: -?\d+\}/, 'm_Father: {fileID: 0}').replace(/m_LocalPosition: \{[^}]*\}/, 'm_LocalPosition: {x: 0, y: 0, z: 0}').replace(/m_RootOrder: \d+/, 'm_RootOrder: 0');
    if (idOf(d) === go) for (const c of dropped) x = x.replace(`  - component: {fileID: ${c}}\n`, '');
    return x;
  });
  const prefabName = pascal(name), dir = `${BASE}/${prefabName}`, prefabFile = `${dir}/${prefabName}.prefab`;
  const files = { [prefabFile]: HEADER + kept.join(''), [prefabFile + '.meta']: prefabMeta(guidOf(prefabFile)), [`${dir}.meta`]: folderMeta(dir), [`${BASE}.meta`]: folderMeta(BASE) };
  const report = { origin, objects: ids.size, droppedStageFilters: dropped.size, prefab: prefabFile };
  if (!write) return report;
  for (const [f, t] of Object.entries(files)) {
    const full = path.join(U.REPO, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full) || f.endsWith('.prefab') || f.endsWith('.prefab.meta')) fs.writeFileSync(full, t);
  }
  // the scene without the group
  const rest = docs.filter(d => !ids.has(idOf(d))).map(d => (idOf(d) === fatherT ? d.replace(`  - {fileID: ${rootT}}\n`, '') : d));
  fs.writeFileSync(file, head + rest.join(''));
  U.refreshIndex();
  // its scene file: one line per piece
  const full = path.join(U.REPO, prefabFile);
  const pdocs = split(fs.readFileSync(full, 'utf8')).docs;
  const pieces = prefabPieces(full, pdocs);
  const up = ancestry(pieces);
  const lines = pieces.map(p => {
    const e = U.quatToEuler(p.rot);
    const extra = [p.textId ? `textId ${p.textId}` : '', `link ${p.link}`, up.get(p.link) ? `in ${up.get(p.link)}` : ''].filter(Boolean).join(', ');
    return S.formatPieceLine({ name: p.piece, position: [p.pos.x + origin[0], p.pos.y + origin[1], p.pos.z + origin[2]], rotation: [e.x, e.y, e.z], scale: [p.scl.x, p.scl.y, p.scl.z], extra });
  });
  const md = `---\nname: ${name}\ntype: scene\nassemblage: linked\n---\n# Scene\n\n${name}, moved out of ${sceneName}.unity into its own prefab (${prefabFile}) by tools/linked.js (Claude, ${new Date().toISOString().slice(0, 10)}): a linked assemblage. Every object keeps its Unity data in the prefab; each line links its object (\`link\`) and its nearest linked parent (\`in\`). Moving a line moves the object (its children with it, in the page); a new line becomes a new instance of its prefab; a line taken out deletes its object.\n\n- Origin: ${origin.join(' ')}\n\n${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(SCENES, name + '.md'), md);
  return { ...report, pieces: pieces.length };
}

// ---------- rebuild (the server's, on save) ----------
// { name, dir, files, notes } for assemblage.js's write; the scene file gets new links written.
function plan(sceneName) {
  const mdFile = path.join(SCENES, sceneName + '.md');
  let text = fs.readFileSync(mdFile, 'utf8');
  const origin = S.originLine(text);
  if (!origin) throw new Error(`${sceneName}: a linked assemblage needs a "- Origin: x y z" line`);
  const parsed = S.parsePieceLines(text);
  if (parsed.errors.length) throw new Error(`${sceneName}: ${parsed.errors[0]}`);
  const prefabName = pascal(sceneName), dir = `${BASE}/${prefabName}`, prefabFile = `${dir}/${prefabName}.prefab`;
  const full = path.join(U.REPO, prefabFile);
  const { head, docs } = split(fs.readFileSync(full, 'utf8'));
  const notes = [];
  const pieces = prefabPieces(full, docs);
  const byLink = new Map(pieces.map(p => [p.link, p]));
  const up = ancestry(pieces);
  const lines = parsed.pieces.map(p => ({ ...p, link: linkOf(p.extra) }));
  const wanted = new Map(lines.filter(l => l.link).map(l => [l.link, l]));
  // moved: each linked object, outermost first, so a parent's new placement is known for its children
  const newWorld = new Map();
  const depth = l => byLink.get(l).path.split('/').length;
  for (const link of [...wanted.keys()].filter(l => byLink.has(l)).sort((a, b) => depth(a) - depth(b))) {
    const old = byLink.get(link), Wold = pieceMatrix(old);
    // unchanged when its line is what its placement now would be written as (lines are rounded:
    // a millimetre, a hundredth of a degree), so a rebuild never nudges what wasn't moved
    const e = U.quatToEuler(old.rot);
    const asLine = S.parsePieceLines(S.formatPieceLine({ name: old.piece, position: [old.pos.x + origin[0], old.pos.y + origin[1], old.pos.z + origin[2]], rotation: [e.x, e.y, e.z], scale: [old.scl.x, old.scl.y, old.scl.z] })).pieces[0];
    const l = wanted.get(link);
    if (same([...asLine.position, ...asLine.rotation, ...asLine.scale], [...l.position, ...l.rotation, ...l.scale])) continue;
    const Wnew = lineMatrix(l, origin);
    newWorld.set(link, Wnew);
    const at = localOf(docs, link);
    const Pold = U.mul(Wold, inverse(at.m));
    const a = up.get(link);
    const Pnew = a ? U.mul(U.mul(newWorld.get(a) || pieceMatrix(byLink.get(a)), inverse(pieceMatrix(byLink.get(a)))), Pold) : Pold;
    const Lnew = U.mul(inverse(Pnew), Wnew);
    if (!same(Lnew, at.m)) setLocal(docs, at, Lnew);
  }
  for (const [link] of wanted) if (!byLink.has(link)) notes.push(`link ${link}: no such object in the prefab; line left as it is`);
  // added: a line without a link, a new PrefabInstance of its prefab under the root
  const used = new Set(docs.map(idOf));
  const root = docs.find(d => d.startsWith('--- !u!4 ') && /m_Father: \{fileID: 0\}/.test(d));
  const rootT = idOf(root);
  let changedLines = false;
  for (const l of lines.filter(x => !x.link)) {
    const p = U.prefabByName(l.name);
    if (!p) { notes.push(`${l.name}: no prefab; not added`); continue; }
    const guid = Object.entries(U.index()).find(([, e]) => e.path === p.path)[0];
    let id;
    do id = String(1000000000 + Math.floor(Math.random() * 1100000000)); while (used.has(id) || used.has(String(+id + 1)));
    used.add(id); used.add(String(+id + 1));
    docs.push(`--- !u!1001 &${id}\nPrefabInstance:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Modification:\n    m_TransformParent: {fileID: ${rootT}}\n    m_Modifications:\n    m_RemovedComponents: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}\n`);
    docs.push(`--- !u!4 &${+id + 1} stripped\nTransform:\n  m_CorrespondingSourceObject: {fileID: ${p.rootId}, guid: ${guid}, type: 3}\n  m_PrefabInstance: {fileID: ${id}}\n  m_PrefabAsset: {fileID: 0}\n`);
    const ri = docs.findIndex(d => d === root);
    docs[ri] = docs[ri].replace(/( {2}m_Children:\n)/, `$1  - {fileID: ${+id + 1}}\n`).replace(/( {2}m_Children: )\[\]\n/, `$1\n  - {fileID: ${+id + 1}}\n`);
    setLocal(docs, localOf(docs, id), lineMatrix(l, origin));
    l.extra = setting(l.extra, 'link', id);
    changedLines = true;
  }
  // removed: a link no line names any more, when it is a PrefabInstance under a plain object and
  // nothing else refers to it (anything else is kept, with a note)
  const by = new Map(docs.map(d => [idOf(d), d]));
  for (const p of pieces) {
    if (wanted.has(p.link)) continue;
    const d = by.get(p.link);
    const parentT = d.startsWith('--- !u!1001 ') && (/m_TransformParent: \{fileID: (-?\d+)\}/.exec(d) || [])[1];
    if (!parentT || !by.has(parentT) || isStripped(by.get(parentT))) { notes.push(`${p.piece} (${p.link}): only an instance under a plain object can be deleted here; kept`); continue; }
    const ids = new Set([p.link]);
    for (const [x, y] of by) if (isStripped(y) && y.includes(`m_PrefabInstance: {fileID: ${p.link}}`)) ids.add(x);
    const attached = [...by].some(([k, x]) => !ids.has(k) && k !== parentT && [...refsOf(x)].some(r => ids.has(r)));
    if (attached) { notes.push(`${p.piece} (${p.link}): something else is attached to or refers to it; kept`); continue; }
    for (const x of ids) by.delete(x);
    by.set(parentT, [...ids].reduce((x, t) => x.replace(`  - {fileID: ${t}}\n`, ''), by.get(parentT)));
  }
  const out = [...by.values()];
  if (changedLines) fs.writeFileSync(mdFile, S.replacePieceLines(text, lines.map(({ link, ...l }) => l)));
  const files = { [prefabFile]: head + out.join(''), [prefabFile + '.meta']: prefabMeta(guidOf(prefabFile)), [`${dir}.meta`]: folderMeta(dir), [`${BASE}.meta`]: folderMeta(BASE) };
  return { name: prefabName, dir, files, notes };
}

module.exports = { isLinked, migrate, plan, pascal };

if (require.main === module) {
  const [cmd, scene, group, name] = process.argv.slice(2);
  if (cmd === 'migrate' && name) console.log(JSON.stringify(migrate(scene, group, name, process.argv.includes('--write')), null, 1));
  else console.log('usage: node tools/linked.js migrate <Scene> <Group> "<Name>" [--write]');
}
