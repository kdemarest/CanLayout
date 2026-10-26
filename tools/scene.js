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
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const LIBRARY = path.join(CACHE, 'pieces.json');
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
// "- Area: <Scene> <Name>": the imported area a composed scene is built on, or null.
function areaLine(text) {
  const m = /^\s*-\s*Area:\s*(.+?)\s*$/m.exec(String(text || ''));
  return m ? m[1] : null;
}
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
function withCandidates(pieces) {
  if (!fs.existsSync(CANDIDATES)) return 0;
  let count = 0;
  for (const piece of pieces) {
    for (const g of Object.values(piece.lodGroups || {})) {
      const file = g.kind === 'grid' && g.prefab && path.join(CANDIDATES, g.prefab + '.lod.json');
      if (file && fs.existsSync(file)) g.candidateCutoffs = JSON.parse(fs.readFileSync(file, 'utf8')).cutoffs;
    }
    if (!piece.parts) continue;
    const twins = [];
    for (const part of piece.parts) {
      const file = part.mesh && part.mesh.kind === 'asset' && part.mesh.path && path.join(CANDIDATES, part.mesh.path);
      if (!file || !fs.existsSync(file)) continue;
      const data = fs.readFileSync(file);
      const blob = 'cand-' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 20);
      part.set = 'shipped';
      // An empty candidate (its triangles all went to neighbors) has no twin: nothing shows there.
      if (!/indexCount: 0\b/.test(data.toString('latin1', 0, 2000))) twins.push({ ...part, set: 'candidate', mesh: { ...part.mesh, blob, file } });
      // Strips beside it (<chunk>.strips.asset, tree-build.js): drawn with the strip shader.
      for (const [suffix, extra] of [['.strips.asset', { strip: true }]]) {
        const side = file.replace(/\.asset$/, suffix);
        if (!fs.existsSync(side)) continue;
        const sdata = fs.readFileSync(side);
        if (/indexCount: 0\b/.test(sdata.toString('latin1', 0, 2000))) continue;
        const sblob = 'cand-' + crypto.createHash('sha1').update(sdata).digest('hex').slice(0, 20);
        twins.push({ ...part, set: 'candidate', ...extra, mesh: { ...part.mesh, name: part.mesh.name + suffix.replace(/\.asset$/, ''), blob: sblob, file: side } });
      }
      count++;
    }
    piece.parts.push(...twins);
  }
  return count;
}
// The LOD groups these parts use.
const groupsFor = (parts, groups) => {
  const used = {};
  for (const part of parts) if (part.lod && groups && groups[part.lod.key]) used[part.lod.key] = groups[part.lod.key];
  return used;
};

function extractArea(scene, center, half) {
  const file = path.join(U.REPO, 'Assets', 'Scenes', scene + '.unity');
  if (!fs.existsSync(file)) throw new Error(`no scene ${scene}`);
  const inside = p => Math.abs(p.pos.x - center[0]) <= half && Math.abs(p.pos.y - center[1]) <= half && Math.abs(p.pos.z - center[2]) <= half;
  const cfg = Config.load(scene);
  const all = U.scenePieces(file);
  const found = all.filter(p => inside(p) && !isTreeChunk(p.mesh, cfg)).sort((a, b) => a.path.localeCompare(b.path));
  const trees = treeChunks(all, center, half, cfg);
  // Plain-mesh pieces are named by their mesh; remember how they resolve.
  const lib = library();
  const meshPart = p => ({ mesh: p.mesh, m: U.I(), material: p.material || null, object: p.object, prefab: '', off: Boolean(p.meshOff) });
  for (const p of found) if (!p.prefab && !lib[p.piece]) lib[p.piece] = { kind: 'mesh', source: p.mesh.path || p.mesh.kind, parts: [meshPart(p)] };
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
      extra: [p.textId ? `textId ${p.textId}` : '', p.active ? '' : 'inactive', extra || ''].filter(Boolean).join(', ')
    };
  };
  // Every imported piece carries its own parts, filtered by the scene's show and hide rules
  // (unity.json). A piece whose parts are all switched off or hidden is left out; one with no
  // meshes at all stays, as a labeled box. A tree brings only its overlapping chunks.
  const pieces = [];
  for (const p of found) {
    if (trees.some(t => t.piece === p)) continue;
    const parts = p.prefab ? p.prefab.parts : [meshPart(p)];
    const shown = Config.visibleParts(cfg, p.piece, parts, materialName);
    if (parts.length && !shown.length) continue;
    pieces.push(place(p, shown, '', groupsFor(shown, p.prefab && p.prefab.lodGroups)));
  }
  for (const t of trees) pieces.push(place(t.piece, t.parts, `tree chunk meshes: ${t.parts.length - t.leaves}${t.leaves ? (t.leafSplit ? `, LeafSplit leaves (thinning from ${t.leafSplit.thin.from})` : ', leaves') : ''}${t.grid && t.grid.manual ? ', GridRender LODs' : ''}`, t.lodGroups));
  return { source: { scene, center, half, config: Config.mtime() }, pieces };
}
function saveArea(name, area) {
  fs.mkdirSync(AREAS, { recursive: true });
  fs.writeFileSync(path.join(AREAS, name + '.json'), JSON.stringify(area, null, 1));
}

