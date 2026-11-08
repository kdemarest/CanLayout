// Pieces, areas, and the piece library for layout. Positions, rotations (Unity euler degrees),
// and scales are Unity's (left-handed); the browser mirrors X.
//   Composed scenes: docs/scenes/<Type> <Name>.md, Piece lines, edited in layout or by hand.
//   Imported areas: layout/areas/<Scene> <Name>.json, cut from a Unity scene, never edited.
// CLI (from layout/):
//   node tools/scene.js extract <Scene> <cx> <cy> <cz> <halfSize> <Name>
//   node tools/scene.js prepare <piece name>...
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('./unity.js');
const { assetToObj } = require('./asset-mesh.js');
const { objModelToObj } = require('./obj-model.js');
const FBX = require('./fbx.js');
const Config = require('./config.js');
const Timing = require('./timing.js');
const Shapes = require('./shapes.js');
const Gems = require('./gems.js');
const Convert = require('./convert-materials.js');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const LIBRARY = path.join(CACHE, 'pieces.json');
const SUBMESHES = crypto.createHash('sha1').update('submeshes').digest('hex').slice(0, 8);
const MESHES = path.join(CACHE, 'meshes');
const TEXTURES = path.join(CACHE, 'textures');
const MATERIALS = path.join(CACHE, 'materials.json');
const AREAS = path.join(ROOT, 'areas');
const GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];
// Blobs missing from Canopy's store are fetched into this throwaway store, read, and deleted,
// so viewing never grows Canopy's git store (only layout's capped cache keeps anything).
// One per process: the server and tools fetching at once each make and delete their own.
const FETCH_STORE = path.join(process.env.HOME, '.cache', `layout-fetch-${process.pid}.git`);

const round = (v, places) => { const r = +v.toFixed(places); return Object.is(r, -0) ? 0 : r; };
const CHUNK_BOUNDS = path.join(CACHE, 'chunk-bounds.json');

// ---------- Piece lines ----------
// "- Piece: Name | x y z | rx ry rz | scale | extra" -> { name, position, rotation, scale, extra }
function parsePieceLines(text) {
  const pieces = [], errors = [];
  String(text || '').split('\n').forEach((line, index) => {
    const m = /^\s*-\s*Piece:\s*(.+)$/.exec(line);
    if (!m) return;
    const f = m[1].split('|').map(s => s.trim());
    const nums = s => (s || '').split(/\s+/).filter(Boolean).map(Number);
    const position = nums(f[1]), rotation = nums(f[2]), scale = nums(f[3] || '1');
    if (!f[0] || position.length !== 3 || rotation.length !== 3 || (scale.length !== 1 && scale.length !== 3)
      || [...position, ...rotation, ...scale].some(v => !Number.isFinite(v))) {
      errors.push(`line ${index + 1}: expected "- Piece: Name | x y z | rx ry rz | scale"`);
      return;
    }
    pieces.push({ name: f[0], position, rotation, scale: scale.length === 1 ? [scale[0], scale[0], scale[0]] : scale, extra: f.slice(4).join(' | ') });
  });
  return { pieces, errors };
}
// "- Area: <Scene> <Name>" lines: the imported areas a composed scene is built on, the first
// giving its Unity scene's settings (Claude, 2026-11-03: several, e.g. Beech beside Hawthorn).
const areaLines = text => [...String(text || '').matchAll(/^\s*-\s*Area:\s*(.+?)\s*$/gm)].map(m => m[1]);
// "- Origin: x y z": an assemblage's root (the point its prefab is built around), or null.
function originLine(text) {
  const m = /^\s*-\s*Origin:\s*(\S+)\s+(\S+)\s+(\S+)\s*$/m.exec(String(text || ''));
  const o = m ? [+m[1], +m[2], +m[3]] : null;
  return o && o.every(Number.isFinite) ? o : null;
}
// "- Switch: <Label> = <Layer> <Layer> | <Label> = <Layer> ...": an on-screen button cycling between
// sets of inspection layers ("inspect:<Layer>" pieces), each shown alone (Ken, 2026-10-28: a before
// and after in the same place): [{ label, layers }], or null.
function switchLine(text) {
  const m = /^\s*-\s*Switch:\s*(.+?)\s*$/m.exec(String(text || ''));
  if (!m) return null;
  const states = m[1].split('|').map(s => {
    const [label, layers] = s.split('=');
    return { label: (label || '').trim(), layers: (layers || '').trim().split(/\s+/).filter(Boolean) };
  }).filter(s => s.label && s.layers.length);
  return states.length >= 2 ? states : null;
}
// "- Include: <Scene>" lines: other composed scenes drawn beneath this one, read-only, scripts and all.
const includeLines = text => [...String(text || '').matchAll(/^\s*-\s*Include:\s*(.+?)\s*$/gm)].map(m => m[1]);

