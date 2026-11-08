// layout: a local web app for viewing and composing Canopy scenes on the phone.
// Run in Termux:  node /sdcard/dev/layout/server.js   then open http://localhost:8080
// Serves web/, the converted meshes, and a small JSON API. Listens on this device only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./tools/scene.js');
const U = require('./tools/unity.js');
const Config = require('./tools/config.js');
const Texts = require('./tools/texts.js');
const Shapes = require('./tools/shapes.js');
const Timing = require('./tools/timing.js');
const Assemblage = require('./tools/assemblage.js');
const Conditions = require('./tools/conditions.js');
const Moods = require('./tools/moods.js');

const PORT = +process.env.PORT || 8080;
const DEV = path.join(__dirname, '..');
const DOCS = path.join(DEV, 'docs');
const SCENES = path.join(DOCS, 'scenes');
const WEB = path.join(__dirname, 'web');
const UNITY_SCENES = '/sdcard/Canopy/Assets/Scenes';
// Each server run has its own id; the page reloads when it sees a new one (dev.js restarts us on edits).
const INSTANCE = Date.now().toString(36);
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.obj': 'text/plain', '.json': 'application/json', '.txt': 'text/plain' };

// ---------- Canopy working-tree changes ----------
// When an uncommitted Canopy file changes (a tool such as modl's --write rewriting its assets),
// the page reloads its scene (a "canopy" event on /events). Polls file times, as dev.js does
// (fs.watch is unreliable on Android shared storage): every uncommitted file the guid index
// knows, their folders, and Assets. A changed file is rehashed in the index in place; anything
// else (files added or removed, a .meta changed) reruns tools/guid-index.js. Changes are taken
// once the files have been quiet a second (a writer touches several), and the event names them.
// Tweak families' sources (their spec doc, script and library; see the tweak workers below) are
// watched too: an edit not made by Tweak itself rebuilds the family from the doc, and the
// Canopy files it rewrites reload the scene.
const { execFile, execFileSync } = require('child_process');
const INDEX = path.join(__dirname, 'cache', 'guid-index.json');
const CANOPY_GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];
const listeners = new Set();
let watched = null, refreshing = false;
function canopyTimes() {
  const local = Object.values(JSON.parse(fs.readFileSync(INDEX, 'utf8')).entries).filter(e => e.local).map(e => e.path);
  const files = new Map(), dirs = new Map();
  const time = p => { try { return fs.statSync(path.join(S.REPO, p)).mtimeMs; } catch { return -1; } };
  for (const p of local) {
    files.set(p, time(p));
    files.set(p + '.meta', time(p + '.meta'));
    // every folder above it too, so a new folder beside one (a new modl family) is seen
    for (let d = path.dirname(p); d !== '.' && !dirs.has(d); d = path.dirname(d)) dirs.set(d, time(d));
  }
  if (!dirs.has('Assets')) dirs.set('Assets', time('Assets'));
  return { files, dirs };
}
// Rebuilds every assemblage's prefab (tools/assemblage.js; only files whose text changed are
// written): on saving one, and when Canopy files outside the assemblages change (their pieces).
function rebuildAssemblages(only) {
  U.refreshIndex();
  for (const name of only ? [only] : Assemblage.scenes()) {
    try {
      const changed = Assemblage.write(Assemblage.plan(name));
      if (changed.length) console.log(`assemblage ${name}: ${changed.length} files rebuilt`);
    } catch (error) {
      console.error(`assemblage ${name}: ${error.message}`);
    }
  }
}
function canopyChanged(changed) {
  const announce = () => {
    refreshing = false;
    if (changed.some(p => !p.startsWith('Assets/Assemblages'))) rebuildAssemblages();
    watched = canopyTimes();
    console.log(`canopy: ${changed.length} changed (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}); scenes reload`);
    const data = JSON.stringify({ at: Date.now(), changed: changed.slice(0, 50) });
    for (const res of listeners) res.write(`event: canopy\ndata: ${data}\n\n`);
  };
  refreshing = true;
  const assets = changed.filter(p => !p.endsWith('.meta') && !watched.dirs.has(p));
  if (assets.length === changed.length) {
    // only known files rewritten: their new content hashes are their blobs
    const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    const hashes = execFileSync('git', CANOPY_GIT.concat(['hash-object', '--stdin-paths']), { input: assets.map(p => path.join(S.REPO, p)).join('\n') + '\n' }).toString().trim().split('\n');
    const byPath = new Map(Object.values(index.entries).map(e => [e.path, e]));
    assets.forEach((p, i) => { if (byPath.has(p)) byPath.get(p).blob = hashes[i]; });
    fs.writeFileSync(INDEX, JSON.stringify(index));
    announce();
  } else {
    execFile(process.execPath, [path.join(__dirname, 'tools', 'guid-index.js')], { cwd: __dirname }, error => {
      if (error) console.error(`canopy: guid-index failed: ${error.message}`);
      announce();
    });
  }
}
let settling = null;
setInterval(() => {
  if (refreshing || !listeners.size) return;
  try {
    checkTweakSources();
    const now = canopyTimes();
    if (!watched) {
      // the first poll: catch up on what changed while the server was down or unwatched (a modl
      // install during a restart left its new material out of the index; Claude, 2026-11-04)
      refreshing = true;
      const before = fs.readFileSync(INDEX, 'utf8');
      execFile(process.execPath, [path.join(__dirname, 'tools', 'guid-index.js')], { cwd: __dirname }, error => {
        if (error) console.error(`canopy: guid-index failed: ${error.message}`);
        refreshing = false;
        watched = canopyTimes();
        if (fs.readFileSync(INDEX, 'utf8') === before) return;
        console.log('canopy: changed while unwatched; scenes reload');
        const data = JSON.stringify({ at: Date.now(), changed: [] });
        for (const res of listeners) res.write(`event: canopy\ndata: ${data}\n\n`);
      });
      return;
    }
    const changed = [];
    for (const [k, t] of now.files) if (watched.files.get(k) !== t) changed.push(k);
    for (const [k, t] of now.dirs) if (watched.dirs.get(k) !== t) changed.push(k);
    if (!changed.length) {
      settling = null;
      watched = now;
      return;
    }
    // wait until a poll finds nothing new: a writer touches several files over a second
    const signature = JSON.stringify([...now.files, ...now.dirs]);
    if (settling !== signature) {
      settling = signature;
      return;
    }
    settling = null;
    canopyChanged(changed);
  } catch (error) {
    console.error(`canopy: ${error.message}`);
  }
}, 1000);

