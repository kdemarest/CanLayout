// Canopy's conditions, read when a scene or prefab is imported (Ken, 2026-10-29): which objects
// the game switches on and off, moves or scales by its progress flags, and what each flag is once
// the game has set it. The page evaluates the gates against a scene's symbols (web/conditions.js,
// MathEval's port) to draw the scene with its conditions met, as a new game starts it, or as saved.
//
// Per file (a scene or prefab, parsed by unity.js), by node (a transform id, or 'pi<instance>'):
//   gates     ActiveWhen, EffectActive (and EffectActiveMany's targets), and EffectBoolActive
//             under an EffectBoolTrigger: the object is on exactly while its condition holds,
//             whatever it was saved as
//   startsOff an EffectScale or EffectMove a trigger plays whose target starts inactive (its
//             objectStartsInactive, moveObjectStartsInactive): off until a trigger's condition holds
//   shrunk    an EffectScale to zero: gone once its trigger's condition holds (the Sky Isle's cloud)
//   moves     an EffectMove (to its end mark's world position), EffectTransform (to its final's
//             position and scale), EffectScale to a size: where the object is once its trigger fired
//   reveals   a Pod's Revealer (PodRequest) a trigger plays: the pieces under its revealRoot, which
//             Revealer.Prepare hides until then; Layout shows them revealed (Ken, 2026-11-10;
//             tools/unity.js landedPods)
//   hidden    HideOnStart: its renderer is switched off when the game starts
// Triggers are OnCondition, OnConditionOnce, OnConditionDoEffect, EffectTrigger and the obsolete
// EffectConditional; each plays the effects on its effectsToExecute object (Effects.PlayMine: that
// object's own). "this" in a condition is the object's Symbol (its uniqueName); FilterWithStageData,
// which some ActiveWhens also test, is not read (none of the scenes so far has one).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('./unity.js');
const Config = require('./config.js');
const { keep: Keep } = require('./keep.js');

const TRIGGERS = new Set(['OnCondition', 'OnConditionOnce', 'OnConditionDoEffect', 'EffectTrigger', 'EffectConditional']);
const SELF_DEFAULT = new Set(['EffectTrigger', 'EffectConditional']); // no effectsToExecute: their own object