// Scripts (web/tickable.js). A script file's URL, its time in it so an edit loads afresh, or null.
const scriptUrl = file => (fs.existsSync(path.join(ROOT, file)) ? `${file}?v=${Math.round(fs.statSync(path.join(ROOT, file)).mtimeMs)}` : null);
// A Unity prefab's C# scripts for the page: those with stand-ins (layout/scripts/<Name>.js) with
// their URL and saved fields, the rest only named (a probe lists them); and its objects, which
// stand-ins move.
function scriptsOf(p) {
  if (!p.scripts || !p.scripts.length) return {};
  const scripts = withScriptUrls(p.scripts.map(s => (s.fields ? s : { name: s.name, off: s.off })));
  return { scripts, ...(p.scripts.some(s => s.fields) ? { objects: p.objects } : {}) };
}
// A prefab's parts as served: their object keys (part.go) only where a stand-in may move them.
const servedParts = (p, parts) => ((p.scripts || []).some(s => s.fields) ? parts : parts.map(({ go, ...rest }) => rest));
// Stand-ins' URLs, fresh (a piece of an imported area keeps its scripts without them).
const withScriptUrls = scripts => scripts.map(s => (s.fields ? { ...s, url: scriptUrl(`scripts/${s.name}.js`) } : s));
// Descriptions of the materials stand-ins' fields name (Cage.cs's liveMat and deadMat), by guid.
function fieldMaterials(scripts, problems) {
  const idx = index();
  const guids = scripts.flatMap(s => Object.values(s.fields || {})).filter(v => v && v.asset && idx[v.asset] && idx[v.asset].path.endsWith('.mat')).map(v => v.asset);
  return guids.length ? shapeMaterials([...new Set(guids)], problems) : {};
}
// Layout's own prefabs (Ken, 2026-10-29), for what Canopy doesn't have or that layout runs
// differently (the Sea, Wind and Sky): layout/prefabs/<Name>.md, its "- Shape:" lines as a docs
// asset's (tools/shapes.js; "use X.prefab" nests that Unity prefab) and "- Script: <file> |
// settings" lines (a script in layout/, e.g. pfx/Wind.js). Never exported to Unity. By name:
// { source, shapes, scripts: [{ name, url, settings }], errors }.
const PREFABS = path.join(ROOT, 'prefabs');
function layoutPrefabs() {
  const out = {};
  if (!fs.existsSync(PREFABS)) return out;
  for (const file of fs.readdirSync(PREFABS).filter(f => f.endsWith('.md'))) {
    const name = file.slice(0, -3), source = `layout/prefabs/${file}`;
    const entry = out[name] = { source, shapes: [], scripts: [], errors: [] };
    for (const line of fs.readFileSync(path.join(PREFABS, file), 'utf8').split('\n')) {
      const shape = /^\s*-\s*Shape:\s*(.+?)\s*$/.exec(line), script = /^\s*-\s*Script:\s*([^|]+?)\s*(?:\|\s*(.*?))?\s*$/.exec(line);
      try {
        if (shape) entry.shapes.push(Shapes.parseShape(shape[1]));
        if (script) {
          const url = scriptUrl(script[1]);
          if (!url) throw new Error(`no layout/${script[1]}`);
          entry.scripts.push({ name: path.basename(script[1], '.js'), url, settings: script[2] || '' });
        }
      } catch (error) {
        entry.errors.push(`${source}: ${error.message}`);
      }
    }
  }
  return out;
}
// "assemblage: true" in a scene's frontmatter: it becomes a prefab of its own (tools/assemblage.js).
const isAssemblage = text => /^---\n[\s\S]*?^assemblage:\s*true\s*$[\s\S]*?^---$/m.test(String(text || '').replace(/\r\n/g, '\n'));
function formatPieceLine(p) {
  const s = p.scale;
  const scale = Math.abs(s[0] - s[1]) < 1e-4 && Math.abs(s[0] - s[2]) < 1e-4 ? String(round(s[0], 3)) : s.map(v => round(v, 3)).join(' ');
  return `- Piece: ${p.name} | ${p.position.map(v => round(v, 3)).join(' ')} | ${p.rotation.map(v => round(v, 2) % 360).join(' ')} | ${scale}${p.extra ? ' | ' + p.extra : ''}`;
}
// Replaces a note's Piece lines with these pieces, keeping all other text. New lines go where
// the first Piece line was, else at the end of the # Scene section, else at the end.
function replacePieceLines(text, pieces) {
  const lines = text.split('\n');
  const isPiece = l => /^\s*-\s*Piece:/.test(l);
  const first = lines.findIndex(isPiece);
  const kept = lines.filter(l => !isPiece(l));
  let at = kept.length;
  if (first >= 0) {
    at = lines.slice(0, first).length;
  } else {
    const scene = kept.findIndex(l => /^# Scene\s*$/.test(l));
    if (scene >= 0) {
      at = kept.length;
      for (let j = scene + 1; j < kept.length; j++) if (/^# /.test(kept[j])) { at = j; break; }
      while (at > scene + 2 && kept[at - 1].trim() === '') at--; // keep a blank line under the heading
    }
  }
  kept.splice(at, 0, ...pieces.map(formatPieceLine));
  return kept.join('\n').replace(/\n*$/, '\n');
}

// ---------- imported areas ----------
const isTreeChunk = (mesh, cfg) => Boolean(mesh && mesh.path && cfg.treeChunks.test(mesh.path));
// A material's name (its file name), for material rules.
let guidIndex = null;
const materialName = guid => {
  guidIndex = guidIndex || JSON.parse(fs.readFileSync(path.join(CACHE, 'guid-index.json'), 'utf8')).entries;
  const e = guid && guidIndex[guid];
  return e ? path.basename(e.path, '.mat') : '';
};

// Tree chunks (the trees cut into cubes; cfg.treeChunks) of any piece in the scene whose bounds
// overlap the cube, every LOD level of each, with the LOD rule the game uses for them: where a
// GridRender draws the chunks (Canopy's GridRender.TestLoDs) a 'grid' group per chunk (its
// part's position, objectSize times the tree's scale across, the GridGroup's cutoffs in percent of
// screen height); else the chunk's own LODGroup, resized as GridGroup.AdjustCutoffs does at
// startup (size objectSize, heights its cutoffs). Bounds come from each chunk's lowest-detail
// mesh, fetched once and cached. Returns [{ piece, parts, leaves, lodGroups }].
function treeChunks(all, center, half, cfg) {
  const idx = JSON.parse(fs.readFileSync(path.join(CACHE, 'guid-index.json'), 'utf8')).entries;
  const byPath = new Map(Object.values(idx).map(e => [e.path, e]));
  const lod = (part, k) => byPath.get(part.mesh.path.replace(/_L\d+\.asset$/, `_L${k}.asset`));
  const lowest = part => { for (let k = 9; k >= 0; k--) { const e = lod(part, k); if (e) return e; } return byPath.get(part.mesh.path); };
  const holders = all.filter(p => p.prefab && p.prefab.parts.some(x => isTreeChunk(x.mesh, cfg)));
  const bounds = fs.existsSync(CHUNK_BOUNDS) ? JSON.parse(fs.readFileSync(CHUNK_BOUNDS, 'utf8')) : {};
  const need = new Set();
  for (const p of holders) for (const part of p.prefab.parts) if (isTreeChunk(part.mesh, cfg)) { const e = lowest(part); if (e && !bounds[e.blob]) need.add(e.blob); }
  for (const [blob, data] of blobs([...need])) {
    const m = /m_LocalAABB:\s*m_Center: \{x: ([^,]+), y: ([^,]+), z: ([^}]+)\}\s*m_Extent: \{x: ([^,]+), y: ([^,]+), z: ([^}]+)\}/.exec(data.toString());
    if (m) bounds[blob] = { c: [+m[1], +m[2], +m[3]], e: [+m[4], +m[5], +m[6]] };
  }
  if (need.size) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(CHUNK_BOUNDS, JSON.stringify(bounds)); }
  const out = [];
  for (const p of holders) {
    const W = U.trs(p.pos, p.rot, p.scl);
    const visible = Config.visibleParts(cfg, p.piece, p.prefab.parts, materialName);
    const anyChunk = p.prefab.parts.find(part => isTreeChunk(part.mesh, cfg));
    const grid = anyChunk ? U.gridSettings(anyChunk.prefab, p.mods || [], p.addedScripts || []) : null;
    // A GridRender draws every chunk whose renderer is enabled, its Parts object being inactive
    // (GridRender switches it off, and scenes are saved that way): unity.json gridDrawsInactiveParts.
    const chunks = grid && grid.manual && cfg.gridDrawsInactiveParts
      ? Config.visibleParts(cfg, p.piece, p.prefab.parts.filter(part => isTreeChunk(part.mesh, cfg)).map(part => ({ ...part, off: part.rendererOff })), materialName)
      : visible.filter(part => isTreeChunk(part.mesh, cfg));
    const parts = [], lodGroups = {};
    const overlaps = part => {
      const e = lowest(part), b = e && bounds[e.blob];
      if (!b) return false;
      const M = U.mul(W, part.m);
      for (let a = 0; a < 3; a++) {
        // World extent along axis a of the chunk's local box.
        const c = M[a * 4] * b.c[0] + M[a * 4 + 1] * b.c[1] + M[a * 4 + 2] * b.c[2] + M[a * 4 + 3];
        const r = Math.abs(M[a * 4]) * b.e[0] + Math.abs(M[a * 4 + 1]) * b.e[1] + Math.abs(M[a * 4 + 2]) * b.e[2];
        if (c + r < center[a] - half || c - r > center[a] + half) return false;
      }
      return true;
    };
    for (const part of chunks) {
      if (!overlaps(part)) continue;
      const level = +((/_L(\d+)\.asset$/.exec(part.mesh.path) || [])[1] || 0);
      if (grid && grid.manual) {
        const key = 'grid:' + part.mesh.path.replace(/_L\d+\.asset$/, '');
        lodGroups[key] = { kind: 'grid', center: [part.m[3], part.m[7], part.m[11]], size: grid.objectSize * U.maxScale(part.m), cutoffs: grid.cutoffs, byDistance: cfg.gridLodByDistance, prefab: grid.prefab };
        parts.push({ ...part, lod: { key, levels: [level] } });
      } else if (part.lod && p.prefab.lodGroups[part.lod.key]) {
        const g = p.prefab.lodGroups[part.lod.key];
        const heights = g.heights.map((h, i) => (grid && grid.cutoffs[i] !== undefined ? grid.cutoffs[i] / 100 : h));
        lodGroups[part.lod.key] = { ...g, size: grid ? grid.objectSize * g.scale : g.size, heights };
        parts.push(part);
      } else parts.push(part);
    }
    // The tree's other shown parts (its leaves: one mesh for the whole tree, each LOD level) come
    // too, cut to the cube. Scenes save trees with leaves switched off; a show rule turns them on.
    // Where the scene adds a LeafSplit (it draws every leaf, instanced, from the placement mesh),
    // only the most detailed leaf mesh comes, cut leaf by leaf, with LeafSplit's distance limit and
    // thinning (the scene's, else unity.json's leafThinning to preview it).
    if (parts.length) {
      let leaves = 0;
      const split = leafSplitOf(p, cfg);
      for (const part of visible) {
        if (isTreeChunk(part.mesh, cfg) || part.mesh.kind !== 'asset') continue;
        if (split) {
          if (part.lod && !part.lod.levels.includes(0)) continue;
          const plain = { ...part };
          delete plain.lod;
          parts.push({ ...plain, clip: { world: W, center, half, leaves: split.leafCount }, leafSplit: split });
        } else {
          parts.push({ ...part, clip: { world: W, center, half } });
          if (part.lod && p.prefab.lodGroups[part.lod.key]) lodGroups[part.lod.key] = p.prefab.lodGroups[part.lod.key];
        }
        leaves++;
      }
      out.push({ piece: p, parts, leaves, lodGroups, grid, leafSplit: split });
    }
  }
  return out;
}
// The LeafSplit a scene adds to a tree instance, as { maxDistance, leafCount, thin: { start,
// end, keep, grow, from } }, or null. Its leaf count is its placement mesh's vertices over
// vertsPerLeaf.
function leafSplitOf(p, cfg) {
  const guid = U.scriptGuid('LeafSplit');
  const ls = (p.addedScriptBodies || []).find(x => x.guid === guid);
  if (!ls) return null;
  const field = k => { const m = new RegExp('\\n {2}' + k + ': (\\S+)').exec(ls.body); return m ? parseFloat(m[1]) : undefined; };
  const placement = /\n {2}placementMesh: \{fileID: \d+, guid: (\w+)/.exec(ls.body);
  const idx = JSON.parse(fs.readFileSync(path.join(CACHE, 'guid-index.json'), 'utf8')).entries;
  const mesh = placement && idx[placement[1]];
  let leafCount = 1000;
  if (mesh && mesh.blob) {
    const text = blobs([mesh.blob]).get(mesh.blob);
    const m = text && /m_VertexCount: (\d+)/.exec(text.toString());
    if (m) leafCount = +m[1] / (field('vertsPerLeaf') || 5);
  }
  const keep = field('thinKeep');
  const thin = keep !== undefined && keep < 1
    ? { start: field('thinStart'), end: field('thinEnd'), keep, grow: field('thinGrow') !== 0, from: 'scene' }
    : { ...cfg.leafThinning, from: 'unity.json' };
  return { maxDistance: field('maxRenderDistance') ?? 400, leafCount, thin };
}
// Candidate meshes (cache/candidates/<Canopy path>, written by tools such as dice.js --candidate):
// every part showing a mesh that has one gets a twin showing the candidate; the page shows one set
// or the other (☰ Candidate trees). Read when a scene loads, so new candidates show on reload.
const CANDIDATES = path.join(CACHE, 'candidates');
// A candidate's own LOD cutoffs (cache/candidates/<prefab>.lod.json, from tree-build.js) go on its
// GridRender groups as candidateCutoffs.
// A candidate mesh file's id and whether it is empty, remembered while the server runs and read
// again only when its size or time changes (reading ~700 of them each load took seconds).
const candidateInfo = new Map();
function candidateFile(file) {
  const s = fs.statSync(file), seen = candidateInfo.get(file);
  if (seen && seen.mtimeMs === s.mtimeMs && seen.size === s.size) return seen;
  const data = fs.readFileSync(file);
  const info = { mtimeMs: s.mtimeMs, size: s.size, blob: 'cand-' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 20), empty: /indexCount: 0\b/.test(data.toString('latin1', 0, 2000)) };
  candidateInfo.set(file, info);
  return info;
}
function withCandidates(pieces) {
  return Timing.time('candidates', () => candidatesIn(pieces));
}
function candidatesIn(pieces) {
  if (!listing(CANDIDATES).size) return 0;
  let count = 0;
  for (const piece of pieces) {
    for (const g of Object.values(piece.lodGroups || {})) {
      const file = g.kind === 'grid' && g.prefab && cached(CANDIDATES, g.prefab + '.lod.json') && path.join(CANDIDATES, g.prefab + '.lod.json');
      if (file) g.candidateCutoffs = JSON.parse(fs.readFileSync(file, 'utf8')).cutoffs;
    }
    if (!piece.parts) continue;
    const twins = [];
    for (const part of piece.parts) {
      const file = part.mesh && part.mesh.kind === 'asset' && part.mesh.path && cached(CANDIDATES, part.mesh.path) && path.join(CANDIDATES, part.mesh.path);
      if (!file) continue;
      const { blob, empty } = candidateFile(file);
      part.set = 'shipped';
      // An empty candidate (its triangles all went to neighbors) has no twin: nothing shows there.
      if (!empty) twins.push({ ...part, set: 'candidate', mesh: { ...part.mesh, blob, file } });
      // Strips beside it (<chunk>.strips.asset, tree-build.js): drawn with the strip shader.
      for (const [suffix, extra] of [['.strips.asset', { strip: true }]]) {
        const side = file.replace(/\.asset$/, suffix);
        if (!cached(CANDIDATES, part.mesh.path.replace(/\.asset$/, suffix))) continue;
        const { blob: sblob, empty: sempty } = candidateFile(side);
        if (sempty) continue;
        twins.push({ ...part, set: 'candidate', ...extra, mesh: { ...part.mesh, name: part.mesh.name + suffix.replace(/\.asset$/, ''), blob: sblob, file: side } });
      }
      count++;
    }
    piece.parts.push(...twins);
  }
  return count;
}
// The LOD groups these parts use.
// The LODGroups a piece's parts (and its stand-ins: a particle system at one level) use.
const groupsFor = (parts, groups, scripts = []) => {
  const used = {};
  for (const x of [...parts, ...scripts]) if (x.lod && groups && groups[x.lod.key]) used[x.lod.key] = groups[x.lod.key];
  return used;
};