// ---------- tweak workers ----------
// Tweak (web/app.js) reshapes pieces live: a worker per family folder (unity.json tweakWorkers,
// e.g. modl's obj/serve.py for Assets/Modl/<Family>), started on first use and kept running,
// answers one JSON line per request, in order. Idle ten minutes, it is stopped.
const { spawn } = require('child_process');
const workers = new Map();
function workerFor(source) {
  const commands = Config.load(null).tweakWorkers;
  for (const [prefix, command] of Object.entries(commands)) {
    if (!source.startsWith(prefix)) continue;
    const family = source.slice(prefix.length).split('/')[0];
    if (family && source.slice(prefix.length).includes('/')) return { folder: prefix + family, command };
  }
  return null;
}
function ask(folder, command, request) {
  let w = workers.get(folder);
  if (!w) {
    const proc = spawn(command[0], [...command.slice(1).map(a => (/^\.\.?\//.test(a) ? path.join(__dirname, a) : a)), folder], { cwd: __dirname });
    w = { proc, waiting: [], buffer: '', chain: Promise.resolve(), idle: null };
    proc.stdout.on('data', chunk => {
      w.buffer += chunk;
      for (let nl; (nl = w.buffer.indexOf('\n')) >= 0;) {
        const line = w.buffer.slice(0, nl);
        w.buffer = w.buffer.slice(nl + 1);
        const done = w.waiting.shift();
        if (done) done(line);
      }
    });
    proc.stderr.on('data', chunk => process.stdout.write(`tweak ${folder}: ${chunk}`));
    proc.on('exit', code => {
      workers.delete(folder);
      for (const done of w.waiting.splice(0)) done(JSON.stringify({ error: `worker for ${folder} exited (${code})` }));
    });
    workers.set(folder, w);
  }
  clearTimeout(w.idle);
  w.idle = setTimeout(() => w.proc.kill(), 10 * 60 * 1000);
  const reply = w.chain.then(() => new Promise(resolve => {
    w.waiting.push(resolve);
    w.proc.stdin.write(JSON.stringify(request) + '\n');
  })).then(line => {
    const data = JSON.parse(line);
    if (data.error) throw new Error(data.error);
    return data;
  });
  w.chain = reply.catch(() => {});
  return reply;
}
// Each family's sources, from its worker's vars: { command, times: Map(file -> mtime), busy }.
const tweakSources = new Map();
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch { return -1; } };
function noteTweakSources(folder, command, files) {
  tweakSources.set(folder, { command, busy: false, times: new Map((files || []).map(f => [f, mtimeOf(f)])) });
}
function checkTweakSources() {
  for (const [folder, w] of tweakSources) {
    if (w.busy) continue;
    const changed = [...w.times].filter(([f, t]) => mtimeOf(f) !== t).map(([f]) => f);
    if (!changed.length) continue;
    console.log(`tweak ${folder}: ${changed.map(f => path.basename(f)).join(', ')} changed; rebuilding from the doc`);
    tweakWrite(folder, w.command, {}).catch(error => console.error(`tweak ${folder}: ${error.message}`));
  }
}
// The worker's write; its own edit of the doc (and the build) is not taken for an outside change.
async function tweakWrite(folder, command, values) {
  const w = tweakSources.get(folder);
  if (w) w.busy = true;
  try {
    return await ask(folder, command, { op: 'write', values });
  } finally {
    if (w) {
      for (const f of w.times.keys()) w.times.set(f, mtimeOf(f));
      w.busy = false;
    }
  }
}
// A tweak request's worker: the folder must be one a worker serves.
function tweakFolder(folder) {
  const w = workerFor(String(folder) + '/');
  if (!w || w.folder !== folder) throw new Error(`no tweak worker for ${folder}`);
  return w;
}

const listNames = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length)).sort() : []);
// A scene or area name is a file name; it may not walk out of its folder.
const safeName = name => {
  if (typeof name !== 'string' || !name.trim() || /[\\/]|^\./.test(name)) throw new Error(`bad name: ${name}`);
  return name.trim();
};

