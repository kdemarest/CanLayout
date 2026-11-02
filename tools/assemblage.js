// An assemblage: a scene marked "assemblage: true" in its frontmatter becomes a prefab of its own,
// so other scenes (and Unity) place it as one piece, as Unity nests a prefab:
//   node tools/assemblage.js <scene> [--write]   (the server rebuilds them on save, and when
//                                                 their pieces' files change)
// Into Assets/Assemblages/<Name>/ (Name: the scene's name in PascalCase), which layout owns and
// rewrites:
//   <Name>.prefab   its root at the scene's "- Origin: x y z", each piece nested at its place
//                   relative to it. A piece whose prefab is a LODGroup over nested models (modl's
//                   benches) has those models nested directly, and the root's one LODGroup draws
//                   them: level k is every such piece's level k, and the last level is one
//                   combined mesh per material of every piece's last level (one draw where there
//                   were many; Unity's LODGroup only switches renderers, it never combines them).
//                   Its switch distances are the pieces' own, the latest of them, plus the
//                   assemblage's radius, so no piece coarsens before its own LOD would; the
//                   combined level is culled where the pieces would be. Other pieces (the disc)
//                   are nested whole, with their own LODs.
//   <Name>_Far.obj  the combined last level (_Far2 ... for more materials)
// Guids come from each file's path, so rebuilding keeps every reference.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./unity.js');
const S = require('./scene.js');
const MS = require('./make-shapes.js');

