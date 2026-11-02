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
//   reveals   a Pod's Revealer (PodRequest) a trigger plays: the pieces under its revealRoot stay
//             hidden until then, as Revealer.Prepare hides them
//   hidden    HideOnStart: its renderer is switched off when the game starts
// Triggers are OnCondition, OnConditionOnce, OnConditionDoEffect, EffectTrigger and the obsolete
// EffectConditional; each plays the effects on its effectsToExecute object (Effects.PlayMine: that
// object's own). "this" in a condition is the object's Symbol (its uniqueName); FilterWithStageData,
// which some ActiveWhens also test, is not read (none of the scenes so far has one).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('./unity.js');

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
// Both have Stage and StageName (Progress.cs) as the scene's stage, by its name (<Stage>Scene).
// unity.json's "symbols" (defaults, then the scene's) set flags code sets at run time (Underwater,
// RingsWorn) in both; a composed scene's "- Symbols: A=1 B=0" lines win (the page applies those).
const SCRIPTS = ['EffectSetProgressFlag', 'EffectMath', 'FastForwardSymbols', 'Gate', 'GateOutpost', 'GateMini'];
let scan = null, scanKey = null;
function scanGame() {
  const key = fs.statSync(path.join(__dirname, '..', 'cache', 'guid-index.json')).mtimeMs;
  if (scan && scanKey === key) return scan;
  const guids = Object.fromEntries(SCRIPTS.map(n => [U.scriptGuid(n), n]).filter(([g]) => g));
  const pattern = `guid: (${Object.keys(guids).join('|')})|propertyPath: (flagId|depositsRequired)$`;
  let files = [];
  try {
    files = execFileSync('grep', ['-rlE', pattern, '--include=*.unity', '--include=*.prefab', 'Assets'], { cwd: U.REPO, maxBuffer: 1 << 26 }).toString().trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error.status !== 1) throw error; // 1: no file matched
  }
  const stages = stageIds();
  const ff = {}, sets = {}, adds = {}, deposits = {};
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
  for (const file of files) {
    const text = fs.readFileSync(path.join(U.REPO, file), 'utf8').replace(/\r\n/g, '\n');
    const f = U.parse(text);
    const stage = sceneStage(path.basename(file).replace(/\.\w+$/, ''), stages);
    for (const [, guid, body] of f.scripts) {
      const name = guids[guid];
      if (!name) continue;
      const fx = U.scriptFields(body);
      if (name === 'EffectSetProgressFlag') setFlag(String(fx.flagId ?? ''), fx.flagOp);
      if (name === 'EffectMath' && fx.mathOperation === 0) adds[fx.flagId] = (adds[fx.flagId] || 0) + (fx.amount || 0);
      if (name === 'FastForwardSymbols') {
        const list = {};
        for (const m of body.matchAll(/\n {2}- key: ([^\n]*)\n {4}value: ([^\n]*)/g)) list[m[1].trim()] = m[2].trim();
        ff[fx.stageId] = { ...ff[fx.stageId], ...list };
      }
      if (/^Gate/.test(name) && stage && fx.depositsRequired) deposits[stage.name] = Math.max(deposits[stage.name] || 0, fx.depositsRequired);
    }
    // instances' settings: a flag set by a prefab's EffectSetProgressFlag, a Gate's deposits
    for (const x of Object.values(f.inst)) {
      for (const m of x.mods) {
        if (m.path === 'flagId' && m.value) {
          const op = x.mods.find(o => o.target === m.target && o.path === 'flagOp');
          setFlag(m.value, op ? +op.value : 1);
        }
        if (m.path === 'depositsRequired' && stage && +m.value) deposits[stage.name] = Math.max(deposits[stage.name] || 0, +m.value);
      }
    }
  }
  scan = { ff, sets, adds, deposits, stages };
  scanKey = key;
  return scan;
}
// StageId.cs's enum: { name: number }.
function stageIds() {
  const file = path.join(U.REPO, 'Assets', 'Scripts', 'StageId.cs');
  const m = fs.existsSync(file) && /enum StageId\s*\{([^}]*)\}/.exec(fs.readFileSync(file, 'utf8'));
  return m ? Object.fromEntries([...m[1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map(x => [x[1], +x[2]])) : {};
}
function sceneStage(scene, stages) {
  const m = /^(\w+?)Scene$/.exec(scene || '');
  return m && m[1] in stages ? { name: m[1], id: stages[m[1]] } : null;
}
function symbols(scene, extra = {}) {
  const g = scanGame();
  const stage = sceneStage(scene, g.stages);
  const met = {}, start = {};
  for (const id of Object.keys(g.ff).map(Number).sort((a, b) => a - b)) {
    Object.assign(met, g.ff[id]);
    if (stage && id < stage.id) Object.assign(start, g.ff[id]);
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
    if (stage) Object.assign(t, { Stage: String(stage.id), StageName: stage.name });
    for (const [k, v] of Object.entries(extra)) t[k] = String(v);
  }
  return { met, start, stage: stage ? stage.name : null };
}
// "- Symbols: A=1 B=0 Name='Tangle'" lines of a composed scene, merged: { A: '1', ... }.
function symbolLines(text) {
  const out = {};
  for (const line of String(text || '').matchAll(/^\s*-\s*Symbols:\s*(.+?)\s*$/gm)) {
    for (const m of line[1].matchAll(/([\w.:]+)\s*=\s*("[^"]*"|'[^']*'|[^\s,]*)/g)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

module.exports = { rulesOf, nodeTerms, gameFields, symbols, symbolLines, sceneStage, stageIds };