// From docs Asset lines: new assets (🔴 or 🟡; existing ones are Unity prefabs) and the
// placeholder shapes of any asset (tools/shapes.js). Text assets are left out of newAssets:
// texts go on tablets (Add while carrying one).
function docsAssets() {
  const docs = Timing.time('docs', () => Shapes.readDocs(DOCS));
  const newAssets = Object.entries(docs.assets).filter(([, a]) => a.chip !== '🟢' && a.type !== 'Text').map(([name]) => name).sort();
  return { newAssets, shapes: docs.shapes, sources: docs.sources, shapeErrors: docs.errors, unity: docs.assets };
}
// Adds placeholder shapes to a prepare result for names with no Unity prefab or mesh, and what
// their "use" shapes name: other assets' shapes, or Unity prefabs (prepared here). Layout's own
// prefabs (layout/prefabs/, scene.js layoutPrefabs) come first, before Unity prefabs of their name,
// with their scripts.
function withShapes(result, names) {
  const docs = docsAssets();
  const own = Timing.time('layout prefabs', () => S.layoutPrefabs());
  const problems = [...(result.problems || []), ...docs.shapeErrors, ...Object.values(own).flatMap(p => p.errors)];
  const add = (name, trail) => {
    if (result.library[name] && !(own[name] && result.library[name].kind !== 'shapes')) return;
    if (trail.includes(name)) return problems.push(`Shape use loops: ${[...trail, name].join(' -> ')}`);
    // Once the asset has a Unity prefab under its Unity name (Burl shard -> BurlShard), that wins;
    // not a generated placeholder (tools/make-shapes.js), which only copies the shapes. A piece's
    // own name was prepared before this; a name "use" brings in was not, so it is looked up even
    // where it is its Unity name (Cocoon in Cocoon Basket drew its shapes, not modl's Cocoon).
    const unity = Shapes.unityName(name, docs.unity[name] && docs.unity[name].unity);
    if (!own[name] && (unity !== name || trail.length)) {
      const prefab = Timing.time('shape prefabs', () => S.prepare([unity]));
      const found = prefab.library[unity];
      if (found && !(docs.shapes[name] && String(found.source).startsWith('Assets/Placeholder/'))) {
        result.library[name] = found;
        Object.assign(result.materials, prefab.materials);
        return;
      }
    }
    const spec = own[name] || (docs.shapes[name] && { shapes: docs.shapes[name], source: `docs/${docs.sources[name]}`, scripts: [] });
    if (!spec) return;
    // A shape's "material" (a Unity material's name) comes as materialGuid, with its description.
    const shapes = spec.shapes.map(shape => {
      if (!shape.material) return shape;
      try {
        const guid = Timing.time('shape materials', () => S.materialGuid(shape.material));
        Object.assign(result.materials, Timing.time('shape materials', () => S.shapeMaterials([guid], problems)));
        return { ...shape, materialGuid: guid };
      } catch (error) {
        problems.push(`${spec.source}: ${name}: ${error.message}`);
        return shape;
      }
    });
    result.library[name] = { kind: 'shapes', source: own[name] ? spec.source : docs.sources[name], shapes, parts: [], ...(spec.scripts.length ? { scripts: spec.scripts } : {}) };
    for (const shape of spec.shapes) {
      if (shape.kind !== 'use') continue;
      if (docs.shapes[shape.name] || own[shape.name]) add(shape.name, [...trail, name]);
      else if (!result.library[shape.name]) {
        const prefab = S.prepare([shape.name]);
        if (!prefab.library[shape.name]) problems.push(`${spec.source}: ${name} uses ${shape.name}, which is neither an asset with shapes nor a Unity prefab`);
        Object.assign(result.library, prefab.library);
        Object.assign(result.materials, prefab.materials);
        problems.push(...prefab.problems);
      }
    }
  };
  for (const name of new Set(names)) add(name, []);
  result.problems = problems;
  return result;
}
function prefabNames() {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'guid-index.json'), 'utf8')).entries;
  return [...new Set(Object.values(index).filter(e => e.path.endsWith('.prefab')).map(e => path.basename(e.path, '.prefab')))].sort();
}