// A piece's game fields as served: { never } or { when }, and moved as a placement in Unity's terms.
function gamePlacement(game) {
  if (!game) return {};
  const { moved, ...gate } = game;
  if (!moved) return gate;
  const e = U.quatToEuler(moved.rot);
  return { ...gate, moved: { when: moved.when, position: [moved.pos.x, moved.pos.y, moved.pos.z].map(v => round(v, 3)), rotation: [e.x, e.y, e.z].map(v => round(v, 2) % 360), scale: [moved.scl.x, moved.scl.y, moved.scl.z].map(v => round(v, 3)) } };
}
// A tree's parts are drawn as GridRender draws them, whatever their objects' conditions.
const plainParts = parts => parts.map(({ when, never, offSaved, ...rest }) => rest);

// terrainOnly: only the trees (their chunks, as grid trees bring them), e.g. the Tangle's
// GridTangle without the scene's gameplay pieces.
function extractArea(scene, center, half, terrainOnly = false) {
  const file = path.join(U.REPO, 'Assets', 'Scenes', scene + '.unity');
  if (!fs.existsSync(file)) throw new Error(`no scene ${scene}`);
  const inside = p => Math.abs(p.pos.x - center[0]) <= half && Math.abs(p.pos.y - center[1]) <= half && Math.abs(p.pos.z - center[2]) <= half;
  const cfg = Config.load(scene);
  const all = U.scenePieces(file);
  const found = all.filter(p => inside(p) && !isTreeChunk(p.mesh, cfg)).sort((a, b) => a.path.localeCompare(b.path));
  const trees = treeChunks(all, center, half, cfg);
  // Plain-mesh pieces are named by their mesh; remember how they resolve.
  const lib = library();
  const meshPart = p => ({ mesh: p.mesh, m: U.I(), ...(p.layer ? { layer: p.layer } : {}), material: p.material || null, ...(p.materials ? { materials: p.materials } : {}), object: p.object, prefab: '', off: Boolean(p.meshOff) });
  for (const p of found) if (!p.prefab && !p.lightOnly && !lib[p.piece]) lib[p.piece] = { kind: 'mesh', source: p.mesh.path || p.mesh.kind, parts: [meshPart(p)] };
  writeLibrary(lib);
  const place = (p, parts, extra, lodGroups) => {
    const e = U.quatToEuler(p.rot);
    return {
      name: p.piece, path: p.path,
      // A piece with its own parts also carries where it comes from (for the folder filter),
      // so the viewer never resolves (and fetches) the whole prefab.
      ...(parts ? { parts, source: p.prefab ? p.prefab.path : (p.mesh && p.mesh.path) || '' } : {}),
      ...(lodGroups && Object.keys(lodGroups).length ? { lodGroups } : {}),
      position: [p.pos.x, p.pos.y, p.pos.z].map(v => round(v, 3)),
      rotation: [e.x, e.y, e.z].map(v => round(v, 2) % 360),
      scale: [p.scl.x, p.scl.y, p.scl.z].map(v => round(v, 3)),
      extra: [p.textId ? `textId ${p.textId}` : '', p.active ? '' : 'inactive', p.guards ? `guards ${p.guards}` : '', extra || ''].filter(Boolean).join(', '),
      // in the game (web/conditions.js): never on, or on while its when holds; moved, where its triggers put it
      ...gamePlacement(p.game),
      // its point Lights (More Lights phase 4), in its own space as its parts' matrices are
      ...(((p.prefab && p.prefab.lights) || p.lights || []).length ? { lights: (p.prefab && p.prefab.lights) || p.lights } : {}),
      // its C# scripts that have stand-ins (their URLs are added when a scene loads), and the objects they move
      ...(p.prefab && (p.prefab.scripts || []).some(s => s.fields) ? { scripts: p.prefab.scripts.filter(s => s.fields), ...(p.prefab.objects ? { objects: p.prefab.objects } : {}) } : {})
    };
  };
  // Every imported piece carries its own parts, filtered by the scene's show and hide rules
  // (unity.json). A piece whose parts are all switched off or hidden is left out; one with no
  // meshes at all stays, as a labeled box. A tree brings only its overlapping chunks.
  const pieces = [];
  for (const imported of terrainOnly ? [] : found) {
    if (trees.some(t => t.piece === imported)) continue;
    // a gem locus brings the gem the game makes on it (tools/gems.js)
    const p = imported.prefab ? { ...imported, prefab: Gems.withGem(imported.prefab, imported.scl) } : imported;
    const parts = p.prefab ? p.prefab.parts : p.lightOnly ? [] : [meshPart(p)];
    const shown = Config.visibleParts(cfg, p.piece, parts, materialName);
    if (parts.length && !shown.length) continue;
    pieces.push(place(p, p.prefab ? servedParts(p.prefab, shown) : shown, '', groupsFor(shown, p.prefab && p.prefab.lodGroups, ((p.prefab && p.prefab.scripts) || []).filter(s => s.fields))));
  }
  for (const t of trees) pieces.push(place({ ...t.piece, game: null }, plainParts(t.parts), `tree chunk meshes: ${t.parts.length - t.leaves}${t.leaves ? (t.leafSplit ? `, LeafSplit leaves (thinning from ${t.leafSplit.thin.from})` : ', leaves') : ''}${t.grid && t.grid.manual ? ', GridRender LODs' : ''}`, t.lodGroups));
  return { source: { scene, center, half, terrainOnly, config: Config.extractKey(scene) }, pieces };
}
function saveArea(name, area) {
  fs.mkdirSync(AREAS, { recursive: true });
  fs.writeFileSync(path.join(AREAS, name + '.json'), JSON.stringify(area, null, 1));
}

