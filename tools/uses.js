// What Canopy really ships: every asset reachable from the build, for audits that should only
// count what is in use (docs: Rendering Performance).
//   node tools/uses.js                    summary: assets in use and unused, by folder
//   node tools/uses.js <path text>        each matching asset, in use or not, and why (one chain
//                                         of references from a root)
//   node tools/uses.js --json             every in-use path with its chain, as JSON
//   --live (with any of them)             only what the game can draw or run (see liveRefs)
// Roots: the enabled scenes in EditorBuildSettings, Addressables entries and everything in a
// Resources folder. From them, references (guid: ...) are followed through scenes, prefabs,
// materials, animator controllers and ScriptableObject .assets. Mesh .assets under Assets/Meshes
// and model files are leaves. Each file's guid list is cached in cache/uses-analysis.json by blob.
// Assets loaded by name from code other than Resources are not seen. Run tools/guid-index.js
// first when Canopy changes.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const S = require('./scene.js');
const U = require('./unity.js');

const CACHE_FILE = path.join(__dirname, '..', 'cache', 'uses-analysis.json');
const VERSION = 1; // bump when what is read changes
const LIVE_VERSION = 5; // bump when liveRefs or drawnMaterials changes
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

// --live (Ken, 2026-11-06: the corals, placed only under Game.unity's inactive Edit branch, aren't
// in use; things under a test or unused heading don't count): a scene's or prefab's references, less those
// made only by what never shows. tools/unity.js knows what never turns on (a piece's or part's
// never: inactive with nothing to switch it on, HideOnStart, a disabled renderer). Dropped: the
// documents of each never piece (an instance whole; a mesh object's components), and every
// document under an inactive object all of whose pieces never show, or under an object named
// Test or Unused. What may still run stays (scripts on live objects, an active object's other components),
// so a prefab a live spawner names is still followed; references from code aren't seen. Scenes
// and prefabs only; cached by depKey (in analyze).
const TEST = /test|unused/i; // a Test or Unused heading: Test, TestArea, ResinTest, McTenantsUnused (Ken, 2026-11-06)
function documents(text) {
  const out = [];
  const re = /^--- !u!(\d+) &(-?\d+)( stripped)?[^\n]*\n/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => out.push({ cls: +m[1], id: m[2], stripped: Boolean(m[3]), start: m.index, body: text.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length) }));
  return out;
}
function liveRefs(p, text) {
  const isScene = p.endsWith('.unity');
  let pieces; // [{ go | instance, never }]
  try {
    if (isScene) pieces = U.scenePieces(path.join(U.REPO, p)).map(q => ({ go: q.go, instance: q.instance, never: Boolean(q.game && q.game.never) }));
    else {
      const pf = U.prefab(guidOf.get(p));
      if (!pf) return null;
      pieces = pf.parts.map(q => {
        const [first, rest] = String(q.go || '').split(/\/(.*)/);
        return rest !== undefined ? { instance: first, never: Boolean(q.never) } : { go: q.go, never: Boolean(q.never) };
      });
    }
  } catch {
    return null; // unreadable here: follow everything
  }
  const docs = documents(text);
  const ref = (body, key) => (new RegExp(key + ': \\{fileID: (-?\\d+)').exec(body) || [])[1];
  const goOfT = {}, fatherOfGo = {}, instOfStripped = {}, nameOfGo = {}, activeOfGo = {};
  for (const d of docs) {
    if (d.stripped) { instOfStripped[d.id] = ref(d.body, 'm_PrefabInstance'); continue; }
    if (d.cls === 1) { nameOfGo[d.id] = (/\n {2}m_Name: (.*)/.exec(d.body) || [])[1] || ''; activeOfGo[d.id] = !/\n {2}m_IsActive: 0/.test(d.body); }
  }
  for (const d of docs) if (!d.stripped && (d.cls === 4 || d.cls === 224)) goOfT[d.id] = ref(d.body, 'm_GameObject');
  // a node's parent node: objects by game object id, instances as 'pi' + id
  const node = t => (goOfT[t] ? goOfT[t] : instOfStripped[t] ? 'pi' + instOfStripped[t] : null);
  for (const d of docs) {
    if (!d.stripped && (d.cls === 4 || d.cls === 224)) fatherOfGo[goOfT[d.id]] = node(ref(d.body, 'm_Father'));
    if (d.cls === 1001 && !d.stripped) fatherOfGo['pi' + d.id] = node(ref(d.body, 'm_TransformParent'));
  }
  const chain = k => { const out = []; for (let x = k, i = 0; x && i < 500; x = fatherOfGo[x], i++) out.push(x); return out; };
  // under each node: how many pieces, and how many of them never show
  const count = {};
  for (const q of pieces) for (const x of chain(q.go || 'pi' + q.instance)) { const c = count[x] = count[x] || [0, 0]; c[0]++; if (q.never) c[1]++; }
  const deadRoot = x => (/^\d|^-/.test(x) && ((activeOfGo[x] === false && count[x] && count[x][0] === count[x][1]) || TEST.test(nameOfGo[x] || '')));
  const dead = x => chain(x).some(deadRoot);
  const deadOwn = new Set(pieces.filter(q => q.never).map(q => q.go || 'pi' + q.instance));
  const owner = d => {
    if (d.stripped) return 'pi' + instOfStripped[d.id];
    if (d.cls === 1001) return 'pi' + d.id;
    if (d.cls === 1) return d.id;
    return ref(d.body, 'm_GameObject') || null;
  };
  const kept = docs.filter(d => {
    const o = owner(d);
    return !o || !(deadOwn.has(o) || dead(o));
  });
  // What the kept documents do with what they name: spawn (a prefab a script or a script setting
  // names, not an instance's source), code (a material a script names) and drawn (a renderer's
  // materials where no instance further out can change them: a scene's renderers, a prefab's
  // particle renderers and its renderers' slots after the first, which tools/unity.js doesn't read).
  const kind = g => (index[g] ? path.extname(index[g].path).toLowerCase() : '');
  const guids = t => [...t.matchAll(/guid: ([0-9a-f]{32})/g)].map(m => m[1]);
  const spawn = new Set(), code = new Set(), drawn = new Set();
  for (const d of kept) {
    if (d.stripped) continue;
    if (d.cls === 1001) {
      for (const m of d.body.matchAll(/propertyPath: (\S+)\n\s+value:[^\n]*\n\s+objectReference: \{[^}]*guid: ([0-9a-f]{32})/g)) {
        if (/^m_Materials\./.test(m[1])) continue; // a renderer's: tools/unity.js applies it
        if (kind(m[2]) === '.prefab') spawn.add(m[2]);
        if (kind(m[2]) === '.mat') code.add(m[2]);
      }
    } else if (d.cls === 23 || d.cls === 137 || d.cls === 199) {
      const slots = guids((/\n {2}m_Materials:\n((?: {2}- .*\n)*)/.exec(d.body) || ['', ''])[1]);
      slots.forEach((g, i) => { if (isScene || d.cls === 199 || i > 0) drawn.add(g); });
    } else if (d.cls === 114) {
      for (const g of guids(d.body)) {
        if (kind(g) === '.prefab') spawn.add(g);
        if (kind(g) === '.mat') code.add(g);
      }
    }
  }
  return { all: [...new Set(kept.flatMap(d => guids(d.body)))], spawn: [...spawn], code: [...code], drawn: [...drawn] };
}