// An imported area, re-imported first when what it bakes in from unity.json changed since (its
// show and hide rules, tree and leaf settings: Config.extractKey), not for other changes.
function loadArea(name) {
  let area = JSON.parse(fs.readFileSync(path.join(S.AREAS, safeName(name) + '.json'), 'utf8'));
  if (area.source.config !== Config.extractKey(area.source.scene)) {
    area = Timing.time('area re-import', () => S.extractArea(area.source.scene, area.source.center, area.source.half, Boolean(area.source.terrainOnly)));
    S.saveArea(name, area);
  }
  return area;
}

// The pieces of included scenes ("- Include: <Scene>", Ken, 2026-10-29), each scene once (seen
// holds those already in, the including scene first), a scene's own includes before its pieces.
// Only their Piece and Include lines count (an Area line there is ignored).
function includedPieces(list, seen, problems) {
  const out = [];
  for (const name of list) {
    if (seen.has(name)) continue;
    seen.add(name);
    let text;
    try {
      text = fs.readFileSync(path.join(SCENES, safeName(name) + '.md'), 'utf8');
    } catch {
      problems.push(`Include: no scene ${name} (docs/scenes/${name}.md)`);
      continue;
    }
    const parsed = S.parsePieceLines(text);
    if (parsed.errors.length) {
      problems.push(`${name}: ${parsed.errors[0]}`);
      continue;
    }
    out.push(...includedPieces(S.includeLines(text), seen, problems), ...parsed.pieces.map(p => ({ ...p, includedFrom: name })));
  }
  return out;
}

// unity.json's environment for a Unity scene, its sky's named material made a description.
// unity.json's environment, and (unless its live is false) the game's moods and zones for the
// page to work the light out from where the camera is (tools/moods.js, web/environment.js);
// scenes: the Unity scenes being drawn, whose zones count beside the game's.
function environment(unityScene, problems, scenes = []) {
  const env = { ...Config.load(unityScene).environment };
  if (env.live !== false) {
    try {
      const live = Timing.time('moods', () => Moods.environment(scenes));
      for (const p of live.problems) problems.push(`moods: ${p}`);
      env.live = { ...live, skyMaterials: S.shapeMaterials(live.materials, problems) };
    } catch (error) {
      problems.push(`moods: ${error.message}`);
      env.live = null;
    }
  } else env.live = null;
  for (const key of ['sky']) {
    try {
      const guid = S.materialGuid(env[key]);
      env[key] = S.shapeMaterials([guid], problems)[guid];
    } catch (error) {
      problems.push(`unity.json environment ${key}: ${error.message}`);
      env[key] = null;
    }
  }
  return env;
}