// ---------- piece library and meshes ----------
// The library, kept in memory while its file is as this process last read or wrote it (another
// tool may write it too), and written only when it changed: a load prepares a dozen times, and
// each read and wrote its 2 MB (Ken, 2026-11-04: a reload took 12 s).
let libraryKept = null; // { lib, text, stamp }
const libraryStamp = () => { try { const st = fs.statSync(LIBRARY); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };
function library() {
  const stamp = libraryStamp();
  if (libraryKept && libraryKept.stamp === stamp) return libraryKept.lib;
  const text = stamp ? fs.readFileSync(LIBRARY, 'utf8') : '{}';
  libraryKept = { lib: JSON.parse(text), text, stamp };
  return libraryKept.lib;
}
function writeLibrary(lib) {
  const text = JSON.stringify(lib);
  if (libraryKept && libraryKept.lib === lib && libraryKept.text === text && libraryKept.stamp === libraryStamp()) return;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(LIBRARY, text);
  libraryKept = { lib, text, stamp: libraryStamp() };
}
const git = (args, input, env) => execFileSync('git', GIT.concat(args), { input, maxBuffer: 1 << 30, env: { ...process.env, ...env } });
// cat-file --batch output -> Map(id -> Buffer)
function readBatch(out, into) {
  for (let i = 0; i < out.length;) {
    const nl = out.indexOf(10, i);
    const [oid, type, size] = out.slice(i, nl).toString().split(' ');
    if (type === 'missing') { i = nl + 1; continue; }
    into.set(oid, out.subarray(nl + 1, nl + 1 + +size));
    i = nl + 1 + +size + 1;
  }
  return into;
}
// Blob contents (Buffers) by id: from Canopy's store when there, else fetched from origin in
// one request into the throwaway store, which is deleted afterwards.
function blobs(ids) {
  return ids.length ? Timing.time('git', () => readBlobs(ids)) : new Map();
}
function readBlobs(ids) {
  const noFetch = { GIT_NO_LAZY_FETCH: '1' };
  const missing = git(['cat-file', '--batch-check'], ids.join('\n') + '\n', noFetch)
    .toString().split('\n').filter(l => l.endsWith(' missing')).map(l => l.split(' ')[0]);
  const present = ids.filter(id => !missing.includes(id));
  const out = readBatch(present.length ? git(['cat-file', '--batch'], present.join('\n') + '\n', noFetch) : Buffer.alloc(0), new Map());
  // Uncommitted files (tools/guid-index.js marks them local) are read from the working tree.
  const local = new Map(Object.values(index()).filter(e => e.local && e.blob).map(e => [e.blob, e.path]));
  for (const id of missing.filter(id => local.has(id))) out.set(id, fs.readFileSync(path.join(U.REPO, local.get(id))));
  missing.splice(0, missing.length, ...missing.filter(id => !local.has(id)));
  if (missing.length) {
    const url = git(['config', '--get', 'remote.origin.url']).toString().trim();
    const tmp = ['--git-dir=' + FETCH_STORE];
    const run = (args, input) => execFileSync('git', tmp.concat(args), { input, maxBuffer: 1 << 30 });
    fs.rmSync(FETCH_STORE, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--bare', FETCH_STORE]);
    Timing.count('fetched from origin', missing.length);
    try {
      for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', url], ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none']]) run(['config', k, v]);
      run(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head',
        '--recurse-submodules=no', '--filter=blob:none', '--stdin'], missing.join('\n') + '\n');
      readBatch(execFileSync('git', tmp.concat(['cat-file', '--batch']), { input: missing.join('\n') + '\n', maxBuffer: 1 << 30, env: { ...process.env, ...noFetch } }), out);
    } finally {
      fs.rmSync(FETCH_STORE, { recursive: true, force: true });
    }
  }
  return out;
}
// Library entries for these piece names: prefabs are re-read each time (so edits show), their
// .asset meshes fetched and converted once per blob. A name ending .fbx or .obj is that model file. part.obj is the mesh URL, or null.
// extraParts (pieces' own parts, from instances with inner overrides) get meshes too.
function prepare(names, extraParts = []) {
  const lib = library();
  const cfg = Config.load(null); // composed scenes use the defaults
  const out = {}, problems = [];
  Timing.count('prepares');
  for (const name of new Set(names)) {
    // An inspection model a tool wrote (cache/inspect/<Name>.obj and .json, e.g. by
    // tools/mesh-clean.js): drawn lit in its color (in its material, if it names one, when Textures
    // is on), its own folder so ☰ Folders toggles it. side "front" or "back" draws only that side
    // (default both): a back-only copy of a front-only surface lines its inside.
    const inspect = /^inspect:([\w .-]+)$/.exec(name);
    if (inspect) {
      const file = path.join(CACHE, 'inspect', inspect[1] + '.obj');
      if (!fs.existsSync(file)) {
        problems.push(`${name}: no cache/inspect/${inspect[1]}.obj (made by a tool such as tools/mesh-clean.js --inspect)`);
        continue;
      }
      let look = {};
      try { look = JSON.parse(fs.readFileSync(file.replace(/\.obj$/, '.json'), 'utf8')); } catch { /* default look */ }
      const obj = `inspect/${encodeURIComponent(inspect[1])}.obj?v=${Math.round(fs.statSync(file).mtimeMs)}`;
      out[name] = { kind: 'inspect', source: `Inspect/${inspect[1]}/model`, parts: [{ mesh: { kind: 'inspect', name: inspect[1] }, m: U.I(), material: look.material || null, object: inspect[1], prefab: '', off: false, inspect: { color: look.color || '#ffffff', opacity: look.opacity ?? 1, side: look.side || 'both' }, obj }], lodGroups: {} };
      continue;
    }
    if (!(lib[name] && lib[name].kind === 'mesh')) {
      // A model file by name ("LeafSingle.fbx"), placed whole, or a prefab ("Sea.prefab" names the
      // Unity prefab even where a layout prefab shares its name).
      const model = /\.(fbx|obj)$/i.test(name) && Object.entries(index()).find(([, e]) => e.path.endsWith('/' + name));
      const p = Timing.time('prefabs', () => (model ? U.modelInstance(model[0], []) : U.prefabByName(name.replace(/\.prefab$/i, ''))));
      if (p) lib[name] = { kind: model ? 'model' : 'prefab', source: p.path, parts: servedParts(p, p.parts), takesText: Boolean(p.takesText), lodGroups: p.lodGroups || {}, ...((p.lights || []).length ? { lights: p.lights } : {}), ...scriptsOf(p) };
    }
    if (lib[name]) out[name] = { ...lib[name], parts: Config.visibleParts(cfg, name, lib[name].parts, materialName) };
  }
  const allParts = [...Object.values(out).flatMap(e => e.parts), ...extraParts];
  // A part with several materials takes its own file, which knows its submeshes (those converted
  // before they were written out stay as they are, under the plain name).
  const assetFile = p => (p.materials ? `${p.mesh.blob}-${SUBMESHES}` : p.mesh.blob) + '.obj';
  const wanted = new Map(), wantedFiles = new Map();
  for (const part of allParts) {
    if (part.mesh.kind !== 'asset' || !part.mesh.blob || cached(MESHES, assetFile(part))) continue;
    wanted.set(part.mesh.blob, part.mesh.name);
    wantedFiles.set(part.mesh.blob, new Set([...(wantedFiles.get(part.mesh.blob) || []), assetFile(part)]));
  }
  fs.mkdirSync(MESHES, { recursive: true });
  const candidateFiles = new Map(allParts.filter(p => p.mesh.file).map(p => [p.mesh.blob, p.mesh.file]));
  const fromCanopy = blobs([...wanted.keys()].filter(b => !candidateFiles.has(b)));
  for (const b of wanted.keys()) if (candidateFiles.has(b)) fromCanopy.set(b, fs.readFileSync(candidateFiles.get(b)));
  for (const [blob, data] of fromCanopy) {
    try {
      const obj = Timing.time('meshes converted', () => assetToObj(data.toString(), wanted.get(blob)));
      for (const file of wantedFiles.get(blob)) {
        fs.writeFileSync(path.join(MESHES, file), obj);
        written(MESHES, file);
      }
      Timing.count('meshes converted');
    } catch (error) {
      problems.push(`${wanted.get(blob)}: ${error.message}`);
    }
  }
  // FBX models: one OBJ per model used, named by the file's blob and the model.
  const fbxParts = allParts.filter(p => p.mesh.kind === 'model' && !p.mesh.whole && p.mesh.blob && /\.fbx$/i.test(p.mesh.path));
  const fbxKey = p => `${p.mesh.blob}-${crypto.createHash('sha1').update(`${p.mesh.listed ? p.mesh.name : ''}|${p.object || ''}|${p.mesh.fileID || ''}${/^43\d{5}$/.test(p.mesh.fileID || '') ? '' : '|hashed'}|submeshes`).digest('hex').slice(0, 8)}`;
  const fbxWanted = fbxParts.filter(p => !cached(MESHES, fbxKey(p) + '.obj'));
  const fbxFiles = blobs([...new Set(fbxWanted.map(p => p.mesh.blob))]);
  const idx = index();
  const scenes = new Map();
  for (const p of fbxWanted) {
    try {
      if (!scenes.has(p.mesh.blob)) scenes.set(p.mesh.blob, FBX.readScene(fbxFiles.get(p.mesh.blob)));
      const scene = scenes.get(p.mesh.blob);
      const model = FBX.findModel(scene, p.mesh.listed ? p.mesh.name : null, p.object, p.mesh.fileID);
      if (!model) throw new Error(`no single mesh matches ${p.object || p.mesh.name}`);
      const settings = (idx[p.mesh.guid] || {}).import;
      fs.writeFileSync(path.join(MESHES, fbxKey(p) + '.obj'), FBX.modelToObj(scene, model, FBX.importScale(scene, settings), `${p.mesh.path} ${model.name}`));
      written(MESHES, fbxKey(p) + '.obj');
    } catch (error) {
      problems.push(`${p.mesh.path}: ${error.message}`);
    }
  }
  // Model files placed whole (FBX or OBJ): one OBJ per file and root-scale choice.
  const wholeParts = allParts.filter(p => p.mesh.kind === 'model' && p.mesh.whole && p.mesh.blob);
  const wholeKey = p => `${p.mesh.blob}-${crypto.createHash('sha1').update(`whole|${p.mesh.keepRootScale ? 1 : 0}`).digest('hex').slice(0, 8)}`;
  const wholeWanted = wholeParts.filter(p => !cached(MESHES, wholeKey(p) + '.obj'));
  const wholeFiles = blobs([...new Set(wholeWanted.map(p => p.mesh.blob))]);
  for (const p of wholeWanted) {
    try {
      const data = wholeFiles.get(p.mesh.blob);
      if (!data) throw new Error('could not fetch');
      const settings = (idx[p.mesh.guid] || {}).import || {};
      let obj;
      if (/\.obj$/i.test(p.mesh.path)) obj = objModelToObj(data.toString(), settings.globalScale ?? 1, p.mesh.path);
      else if (/\.fbx$/i.test(p.mesh.path)) {
        const scene = FBX.readScene(data);
        obj = FBX.wholeModelToObj(scene, FBX.importScale(scene, settings), p.mesh.keepRootScale, p.mesh.path);
      } else throw new Error('only FBX and OBJ models are read');
      fs.writeFileSync(path.join(MESHES, wholeKey(p) + '.obj'), obj);
      written(MESHES, wholeKey(p) + '.obj');
    } catch (error) {
      problems.push(`${p.mesh.path}: ${error.message}`);
    }
  }
  for (const part of allParts) {
    if (part.mesh.kind === 'inspect') continue; // its own URL already
    if (wholeParts.includes(part)) {
      part.obj = cached(MESHES, wholeKey(part) + '.obj') ? `meshes/${wholeKey(part)}.obj` : null;
      continue;
    }
    if (fbxParts.includes(part)) {
      part.obj = cached(MESHES, fbxKey(part) + '.obj') ? `meshes/${fbxKey(part)}.obj` : null;
      continue;
    }
    part.obj = part.mesh.kind === 'asset' && cached(MESHES, assetFile(part)) ? `meshes/${assetFile(part)}` : null;
  }
  // Parts cut to an area's cube (a tree's leaves): keep the triangles whose center is inside.
  for (const part of allParts) {
    if (!part.clip || !part.obj) continue;
    const key = crypto.createHash('sha1').update(JSON.stringify([part.mesh.blob, part.m, part.clip])).digest('hex').slice(0, 8);
    const file = path.join(MESHES, `${part.mesh.blob}-${key}.obj`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, clipObj(fs.readFileSync(path.join(ROOT, 'cache', part.obj), 'utf8'), U.mul(part.clip.world, part.m), part.clip.center, part.clip.half, part.clip.leaves));
    part.obj = `meshes/${part.mesh.blob}-${key}.obj`;
  }
  writeLibrary(lib);
  const materials = prepareMaterials(allParts.flatMap(p => [p.material, ...(p.materials || [])]).filter(Boolean), problems, cfg.maxTexture);
  // A material tools/convert-materials.js moved onto a Canopy shader carries its copy as it was,
  // on Unity's, as unity: ☰ View › Unity's shaders draws that (More Lights phase 3).
  const pairs = new Map(Convert.switchPairs());
  const converted = Object.keys(materials).filter(g => pairs.has(g));
  if (converted.length) {
    const copies = prepareMaterials(converted.map(g => pairs.get(g)), problems, cfg.maxTexture);
    for (const g of converted) materials[g] = { ...materials[g], unity: copies[pairs.get(g)] || null };
  }
  return { library: out, materials, problems };
}