// The rules of one parsed file; for a scene, instances (f.inst) are looked into for a Pod's Revealer.
function rulesOf(f) {
  if (f.conditionRules) return f.conditionRules;
  const tOf = {};
  for (const [id, t] of Object.entries(f.t)) tOf[t.go] = id;
  const compGo = {};
  for (const [g, , , id] of f.scripts) compGo[id] = g;
  // An object, transform or component of this file (by id) as its node, or null.
  const nodeOf = id => {
    if (!id || id === '0') return null;
    if (f.t[id]) return id;
    if (f.strippedT[id]) return 'pi' + f.strippedT[id];
    if (f.go[id]) return tOf[id] || null;
    if (f.strippedGo[id]) return 'pi' + f.strippedGo[id];
    if (compGo[id]) return nodeOf(compGo[id]);
    if (f.strippedComponent[id]) return 'pi' + f.strippedComponent[id];
    return null;
  };
  const scripts = f.scripts.map(([g, guid, body, id]) => ({ node: nodeOf(g), go: g, id, name: U.scriptName(guid), fields: U.scriptFields(body), body }));
  const at = {};
  for (const s of scripts) if (s.node) (at[s.node] = at[s.node] || []).push(s);
  const symbolOf = {};
  for (const s of scripts) if (s.name === 'Symbol' && s.fields.uniqueName) symbolOf[s.node] = String(s.fields.uniqueName);
  // "this" is the object's own symbol (Expression.cs; SymbolExtensions looks only at the object).
  const expr = (s, text) => String(text ?? '').replace(/\bthis\b/g, () => symbolOf[s.node] || 'this');
  const r = { gates: {}, startsOff: {}, shrunk: {}, moves: {}, reveals: [], hidden: new Set(), symbolOf };
  const add = (map, key, v) => { if (key) (map[key] = map[key] || []).push(v); };
  const ref = v => (v && v.ref ? nodeOf(v.ref) : null);
  for (const s of scripts) {
    if (s.name === 'ActiveWhen' || s.name === 'EffectActive') add(r.gates, s.node, expr(s, s.fields.condition));
    if (s.name === 'EffectActiveMany') {
      const list = /\n {2}targetList:\n((?: {2}- .*\n?)*)/.exec(s.body);
      for (const m of (list ? list[1] : '').matchAll(/fileID: (-?\d+)/g)) add(r.gates, nodeOf(m[1]), expr(s, s.fields.condition));
    }
    if (s.name === 'HideOnStart') r.hidden.add(s.node);
    if (s.name === 'EffectBoolTrigger') {
      // Effects.PlayAll: the bool effects anywhere under it
      const cond = expr(s, s.fields.condition);
      for (const b of scripts) if (b.name === 'EffectBoolActive' && under(f, b.node, s.node)) add(r.gates, b.node, b.fields.stateWhenTrue === 0 ? { not: cond } : cond);
    }
    if (!TRIGGERS.has(s.name)) continue;
    const when = expr(s, s.fields.condition);
    if (s.name === 'OnConditionDoEffect') {
      const e = s.fields.effectToExecute && s.fields.effectToExecute.ref;
      const played = scripts.find(x => x.id === e);
      if (played) play(played, when);
      continue;
    }
    const target = ref(s.fields.effectsToExecute) || (SELF_DEFAULT.has(s.name) ? s.node : null);
    for (const e of at[target] || []) play(e, when);
    // A prefab instance's own root effects: a Pod (PodRequest's Revealer, its revealRoot set here)
    if (target && target.startsWith('pi') && f.inst[target.slice(2)]) {
      const x = f.inst[target.slice(2)];
      const root = x.mods.find(m => m.path === 'revealRoot' && m.ref);
      if (root && rootScripts(x.src).includes('Revealer')) r.reveals.push({ root: nodeOf(root.ref), when });
    }
  }
  function play(e, when) {
    const fx = e.fields;
    if (e.name === 'EffectScale') {
      const t = ref(fx.targetObject);
      if (fx.objectStartsInactive !== 0) add(r.startsOff, t, when);
      const s = fx.endScale || {};
      if (!s.x && !s.y && !s.z) add(r.shrunk, t, when);
      else add(r.moves, t, { when, scale: s });
    }
    if (e.name === 'EffectMove') {
      const t = ref(fx.moveObject);
      if (fx.moveObjectStartsInactive !== 0) add(r.startsOff, t, when);
      if (ref(fx.endMark)) add(r.moves, t, { when, to: ref(fx.endMark) });
    }
    if (e.name === 'EffectTransform' && ref(fx.final)) add(r.moves, ref(fx.target), { when, to: ref(fx.final), toScale: true });
  }
  f.conditionRules = r;
  return r;
}
// Is node a at or under node b (by this file's transforms)?
function under(f, a, b) {
  const tOf = {};
  for (const [id, t] of Object.entries(f.t)) tOf[t.go] = id;
  let k = a;
  for (let i = 0; k && i < 200; i++) {
    if (k === b) return true;
    if (k.startsWith('pi')) { const x = f.inst[k.slice(2)]; k = x ? alias(f, x.parent) : null; continue; }
    k = f.t[k] ? alias(f, f.t[k].father) : null;
  }
  return false;
}
const alias = (f, id) => (!id || id === '0' ? null : f.strippedT[id] ? 'pi' + f.strippedT[id] : id);

// The names of the scripts on a prefab's root object (by guid), as its file has them.
const rootScriptCache = new Map();
function rootScripts(guid) {
  if (rootScriptCache.has(guid)) return rootScriptCache.get(guid);
  const e = U.index()[guid];
  let names = [];
  if (e && e.path.endsWith('.prefab') && fs.existsSync(path.join(U.REPO, e.path))) {
    const f = U.parse(fs.readFileSync(path.join(U.REPO, e.path), 'utf8'));
    const root = Object.values(f.t).find(t => t.father === '0');
    if (root) names = f.scripts.filter(s => s[0] === root.go).map(s => U.scriptName(s[1]));
  }
  rootScriptCache.set(guid, names);
  return names;
}