const api = {
  'GET /api/list': () => ({
    composed: listNames(SCENES, '.md'),
    areas: listNames(S.AREAS, '.json'),
    unityScenes: listNames(UNITY_SCENES, '.unity')
  }),
  'GET /api/palette': () => {
    const docs = docsAssets(), prefabs = prefabNames();
    // Reused assets by their docs name, with the prefab (or model file) each names.
    const reuses = Object.entries(docs.unity).filter(([, a]) => a.chip === '🟢' && a.type !== 'Text')
      .map(([name, a]) => ({ name, prefab: Shapes.unityName(name, a.unity) }))
      .filter(r => prefabs.includes(r.prefab) || /\.(fbx|obj)$/i.test(r.prefab)).sort((a, b) => a.name.localeCompare(b.name));
    // Assemblage scenes are added whole, as their prefab (Add's Scenes); modl's models listed apart.
    const index = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'guid-index.json'), 'utf8')).entries;
    const under = dir => new Set(Object.values(index).filter(e => e.path.startsWith(dir) && e.path.endsWith('.prefab')).map(e => path.basename(e.path, '.prefab')));
    const assembled = under('Assets/Assemblages/'), modl = under('Assets/Modl/');
    const scenes = Assemblage.scenes().map(name => ({ name, prefab: Assemblage.pascal(name) })).filter(s => assembled.has(s.prefab));
    return { newAssets: docs.newAssets, shaped: Object.keys(docs.shapes), shapeErrors: docs.shapeErrors, reuses, prefabs: prefabs.filter(p => !assembled.has(p)), modl: [...modl].sort(), scenes };
  },
  'GET /api/texts': () => ({ file: Texts.FILE, texts: Texts.loadTexts(S.REPO, JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'guid-index.json'), 'utf8')).entries, S.blobs) }),
  'GET /api/scene': q => {
    const name = safeName(q.get('name'));
    let pieces, editable, area = null, base = [], unityScene = null, origin = null, assemblage = false, switches = null, includes = [], symbolLines = {};
    // Other areas drawn alongside, read-only (☰ Areas, "also"; a composed scene's later Area lines):
    // their pieces carry their Unity scene, whose stage their conditions are tested against.
    let lines = [];
    const also = [];
    if (q.get('kind') === 'area') {
      const loaded = loadArea(name);
      pieces = loaded.pieces;
      unityScene = loaded.source.scene;
      editable = false;
    } else {
      // A composed scene may sit on imported areas ("- Area: <name>"), drawn read-only beneath it.
      const text = fs.readFileSync(path.join(SCENES, name + '.md'), 'utf8');
      const parsed = Timing.time('scene file', () => S.parsePieceLines(text));
      if (parsed.errors.length) throw new Error(`${name}: ${parsed.errors[0]}`);
      pieces = parsed.pieces;
      editable = true;
      lines = S.areaLines(text);
      area = lines[0] || null;
      origin = S.originLine(text);
      switches = S.switchLine(text);
      assemblage = S.isAssemblage(text);
      if (area) {
        const loaded = Timing.time('areas', () => loadArea(area));
        base = loaded.pieces;
        unityScene = loaded.source.scene;
      }
      includes = S.includeLines(text);
      symbolLines = Conditions.symbolLines(text);
    }
    const scenesOf = {};
    for (const other of new Set([...lines.slice(1), ...q.getAll('also').map(safeName)])) {
      if (other === name || other === area || !fs.existsSync(path.join(S.AREAS, other + '.json'))) continue;
      const loaded = loadArea(other);
      if (!unityScene) unityScene = loaded.source.scene;
      if (loaded.source.scene !== unityScene) {
        for (const p of loaded.pieces) p.unityScene = loaded.source.scene;
        scenesOf[loaded.source.scene] = true;
      }
      base = [...base, ...loaded.pieces];
      also.push(other);
    }
    // Included scenes' pieces go beneath, first (so their singletons win): unity.json's include
    // (World) for what comes from Canopy, an imported area or a scene on one, then "- Include:" lines.
    const includeProblems = [];
    const fromCanopy = unityScene ? Config.load(unityScene).include : [];
    base = [...Timing.time('includes', () => includedPieces([...fromCanopy, ...includes], new Set([name]), includeProblems)), ...base];
    // Pieces with their own parts (trees, overridden instances) are not resolved as whole prefabs.
    const all = [...base, ...pieces];
    const candidates = S.withCandidates(all);
    const names = all.filter(p => !p.parts).map(p => p.name);
    const { library, materials, problems } = Timing.time('shapes', () => withShapes(Timing.time('prepare', () => S.prepare(names, all.flatMap(p => p.parts || []))), names));
    problems.push(...includeProblems);
    // Scripts: imported pieces' stand-ins get their URLs; materials their fields name come along.
    for (const p of all) if (p.scripts) p.scripts = S.withScriptUrls(p.scripts);
    Object.assign(materials, Timing.time('script materials', () => S.fieldMaterials([...all.flatMap(p => p.scripts || []), ...Object.values(library).flatMap(e => e.scripts || [])], problems)));
    // "material <Name>" in a piece's settings: all of it drawn in that material (scene.js pieceMaterial).
    for (const p of all) {
      const named = S.materialSetting(p.extra);
      if (!named) continue;
      try {
        const { key, description } = S.pieceMaterial(named, problems);
        p.material = key;
        materials[key] = description;
      } catch (error) {
        problems.push(`${name}: ${p.name}: ${error.message}`);
      }
    }
    const cfg = Config.load(unityScene || null);
    // What each progress flag is in the page's condition modes (met, start), for its gates.
    const symbols = Timing.time('symbols', () => Conditions.symbols(unityScene, { ...cfg.symbols, ...symbolLines }, cfg.stage));
    const sceneSymbols = Object.fromEntries(Object.keys(scenesOf).map(s => { const c = Config.load(s); return [s, Conditions.symbols(s, { ...c.symbols, ...symbolLines }, c.stage)]; }));
    for (const p of [...base, ...pieces]) p.cull = Config.cullDistance(cfg, { ...p, source: p.source || (library[p.name] && library[p.name].source) || '' });
    const env = Timing.time('environment', () => environment(unityScene, problems, [unityScene, ...Object.keys(scenesOf)]));
    // logged once the reply is made (only its JSON comes after), so the log has nearly all its time
    compressTextures();
    console.log(`load: ${name}: server ${Timing.report()}; ${pieces.length} pieces${area ? ` on ${area}` : ''}${also.length ? ` with ${also.join(', ')}` : ''} (${base.length} beneath)`);
    return { name, editable, pieces, area, origin, switch: switches, assemblage, base, library, materials, problems, environment: env, lod: { fov: cfg.lodFov, bias: cfg.lodBias }, clip: { near: cfg.near, far: cfg.far, fog: cfg.farClip }, culling: { perFrame: cfg.culling.perFrame, margin: cfg.culling.margin }, candidates, symbols, sceneSymbols, also, areaLines: lines };
  },
  'POST /api/prepare': body => {
    const result = withShapes(S.prepare(body.names || []), body.names || []);
    compressTextures();
    console.log(`load: prepare ${(body.names || []).join(', ')}: server ${Timing.report()}`);
    return result;
  },
  // The page's side of a load: the scene's JSON, then every mesh and texture it shows.
  'POST /api/loaded': body => {
    console.log(`load: ${String(body.name).slice(0, 200)}: page ${String(body.text).slice(0, 500)}`);
    return {};
  },
  // Page errors, so they can be read in layout.log.
  'POST /api/log': body => {
    console.error(`page error: ${String(body.text).slice(0, 2000)}`);
    return {};
  },
  // Tweak's changes to a Canopy material, into its .mat in the working tree (never committed here).
  'POST /api/material/write': body => {
    const entry = JSON.parse(fs.readFileSync(INDEX, 'utf8')).entries[body.guid];
    if (!entry || !entry.path.endsWith('.mat')) throw new Error(`no material ${body.guid}`);
    const file = path.join(S.REPO, entry.path);
    if (!fs.existsSync(file)) throw new Error(`${entry.path} isn't checked out`);
    fs.writeFileSync(file, require('./tools/convert-materials.js').setTweaks(fs.readFileSync(file, 'utf8'), body.values || {}));
    console.log(`tweak: ${entry.path}: ${JSON.stringify(body.values)}`);
    return {};
  },
  // Tweak: the families among these prefab sources, with their vars and the pieces they make.
  'POST /api/tweak/vars': async body => {
    const folders = new Map();
    for (const source of body.sources || []) {
      const w = workerFor(String(source));
      if (w) folders.set(w.folder, w.command);
    }
    const out = [];
    for (const [folder, command] of folders) {
      const reply = await ask(folder, command, { op: 'vars' });
      if (!tweakSources.has(folder) || !tweakSources.get(folder).busy) noteTweakSources(folder, command, reply.watch);
      out.push({ folder, ...reply });
    }
    return { families: out };
  },
  'POST /api/tweak/meshes': body => {
    const w = tweakFolder(body.folder);
    return ask(w.folder, w.command, { op: 'meshes', values: body.values || {} });
  },
  // Preview atlases, copied where /textures serves them under fresh names.
  'POST /api/tweak/textures': async body => {
    const w = tweakFolder(body.folder);
    const reply = await ask(w.folder, w.command, { op: 'textures', values: body.values || {} });
    // each pair its own stamp (hex, as the texture route wants), so none overwrites another
    const copy = (pair, k) => Object.fromEntries(['map', 'normal'].map(key => {
      const name = `tw${(Date.now() * 16 + k).toString(16)}${key === 'map' ? 'c' : 'n'}.png`;
      fs.copyFileSync(pair[key], path.join(S.TEXTURES, name));
      return [key, `textures/${name}`];
    }));
    // more: the atlases of the assets that have their own (a family's second material)
    return { ...copy(reply, 0), more: (reply.more || []).map((m, k) => ({ assets: m.assets, ...copy(m, k + 1) })) };
  },
  // The values into the model's doc and the full build into Canopy (the page then reloads).
  'POST /api/tweak/write': body => {
    const w = tweakFolder(body.folder);
    return tweakWrite(w.folder, w.command, body.values || {});
  },
  // Probe (the reticle button): what the ray from the camera hit, kept for Claude to read
  // (cache/probes.jsonl, newest last) and logged.
  // The current probe (the last one taken), for the page to go back to where it was taken.
  'GET /api/probe': () => {
    const file = path.join(__dirname, 'cache', 'probes.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    return lines.length ? JSON.parse(lines[lines.length - 1]) : {};
  },
  'POST /api/probe': body => {
    const entry = { at: new Date().toISOString(), ...body };
    fs.mkdirSync(path.join(__dirname, 'cache'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, 'cache', 'probes.jsonl'), JSON.stringify(entry) + '\n');
    const h = body.hit;
    console.log(`probe: ${h ? `${h.piece} ${h.model || ''} at ${h.point.join(',')} (${h.distance} m)` : 'nothing'} in ${body.scene}`);
    // a mesh-clean layer: its branch and ring, and the changes near it, added to the entry when
    // tools/mesh-why.js has them (a few seconds; Ken, 2026-10-28)
    const layer = h && /^inspect:(.+)$/.exec(h.piece || '');
    let look = {};
    try { look = layer ? JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'inspect', layer[1] + '.json'), 'utf8')) : {}; } catch { /* no layer file */ }
    if (look.source && fs.existsSync(path.join(__dirname, 'cache', 'mesh-clean', path.basename(look.source).replace(/\.[^.]+$/, '') + '.jsonl'))) {
      execFile(process.execPath, [path.join(__dirname, 'tools', 'mesh-why.js'), path.basename(look.source).replace(/\.[^.]+$/, ''), ...h.local.map(String), '--r', '0.5', '--json'], { cwd: __dirname, maxBuffer: 1 << 24 }, (error, out) => {
        const file = path.join(__dirname, 'cache', 'probes.jsonl');
        let branch;
        try { branch = error ? { error: String(error.message).slice(0, 300) } : JSON.parse(out); } catch (e) { branch = { error: e.message }; }
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const i = lines.findIndex(l => l && JSON.parse(l).at === entry.at);
        if (i < 0) return;
        lines[i] = JSON.stringify({ ...entry, branch });
        fs.writeFileSync(file, lines.join('\n'));
      });
    }
    return { ok: true };
  },
  'POST /api/save': body => {
    const file = path.join(SCENES, safeName(body.name) + '.md');
    fs.writeFileSync(file, S.replacePieceLines(fs.readFileSync(file, 'utf8'), body.pieces || []));
    if (S.isAssemblage(fs.readFileSync(file, 'utf8'))) rebuildAssemblages(safeName(body.name));
    return { saved: body.pieces.length };
  },
  'POST /api/new': body => {
    const name = safeName(body.name);
    const file = path.join(SCENES, name + '.md');
    if (fs.existsSync(file)) throw new Error(`${name} already exists`);
    fs.mkdirSync(SCENES, { recursive: true });
    const areas = body.area ? [body.area, ...(body.also || [])].map(a => safeName(String(a))) : [];
    for (const a of areas) if (!fs.existsSync(path.join(S.AREAS, a + '.json'))) throw new Error(`no area ${a}`);
    const area = areas.map(a => `- Area: ${a}\n`).join('');
    fs.writeFileSync(file, `---\nname: ${name}\ntype: scene\n---\n# Scene\n\n${area}`);
    return { name };
  },
  'POST /api/extract': body => {
    const name = `${safeName(body.scene)} ${safeName(body.name)}`;
    const area = S.extractArea(body.scene, body.center.map(Number), +body.half, Boolean(body.terrainOnly));
    S.saveArea(name, area);
    return { name, count: area.pieces.length };
  }
};