function analyze({ live = false } = {}) {
  let cache = { version: VERSION, refs: {} };
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === VERSION) cache = c;
  } catch {
    // none yet
  }
  if (!cache.live || cache.live.version !== LIVE_VERSION) cache.live = { version: LIVE_VERSION, refs: {}, pieces: {} };
  const entryOf = p => index[guidOf.get(p)];
  const blobOf = p => (entryOf(p) || {}).blob;
  const rawRefs = p => (blobOf(p) && cache.refs[blobOf(p)]) || [];
  // From the roots, one round per depth, reading what a round needs in one batch.
  const reach = (refsOf, round) => {
    const why = new Map(); // path -> [from path or root kind]
    let frontier = [];
    for (const [p, kind] of roots()) {
      if (!why.has(p) && entryOf(p)) {
        why.set(p, [kind]);
        frontier.push(p);
      }
    }
    while (frontier.length) {
      round(frontier);
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
    return why;
  };
  // Guids a file references, by blob. Scene and prefab texts are kept for liveRefs.
  let read = 0;
  const texts = new Map();
  let why = reach(rawRefs, frontier => {
    const toRead = frontier.filter(p => follows(p) && blobOf(p) && !cache.refs[blobOf(p)]);
    if (!toRead.length) return;
    const got = S.blobs(toRead.map(blobOf));
    for (const p of toRead) {
      const text = got.get(blobOf(p));
      cache.refs[blobOf(p)] = text ? [...new Set([...text.toString('latin1').matchAll(/guid: ([0-9a-f]{32})/g)].map(m => m[1]))] : [];
      if (text && /\.(unity|prefab)$/.test(p)) texts.set(p, text);
    }
    read += toRead.length;
  });
  // A scene's or prefab's live answer depends on its own text and on everything it reaches but
  // materials (and what only they reach): nested prefabs, scripts, models, ScriptableObjects. Each
  // is cached under a hash of those blobs, so converting a material keeps every answer, and a
  // changed prefab redoes only the files that reach it.
  const keys = new Map();
  const depKey = p => {
    if (keys.has(p)) return keys.get(p);
    const seen = new Set([p]);
    const stack = [p];
    while (stack.length) {
      const q = stack.pop();
      if (!follows(q)) continue;
      for (const g of rawRefs(q)) {
        const e = index[g];
        if (!e || e.folder || e.path.endsWith('.mat') || seen.has(e.path)) continue;
        seen.add(e.path);
        stack.push(e.path);
      }
    }
    const k = crypto.createHash('sha1').update([...seen].map(q => q + ' ' + blobOf(q)).sort().join('\n')).digest('hex');
    keys.set(p, k);
    return k;
  };
  const liveKey = p => (/\.(unity|prefab)$/.test(p) && blobOf(p) ? depKey(p) : null);
  const liveOf = p => (liveKey(p) && cache.live.refs[liveKey(p)]) || null;
  const usedKeys = new Set();
  if (live) {
    why = reach(p => (liveOf(p) || { all: rawRefs(p) }).all, frontier => {
      const todo = frontier.filter(p => liveKey(p) && !cache.live.refs[liveKey(p)]);
      const missing = todo.filter(p => !texts.has(p));
      if (missing.length) {
        const got = S.blobs(missing.map(blobOf));
        for (const p of missing) if (got.get(blobOf(p))) texts.set(p, got.get(blobOf(p)));
      }
      for (const p of todo) {
        const text = texts.get(p);
        cache.live.refs[liveKey(p)] = (text && liveRefs(p, text.toString('utf8').replace(/\r\n/g, '\n'))) || { all: rawRefs(p), spawn: [], code: [], drawn: [], unread: true };
      }
      read += todo.length;
      for (const p of frontier) if (liveKey(p)) usedKeys.add(liveKey(p));
    });
  }
  const save = () => {
    if (live) cache.live.refs = Object.fromEntries([...usedKeys].map(k => [k, cache.live.refs[k]])); // only what this Canopy reaches
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  };
  if (read) save();
  const chain = p => {
    const out = [p];
    for (let at = why.get(p); at && why.has(at[0]); at = why.get(at[0])) out.push(at[0]);
    out.push(why.get(out[out.length - 1])[0]);
    return out;
  };
  return { used: why, chain, all: Object.values(index).filter(e => !e.folder).map(e => e.path), liveOf, rawRefs, depKey, cache, save };
}