// A node's own terms in the game (the page's met and start modes): what replaces its saved
// active flag, as a gate's terms (all must hold). An object nothing switches stays as saved.
function nodeTerms(r, key, savedActive) {
  if (!r) return savedActive ? [] : [false];
  const out = [];
  if (r.gates[key]) out.push(...r.gates[key]);
  else if (r.startsOff[key]) out.push(r.startsOff[key].length === 1 ? r.startsOff[key][0] : { any: r.startsOff[key] });
  else if (!savedActive) out.push(false);
  if (r.shrunk[key]) out.push({ not: r.shrunk[key].length === 1 ? r.shrunk[key][0] : { any: r.shrunk[key] } });
  return out;
}
// A part's or piece's game fields from its chain's terms: never (off whatever the flags), or when
// (the terms that must hold), or neither (always as saved). gone: off in the game for another
// reason (a renderer switched off, HideOnStart).
function gameFields(terms, gone = false) {
  if (gone || terms.includes(false)) return { never: true };
  return terms.length ? { when: dedupe(terms) } : {};
}
const dedupe = terms => [...new Map(terms.map(t => [JSON.stringify(t), t])).values()];

// ---------- symbols ----------
// What every progress flag is in each mode, for a Unity scene (null: a composed scene not on one):
//   met    every flag the game sets, at the value it sets: Game.unity's FastForwardSymbols (each
//          stage's flags, as fast-forwarding to a later stage grants them) for every stage, then
//          each EffectSetProgressFlag (set to one: "1"; incremented: the number of them; Head,
//          Left, Right; set to zero or cleared only if nothing sets it otherwise) and EffectMath
//          (its additions summed), and each stage's <Stage>Deposits at its Gates' most required
//   start  as fast-forwarding to the scene's stage starts it: the stages before it, nothing else
// Both have StageName (Progress.cs) as the scene's stage, by its name (<Stage>Scene); conditions
// test stages by name only (Ken, 2026-11-09: no Stage number).
// unity.json's "symbols" (defaults, then the scene's) set flags code sets at run time (Underwater,
// RingsWorn) in both; a composed scene's "- Symbols: A=1 B=0" lines win (the page applies those).
const SCRIPTS = ['EffectSetProgressFlag', 'EffectMath', 'FastForwardSymbols', 'FastForwardConfig', 'Gate', 'GateOutpost', 'GateMini'];
const SCAN_VERSION = 6; // bump when the scan reads more
// The scan is kept per file (tools/keep.js, cache/game-scan.json): each scene's and prefab's
// findings by its blob in the guid index, so only a file whose blob changed is read again (Ken,
// 2026-11-09: any Canopy change, a texture even, rescanned them all, 5 to 7 s), and they are merged
// by unity.json and StageId.cs as they are now. Looked at again only when one of those three files
// changes. (2026-11-04: a restart used to scan again, about 8 s.)
const INDEX_FILE = path.join(__dirname, '..', 'cache', 'guid-index.json');
const UNITY_JSON = path.join(__dirname, '..', 'unity.json');
const keptScan = Keep('game-scan');
let scanMemo = null; // { stamp, scan }
function scanGame() {
  const stampOf = f => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
  const stamp = [INDEX_FILE, UNITY_JSON, path.join(U.REPO, 'Assets', 'Scripts', 'StageId.cs')].map(stampOf).join('|');
  if (scanMemo && scanMemo.stamp === stamp) return scanMemo.scan;
  const kept = keptScan.get();
  if (kept.version !== SCAN_VERSION || !kept.files) {
    for (const k of Object.keys(kept)) delete kept[k];
    Object.assign(kept, { version: SCAN_VERSION, files: {} });
  }
  const files = kept.files;
  const entries = Object.values(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).entries).filter(e => e.path && /^Assets\/.*\.(unity|prefab)$/.test(e.path));
  const stale = entries.filter(e => !e.blob || !files[e.path] || files[e.path].blob !== e.blob);
  const guids = Object.fromEntries(SCRIPTS.map(n => [U.scriptGuid(n), n]).filter(([g]) => g));
  const pattern = `guid: (${Object.keys(guids).join('|')})|propertyPath: (flagId|depositsRequired)$`;
  // many to read (the first scan): grep picks the files that matter; else each is read and tested
  let matching = null;
  if (stale.length > 40) {
    let out = '';
    try {
      out = execFileSync('grep', ['-rlE', pattern, '--include=*.unity', '--include=*.prefab', 'Assets'], { cwd: U.REPO, maxBuffer: 1 << 26 }).toString();
    } catch (error) {
      if (error.status !== 1) throw error; // 1: no file matched
    }
    matching = new Set(out.trim().split('\n').filter(Boolean));
  }
  const re = new RegExp(pattern, 'm');
  for (const e of stale) {
    let text = null;
    if (!matching || matching.has(e.path)) {
      try { text = fs.readFileSync(path.join(U.REPO, e.path), 'utf8').replace(/\r\n/g, '\n'); } catch { /* gone */ }
    }
    files[e.path] = { blob: e.blob || null, found: text && re.test(text) ? findings(text, guids) : null };
  }
  const present = new Set(entries.map(e => e.path));
  let dropped = 0;
  for (const p of Object.keys(files)) if (!present.has(p)) { delete files[p]; dropped++; }
  if (stale.length || dropped) keptScan.save();
  const scan = mergeFindings(files);
  scanMemo = { stamp, scan };
  return scan;
}
// What one scene or prefab sets, before stages are known: { set: [[flag, op]], adds: { flag: n },
// ff: { stageId: { flag: value } }, configs: { stageId: config }, deposits: its Gates' most required }.
function findings(text, guids) {
  const f = U.parse(text);
  const out = { set: [], adds: {}, ff: {}, configs: {}, deposits: 0 };
  for (const [, guid, body] of f.scripts) {
    const name = guids[guid];
    if (!name) continue;
    const fx = U.scriptFields(body);
    if (name === 'EffectSetProgressFlag') out.set.push([String(fx.flagId ?? ''), fx.flagOp]);
    if (name === 'EffectMath' && fx.mathOperation === 0) out.adds[fx.flagId] = (out.adds[fx.flagId] || 0) + (fx.amount || 0);
    if (name === 'FastForwardSymbols') {
      const list = {};
      for (const m of body.matchAll(/\n {2}- key: ([^\n]*)\n {4}value: ([^\n]*)/g)) list[m[1].trim()] = m[2].trim();
      out.ff[fx.stageId] = { ...out.ff[fx.stageId], ...list };
    }
    if (name === 'FastForwardConfig') out.configs[fx.stageId || 0] = fastForwardConfig(body);
    if (/^Gate/.test(name) && fx.depositsRequired) out.deposits = Math.max(out.deposits, fx.depositsRequired);
  }
  // instances' settings: a flag set by a prefab's EffectSetProgressFlag, a Gate's deposits
  for (const x of Object.values(f.inst)) {
    for (const m of x.mods) {
      if (m.path === 'flagId' && m.value) {
        const op = x.mods.find(o => o.target === m.target && o.path === 'flagOp');
        out.set.push([String(m.value), op ? +op.value : 1]);
      }
      if (m.path === 'depositsRequired' && +m.value) out.deposits = Math.max(out.deposits, +m.value);
    }
  }
  return out;
}
// The files' findings as the scan: { ff, sets, adds, deposits, stages, configs }; a file's Gates'
// deposits count for the stage its scene plays (by name, or unity.json's stage).
function mergeFindings(files) {
  const stages = stageIds();
  const ff = {}, sets = {}, adds = {}, deposits = {}, configs = {};
  const setFlag = (flag, op) => {
    if (!flag) return;
    const s = sets[flag] = sets[flag] || { one: false, count: 0, text: null, zero: false, clear: false };
    if (op === 1) s.one = true;
    else if (op === 2) s.count++;
    else if (op === 0) s.zero = true;
    else if (op === 3) s.clear = true;
    else if (op === 100) s.text = 'Head';
    else if (op === 110) s.text = 'Left';
    else if (op === 120) s.text = 'Right';
  };
  for (const file of Object.keys(files).sort()) {
    const found = files[file].found;
    if (!found) continue;
    for (const [flag, op] of found.set) setFlag(flag, op);
    for (const [flag, n] of Object.entries(found.adds)) adds[flag] = (adds[flag] || 0) + n;
    for (const [id, list] of Object.entries(found.ff)) ff[id] = { ...ff[id], ...list };
    Object.assign(configs, found.configs);
    if (found.deposits) {
      const sceneName = path.basename(file).replace(/\.\w+$/, ''), playsIn = Config.load(sceneName).stage;
      const stage = sceneStage(playsIn ? playsIn + 'Scene' : sceneName, stages);
      if (stage) deposits[stage.name] = Math.max(deposits[stage.name] || 0, found.deposits);
    }
  }
  return { ff, sets, adds, deposits, stages, configs };
}
// A FastForwardConfig (Game.unity, one per stage): what fast-forwarding to its stage starts the
// player with (FastForwardConfig.ApplyInitialSettings): its inventory's fields, its ringList (ten
// AbilityIds, left thumb to right pinky; Unity keeps an int array as little-endian hex). The
// temple's gems aren't listed: Canopy finds them (FastForwardConfig.FillTemple).
function fastForwardConfig(body) {
  const inventory = {};
  const block = /\n {2}inventory:\n((?: {4}\w+: [^\n]*\n?)*)/.exec(body);
  for (const m of ((block && block[1]) || '').matchAll(/ {4}(\w+): ([^\n]*)/g)) inventory[m[1]] = +m[2] || 0;
  const ints = hex => (String(hex || '').match(/.{8}/g) || []).map(h => Buffer.from(h, 'hex').readInt32LE(0));
  const field = name => ((new RegExp('\\n {2}' + name + ': ([0-9a-f]*)')).exec(body) || [])[1];
  // portalLinks: portals the fast-forward links (FastForwardConfig.ApplyFastForward), { name: destination }
  const portalLinks = Object.fromEntries([...body.matchAll(/\n {2}- portalName: ([^\n]*)\n {4}destinationPortalName: ([^\n]*)/g)].map(m => [m[1].trim(), m[2].trim()]).filter(([a, b]) => a && b));
  return { inventory, rings: ints(field('ringList')), portalLinks }; // the temple fills itself (FastForwardConfig.FillTemple)
}
// AbilityId.cs's enum: { number: name }.
function abilityNames() {
  const file = path.join(U.REPO, 'Assets', 'Scripts', 'AbilityId.cs');
  const m = fs.existsSync(file) && /enum AbilityId\s*\{([^}]*)\}/.exec(fs.readFileSync(file, 'utf8'));
  return m ? Object.fromEntries([...m[1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map(x => [+x[2], x[1]])) : {};
}
// Fast forward (Ken, 2026-11-08; the page's ☰ Fast forward): the stages, each stage's
// FastForwardSymbols, and each stage's FastForwardConfig with its rings named and colored (a ring
// shows its gem's color, GemTypes; NoAbility: a ring holding no gem; NoRing: an empty finger).
function fastForward() {
  const g = scanGame(), names = abilityNames(), types = require('./gems.js').gemTypes();
  const ring = id => {
    if (!id) return null;
    const t = types.byAbility[id];
    return { id, ability: names[id] || String(id), ...(t && types.colors[t.color] ? { color: types.colors[t.color].slice(0, 3) } : {}) };
  };
  const configs = Object.fromEntries(Object.entries(g.configs || {}).map(([stage, c]) => [stage, { inventory: c.inventory, portalLinks: c.portalLinks || {}, rings: c.rings.map(ring) }]));
  // stages: { name: number }; order: the names as played; symbols and configs by number;
  // abilities: { id: name }, for gems set into rings
  return { stages: g.stages, order: stageOrder().order, symbols: g.ff, configs, abilities: names };
}
// StageId.cs's enum: { name: number }, each stage's permanent number (not its order; Invalid left out).
function stageIds() {
  const file = path.join(U.REPO, 'Assets', 'Scripts', 'StageId.cs');
  const m = fs.existsSync(file) && /enum StageId\s*\{([^}]*)\}/.exec(fs.readFileSync(file, 'utf8'));
  return m ? Object.fromEntries([...m[1].matchAll(/(\w+)\s*=\s*(\d+)/g)].filter(x => x[1] !== 'Invalid').map(x => [x[1], +x[2]])) : {};
}
// The stages in the order they are played: StageId.cs's Stage.ValidStages (Ken, 2026-11-09: Hawthorn,
// number 10, plays between Tangle and Oak), else by number. { order: [names], rank: { name: place } }.
function stageOrder() {
  const file = path.join(U.REPO, 'Assets', 'Scripts', 'StageId.cs');
  const m = fs.existsSync(file) && /ValidStages\s*=\s*\{([^}]*)\}/.exec(fs.readFileSync(file, 'utf8'));
  const ids = stageIds();
  const order = m ? [...m[1].matchAll(/StageId\.(\w+)/g)].map(x => x[1]).filter(n => n in ids) : Object.keys(ids).sort((a, b) => ids[a] - ids[b]);
  return { order, rank: Object.fromEntries(order.map((n, i) => [n, i])) };
}
function sceneStage(scene, stages) {
  const m = /^(\w+?)Scene$/.exec(scene || '');
  return m && m[1] in stages ? { name: m[1], id: stages[m[1]], rank: stageOrder().rank[m[1]] } : null;
}
// stageName: the stage the scene plays in, when its name is not one (unity.json stage).
function symbols(scene, extra = {}, stageName = null) {
  const g = scanGame();
  const stage = sceneStage(stageName ? stageName + 'Scene' : scene, g.stages);
  const met = {}, start = {}, { rank } = stageOrder();
  const nameOf = Object.fromEntries(Object.entries(g.stages).map(([n, id]) => [id, n]));
  const rankOf = id => rank[nameOf[id]] ?? -1;
  for (const id of Object.keys(g.ff).map(Number).sort((a, b) => rankOf(a) - rankOf(b))) {
    Object.assign(met, g.ff[id]);
    if (stage && rankOf(id) < stage.rank) Object.assign(start, g.ff[id]);
  }
  for (const [flag, s] of Object.entries(g.sets)) {
    if (s.one) met[flag] = '1';
    else if (s.count) met[flag] = String(s.count);
    else if (s.text) met[flag] = s.text;
    else if (!(flag in met)) met[flag] = s.zero ? '0' : '';
  }
  for (const [flag, n] of Object.entries(g.adds)) met[flag] = String((parseInt(met[flag], 10) || 0) + n);
  for (const [name, n] of Object.entries(g.deposits)) met[name + 'Deposits'] = String(n);
  for (const t of [met, start]) {
    if (stage) t.StageName = stage.name;
    for (const [k, v] of Object.entries(extra)) t[k] = String(v);
  }
  return { met, start, stage: stage ? stage.name : null, extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) };
}
// "- Symbols: A=1 B=0 Name='Tangle'" lines of a composed scene, merged: { A: '1', ... }.
function symbolLines(text) {
  const out = {};
  for (const line of String(text || '').matchAll(/^\s*-\s*Symbols:\s*(.+?)\s*$/gm)) {
    for (const m of line[1].matchAll(/([\w.:]+)\s*=\s*("[^"]*"|'[^']*'|[^\s,]*)/g)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// The stage a piece of a Canopy scene shows from, for fast-forwarding (Ken, 2026-11-09: fast-
// forwarded to Beech, Tangle and the later biomes aren't shown; the Stronghold always is, the Temple
// with Beech): unity.json's places in its scene, by path (Game.unity's Approach from the Tutorial,
// Temple from Beech, Stronghold always: null), then its stagePath (Game's World/<Stage>Biome/), else
// its scene's stage (or the stage it plays in);
// null: always shown.
// placeStager(scene): placeStage for that scene's pieces, its unity.json and StageId.cs read once
// (Claude, 2026-11-09: reading both again for each of a load's 555 pieces took 3 of its 4 s).
function placeStager(scene) {
  const cfg = Config.load(scene), ids = stageIds();
  const own = sceneStage(cfg.stage ? cfg.stage + 'Scene' : scene, ids);
  return piecePath => {
    for (const place of cfg.places) if (piecePath === place.path || String(piecePath || '').startsWith(place.path + '/')) return place.from;
    const named = cfg.stagePath && cfg.stagePath.exec(String(piecePath || ''));
    if (named && named[1] in ids) return named[1]; // Game's World/OakBiome/...: from Oak
    return own ? own.name : null;
  };
}
const placeStage = (scene, piecePath) => placeStager(scene)(piecePath);
module.exports = { scanGame, rulesOf, nodeTerms, gameFields, symbols, symbolLines, sceneStage, stageIds, stageOrder, fastForward, placeStage, placeStager };
