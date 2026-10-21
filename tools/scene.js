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
const FBX = require('./fbx.js');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const LIBRARY = path.join(CACHE, 'pieces.json');
const MESHES = path.join(CACHE, 'meshes');
const TEXTURES = path.join(CACHE, 'textures');
const MATERIALS = path.join(CACHE, 'materials.json');
const AREAS = path.join(ROOT, 'areas');
const GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];

const round = (v, places) => { const r = +v.toFixed(places); return Object.is(r, -0) ? 0 : r; };
const isTreeChunk = mesh => mesh && mesh.path && /\/Meshes\/Grid/.test(mesh.path);

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
function extractArea(scene, center, half) {
  const file = path.join(U.REPO, 'Assets', 'Scenes', scene + '.unity');
  if (!fs.existsSync(file)) throw new Error(`no scene ${scene}`);
  const inside = p => Math.abs(p.pos.x - center[0]) <= half && Math.abs(p.pos.y - center[1]) <= half && Math.abs(p.pos.z - center[2]) <= half;
  const found = U.scenePieces(file).filter(p => inside(p) && !isTreeChunk(p.mesh)).sort((a, b) => a.path.localeCompare(b.path));
  // Plain-mesh pieces are named by their mesh; remember how they resolve.
  const lib = library();
  for (const p of found) if (!p.prefab && !lib[p.piece]) lib[p.piece] = { kind: 'mesh', source: p.mesh.path || p.mesh.kind, parts: [{ mesh: p.mesh, m: U.I(), material: p.material || null, object: p.object }] };
  writeLibrary(lib);
  return {
    source: { scene, center, half },
    pieces: found.map(p => {
      const e = U.quatToEuler(p.rot);
      return {
        name: p.piece, path: p.path,
        // An instance that changes objects inside its prefab carries its own parts.
        ...(p.overridden && p.prefab ? { parts: p.prefab.parts } : {}),
        position: [p.pos.x, p.pos.y, p.pos.z].map(v => round(v, 3)),
        rotation: [e.x, e.y, e.z].map(v => round(v, 2) % 360),
        scale: [p.scl.x, p.scl.y, p.scl.z].map(v => round(v, 3)),
        extra: [p.textId ? `textId ${p.textId}` : '', p.active ? '' : 'inactive'].filter(Boolean).join(', ')
      };
    })
  };
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
// Blob contents (Buffers) by id, fetching any missing ones from origin in one request.
function blobs(ids) {
  if (!ids.length) return new Map();
  const missing = git(['cat-file', '--batch-check'], ids.join('\n') + '\n', { GIT_NO_LAZY_FETCH: '1' })
    .toString().split('\n').filter(l => l.endsWith(' missing')).map(l => l.split(' ')[0]);
  if (missing.length) {
    git(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head',
      '--recurse-submodules=no', '--filter=blob:none', '--stdin'], missing.join('\n') + '\n');
  }
  const out = git(['cat-file', '--batch'], ids.join('\n') + '\n');
  const text = new Map();
  for (let i = 0; i < out.length;) {
    const nl = out.indexOf(10, i);
    const [oid, , size] = out.slice(i, nl).toString().split(' ');
    text.set(oid, out.subarray(nl + 1, nl + 1 + +size));
    i = nl + 1 + +size + 1;
  }
  return text;
}
// Library entries for these piece names: prefabs are re-read each time (so edits show), their
// .asset meshes fetched and converted once per blob. part.obj is the mesh URL, or null.
// extraParts (pieces' own parts, from instances with inner overrides) get meshes too.
function prepare(names, extraParts = []) {
  const lib = library();
  const out = {}, problems = [];
  for (const name of new Set(names)) {
    if (!(lib[name] && lib[name].kind === 'mesh')) {
      const p = U.prefabByName(name);
      if (p) lib[name] = { kind: 'prefab', source: p.path, parts: p.parts };
    }
    if (lib[name]) out[name] = lib[name];
  }
  const allParts = [...Object.values(out).flatMap(e => e.parts), ...extraParts];
  const wanted = new Map();
  for (const part of allParts) {
    if (part.mesh.kind === 'asset' && part.mesh.blob && !fs.existsSync(path.join(MESHES, part.mesh.blob + '.obj'))) wanted.set(part.mesh.blob, part.mesh.name);
  }
  fs.mkdirSync(MESHES, { recursive: true });
  for (const [blob, data] of blobs([...wanted.keys()])) {
    try {
      fs.writeFileSync(path.join(MESHES, blob + '.obj'), assetToObj(data.toString(), wanted.get(blob)));
    } catch (error) {
      problems.push(`${wanted.get(blob)}: ${error.message}`);
    }
  }
  // FBX models: one OBJ per model used, named by the file's blob and the model.
  const fbxParts = allParts.filter(p => p.mesh.kind === 'model' && p.mesh.blob && /\.fbx$/i.test(p.mesh.path));
  const fbxKey = p => `${p.mesh.blob}-${crypto.createHash('sha1').update(`${p.mesh.listed ? p.mesh.name : ''}|${p.object || ''}|${p.mesh.fileID || ''}`).digest('hex').slice(0, 8)}`;
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
  for (const part of allParts) {
    if (fbxParts.includes(part)) {
      part.obj = fs.existsSync(path.join(MESHES, fbxKey(part) + '.obj')) ? `meshes/${fbxKey(part)}.obj` : null;
      continue;
    }
    part.obj = part.mesh.kind === 'asset' && fs.existsSync(path.join(MESHES, part.mesh.blob + '.obj')) ? `meshes/${part.mesh.blob}.obj` : null;
  }
  writeLibrary(lib);
  const materials = prepareMaterials(allParts.map(p => p.material).filter(Boolean), problems);
  return { library: out, materials, problems };
}

