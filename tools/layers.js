// Layer analysis for Canopy (docs: Rendering Performance): how each of Unity's 32 layers is really
// used, before anything (such as Camera.layerCullDistances) relies on them.
//   node tools/layers.js           summary
//   node tools/layers.js --json    every finding, as JSON
// Per layer: objects on it in prefabs and scenes (with renderers, colliders, rigidbodies), the
// files they are in, prefab instances that move objects onto it, which layers it collides with
// (DynamicsManager), the cameras that draw it and the lights that light it (culling masks), and
// how often the C# names it. Prefabs and scenes are cached in cache/layer-analysis.json by size
// and time, so a rerun only reads what changed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./scene.js');

const CACHE_FILE = path.join(__dirname, '..', 'cache', 'layer-analysis.json');
const VERSION = 1; // bump when what is read changes
const GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];
const RENDERERS = new Set(['23', '137', '199', '212', '120', '96']); // mesh, skinned, particle, sprite, line, trail
const COLLIDERS = new Set(['64', '65', '135', '136']); // mesh, box, sphere, capsule

const projectFile = p => execFileSync('git', GIT.concat(['show', 'HEAD:' + p]), { maxBuffer: 1 << 28 }).toString();

// Layer names by index, from TagManager.
function layerNames() {
  const text = projectFile('ProjectSettings/TagManager.asset');
  const block = /\n\s*layers:\n((?:\s*- .*\n)+)/.exec(text);
  return block[1].split('\n').filter(Boolean).map(l => l.replace(/^\s*- ?/, '').trim());
}
// collides[i] is the set of layers layer i collides with (DynamicsManager's matrix: 32 words,
// little-endian hex; a set bit means the two layers collide).
function collisionMatrix() {
  const hex = /m_LayerCollisionMatrix: ([0-9a-f]+)/.exec(projectFile('ProjectSettings/DynamicsManager.asset'))[1];
  return Array.from({ length: 32 }, (_, i) => {
    const word = hex.slice(i * 8, i * 8 + 8).match(/../g).reverse().join('');
    const bits = parseInt(word, 16) >>> 0;
    return Array.from({ length: 32 }, (__, j) => j).filter(j => (bits >>> j) & 1);
  });
}
const maskLayers = bits => Array.from({ length: 32 }, (_, j) => j).filter(j => (bits >>> j) & 1);

// One prefab or scene: per layer, its objects; cameras and lights with their masks; prefab
// instances that set m_Layer.
function analyzeFile(text) {
  const docs = text.split(/^--- /m);
  const byId = {};
  for (const d of docs) {
    const m = /^!u!(\d+) &(-?\d+)( stripped)?/.exec(d);
    if (m) byId[m[2]] = { cls: m[1], text: d, stripped: Boolean(m[3]) };
  }
  const layers = {};
  const views = [];
  const overrides = {};
  for (const d of Object.values(byId)) {
    if (d.cls === '1' && !d.stripped) {
      const layer = +((/m_Layer: (\d+)/.exec(d.text) || [])[1] || 0);
      const kinds = [...d.text.matchAll(/component: \{fileID: (-?\d+)\}/g)].map(m => byId[m[1]] && byId[m[1]].cls);
      const l = layers[layer] = layers[layer] || { objects: 0, renderers: 0, colliders: 0, rigidbodies: 0, names: [] };
      l.objects++;
      if (kinds.some(k => RENDERERS.has(k))) l.renderers++;
      if (kinds.some(k => COLLIDERS.has(k))) l.colliders++;
      if (kinds.includes('54')) l.rigidbodies++;
      if (l.names.length < 5) l.names.push(((/m_Name: (.*)/.exec(d.text) || [])[1] || '').trim());
    } else if ((d.cls === '20' || d.cls === '108') && !d.stripped) {
      const bits = /m_CullingMask:\n\s+serializedVersion: \d+\n\s+m_Bits: (\d+)/.exec(d.text);
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text);
      const name = go && byId[go[1]] ? ((/m_Name: (.*)/.exec(byId[go[1]].text) || [])[1] || '').trim() : '';
      const enabled = !/m_Enabled: 0/.test(d.text);
      if (bits) views.push({ kind: d.cls === '20' ? 'camera' : 'light', name, enabled, layers: maskLayers(+bits[1] >>> 0) });
    } else if (d.cls === '1001') {
      for (const m of d.text.matchAll(/propertyPath: m_Layer\n\s+value: (\d+)/g)) overrides[m[1]] = (overrides[m[1]] || 0) + 1;
    }
  }
  return { layers, views, overrides };
}

