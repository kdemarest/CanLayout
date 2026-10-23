// layout: a local web app for viewing and composing Canopy scenes on the phone.
// Run in Termux:  node /sdcard/dev/layout/server.js   then open http://localhost:8080
// Serves web/, the converted meshes, and a small JSON API. Listens on this device only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./tools/scene.js');
const Config = require('./tools/config.js');
const Texts = require('./tools/texts.js');
const Shapes = require('./tools/shapes.js');

const PORT = +process.env.PORT || 8080;
const DEV = path.join(__dirname, '..');
const DOCS = path.join(DEV, 'docs');
const SCENES = path.join(DOCS, 'scenes');
const WEB = path.join(__dirname, 'web');
const UNITY_SCENES = '/sdcard/Canopy/Assets/Scenes';
// Each server run has its own id; the page reloads when it sees a new one (dev.js restarts us on edits).
const INSTANCE = Date.now().toString(36);
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.obj': 'text/plain', '.json': 'application/json', '.txt': 'text/plain' };

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
  const docs = Shapes.readDocs(DOCS);
  const newAssets = Object.entries(docs.assets).filter(([, a]) => a.chip !== '🟢' && a.type !== 'Text').map(([name]) => name).sort();
  return { newAssets, shapes: docs.shapes, sources: docs.sources, shapeErrors: docs.errors, unity: docs.assets };
}
// Adds placeholder shapes to a prepare result for names with no Unity prefab or mesh, and what
// their "use" shapes name: other assets' shapes, or Unity prefabs (prepared here).
function withShapes(result, names) {
  const docs = docsAssets();
  const problems = [...(result.problems || []), ...docs.shapeErrors];
  const add = (name, trail) => {
    if (result.library[name]) return;
    if (trail.includes(name)) return problems.push(`Shape use loops: ${[...trail, name].join(' -> ')}`);
    // Once the asset has a Unity prefab under its Unity name (Burl shard -> BurlShard), that wins;
    // not a generated placeholder (tools/make-shapes.js), which only copies the shapes.
    const unity = Shapes.unityName(name, docs.unity[name] && docs.unity[name].unity);
    if (unity !== name) {
      const prefab = S.prepare([unity]);
      const found = prefab.library[unity];
      if (found && !(docs.shapes[name] && String(found.source).startsWith('Assets/Placeholder/'))) {
        result.library[name] = found;
        Object.assign(result.materials, prefab.materials);
        return;
      }
    }
    if (!docs.shapes[name]) return;
    result.library[name] = { kind: 'shapes', source: docs.sources[name], shapes: docs.shapes[name], parts: [] };
    for (const shape of docs.shapes[name]) {
      if (shape.kind !== 'use') continue;
      if (docs.shapes[shape.name]) add(shape.name, [...trail, name]);
      else if (!result.library[shape.name]) {
        const prefab = S.prepare([shape.name]);
        if (!prefab.library[shape.name]) problems.push(`docs/${docs.sources[name]}: ${name} uses ${shape.name}, which is neither an asset with shapes nor a Unity prefab`);
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

// An imported area, re-imported first when unity.json changed since (its show/hide rules shape it).
function loadArea(name) {
  let area = JSON.parse(fs.readFileSync(path.join(S.AREAS, safeName(name) + '.json'), 'utf8'));
  if (area.source.config !== Config.mtime()) {
    area = S.extractArea(area.source.scene, area.source.center, area.source.half);
    S.saveArea(name, area);
  }
  return area;
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
    return { newAssets: docs.newAssets, shaped: Object.keys(docs.shapes), shapeErrors: docs.shapeErrors, reuses, prefabs };
  },
  'GET /api/texts': () => ({ file: Texts.FILE, texts: Texts.loadTexts(S.REPO, JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'guid-index.json'), 'utf8')).entries, S.blobs) }),
  'GET /api/scene': q => {
    const name = safeName(q.get('name'));
    let pieces, editable, area = null, base = [];
    if (q.get('kind') === 'area') {
      pieces = loadArea(name).pieces;
      editable = false;
    } else {
      // A composed scene may sit on an imported area ("- Area: <name>"), drawn read-only beneath it.
      const text = fs.readFileSync(path.join(SCENES, name + '.md'), 'utf8');
      const parsed = S.parsePieceLines(text);
      if (parsed.errors.length) throw new Error(`${name}: ${parsed.errors[0]}`);
      pieces = parsed.pieces;
      editable = true;
      area = S.areaLine(text);
      if (area) base = loadArea(area).pieces;
    }
    // Pieces with their own parts (trees, overridden instances) are not resolved as whole prefabs.
    const all = [...base, ...pieces];
    const names = all.filter(p => !p.parts).map(p => p.name);
    const { library, materials, problems } = withShapes(S.prepare(names, all.flatMap(p => p.parts || [])), names);
    return { name, editable, pieces, area, base, library, materials, problems };
  },
  'POST /api/prepare': body => withShapes(S.prepare(body.names || []), body.names || []),
  // Page errors, so they can be read in layout.log.
  'POST /api/log': body => {
    console.error(`page error: ${String(body.text).slice(0, 2000)}`);
    return {};
  },
  'POST /api/save': body => {
    const file = path.join(SCENES, safeName(body.name) + '.md');
    fs.writeFileSync(file, S.replacePieceLines(fs.readFileSync(file, 'utf8'), body.pieces || []));
    return { saved: body.pieces.length };
  },
  'POST /api/new': body => {
    const name = safeName(body.name);
    const file = path.join(SCENES, name + '.md');
    if (fs.existsSync(file)) throw new Error(`${name} already exists`);
    fs.mkdirSync(SCENES, { recursive: true });
    const area = body.area ? `- Area: ${safeName(body.area)}\n` : '';
    if (area && !fs.existsSync(path.join(S.AREAS, body.area.trim() + '.json'))) throw new Error(`no area ${body.area}`);
    fs.writeFileSync(file, `---\nname: ${name}\ntype: scene\n---\n# Scene\n\n${area}`);
    return { name };
  },
  'POST /api/extract': body => {
    const name = `${safeName(body.scene)} ${safeName(body.name)}`;
    const area = S.extractArea(body.scene, body.center.map(Number), +body.half);
    S.saveArea(name, area);
    return { name, count: area.pieces.length };
  }
};

function send(res, status, type, data) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
function serveFile(res, file) {
  fs.readFile(file, (error, data) => (error ? send(res, 404, 'text/plain', 'not found') : send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data)));
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
        const result = route(req.method === 'POST' ? JSON.parse(body || '{}') : url.searchParams);
        send(res, 200, 'application/json', JSON.stringify(result));
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
    req.on('close', () => clearInterval(keepAlive));
    return;
  }
  if (url.pathname === '/') return serveFile(res, path.join(WEB, 'index.html'));
  const mesh = /^\/meshes\/([0-9a-f]{40}(?:-[0-9a-f]{8})?\.obj)$/.exec(url.pathname);
  if (mesh) return serveFile(res, path.join(S.MESHES, mesh[1]));
  const texture = /^\/textures\/((?:wt)?[0-9a-f]{38,40}-\d+\.(png|jpg))$/.exec(url.pathname);
  if (texture) return serveFile(res, path.join(S.TEXTURES, texture[1]));
  const web = /^\/([\w.-]+)$/.exec(url.pathname);
  if (web) return serveFile(res, path.join(WEB, web[1]));
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`layout: http://localhost:${PORT}`));
