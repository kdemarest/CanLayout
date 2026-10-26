// What Canopy really ships: every asset reachable from the build, for audits that should only
// count what is in use (docs: Rendering Performance).
//   node tools/uses.js                    summary: assets in use and unused, by folder
//   node tools/uses.js <path text>        each matching asset, in use or not, and why (one chain
//                                         of references from a root)
//   node tools/uses.js --json             every in-use path with its chain, as JSON
// Roots: the enabled scenes in EditorBuildSettings, Addressables entries and everything in a
// Resources folder. From them, references (guid: ...) are followed through scenes, prefabs,
// materials, animator controllers and ScriptableObject .assets. Mesh .assets under Assets/Meshes
// and model files are leaves. Each file's guid list is cached in cache/uses-analysis.json by blob.
// Assets loaded by name from code other than Resources are not seen. Run tools/guid-index.js
// first when Canopy changes.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./scene.js');

const CACHE_FILE = path.join(__dirname, '..', 'cache', 'uses-analysis.json');
const VERSION = 1; // bump when what is read changes
const GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];
const FOLLOW = /\.(unity|prefab|mat|asset|controller|overrideController|preset|spriteatlas|playable)$/;

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
const guidOf = new Map(Object.entries(index).map(([g, e]) => [e.path, g]));
const follows = p => FOLLOW.test(p) && !(p.startsWith('Assets/Meshes/') && p.endsWith('.asset'));

function roots() {
  const settings = execFileSync('git', GIT.concat(['show', 'HEAD:ProjectSettings/EditorBuildSettings.asset'])).toString();
  const out = [];
  for (const m of settings.matchAll(/- enabled: (\d)\n\s+path: (.*)\n/g)) if (m[1] === '1') out.push([m[2].trim(), 'build scene']);
  for (const e of Object.values(index)) {
    if (!e.folder && /(^|\/)Resources\//.test(e.path)) out.push([e.path, 'Resources']);
  }
  for (const e of Object.values(index)) {
    if (e.path.startsWith('Assets/AddressableAssetsData/AssetGroups/') && e.path.endsWith('.asset')) out.push([e.path, 'Addressables']);
  }
  return out;
}

function analyze() {
  let cache = { version: VERSION, refs: {} };
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === VERSION) cache = c;
  } catch {
    // none yet
  }
  const entryOf = p => index[guidOf.get(p)];
  // Guids a file references, by blob; the whole reachable set is read in rounds, one batch each.
  const refsOf = p => {
    const e = entryOf(p);
    return e && e.blob && cache.refs[e.blob] ? cache.refs[e.blob] : [];
  };
  const why = new Map(); // path -> [from path or root kind]
  let frontier = [];
  for (const [p, kind] of roots()) {
    if (!why.has(p) && entryOf(p)) {
      why.set(p, [kind]);
      frontier.push(p);
    }
  }
  let read = 0;
  while (frontier.length) {
    const toRead = frontier.filter(p => follows(p) && entryOf(p).blob && !cache.refs[entryOf(p).blob]);
    if (toRead.length) {
      const texts = S.blobs(toRead.map(p => entryOf(p).blob));
      for (const p of toRead) {
        const blob = entryOf(p).blob;
        const text = texts.get(blob);
        cache.refs[blob] = text ? [...new Set([...text.toString('latin1').matchAll(/guid: ([0-9a-f]{32})/g)].map(m => m[1]))] : [];
      }
      read += toRead.length;
    }
    const next = [];
    for (const p of frontier) {
      if (!follows(p)) continue;
      for (const g of refsOf(p)) {
        const e = index[g];
        if (!e || e.folder || why.has(e.path)) continue;
        why.set(e.path, [p]);
        next.push(e.path);
      }
    }
    frontier = next;
  }
  if (read) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const chain = p => {
    const out = [p];
    for (let at = why.get(p); at && why.has(at[0]); at = why.get(at[0])) out.push(at[0]);
    out.push(why.get(out[out.length - 1])[0]);
    return out;
  };
  return { used: why, chain, all: Object.values(index).filter(e => !e.folder).map(e => e.path) };
}

function folderOf(p) {
  return p.split('/').slice(0, 3).join('/');
}

if (require.main === module) {
  const { used, chain, all } = analyze();
  const arg = process.argv[2];
  if (arg === '--json') {
    console.log(JSON.stringify(Object.fromEntries([...used.keys()].map(p => [p, chain(p).slice(1)])), null, 1));
  } else if (arg) {
    const hits = all.filter(p => p.includes(arg) && !p.endsWith('.meta')).sort();
    for (const p of hits) console.log(used.has(p) ? `in use  ${p}  <- ${chain(p).slice(1).join(' <- ')}` : `unused  ${p}`);
    console.log(`${hits.filter(p => used.has(p)).length} of ${hits.length} in use`);
  } else {
    const rows = {};
    for (const p of all) {
      if (/\.(cs|meta|asmdef|dll)$/.test(p)) continue;
      const r = rows[folderOf(p)] = rows[folderOf(p)] || [0, 0];
      r[used.has(p) ? 0 : 1]++;
    }
    console.log('Assets in use / unused, by folder (code excluded):');
    for (const [f, [u, n]] of Object.entries(rows).sort((a, b) => b[1][1] - a[1][1])) console.log(`  ${f}: ${u} / ${n}`);
  }
}

module.exports = { analyze };