function analyze() {
  const names = layerNames();
  const collides = collisionMatrix();
  let cache = { version: VERSION, files: {} };
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === VERSION) cache = c;
  } catch {
    // none yet
  }
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(S.REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(prefab|unity)$/.test(e.name)) files.push(rel);
    }
  })('Assets');
  const seen = new Set(files);
  for (const rel of Object.keys(cache.files)) if (!seen.has(rel)) delete cache.files[rel];
  for (const rel of files) {
    const stat = fs.statSync(path.join(S.REPO, rel));
    const c = cache.files[rel];
    if (c && c.size === stat.size && c.mtimeMs === stat.mtimeMs) continue;
    cache.files[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, ...analyzeFile(fs.readFileSync(path.join(S.REPO, rel), 'utf8')) };
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  // How often the C# names each layer: NameToLayer("X") and GetMask("X") (Layer.cs wraps these).
  const code = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cs')) {
        const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // live code only
        for (const m of text.matchAll(/(?:NameToLayer|GetMask)\(\s*"([^"]+)"/g)) {
          const at = path.relative(S.REPO, p);
          (code[m[1]] = code[m[1]] || new Set()).add(at);
        }
      }
    }
  })(path.join(S.REPO, 'Assets', 'Scripts'));

  const layers = names.map((name, i) => {
    const out = { index: i, name, objects: 0, renderers: 0, colliders: 0, rigidbodies: 0, files: [], overrides: 0, examples: [], camerasDrawing: [], lightsLighting: [], collidesWith: collides[i].map(j => names[j] || String(j)), code: code[name] ? [...code[name]] : [] };
    for (const [rel, f] of Object.entries(cache.files)) {
      const l = f.layers[i];
      if (l) {
        out.objects += l.objects;
        out.renderers += l.renderers;
        out.colliders += l.colliders;
        out.rigidbodies += l.rigidbodies;
        out.files.push(rel);
        for (const n of l.names) if (out.examples.length < 6 && !out.examples.includes(n)) out.examples.push(n);
      }
      out.overrides += f.overrides[i] || 0;
      for (const v of f.views) if (v.enabled && v.layers.includes(i)) (v.kind === 'camera' ? out.camerasDrawing : out.lightsLighting).push(`${v.name} (${path.basename(rel)})`);
    }
    return out;
  });
  const missing = Object.keys(code).filter(n => !names.includes(n)).map(n => ({ name: n, code: [...code[n]] }));
  const views = Object.entries(cache.files).flatMap(([rel, f]) => f.views.map(v => ({ ...v, file: rel, layers: v.layers.map(j => names[j] || String(j)) })));
  return { layers, missing, views };
}

function summary({ layers, missing, views }) {
  console.log('Layers: objects (with renderers / colliders / rigidbodies) in files, instance overrides; collides with; code references');
  for (const l of layers) {
    if (!l.name && !l.objects) {
      console.log(`${String(l.index).padStart(2)} (empty slot)`);
      continue;
    }
    const used = `${l.objects} (${l.renderers}/${l.colliders}/${l.rigidbodies}) in ${l.files.length} files${l.overrides ? `, ${l.overrides} overrides` : ''}`;
    const col = l.collidesWith.length === 32 ? 'all' : l.collidesWith.length ? l.collidesWith.join(' ') : 'nothing';
    console.log(`${String(l.index).padStart(2)} ${l.name}: ${used}; collides with ${col}; code ${l.code.length}${l.examples.length ? `; e.g. ${l.examples.slice(0, 4).join(', ')}` : ''}`);
  }
  if (missing.length) {
    console.log('\nNamed in code but not a layer (NameToLayer gives -1; 1 << -1 is layer 31):');
    for (const m of missing) console.log(`  ${m.name}: ${m.code.join(', ')}`);
  }
  const all = 32;
  console.log('\nCameras and lights whose culling mask leaves layers out (enabled ones):');
  for (const v of views.filter(v => v.enabled && v.layers.length < all)) console.log(`  ${v.kind} ${v.name} (${path.basename(v.file)}): ${v.layers.length ? v.layers.join(', ') : 'nothing'}`);
}

if (require.main === module) {
  const found = analyze();
  if (process.argv[2] === '--json') console.log(JSON.stringify(found, null, 1));
  else summary(found);
}

module.exports = { analyze };