// Where the game draws each material (Ken, 2026-11-06: count only what is really used): live
// pieces of the build scenes (tools/unity.js, instances' material settings applied; not under a
// Test object), the live parts of every prefab a live script names (spawned) or a Resources folder
// holds, and what liveRefs calls drawn or code. Material guid -> [where, ...] (a few each). Each
// scene's and spawned prefab's drawn materials are cached under its depKey, like its live answer.
function drawnMaterials() {
  const { used, liveOf, rawRefs, depKey, cache, save } = analyze({ live: true });
  const pieces = {};
  let made = 0;
  const piecesOf = (p, make) => {
    const k = depKey(p);
    if (!cache.live.pieces[k]) {
      cache.live.pieces[k] = make();
      made++;
    }
    return (pieces[k] = cache.live.pieces[k]);
  };
  const out = new Map();
  const add = (g, why) => {
    if (!g || !index[g] || !index[g].path.endsWith('.mat')) return;
    const list = out.get(g) || out.set(g, []).get(g);
    if (list.length < 4 && !list.includes(why)) list.push(why);
  };
  for (const [p, kind] of roots()) {
    if (kind !== 'build scene') continue;
    const scene = path.basename(p, '.unity');
    const list = piecesOf(p, () => {
      const drawn = [];
      for (const q of U.scenePieces(path.join(U.REPO, p))) {
        if ((q.game && q.game.never) || q.path.split('/').slice(0, -1).some(n => TEST.test(n))) continue;
        if (q.prefab) for (const part of q.prefab.parts) { if (!part.never) for (const g of [part.material, ...(part.materials || [])]) drawn.push([g, q.path]); }
        else for (const g of [q.material, ...(q.materials || [])]) drawn.push([g, q.path]);
      }
      return drawn;
    });
    for (const [g, at] of list) add(g, `${scene}: ${at}`);
  }
  const spawned = new Map(); // prefab guid -> the file naming it
  for (const p of used.keys()) {
    const live = liveOf(p);
    if (/(^|\/)Resources\/.*\.prefab$/.test(p)) spawned.set(guidOf.get(p), 'Resources');
    if (!live) continue;
    for (const g of live.spawn) if (!spawned.has(g)) spawned.set(g, path.basename(p));
    for (const g of live.drawn) add(g, `${path.basename(p)} (renderer)`);
    for (const g of live.code) add(g, `${path.basename(p)} (set by a script)`);
  }
  // other followed files (ScriptableObjects, controllers) name materials too
  for (const p of used.keys()) if (/\.(asset|controller|overrideController|playable)$/.test(p) && !p.startsWith('Assets/Meshes/')) for (const g of rawRefs(p)) add(g, path.basename(p));
  for (const [g, by] of spawned) {
    if (!index[g]) continue;
    const [name, list] = piecesOf(index[g].path, () => {
      const pf = U.prefab(g);
      return pf ? [pf.name, pf.parts.filter(part => !part.never).flatMap(part => [part.material, ...(part.materials || [])])] : ['', []];
    });
    for (const m of list) add(m, `${name} (spawned by ${by})`);
  }
  if (made || Object.keys(pieces).length !== Object.keys(cache.live.pieces).length) {
    cache.live.pieces = pieces;
    save();
  }
  return out;
}

function folderOf(p) {
  return p.split('/').slice(0, 3).join('/');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const { used, chain, all } = analyze({ live: args.includes('--live') });
  const arg = args.filter(a => a !== '--live')[0];
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

module.exports = { analyze, drawnMaterials, TEST };