const SCENES = path.join(__dirname, '..', '..', 'docs', 'scenes');
const BASE = 'Assets/Assemblages';
const guidOf = file => crypto.createHash('md5').update('canopy-assemblage:' + file).digest('hex');
const folderMeta = file => `fileFormatVersion: 2\nguid: ${guidOf(file)}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
const pascal = name => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const index = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;

// Position, rotation (euler degrees, Unity's ZXY order) and scale of a 4x4 row-major matrix.
function decompose(m) {
  const col = c => [m[c], m[4 + c], m[8 + c]];
  const scale = [0, 1, 2].map(c => Math.hypot(...col(c)));
  const r = [0, 1, 2].map(row => [0, 1, 2].map(c => m[row * 4 + c] / scale[c]));
  // rotation matrix to quaternion
  const tr = r[0][0] + r[1][1] + r[2][2];
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: s / 4, x: (r[2][1] - r[1][2]) / s, y: (r[0][2] - r[2][0]) / s, z: (r[1][0] - r[0][1]) / s };
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2;
    q = { w: (r[2][1] - r[1][2]) / s, x: s / 4, y: (r[0][1] + r[1][0]) / s, z: (r[0][2] + r[2][0]) / s };
  } else if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2;
    q = { w: (r[0][2] - r[2][0]) / s, x: (r[0][1] + r[1][0]) / s, y: s / 4, z: (r[1][2] + r[2][1]) / s };
  } else {
    const s = Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2;
    q = { w: (r[1][0] - r[0][1]) / s, x: (r[0][2] + r[2][0]) / s, y: (r[1][2] + r[2][1]) / s, z: s / 4 };
  }
  const e = U.quatToEuler(q);
  return { at: [m[3], m[7], m[11]], turn: [e.x, e.y, e.z], scale };
}

// An OBJ's triangles: { v, vt, vn, f: [[[vi, ti, ni] x3]] } (0-based; polygons fanned).
function readObj(text) {
  const v = [], vt = [], vn = [], f = [];
  for (const raw of text.split('\n')) {
    const [kind, ...rest] = raw.trim().split(/\s+/);
    if (kind === 'v') v.push(rest.slice(0, 3).map(Number));
    else if (kind === 'vt') vt.push(rest.slice(0, 2).map(Number));
    else if (kind === 'vn') vn.push(rest.slice(0, 3).map(Number));
    else if (kind === 'f') {
      const c = rest.map(x => x.split('/').map((s, k) => (s ? (+s < 0 ? [v, vt, vn][k].length + +s : +s - 1) : -1)));
      for (let i = 1; i + 1 < c.length; i++) f.push([c[0], c[i], c[i + 1]]);
    }
  }
  return { v, vt, vn, f };
}

// The scene's plan: { name, files: {path: text}, notes }.
function plan(sceneName) {
  const text = fs.readFileSync(path.join(SCENES, sceneName + '.md'), 'utf8');
  if (!S.isAssemblage(text)) throw new Error(`${sceneName} is not an assemblage (frontmatter assemblage: true)`);
  const origin = S.originLine(text);
  if (!origin) throw new Error(`${sceneName}: an assemblage needs a "- Origin: x y z" line`);
  const parsed = S.parsePieceLines(text);
  if (parsed.errors.length) throw new Error(`${sceneName}: ${parsed.errors[0]}`);
  const name = pascal(sceneName), dir = `${BASE}/${name}`;
  const idx = index(), byPath = new Map(Object.entries(idx).map(([g, e]) => [e.path, g]));
  const files = {}, notes = [];
  const children = []; // make-shapes instance() inputs, with lod levels for expanded models
  const groups = []; // each expanded piece's LODGroup in assemblage space: { at, size, heights }
  let radius = 0;
  // Pieces are expanded only with as many levels as most of them have: their last levels are
  // combined into one, so they must line up; another piece is nested whole, with its own LODs.
  const counts = {};
  for (const piece of parsed.pieces) {
    const p = U.prefabByName(piece.name);
    const g = p && Object.values(p.lodGroups || {})[0];
    if (g && p.parts.every(x => x.mesh.kind === 'model' && x.lod)) counts[g.heights.length] = (counts[g.heights.length] || 0) + 1;
  }
  const expectLevels = +(Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [0])[0];
  parsed.pieces.forEach((piece, i) => {
    const p = U.prefabByName(piece.name);
    if (!p) return notes.push(`${piece.name}: no prefab; left out`);
    const rel = piece.position.map((x, a) => x - origin[a]);
    radius = Math.max(radius, Math.hypot(rel[0], rel[2]));
    const q = U.eulerToQuat({ x: piece.rotation[0], y: piece.rotation[1], z: piece.rotation[2] });
    const W = U.trs({ x: rel[0], y: rel[1], z: rel[2] }, q, { x: piece.scale[0], y: piece.scale[1], z: piece.scale[2] });
    const keys = new Set(p.parts.map(x => x.lod && x.lod.key));
    const expand = p.parts.length && p.parts.every(x => x.mesh.kind === 'model' && x.lod && x.mesh.guid) && keys.size === 1
      && (!expectLevels || p.lodGroups[[...keys][0]].heights.length === expectLevels);
    if (expand) {
      const g = p.lodGroups[[...keys][0]];
      groups.push({ at: rel, size: g.size * Math.max(...piece.scale), heights: g.heights });
      for (const part of p.parts) {
        const m = U.mul(W, part.m);
        children.push({ guid: part.mesh.guid, rootT: MS.MODEL.t, rootGo: MS.MODEL.go, name: part.mesh.name, ...decompose(m), material: part.material, renderer: true, levels: part.lod.levels, mesh: part.mesh, m, order: i });
      }
    } else {
      const guid = byPath.get(p.path);
      children.push({ guid, rootT: p.rootId, rootGo: p.rootGoId, name: piece.name, at: rel, turn: piece.rotation, scale: piece.scale, order: i });
    }
  });
  const levels = Math.max(0, ...children.filter(c => c.levels).flatMap(c => c.levels)) + 1;
  // The last level, combined per material, in OBJ space (right-handed; Unity's import negates X):
  // a model's vertex v sits at S W S v in the assemblage, S negating X.
  const last = children.filter(c => c.levels && c.levels.includes(levels - 1));
  const byMaterial = new Map();
  for (const c of last) byMaterial.set(c.material, [...(byMaterial.get(c.material) || []), c]);
  const combined = [];
  [...byMaterial].forEach(([material, list], k) => {
    const objName = `${name}_Far${k ? k + 1 : ''}`;
    const out = { v: [], vt: [], vn: [], f: [] };
    for (const c of list) {
      const file = path.join(U.REPO, c.mesh.path);
      const src = readObj(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : S.blobs([c.mesh.blob]).get(c.mesh.blob).toString());
      const m = c.m.slice();
      for (const i of [1, 2, 3, 4, 8]) m[i] = -m[i]; // S M S: negate row 0 and column 0, the corner twice
      const base = [out.v.length, out.vt.length, out.vn.length];
      for (const v of src.v) out.v.push([0, 1, 2].map(r => m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3]));
      out.vt.push(...src.vt);
      // normals by the inverse transpose of the 3x3 (rotation and scale)
      const a = [0, 1, 2].map(r => [0, 1, 2].map(cc => m[r * 4 + cc]));
      const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
      const cof = (r, cc) => {
        const rs = [0, 1, 2].filter(x => x !== r), cs = [0, 1, 2].filter(x => x !== cc);
        return ((r + cc) % 2 ? -1 : 1) * (a[rs[0]][cs[0]] * a[rs[1]][cs[1]] - a[rs[0]][cs[1]] * a[rs[1]][cs[0]]);
      };
      for (const n of src.vn) {
        const t = [0, 1, 2].map(r => (cof(r, 0) * n[0] + cof(r, 1) * n[1] + cof(r, 2) * n[2]) / det);
        const l = Math.hypot(...t) || 1;
        out.vn.push(t.map(x => x / l));
      }
      for (const tri of src.f) out.f.push(tri.map(([vi, ti, ni]) => [vi + base[0], ti >= 0 ? ti + base[1] : -1, ni >= 0 ? ni + base[2] : -1]));
    }
    const f6 = x => +x.toFixed(6);
    const corner = ([vi, ti, ni]) => `${vi + 1}/${ti >= 0 ? ti + 1 : ''}/${ni >= 0 ? ni + 1 : ''}`;
    const objText = [`# ${objName}: ${list.length} pieces' last LOD combined (layout/tools/assemblage.js)`, `o ${objName}`,
      ...out.v.map(v => `v ${v.map(f6).join(' ')}`), ...out.vt.map(t => `vt ${t.map(f6).join(' ')}`), ...out.vn.map(n => `vn ${n.map(f6).join(' ')}`),
      ...out.f.map(tri => `f ${tri.map(corner).join(' ')}`)].join('\n') + '\n';
    const file = `${dir}/${objName}.obj`;
    files[file] = objText;
    files[file + '.meta'] = MS.OBJ_META.replace('{{guid}}', guidOf(file)).replace('materialImportMode: 2', 'materialImportMode: 0');
    combined.push({ guid: guidOf(file), rootT: MS.MODEL.t, rootGo: MS.MODEL.go, name: objName, at: [0, 0, 0], turn: [0, 0, 0], scale: [1, 1, 1], material, renderer: true, levels: [levels - 1], triangles: out.f.length });
  });
  // the nested children: everything but the last level's models, which the combined meshes replace
  const kept = [...children.filter(c => !(c.levels && c.levels.length === 1 && c.levels[0] === levels - 1)), ...combined];
  const nested = kept.map((c, order) => ({ c, ...MS.instance(MS.ROOT.t, order, c) }));
  // The root's LODGroup: level k ends where the latest piece's level k ends, plus the radius.
  let lodDoc = '', lodComponent = '';
  if (groups.length && levels > 1) {
    const ends = [...Array(levels).keys()].map(k => Math.max(...groups.map(g => g.size / (2 * g.heights[Math.min(k, g.heights.length - 1)]))) + radius);
    const yMid = groups.reduce((s, g) => s + g.at[1], 0) / groups.length;
    const size = 2 * Math.max(...groups.map(g => Math.hypot(g.at[0], g.at[1] - yMid, g.at[2]) + g.size / 2));
    const lodId = MS.idOf(name, 'lodgroup');
    lodComponent = `  - component: {fileID: ${lodId}}\n`;
    const level = k => `  - screenRelativeHeight: ${MS.n6(size / (2 * ends[k]))}\n    fadeTransitionWidth: 0\n    renderers:\n` +
      nested.filter(x => x.renderer && x.c.levels.includes(k)).map(x => `    - renderer: {fileID: ${x.renderer}}`).join('\n') + '\n';
    lodDoc = `--- !u!205 &${lodId}
LODGroup:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: ${MS.ROOT.go}}
  serializedVersion: 2
  m_LocalReferencePoint: {x: 0, y: ${MS.n6(yMid)}, z: 0}
  m_Size: ${MS.n6(size)}
  m_FadeMode: 0
  m_AnimateCrossFading: 0
  m_LastLODIsBillboard: 0
  m_LODs:
${[...Array(levels).keys()].map(level).join('')}  m_Enabled: 1
`;
    notes.push(`LODGroup: levels end at ${ends.map(d => d.toFixed(0)).join(', ')} m (pieces' own plus the ${radius.toFixed(1)} m radius); last level ${combined.map(c => `${c.name} ${c.triangles} triangles`).join(', ')}`);
  }
  const prefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &${MS.ROOT.go}
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
  - component: {fileID: ${MS.ROOT.t}}
