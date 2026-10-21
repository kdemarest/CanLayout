// layout: a local web app for viewing and composing Canopy scenes on the phone.
// Run in Termux:  node /sdcard/dev/layout/server.js   then open http://localhost:8080
// Serves web/, the converted meshes, and a small JSON API. Listens on this device only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./tools/scene.js');

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

// New assets from docs Asset lines (🔴 or 🟡); existing ones are Unity prefabs.
function newAssetNames() {
  const names = new Set();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['source', 'build'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/^\s*- Asset: (?:🔴|🟡) \w+: (.+?)(?: x\d+)? - /gmu)) names.add(m[1].trim());
      }
    }
  })(DOCS);
  return [...names].sort();
}
function prefabNames() {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'guid-index.json'), 'utf8')).entries;
  return [...new Set(Object.values(index).filter(e => e.path.endsWith('.prefab')).map(e => path.basename(e.path, '.prefab')))].sort();
}

const api = {
  'GET /api/list': () => ({
    composed: listNames(SCENES, '.md'),
    areas: listNames(S.AREAS, '.json'),
    unityScenes: listNames(UNITY_SCENES, '.unity')
  }),
  'GET /api/palette': () => ({ newAssets: newAssetNames(), prefabs: prefabNames() }),
  'GET /api/scene': q => {
    const name = safeName(q.get('name'));
    let pieces, editable;
    if (q.get('kind') === 'area') {
      pieces = JSON.parse(fs.readFileSync(path.join(S.AREAS, name + '.json'), 'utf8')).pieces;
      editable = false;
    } else {
      const parsed = S.parsePieceLines(fs.readFileSync(path.join(SCENES, name + '.md'), 'utf8'));
      if (parsed.errors.length) throw new Error(`${name}: ${parsed.errors[0]}`);
      pieces = parsed.pieces;
      editable = true;
    }
    const { library, materials, problems } = S.prepare(pieces.map(p => p.name), pieces.flatMap(p => p.parts || []));
    return { name, editable, pieces, library, materials, problems };
  },
  'POST /api/prepare': body => S.prepare(body.names || []),
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
    fs.writeFileSync(file, `---\nname: ${name}\ntype: scene\n---\n# Scene\n\n`);
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
  const texture = /^\/textures\/((?:wt)?[0-9a-f]{38,40}\.(png|jpg))$/.exec(url.pathname);
  if (texture) return serveFile(res, path.join(S.TEXTURES, texture[1]));
  const web = /^\/([\w.-]+)$/.exec(url.pathname);
  if (web) return serveFile(res, path.join(WEB, web[1]));
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`layout: http://localhost:${PORT}`));