// ---------- piece library and meshes ----------
const library = () => (fs.existsSync(LIBRARY) ? JSON.parse(fs.readFileSync(LIBRARY, 'utf8')) : {});
function writeLibrary(lib) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(LIBRARY, JSON.stringify(lib));
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
    if (!(lib[name] && lib[name].kind === 'mesh')) {
      // A model file by name ("LeafSingle.fbx"), placed whole, or a prefab.
      const model = /\.(fbx|obj)$/i.test(name) && Object.entries(index()).find(([, e]) => e.path.endsWith('/' + name));
      const p = Timing.time('prefabs', () => (model ? U.modelInstance(model[0], []) : U.prefabByName(name)));
      if (p) lib[name] = { kind: model ? 'model' : 'prefab', source: p.path, parts: p.parts, takesText: Boolean(p.takesText), lodGroups: p.lodGroups || {} };
    }
    if (lib[name]) out[name] = { ...lib[name], parts: Config.visibleParts(cfg, name, lib[name].parts, materialName) };
  }
  const allParts = [...Object.values(out).flatMap(e => e.parts), ...extraParts];
  const wanted = new Map();
  for (const part of allParts) {
    if (part.mesh.kind === 'asset' && part.mesh.blob && !fs.existsSync(path.join(MESHES, part.mesh.blob + '.obj'))) wanted.set(part.mesh.blob, part.mesh.name);
  }
  fs.mkdirSync(MESHES, { recursive: true });
  const candidateFiles = new Map(allParts.filter(p => p.mesh.file).map(p => [p.mesh.blob, p.mesh.file]));
  const fromCanopy = blobs([...wanted.keys()].filter(b => !candidateFiles.has(b)));
  for (const b of wanted.keys()) if (candidateFiles.has(b)) fromCanopy.set(b, fs.readFileSync(candidateFiles.get(b)));
  for (const [blob, data] of fromCanopy) {
    try {
      fs.writeFileSync(path.join(MESHES, blob + '.obj'), Timing.time('meshes converted', () => assetToObj(data.toString(), wanted.get(blob))));
      Timing.count('meshes converted');
    } catch (error) {
      problems.push(`${wanted.get(blob)}: ${error.message}`);
    }
  }
  // FBX models: one OBJ per model used, named by the file's blob and the model.
  const fbxParts = allParts.filter(p => p.mesh.kind === 'model' && !p.mesh.whole && p.mesh.blob && /\.fbx$/i.test(p.mesh.path));
  const fbxKey = p => `${p.mesh.blob}-${crypto.createHash('sha1').update(`${p.mesh.listed ? p.mesh.name : ''}|${p.object || ''}|${p.mesh.fileID || ''}${/^43\d{5}$/.test(p.mesh.fileID || '') ? '' : '|hashed'}`).digest('hex').slice(0, 8)}`;
  const fbxWanted = fbxParts.filter(p => !fs.existsSync(path.join(MESHES, fbxKey(p) + '.obj')));
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
    } catch (error) {
      problems.push(`${p.mesh.path}: ${error.message}`);
    }
  }
  // Model files placed whole (FBX or OBJ): one OBJ per file and root-scale choice.
  const wholeParts = allParts.filter(p => p.mesh.kind === 'model' && p.mesh.whole && p.mesh.blob);
  const wholeKey = p => `${p.mesh.blob}-${crypto.createHash('sha1').update(`whole|${p.mesh.keepRootScale ? 1 : 0}`).digest('hex').slice(0, 8)}`;
  const wholeWanted = wholeParts.filter(p => !fs.existsSync(path.join(MESHES, wholeKey(p) + '.obj')));
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
    } catch (error) {
      problems.push(`${p.mesh.path}: ${error.message}`);
    }
  }
  for (const part of allParts) {
    if (wholeParts.includes(part)) {
      part.obj = fs.existsSync(path.join(MESHES, wholeKey(part) + '.obj')) ? `meshes/${wholeKey(part)}.obj` : null;
      continue;
    }
    if (fbxParts.includes(part)) {
      part.obj = fs.existsSync(path.join(MESHES, fbxKey(part) + '.obj')) ? `meshes/${fbxKey(part)}.obj` : null;
      continue;
    }
    part.obj = part.mesh.kind === 'asset' && fs.existsSync(path.join(MESHES, part.mesh.blob + '.obj')) ? `meshes/${part.mesh.blob}.obj` : null;
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
  const materials = prepareMaterials(allParts.map(p => p.material).filter(Boolean), problems, cfg.maxTexture);
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
  const want = guids.filter(g => !cache[idx[g].blob] || !('cull' in cache[idx[g].blob]));
  const texts = blobs(want.map(g => idx[g].blob));
  for (const g of want) {
    const src = (texts.get(idx[g].blob) || '').toString();
    cache[idx[g].blob] = {
      cutout: /\bclip\s*\(|"Queue"\s*=\s*"AlphaTest/.test(src),
      transparent: /"Queue"\s*=\s*"Transparent|\bBlend\s+SrcAlpha\s+OneMinusSrcAlpha/.test(src),
      surface: surfaceOf(src),
      cull: cullOf(src)
    };
  }
  if (want.length) fs.writeFileSync(SHADERS, JSON.stringify(cache));
  return Object.fromEntries(guids.map(g => [g, cache[idx[g].blob]]));
}
// Which faces a shader draws: its first Cull (Back, Front, Off; Unity's default is Back), or the
// material property that sets it ("Cull [_CullMode]": { property }).
function cullOf(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*/, '')).join('\n');
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
const beginRequest = () => { shared = {}; };
const index = () => shared.index || (shared.index = JSON.parse(fs.readFileSync(path.join(CACHE, 'guid-index.json'), 'utf8')).entries);
// Reads what the viewer needs from a .mat: base color, color texture, normal map, and (for
// Canopy/General) the detail texture, each texture with its tiling and offset. Bump
// MATERIAL_PARSER when what it reads changes, so cached materials are read again.
const MATERIAL_PARSER = 2;
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
  return {
    parser: MATERIAL_PARSER,
    shader: shader.length ? { fileID: shader[0], guid: shader[1] } : null,
    // Cutout (alpha test): Standard Cutout mode, URP alpha clip, or the keyword. Custom shaders
    // are checked in their source (see shaderFlags).
    cutout: float('_Mode') === 1 || float('_AlphaClip') === 1 || /_ALPHATEST_ON/.test(text),
    cutoff: float('_Cutoff') ?? 0.5,
    transparent,
    name: (/m_Name: (.*)/.exec(text) || [])[1] || '',
    color: (general ? color('_Tint') : null) || color('_BaseColor') || color('_Color') || [1, 1, 1, 1],
    brightness: general ? (float('_Brightness') ?? 1) : 1,
    general,
    map: tex('_MainTex') || tex('_BaseMap') || tex('_BaseColorMap') || tex('_Tex'), // _Tex: a skybox's
    normal: tex('_NormalMap') || tex('_BumpMap'),
    detail: general ? tex('_DetailTex') : null,
    // Every float and color (or vector) property, for surface shaders (web/surface.js).
    values: Object.fromEntries([
      ...[...text.matchAll(/^\s+- (_\w+): (-?[\d.e+-]+)$/gm)].map(m => [m[1], [+m[2]]]),
      ...[...text.matchAll(/^\s+- (_\w+): \{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\}$/gm)].map(m => [m[1], m.slice(2, 6).map(Number)])
    ])
  };
}
// Stores a texture at most MAX_TEXTURE px (unity.json maxTexture) on a side, as PNG (JPG stays JPG), using ImageMagick.
// TIF and PSD extra channels become alpha, as Unity reads them. Returns false if it can't.
function storeTexture(data, ext, dest, MAX_TEXTURE) {
  const fmt = { jpg: 'jpg', jpeg: 'jpg', tif: 'tiff', tiff: 'tiff', psd: 'psd', tga: 'tga', png: 'png' }[ext];
  const run = extra => execFileSync('magick', [`${fmt}:-[0]`, ...extra, '-resize', `${MAX_TEXTURE}x${MAX_TEXTURE}>`, '-depth', '8', dest], { input: data, stdio: ['pipe', 'ignore', 'pipe'] });
  try {
    run(fmt === 'tiff' || fmt === 'psd' ? ['-channel-fx', 'meta0=>alpha'] : []);
  } catch {
    run([]); // no extra channel
  }
}
// Textures changed in the Canopy working tree but not yet committed (e.g. TIFs converted to
// PNG): guid -> absolute path, from the checked-out .meta files.
function workingTreeTextures() {
  if (shared.local) return shared.local;
  const out = shared.local = {};
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(png|jpe?g|tga|tiff?|psd)\.meta$/i.test(e.name)) {
        const g = /^guid: (\w+)/m.exec(fs.readFileSync(p, 'utf8'));
        if (g && fs.existsSync(p.slice(0, -5))) out[g[1]] = p.slice(0, -5);
      }
    }
  };
  Timing.time('working tree textures', () => walk(path.join(U.REPO, 'Assets')));
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
// Material descriptions by guid, with texture URLs (textures/<key>.png or .jpg). Textures are
// fetched, capped at unity.json maxTexture px, and stored once per source and cap.
function prepareMaterials(guids, problems, maxTexture) {
  const cache = fs.existsSync(MATERIALS) ? JSON.parse(fs.readFileSync(MATERIALS, 'utf8')) : {};
  const idx = index();
  // A material checked out in the Canopy working tree may have uncommitted edits: read it fresh.
  const checkedOut = g => idx[g] && idx[g].path.endsWith('.mat') && fs.existsSync(path.join(U.REPO, idx[g].path));
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
    if (!f) continue;
    d.surface = f.surface || null;
    if (f.cutout) d.cutout = true;
    if (f.transparent) d.transparent = true;
    // a property's value is UnityEngine.Rendering.CullMode: 0 Off, 1 Front, 2 Back
    const c = f.cull && f.cull.property ? ['Off', 'Front', 'Back'][(d.values && d.values[f.cull.property] && d.values[f.cull.property][0]) ?? 2] || 'Back' : f.cull;
    d.cull = c || 'Back';
  }
  // Unity's built-in shaders (Standard and the like) cull back faces.
  for (const g of new Set(guids)) if (cache[g] && !cache[g].cull) cache[g].cull = 'Back';
  // Textures for every material asked for: from the working tree if changed there, else git.
  const fromGit = new Map(); // blob -> { ext, file, path }
  fs.mkdirSync(TEXTURES, { recursive: true });
  for (const g of new Set(guids)) for (const slot of ['map', 'normal', 'detail']) {
    const t = cache[g] && cache[g][slot];
    if (!t) continue;
    t.url = null;
    const file = workingTreeTextures()[t.guid];
    const source = file || (idx[t.guid] && idx[t.guid].path);
    const ext = source && ((/\.(png|jpe?g|tga|tiff?|psd)$/i.exec(source) || [])[1] || '').toLowerCase();
    if (!ext) continue;
    const key = file ? 'wt' + crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 38) : idx[t.guid].blob;
    const name = `${key}-${maxTexture}.${/^jpe?g$/.test(ext) ? 'jpg' : 'png'}`;
    if (!fs.existsSync(path.join(TEXTURES, name))) {
      if (file) {
        try {
          Timing.time('textures converted', () => storeTexture(fs.readFileSync(file), ext, path.join(TEXTURES, name), maxTexture));
          Timing.count('textures converted');
        } catch (error) {
          problems.push(`${file}: ${error.message.split('\n')[0]}`);
          continue;
        }
      } else {
        fromGit.set(key, { ext, name, path: source });
      }
    }
    t.url = `textures/${name}`;
  }
  for (const [blob, data] of blobs([...fromGit.keys()])) {
    const t = fromGit.get(blob);
    try {
      Timing.time('textures converted', () => storeTexture(data, t.ext, path.join(TEXTURES, t.name), maxTexture));
      Timing.count('textures converted');
    } catch (error) {
      problems.push(`${t.path}: ${error.message.split('\n')[0]}`);
    }
  }
  for (const g of new Set(guids)) for (const slot of ['map', 'normal', 'detail']) {
    const t = cache[g] && cache[g][slot];
    if (t && t.url && !fs.existsSync(path.join(ROOT, 'cache', t.url))) t.url = null;
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

module.exports = { REPO: U.REPO, ROOT, AREAS, MESHES, TEXTURES, beginRequest, blobs, withCandidates, parseMaterial, materialGuid, shapeMaterials, parsePieceLines, areaLine, formatPieceLine, replacePieceLines, extractArea, saveArea, prepare };

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