// ---------- materials and textures ----------
const BUILTIN_SHADERS = '0000000000000000f000000000000000';
const SHADERS = path.join(CACHE, 'shaders.json');
// What a custom shader does with alpha, and its surface function if it has one, read from its
// source once and cached by blob (so an edited working-tree shader is read again). By guid.
function shaderFlags(shaders, idx) {
  const cache = fs.existsSync(SHADERS) ? JSON.parse(fs.readFileSync(SHADERS, 'utf8')) : {};
  const guids = [...new Set(shaders.map(s => s.guid))].filter(g => idx[g] && idx[g].blob && /\.shader$/.test(idx[g].path));
  const want = guids.filter(g => !cache[idx[g].blob] || !('queue' in cache[idx[g].blob]));
  const texts = blobs(want.map(g => idx[g].blob));
  for (const g of want) {
    const src = (texts.get(idx[g].blob) || '').toString();
    if (!src) continue; // not fetched: no flags, read again next time
    cache[idx[g].blob] = {
      cutout: /\bclip\s*\(|"Queue"\s*=\s*"AlphaTest/.test(src),
      transparent: /"Queue"\s*=\s*"Transparent|\bBlend\s+SrcAlpha\s+OneMinusSrcAlpha/.test(src),
      surface: surfaceOf(src),
      cull: cullOf(src),
      colors: ['_Tint', '_BaseColor', '_Color'].filter(name => new RegExp(`\\b${name}\\b`).test(codeOf(src))), // the base colors it reads
      name: (/^\s*Shader\s+"([^"]+)"/m.exec(src) || [])[1] || '',
      queue: queueOf(src)
    };
  }
  if (want.length) fs.writeFileSync(SHADERS, JSON.stringify(cache));
  return Object.fromEntries(guids.map(g => [g, cache[idx[g].blob]]));
}
// A shader's render queue, from its first Queue tag ("Transparent", "Geometry+1"), or null (Unity's
// default, Geometry). Unity draws by queue first: below 2500 opaque, from 2500 transparent.
const QUEUES = { background: 1000, geometry: 2000, alphatest: 2450, geometrylast: 2500, transparent: 3000, overlay: 4000 };
function queueOf(src) {
  const m = /"Queue"\s*=\s*"\s*(\w+)\s*(?:([+-])\s*(\d+))?\s*"/.exec(codeOf(src));
  if (!m || !(m[1].toLowerCase() in QUEUES)) return null;
  return QUEUES[m[1].toLowerCase()] + (m[2] ? (m[2] === '-' ? -1 : 1) * +m[3] : 0);
}
// A shader's source without its comments.
const codeOf = src => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*/, '')).join('\n');
// Which faces a shader draws: its first Cull (Back, Front, Off; Unity's default is Back), or the
// material property that sets it ("Cull [_CullMode]": { property }).
function cullOf(src) {
  const code = codeOf(src);
  const m = /^\s*Cull\s+(\[\s*(\w+)\s*\]|Back|Front|Off)/mi.exec(code);
  if (!m) return 'Back';
  return m[2] ? { property: m[2] } : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
}
// A surface shader's parts for web/surface.js: its properties and the code between the MODL
// SURFACE markers (modl/tools/shaders.js writes them; any Canopy shader may have them). Or null.
function surfaceOf(src) {
  src = src.replace(/\r\n/g, '\n');
  const code = /\/\/ MODL SURFACE BEGIN\n([\s\S]*?)[ \t]*\/\/ MODL SURFACE END/.exec(src);
  const block = /\bProperties\s*\{([^}]*)\}/.exec(src);
  if (!code || !block) return null;
  const properties = [];
  for (const line of block[1].split('\n')) {
    const m = /^\s*(?:\[[^\]]*\]\s*)*(_\w+)\s*\(\s*"[^"]*"\s*,\s*(Color|Vector|Float|Int|Range)\b[^=]*=\s*(.+?)\s*$/.exec(line);
    if (m) properties.push({ name: m[1], type: m[2], value: m[3].replace(/[()]/g, '').split(',').map(Number) });
  }
  return { name: (/^\s*Shader\s+"([^"]+)"/m.exec(src) || [])[1] || '', properties, code: code[1] };
}
// Work shared by one request's prepare calls (server.js calls beginRequest for each): the parsed
// guid index and the working tree's textures, each read at most once. A request for the New
// Assets scene prepares each asset's prefab in turn; reading these per call took most of a minute.
let shared = {};
const beginRequest = () => {
  shared = {};
  U.refreshIndex();
  guidIndex = null; // materialName's
};
const index = () => shared.index || (shared.index = JSON.parse(fs.readFileSync(path.join(CACHE, 'guid-index.json'), 'utf8')).entries);
// What a cache folder holds (paths relative to it, recursively), read once a request: on shared
// storage each existsSync costs about as much as listing a folder, and a load checked thousands
// (2026-10-29). Files a request writes are noted in it (written).
// Kept across requests too (listings), while none of its folders has changed (a folder's time
// changes when a file is added to it or removed): walking them took a second or two a load
// (Ken, 2026-11-04).
const listings = new Map(); // dir -> { out, folders: Map(folder, mtime) }
function listing(dir) {
  const key = 'list:' + dir;
  if (!shared[key]) {
    const kept = listings.get(dir);
    const mtime = d => { try { return fs.statSync(d).mtimeMs; } catch { return -1; } };
    if (kept && Timing.time('cache listings checked', () => [...kept.folders].every(([d, t]) => mtime(d) === t))) {
      shared[key] = kept.out;
      return kept.out;
    }
    const out = new Set(), folders = new Map();
    const walk = (d, rel) => {
      let entries;
      folders.set(d, mtime(d));
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/'); else out.add(rel + e.name);
    };
    Timing.time('cache listings', () => walk(dir, ''));
    listings.set(dir, { out, folders });
    shared[key] = out;
  }
  return shared[key];
}
const cached = (dir, name) => listing(dir).has(name);
const written = (dir, name) => listing(dir).add(name);
// Reads what the viewer needs from a .mat: base color, color texture, normal map, and (for
// Canopy/General) the detail texture, each texture with its tiling and offset. Bump
// MATERIAL_PARSER when what it reads changes, so cached materials are read again.
const MATERIAL_PARSER = 7;
function parseMaterial(text) {
  text = text.replace(/\r\n/g, '\n');
  const tex = name => {
    const m = new RegExp('- ' + name + ':\\n\\s+m_Texture: \\{fileID: (-?\\d+)(?:, guid: ([0-9a-f]+))?[^\\n]*\\n\\s+m_Scale: \\{x: ([^,]+), y: ([^}]+)\\}\\n\\s+m_Offset: \\{x: ([^,]+), y: ([^}]+)\\}').exec(text);
    return m && m[2] && m[1] !== '0' ? { guid: m[2], scale: [+m[3], +m[4]], offset: [+m[5], +m[6]] } : null;
  };
  const color = name => {
    const m = new RegExp('- ' + name + ': \\{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\\}').exec(text);
    return m ? [+m[1], +m[2], +m[3], +m[4]] : null;
  };
  const float = name => {
    const m = new RegExp('- ' + name + ': (-?[\\d.e+-]+)').exec(text);
    return m ? +m[1] : null;
  };
  const general = /- _Tint: /.test(text); // Canopy/General: base * detail * tint * brightness
  // See-through only as Unity would draw it: Standard Fade/Transparent mode, a URP transparent
  // surface, blend keywords, or a transparent render queue. Otherwise color alpha is ignored.
  const queue = +((/m_CustomRenderQueue: (-?\d+)/.exec(text) || [])[1] ?? -1);
  const transparent = [2, 3].includes(float('_Mode')) || float('_Surface') === 1 || queue >= 3000
    || /_ALPHABLEND_ON|_ALPHAPREMULTIPLY_ON|_SURFACE_TYPE_TRANSPARENT/.test(text);
  const shader = (/m_Shader: \{fileID: (-?\d+), guid: ([0-9a-f]+)/.exec(text) || []).slice(1);
  // The property the base color comes from: a custom shader that never reads it isn't tinted (see prepareMaterials).
  const colorProperty = (general && color('_Tint') && '_Tint') || (color('_BaseColor') && '_BaseColor') || (color('_Color') && '_Color') || null;
  return {
    parser: MATERIAL_PARSER,
    shader: shader.length ? { fileID: shader[0], guid: shader[1] } : null,
    // Cutout (alpha test): Standard Cutout mode, URP alpha clip, or the keyword. Custom shaders
    // are checked in their source (see shaderFlags).
    cutout: float('_Mode') === 1 || float('_AlphaClip') === 1 || /_ALPHATEST_ON/.test(text),
    cutoff: float('_Cutoff') ?? 0.5,
    transparent,
    customQueue: queue, // its own render queue, or -1 for its shader's (see prepareMaterials)
    name: (/m_Name: (.*)/.exec(text) || [])[1] || '',
    color: (colorProperty && color(colorProperty)) || [1, 1, 1, 1],
    colorProperty,
    brightness: general ? (float('_Brightness') ?? 1) : 1,
    general,
    map: tex('_MainTex') || tex('_BaseMap') || tex('_BaseColorMap') || tex('_Tex'), // _Tex: a skybox's
    normal: tex('_NormalMap') || tex('_BumpMap'),
    normal1: tex('_Normal1'), normal2: tex('_Normal2'), // the sea's two (SeaSurface, WaterBelow)
    noise: tex('_NoiseTex'), // clouds' and goop's mottling (CloudTextured, Goop)
    detail: general ? tex('_DetailTex') : null,
    emission: tex('_EmissionMap'), // Standard's emission and GlowLit's constant glow
    glow: tex('_GlowTex'), // GlowLit's and the glow surface shaders' thresholded glow
    // Every float and color (or vector) property, for surface shaders (web/surface.js).
    values: Object.fromEntries([
      ...[...text.matchAll(/^\s+- (_\w+): (-?[\d.e+-]+)$/gm)].map(m => [m[1], [+m[2]]]),
      ...[...text.matchAll(/^\s+- (_\w+): \{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\}$/gm)].map(m => [m[1], m.slice(2, 6).map(Number)])
    ])
  };
}
// Stores a texture at most MAX_TEXTURE px (unity.json maxTexture) on a side, as PNG (JPG stays JPG), using ImageMagick.
// TIF and PSD extra channels become alpha, as Unity reads them. alpha: its .meta's Alpha Source
// (tools/guid-index.js): 0 none (opaque), 2 from gray scale (the average of R, G and B, as Unity
// makes it), else its own. Returns false if it can't.
const ALPHA_FROM = {
  0: ['-alpha', 'off'],
  2: ['-alpha', 'off', '(', '+clone', '-channel', 'RGB', '-separate', '+channel', '-evaluate-sequence', 'mean', ')', '-compose', 'CopyOpacity', '-composite']
};
function storeTexture(data, ext, dest, MAX_TEXTURE, alpha, fromGray) {
  const fmt = { jpg: 'jpg', jpeg: 'jpg', tif: 'tiff', tiff: 'tiff', psd: 'psd', tga: 'tga', png: 'png' }[ext];
  if (fromGray) return storeNormalFromGray(data, fmt, dest, MAX_TEXTURE, fromGray);
  const run = extra => execFileSync('magick', [`${fmt}:-[0]`, ...extra, '-resize', `${MAX_TEXTURE}x${MAX_TEXTURE}>`, '-depth', '8', dest], { input: data, stdio: ['pipe', 'ignore', 'pipe'] });
  if (ALPHA_FROM[alpha]) return run(ALPHA_FROM[alpha]);
  try {
    run(fmt === 'tiff' || fmt === 'psd' ? ['-channel-fx', 'meta0=>alpha'] : []);
  } catch {
    run([]); // no extra channel
  }
}
// A texture's source and how Unity imports it, for tools/texture-astc.js.
function textureSource(guid) {
  const file = workingTreeTextures()[guid], e = index()[guid];
  return { data: file ? fs.readFileSync(file) : blobs([e.blob]).get(e.blob), ext: /\.(\w+)$/.exec(file || e.path)[1].toLowerCase(), alpha: e.alpha, fromGray: e.fromGray };
}
// A Normal Map Unity makes from a gray height map as it imports it (Create from Grayscale), at the
// source's size, then shrunk: the height is the average of R, G and B; its slope by forward
// differences (Filtering: Smooth) or a Sobel filter, unnormalized as such filters usually are
// (Sharp), wrapping at the edges, in steps of 1/255 times Bumpiness (scale); the normal (-slope u,
// -slope v, 1), v up the image as Unity's is, stored as Unity stores a normal map on Quest (RGB,
// n / 2 + 1/2). Unity's own formula isn't published, so the strength is a guess, not yet judged
// by eye or against Unity (docs: tasks/General.md, Calibrate Layout's normals).
function storeNormalFromGray(data, fmt, dest, MAX_TEXTURE, { scale, filter }) {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', `${fmt}:-[0]`], { input: data }).toString().trim().split(' ').map(Number);
  const rgb = execFileSync('magick', [`${fmt}:-[0]`, '-alpha', 'off', '-depth', '8', 'rgb:-'], { input: data, maxBuffer: 1 << 30 });
  const height = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) height[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3; // 0 to 255
  const at = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // du: toward +x; dv: toward -y (up the image, +v)
    const du = filter === 1 ? (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) : at(x + 1, y) - at(x, y);
    const dv = filter === 1 ? (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) - at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1)) : at(x, y - 1) - at(x, y);
    const nx = -du * scale, ny = -dv * scale, k = 1 / Math.hypot(nx, ny, 1), o = (y * w + x) * 3;
    out[o] = Math.round((nx * k * 0.5 + 0.5) * 255);
    out[o + 1] = Math.round((ny * k * 0.5 + 0.5) * 255);
    out[o + 2] = Math.round((k * 0.5 + 0.5) * 255);
  }
  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', '-resize', `${MAX_TEXTURE}x${MAX_TEXTURE}>`, dest], { input: out, stdio: ['pipe', 'ignore', 'pipe'] });
}
// Textures changed in the Canopy working tree but not yet committed (e.g. TIFs converted to
// PNG): guid -> absolute path, from the checked-out .meta files.
function workingTreeTextures() {
  if (shared.local) return shared.local;
  // Uncommitted textures, from the guid index (tools/guid-index.js marks them local), not a walk of
  // Canopy's Assets: on shared storage that walk took seconds a load (2026-10-29). A texture
  // checked out but unchanged is read from git, the same bytes.
  const out = shared.local = {};
  for (const [g, e] of Object.entries(index())) if (e.local && /\.(png|jpe?g|tga|tiff?|psd)$/i.test(e.path)) out[g] = path.join(U.REPO, e.path);
  return out;
}
// A Unity material's guid by its file name (no .mat), as a Shape's "material" names it.
function materialGuid(name) {
  const hits = Object.entries(index()).filter(([, e]) => e.path.endsWith('.mat') && path.basename(e.path, '.mat').toLowerCase() === name.toLowerCase());
  if (hits.length > 1) throw new Error(`material ${name}: ${hits.length} materials have that name (${hits.map(([, e]) => e.path).join(', ')})`);
  if (!hits.length) throw new Error(`material ${name}: no Unity material has that name`);
  return hits[0][0];
}
// Descriptions of materials named by Shapes, by guid.
const shapeMaterials = (guids, problems) => prepareMaterials(guids, problems, Config.load(null).maxTexture);
// A Piece line's "material <Name>" setting: the piece drawn all in that material (Ken, 2026-10-28:
// the Tangle in bone). Layout's own materials (materials/<Name>.json: map and normal, files beside
// it, optional color [r g b a] and scale [x y]), for previews that are not in Canopy, come first;
// else a Unity material by name. Returns { key, description } for the scene's materials.
const LOCAL_MATERIALS = path.join(ROOT, 'materials');
const materialSetting = extra => ((/(?:^|, )material ([^,]+)/.exec(extra || '') || [])[1] || '').trim() || null;
function pieceMaterial(name, problems) {
  const file = path.join(LOCAL_MATERIALS, path.basename(name) + '.json');
  if (!fs.existsSync(file)) {
    const guid = materialGuid(name);
    return { key: guid, description: shapeMaterials([guid], problems)[guid] };
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tex = f => {
    if (!f) return null;
    const p = path.join(LOCAL_MATERIALS, path.basename(f));
    if (!fs.existsSync(p)) throw new Error(`materials/${name}.json: no materials/${f}`);
    return { guid: null, url: `materials/${encodeURIComponent(path.basename(f))}?v=${Math.round(fs.statSync(p).mtimeMs)}`, scale: j.scale || [1, 1], offset: [0, 0] };
  };
  return { key: 'layout:' + name, description: { parser: MATERIAL_PARSER, name: `layout/materials/${name}.json`, color: j.color || [1, 1, 1, 1], brightness: 1, map: tex(j.map), normal: tex(j.normal), detail: null, cull: 'Back' } };
}
// Material descriptions by guid, with texture URLs (textures/<key>.png or .jpg). Textures are
// fetched, capped at unity.json maxTexture px, and stored once per source and cap.
const { astcJob } = require('./texture-astc.js');
const astcWanted = new Map(); // .astcm name -> what tools/texture-astc.js needs; see takeAstcWanted
// The textures a load found uncompressed, for the server to pass to tools/texture-astc.js.
function takeAstcWanted() {
  const list = [...astcWanted.values()];
  astcWanted.clear();
  return list;
}
const TEXTURE_SLOTS = ['map', 'normal', 'detail', 'normal1', 'normal2', 'noise', 'emission', 'glow'];
function prepareMaterials(guids, problems, maxTexture) {
  const cache = fs.existsSync(MATERIALS) ? JSON.parse(fs.readFileSync(MATERIALS, 'utf8')) : {};
  const idx = index();
  // A material checked out in the Canopy working tree may have uncommitted edits: read it fresh.
  const checkedOut = g => idx[g] && idx[g].path.endsWith('.mat') && idx[g].local; // uncommitted (the index marks them); an unchanged one reads the same from git
  for (const g of new Set(guids)) if (checkedOut(g)) cache[g] = parseMaterial(fs.readFileSync(path.join(U.REPO, idx[g].path), 'utf8'));
  const want = [...new Set(guids)].filter(g => !cache[g] || cache[g].parser !== MATERIAL_PARSER);
  const matBlobs = want.map(g => idx[g] && idx[g].path.endsWith('.mat') ? idx[g].blob : null);
  const mats = blobs(matBlobs.filter(Boolean));
  want.forEach((g, i) => {
    if (!matBlobs[i]) {
      cache[g] = { parser: MATERIAL_PARSER, name: idx[g] ? idx[g].path : 'built-in', color: [0.7, 0.7, 0.7, 1], brightness: 1, map: null, normal: null, detail: null };
      return;
    }
    cache[g] = parseMaterial(mats.get(matBlobs[i]).toString());
  });
  // Custom shaders: whether they cut out (clip()/AlphaTest queue) or blend (Transparent queue).
  const flags = shaderFlags([...new Set(guids)].map(g => cache[g] && cache[g].shader).filter(s => s && s.guid !== BUILTIN_SHADERS), idx);
  for (const g of new Set(guids)) {
    const d = cache[g], f = d && d.shader && flags[d.shader.guid];
    // A color the shader never reads (Canopy/BarkSimple has no _Color, though BarkBeech.mat keeps
    // one from an old shader) tints nothing in the game, so it tints nothing here.
    if (d) d.untinted = Boolean(f && d.colorProperty && f.colors && !f.colors.includes(d.colorProperty));
    if (!f) continue;
    d.surface = f.surface || null;
    d.shaderName = f.name || null; // the page draws some of Canopy's by name (the sea's)
    if (f.cutout) d.cutout = true;
    if (f.transparent) d.transparent = true;
    // a property's value is UnityEngine.Rendering.CullMode: 0 Off, 1 Front, 2 Back
    const c = f.cull && f.cull.property ? ['Off', 'Front', 'Back'][(d.values && d.values[f.cull.property] && d.values[f.cull.property][0]) ?? 2] || 'Back' : f.cull;
    d.cull = c || 'Back';
  }
  // Unity's built-in shaders (Standard and the like) cull back faces.
  for (const g of new Set(guids)) if (cache[g] && !cache[g].cull) cache[g].cull = 'Back';
  // The render queue Unity draws it in (Ken, 2026-10-30: the sea, at 2950, drew over particles at
  // 3000): the material's own, else its shader's, else by how it draws (Standard's are saved in
  // the material).
  for (const g of new Set(guids)) {
    const d = cache[g], f = d && d.shader && flags[d.shader.guid];
    if (!d) continue;
    d.queue = d.customQueue >= 0 ? d.customQueue : f && f.queue !== null && f.queue !== undefined ? f.queue : d.cutout ? 2450 : d.transparent ? 3000 : 2000;
  }
  // Textures for every material asked for: from the working tree if changed there, else git.
  const fromGit = new Map(); // blob -> { ext, file, path }
  fs.mkdirSync(TEXTURES, { recursive: true });
  for (const g of new Set(guids)) for (const slot of TEXTURE_SLOTS) {
    const t = cache[g] && cache[g][slot];
    if (!t) continue;
    t.url = null;
    // decoded from sRGB or not as Unity decodes it (tools/guid-index.js); unknown, by its slot
    if (idx[t.guid] && idx[t.guid].srgb !== undefined) t.srgb = idx[t.guid].srgb;
    else delete t.srgb;
    const file = workingTreeTextures()[t.guid];
    const source = file || (idx[t.guid] && idx[t.guid].path);
    const ext = source && ((/\.(png|jpe?g|tga|tiff?|psd)$/i.exec(source) || [])[1] || '').toLowerCase();
    if (!ext) continue;
    const key = file ? 'wt' + crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 38) : idx[t.guid].blob;
    const alpha = idx[t.guid] && idx[t.guid].alpha; // Unity's Alpha Source, when not the texture's own
    const fromGray = idx[t.guid] && idx[t.guid].fromGray; // a Normal Map Unity makes from its gray
    const gray = fromGray ? `-n${fromGray.scale}f${fromGray.filter}s2` : ''; // s2: the formula's second version
    const name = `${key}-${maxTexture}${alpha !== undefined ? '-a' + alpha : ''}${gray}.${/^jpe?g$/.test(ext) && alpha !== 2 && !fromGray ? 'jpg' : 'png'}`;
    if (!cached(TEXTURES, name)) {
      if (file) {
        try {
          Timing.time('textures converted', () => storeTexture(fs.readFileSync(file), ext, path.join(TEXTURES, name), maxTexture, alpha, fromGray));
          written(TEXTURES, name);
          Timing.count('textures converted');
        } catch (error) {
          problems.push(`${file}: ${error.message.split('\n')[0]}`);
          continue;
        }
      } else {
        fromGit.set(key, { ext, name, path: source, alpha, fromGray });
      }
    }
    t.url = `textures/${name}`;
    delete t.size;
    // The compressed copy the page takes when it can, at the size the game draws it, where the PNG
    // is capped (tools/texture-astc.js): the server makes the missing ones in the background after
    // a load, so a new texture is a PNG until the next load.
    const job = astcJob(name, slot, t, cache[g], idx[t.guid]);
    if (cached(TEXTURES, job.astc)) t.astc = `textures/${job.astc}`;
    else {
      delete t.astc;
      astcWanted.set(job.astc, job);
    }
  }
  for (const [blob, data] of blobs([...fromGit.keys()])) {
    const t = fromGit.get(blob);
    try {
      Timing.time('textures converted', () => storeTexture(data, t.ext, path.join(TEXTURES, t.name), maxTexture, t.alpha, t.fromGray));
      written(TEXTURES, t.name);
      Timing.count('textures converted');
    } catch (error) {
      problems.push(`${t.path}: ${error.message.split('\n')[0]}`);
    }
  }
  for (const g of new Set(guids)) for (const slot of TEXTURE_SLOTS) {
    const t = cache[g] && cache[g][slot];
    if (t && t.url && !cached(TEXTURES, t.url.replace(/^textures\//, ''))) {
      t.url = null;
      delete t.astc;
    }
  }
  fs.writeFileSync(MATERIALS, JSON.stringify(cache));
  const out = {};
  for (const g of new Set(guids)) out[g] = cache[g];
  return out;
}

// The triangles of an OBJ (cache convention: X negated from Unity) whose center, placed by
// the row-major Unity matrix M, lies inside the cube.
// Keeps the faces whose center is inside the cube. With leaves (a leaf mesh of that many leaves,
// each a run of faces in order), whole leaves by their center, and a "# leaves" line lists the
// kept leaves' indices (as ranges) for the page's thinning.
function clipObj(text, M, center, half, leaves) {
  const lines = text.split('\n');
  const v = [];
  for (const l of lines) if (l.startsWith('v ')) v.push(l.split(/\s+/).slice(1).map(Number));
  const inside = ids => {
    const c = [0, 1, 2].map(a => ids.reduce((s, i) => s + v[i][a], 0) / ids.length);
    const u = [-c[0], c[1], c[2]];
    return [0, 1, 2].every(r => Math.abs(M[r * 4] * u[0] + M[r * 4 + 1] * u[1] + M[r * 4 + 2] * u[2] + M[r * 4 + 3] - center[r]) <= half);
  };
  const corners = l => l.split(/\s+/).slice(1).map(t => +t.split('/')[0] - 1);
  if (!leaves) return lines.filter(l => !l.startsWith('f ') || inside(corners(l))).join('\n');
  const faces = lines.filter(l => l.startsWith('f '));
  const per = faces.length / leaves;
  if (!Number.isInteger(per)) throw new Error(`leaf mesh: ${faces.length} faces is not a whole number for ${leaves} leaves`);
  const kept = [];
  for (let i = 0; i < leaves; i++) if (inside(faces.slice(i * per, (i + 1) * per).flatMap(corners))) kept.push(i);
  const keep = new Set(kept.flatMap(i => faces.slice(i * per, (i + 1) * per)));
  const ranges = [];
  for (const i of kept) {
    const r = ranges[ranges.length - 1];
    if (r && r[1] === i - 1) r[1] = i;
    else ranges.push([i, i]);
  }
  const list = ranges.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(' ');
  return [`# leaves ${leaves} ${per} ${list}`, ...lines.filter(l => !l.startsWith('f ') || keep.has(l))].join('\n');
}

module.exports = { REPO: U.REPO, ROOT, AREAS, MESHES, TEXTURES, LOCAL_MATERIALS, beginRequest, blobs, withCandidates, parseMaterial, materialGuid, shapeMaterials, materialSetting, pieceMaterial, parsePieceLines, areaLines, originLine, switchLine, includeLines, layoutPrefabs, withScriptUrls, fieldMaterials, isAssemblage, takeAstcWanted, textureSource, storeTexture, formatPieceLine, replacePieceLines, extractArea, saveArea, prepare };

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'extract' && args.length === 6) {
    const [scene, cx, cy, cz, half, name] = args;
    const area = extractArea(scene, [+cx, +cy, +cz], +half);
    saveArea(`${scene} ${name}`, area);
    console.log(`extract: ${area.pieces.length} pieces -> areas/${scene} ${name}.json`);
  } else if (command === 'prepare' && args.length) {
    const { library: lib, problems } = prepare(args);
    console.log(`prepare: ${Object.keys(lib).length} of ${args.length} names resolved`);
    problems.forEach(p => console.log('  ' + p));
  } else {
    console.error('usage: node tools/scene.js extract <Scene> <cx> <cy> <cz> <halfSize> <Name> | prepare <name>...');
    process.exitCode = 2;
  }
}