// ---------- materials and textures ----------
const index = () => JSON.parse(fs.readFileSync(path.join(CACHE, 'guid-index.json'), 'utf8')).entries;
// Reads what the viewer needs from a .mat: base color, color texture, normal map, and (for
// Canopy/General) the detail texture, each texture with its tiling and offset.
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
  return {
    name: (/m_Name: (.*)/.exec(text) || [])[1] || '',
    color: (general ? color('_Tint') : null) || color('_BaseColor') || color('_Color') || [1, 1, 1, 1],
    brightness: general ? (float('_Brightness') ?? 1) : 1,
    general,
    map: tex('_MainTex') || tex('_BaseMap') || tex('_BaseColorMap'),
    normal: tex('_NormalMap') || tex('_BumpMap'),
    detail: general ? tex('_DetailTex') : null
  };
}
// Stores a texture at most MAX_TEXTURE px on a side, as PNG (JPG stays JPG), using ImageMagick.
// TIF and PSD extra channels become alpha, as Unity reads them. Returns false if it can't.
const MAX_TEXTURE = 1024;
function storeTexture(data, ext, dest) {
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
  const out = {};
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
  walk(path.join(U.REPO, 'Assets'));
  return out;
}
// Material descriptions by guid, with texture URLs (textures/<key>.png or .jpg). Textures are
// fetched, capped at MAX_TEXTURE px, and stored once per source.
function prepareMaterials(guids, problems) {
  const cache = fs.existsSync(MATERIALS) ? JSON.parse(fs.readFileSync(MATERIALS, 'utf8')) : {};
  const idx = index();
  // A material checked out in the Canopy working tree may have uncommitted edits: read it fresh.
  const checkedOut = g => idx[g] && idx[g].path.endsWith('.mat') && fs.existsSync(path.join(U.REPO, idx[g].path));
  for (const g of new Set(guids)) if (checkedOut(g)) cache[g] = parseMaterial(fs.readFileSync(path.join(U.REPO, idx[g].path), 'utf8'));
  const want = [...new Set(guids)].filter(g => !cache[g]);
  const matBlobs = want.map(g => idx[g] && idx[g].path.endsWith('.mat') ? idx[g].blob : null);
  const mats = blobs(matBlobs.filter(Boolean));
  want.forEach((g, i) => {
    if (!matBlobs[i]) {
      cache[g] = { name: idx[g] ? idx[g].path : 'built-in', color: [0.7, 0.7, 0.7, 1], brightness: 1, map: null, normal: null, detail: null };
      return;
    }
    cache[g] = parseMaterial(mats.get(matBlobs[i]).toString());
  });
  // Textures for every material asked for: from the working tree if changed there, else git.
  const local = workingTreeTextures();
  const fromGit = new Map(); // blob -> { ext, file, path }
  fs.mkdirSync(TEXTURES, { recursive: true });
  for (const g of new Set(guids)) for (const slot of ['map', 'normal', 'detail']) {
    const t = cache[g] && cache[g][slot];
    if (!t) continue;
    t.url = null;
    const file = local[t.guid];
    const source = file || (idx[t.guid] && idx[t.guid].path);
    const ext = source && ((/\.(png|jpe?g|tga|tiff?|psd)$/i.exec(source) || [])[1] || '').toLowerCase();
    if (!ext) continue;
    const key = file ? 'wt' + crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 38) : idx[t.guid].blob;
    const name = `${key}.${/^jpe?g$/.test(ext) ? 'jpg' : 'png'}`;
    if (!fs.existsSync(path.join(TEXTURES, name))) {
      if (file) {
        try {
          storeTexture(fs.readFileSync(file), ext, path.join(TEXTURES, name));
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
      storeTexture(data, t.ext, path.join(TEXTURES, t.name));
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

module.exports = { ROOT, AREAS, MESHES, TEXTURES, parseMaterial, parsePieceLines, formatPieceLine, replacePieceLines, extractArea, saveArea, prepare };

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