${lodComponent}  m_Layer: 0
  m_Name: ${name}
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 1
--- !u!4 &${MS.ROOT.t}
Transform:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: ${MS.ROOT.go}}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_ConstrainProportionsScale: 0
  m_Children:
${nested.map(x => `  - {fileID: ${x.stripped}}`).join('\n')}
  m_Father: {fileID: 0}
  m_RootOrder: 0
  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}
${lodDoc}${nested.map(x => x.yaml).join('')}`;
  files[`${dir}/${name}.prefab`] = prefab;
  files[`${dir}/${name}.prefab.meta`] = MS.meta(guidOf(`${dir}/${name}.prefab`), 'PrefabImporter:');
  files[`${BASE}.meta`] = folderMeta(BASE);
  files[`${dir}.meta`] = folderMeta(dir);
  return { name, dir, files, notes };
}

// Writes the plan into the Canopy working tree: only files whose text changed, and removes what
// an earlier build left in its folder. Returns the paths changed.
function write(p) {
  const changed = [];
  for (const [file, text] of Object.entries(p.files)) {
    const full = path.join(U.REPO, file);
    if (fs.existsSync(full) && fs.readFileSync(full, 'utf8') === text) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    changed.push(file);
  }
  const folder = path.join(U.REPO, p.dir);
  for (const n of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    if (!p.files[`${p.dir}/${n}`]) {
      fs.rmSync(path.join(folder, n));
      changed.push(`${p.dir}/${n} (removed)`);
    }
  }
  return changed;
}

// Every assemblage scene's name.
const scenes = () => (fs.existsSync(SCENES) ? fs.readdirSync(SCENES).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).filter(n => S.isAssemblage(fs.readFileSync(path.join(SCENES, n + '.md'), 'utf8'))) : []);

module.exports = { plan, write, scenes, pascal };

if (require.main === module) {
  const name = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!name) {
    console.log(`assemblages: ${scenes().join(', ') || 'none'}; usage: node tools/assemblage.js <scene> [--write]`);
    process.exit(0);
  }
  const p = plan(name);
  for (const n of p.notes) console.log(n);
  if (!process.argv.includes('--write')) console.log(`${Object.keys(p.files).length} files for ${p.dir}; --write writes them`);
  else console.log(`${p.dir}: ${write(p).join(', ') || 'unchanged'}`);
}