function send(res, status, type, data) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
// A file, which the browser may keep but must check each time (Ken, 2026-10-31: cache on the
// client): its ETag is its size and modification time, so an unchanged file costs a stat and a
// 304, not a read (Oak's 1272 meshes: about 0.4 s of stats against 2.5 s of reads), and a file
// rebuilt or edited is sent again.
// Compresses what loads found uncompressed (tools/texture-astc.js), one run at a time, at low
// priority so it doesn't slow the page it is working for.
let compressing = false;
const compressQueue = new Map();
function compressTextures() {
  for (const t of S.takeAstcWanted()) compressQueue.set(t.astc, t);
  if (compressing || !compressQueue.size) return;
  compressing = true;
  const run = spawn('nice', ['-n', '10', process.execPath, path.join(S.ROOT, 'tools', 'texture-astc.js')], { stdio: ['pipe', 'inherit', 'inherit'] });
  run.stdin.end(JSON.stringify([...compressQueue.values()]));
  compressQueue.clear();
  run.on('close', () => {
    compressing = false;
    compressTextures();
  });
}

function serveFile(req, res, file) {
  fs.stat(file, (error, st) => {
    if (error || !st.isFile()) return send(res, 404, 'text/plain', 'not found');
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"` };
    if (req.headers['if-none-match'] === headers.ETag) {
      res.writeHead(304, headers);
      return res.end();
    }
    fs.readFile(file, (readError, data) => {
      if (readError) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = api[`${req.method} ${url.pathname}`];
  if (route) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        S.beginRequest();
        Timing.begin();
        const result = route(req.method === 'POST' ? JSON.parse(body || '{}') : url.searchParams);
        if (result && typeof result.then === 'function') {
          result.then(r => send(res, 200, 'application/json', JSON.stringify(r)), error => {
            console.error(`${req.method} ${url.pathname}: ${error.message}`);
            send(res, 400, 'application/json', JSON.stringify({ error: error.message }));
          });
        } else send(res, 200, 'application/json', JSON.stringify(result));
      } catch (error) {
        console.error(`${req.method} ${url.pathname}: ${error.message}`);
        send(res, 400, 'application/json', JSON.stringify({ error: error.message }));
      }
    });
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 1000\ndata: ${INSTANCE}\n\n`);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    listeners.add(res);
    req.on('close', () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
    return;
  }
  if (url.pathname === '/') return serveFile(req, res, path.join(WEB, 'index.html'));
  // Meshes by blob (40 hex), cut variants (-8 hex), and candidates (cand-20 hex; see scene.js withCandidates).
  const mesh = /^\/meshes\/((?:[0-9a-f]{40}|cand-[0-9a-f]{20})(?:-[0-9a-f]{8})?\.obj)$/.exec(url.pathname);
  if (mesh) return serveFile(req, res, path.join(S.MESHES, mesh[1]));
  // Inspection models (tools such as mesh-clean.js write them; scene pieces "inspect:<Name>").
  const inspect = /^\/inspect\/([\w .%-]+\.obj)$/.exec(url.pathname);
  if (inspect) return serveFile(req, res, path.join(S.ROOT, 'cache', 'inspect', path.basename(decodeURIComponent(inspect[1]))));
  // Any name without a slash: a stricter pattern hid the normal maps from gray, whose new suffix it refused.
  const texture = /^\/textures\/([\w.-]+\.(?:png|jpg|astcm))$/.exec(url.pathname);
  if (texture) return serveFile(req, res, path.join(S.TEXTURES, texture[1]));
  // Layout's own materials' textures (materials/, beside their .json).
  const local = /^\/materials\/([\w .%-]+\.(?:png|jpg))$/.exec(url.pathname);
  if (local) return serveFile(req, res, path.join(S.LOCAL_MATERIALS, path.basename(decodeURIComponent(local[1]))));
  // Scripts (web/tickable.js): effects (pfx/) and the rest (scripts/: stand-ins for Canopy's C#, and layout's own).
  const script = /^\/(pfx|scripts)\/(\w+\.js)$/.exec(url.pathname);
  if (script) return serveFile(req, res, path.join(S.ROOT, script[1], script[2]));
  const web = /^\/([\w.-]+)$/.exec(url.pathname);
  if (web) return serveFile(req, res, path.join(WEB, web[1]));
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`layout: http://localhost:${PORT}`));
