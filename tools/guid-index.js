// Builds cache/guid-index.json from the Canopy repo's .meta files, read from git (no checkout),
// plus uncommitted changes in the working tree.
// usage (cwd = layout/): node tools/guid-index.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];
const git = (args, input) => execFileSync('git', GIT.concat(args), { input, maxBuffer: 1 << 30 });

const commit = git(['rev-parse', 'HEAD']).toString().trim();
const tree = git(['ls-tree', '-r', 'HEAD']).toString().trim().split('\n').map(l => {
  const [meta, path] = l.split('\t');
  return { path, blob: meta.split(' ')[2] };
});
const blobOf = new Map(tree.map(t => [t.path, t.blob]));
const metas = tree.filter(t => t.path.endsWith('.meta'));

// fetch any meta blobs still missing, in one request
const missing = git(['cat-file', '--batch-check'], metas.map(m => m.blob).join('\n') + '\n')
  .toString().split('\n').filter(l => l.endsWith(' missing')).map(l => l.split(' ')[0]);
if (missing.length) {
  console.log('fetching', missing.length, 'meta blobs');
  git(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head',
    '--recurse-submodules=no', '--filter=blob:none', '--stdin'], missing.join('\n') + '\n');
}

// read all meta blobs in one batch
const out = git(['cat-file', '--batch'], metas.map(m => m.blob).join('\n') + '\n');
const text = new Map();
for (let i = 0; i < out.length;) {
  const nl = out.indexOf(10, i);
  const [oid, , size] = out.slice(i, nl).toString().split(' ');
  text.set(oid, out.slice(nl + 1, nl + 1 + +size).toString());
  i = nl + 1 + +size + 1;
}

// One .meta's entry: { path, blob, folder?, meshes?, import? }.
function entryFor(path, t, blob) {
  const g = /^guid: (\w+)/m.exec(t);
  if (!g) return null;
  const e = { path, blob };
  if (/^folderAsset: yes/m.test(t)) e.folder = true;
  // meshes inside a model file: fileID -> name (class 43 = Mesh)
  const sub = {};
  for (const x of t.matchAll(/- first:\n\s+43: (-?\d+)\n\s+second: (.*)/g)) sub[x[1]] = x[2].trim();
  for (const x of t.matchAll(/^\s+43(\d{5}): (.*)$/gm)) sub['43' + x[1]] = x[2].trim();
  if (Object.keys(sub).length) e.meshes = sub;
  // Model import scale: Scale Factor, Convert Units (file scale), and axis conversion baking.
  // The project sets no default import presets, so each model's .meta decides.
  if (/^ModelImporter:/m.test(t)) {
    const field = k => { const m = new RegExp('^\\s+' + k + ': (\\S+)', 'm').exec(t); return m ? +m[1] : undefined; };
    e.import = { globalScale: field('globalScale'), useFileScale: field('useFileScale'), useFileUnits: field('useFileUnits'), bakeAxisConversion: field('bakeAxisConversion') };
  }
  return [g[1], e];
}
const entries = {};
for (const m of metas) {
  const path = m.path.slice(0, -5);
  const found = entryFor(path, text.get(m.blob), blobOf.get(path) || null);
  if (found) entries[found[0]] = found[1];
}

// Uncommitted changes in the working tree overlay HEAD, as Unity would see them: added or changed
// .meta files and assets, and deleted .meta files. A changed file's blob is its content hash
// (not stored in git) and it is marked local, so readers take it from the working tree.
const REPO = '/sdcard/Canopy';
const WT = ['--work-tree=' + REPO];
const changed = git(WT.concat(['status', '--porcelain', '-z', '-uall', '--no-renames', '--', 'Assets'])).toString().split('\0').filter(Boolean)
  .map(l => ({ code: l.slice(0, 2), path: l.slice(3) }));
const byPath = new Map(Object.entries(entries).map(([guid, e]) => [e.path, guid]));
const gone = changed.filter(c => c.code.includes('D')).map(c => c.path);
for (const p of gone.filter(p => p.endsWith('.meta'))) {
  const guid = byPath.get(p.slice(0, -5));
  if (guid) delete entries[guid];
}
const present = changed.filter(c => !c.code.includes('D') && fs.existsSync(REPO + '/' + c.path) && fs.statSync(REPO + '/' + c.path).isFile());
const assets = new Set(present.map(c => (c.path.endsWith('.meta') ? c.path.slice(0, -5) : c.path)).filter(p => fs.existsSync(REPO + '/' + p) && fs.statSync(REPO + '/' + p).isFile()));
const hashes = assets.size ? git(WT.concat(['hash-object', '--stdin-paths']), [...assets].map(p => REPO + '/' + p).join('\n') + '\n').toString().trim().split('\n') : [];
const localBlob = new Map([...assets].map((p, i) => [p, hashes[i]]));
let overlaid = 0;
for (const c of present) {
  if (c.path.endsWith('.meta')) {
    const path = c.path.slice(0, -5);
    const found = entryFor(path, fs.readFileSync(REPO + '/' + c.path, 'utf8'), localBlob.get(path) || blobOf.get(path) || null);
    if (!found) continue;
    if (localBlob.has(path)) found[1].local = true;
    entries[found[0]] = found[1];
    overlaid++;
  } else if (byPath.has(c.path) && entries[byPath.get(c.path)]) {
    Object.assign(entries[byPath.get(c.path)], { blob: localBlob.get(c.path), local: true });
    overlaid++;
  }
}
fs.mkdirSync('cache', { recursive: true });
fs.writeFileSync('cache/guid-index.json', JSON.stringify({ commit, entries }));
console.log('guid-index:', Object.keys(entries).length, 'guids,', overlaid, 'from uncommitted changes,', Object.values(entries).filter(e => e.meshes).length, 'model files, commit', commit.slice(0, 7));
