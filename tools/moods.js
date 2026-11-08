// The game's light, fog and sky as its EnvironmentManager works them out (Claude, 2026-11-03; Ken:
// "fog and ambient and sun all reasonably mimic the game"), read from Canopy for the page's
// web/environment.js, which runs EnvironmentManager.Update's part of it each frame:
//   zones   every BiomeZone in the game's scenes (Chunk.cs's list, plus the scenes being drawn),
//           at any depth of nesting (each tree prefab carries one), with its instances' overrides:
//           its shape (a CapsuleCollider or BoxCollider, as PercentFromCenter measures them), falloffPct,
//           whether it is active as saved (stage filters aren't applied), and its MoodVisual
//   moods   each MoodVisual's curves (AnimationCurve keys) and gradients (Gradient keys) and settings
//   default Game.unity's BiomeManager.defaultBiomeZone's mood (where no zone is)
//   sea     Game.unity's Sea: its mood (under the sea) and maxDepth, darknessWhenOvercast, dimAmountDefault
//   fog     Game.unity's Fog: fogLerpSpeed, fogDensityMinimum
//   sun     Game.unity's sun Light: its color and its world rotation's euler angles
//   sky     EnvironmentManager's CanSky values (csBlendMinAdd and the rest) and skyMaterialDefault
// Unity documents are read here with a small YAML reader (block maps and sequences, flow maps),
// enough for the components these need; a prefab instance's modifications are applied by their
// property paths ("fogDensity.m_Curve.Array.data[1].value"), outermost last, and a reference an
// override sets is resolved in the file the override is written in.
const fs = require('fs');
const path = require('path');
const U = require('./unity.js');

// ---------- files ----------
let touched = null; // files read while working, for the cache key
const fileCache = new Map(); // relative path -> { mtime, text, docs }
function file(rel) {
  const abs = path.join(U.REPO, rel);
  const mtime = fs.statSync(abs).mtimeMs;
  if (touched) touched.add(rel);
  const hit = fileCache.get(rel);
  if (hit && hit.mtime === mtime) return hit;
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const docs = new Map();
  for (const chunk of text.split(/^--- /m).slice(1)) {
    const m = /^!u!(\d+) &(-?\d+)( stripped)?\n/.exec(chunk);
    if (m) docs.set(m[2], { cls: +m[1], stripped: Boolean(m[3]), body: chunk.slice(m[0].length) });
  }
  const f = { mtime, text, docs, parsed: new Map() };
  fileCache.set(rel, f);
  return f;
}
const pathOfGuid = guid => (U.index()[guid] || {}).path || null;

// ---------- Unity's YAML ----------
// A document's body as an object (its one top-level key's value).
function yaml(body) {
  const lines = body.split('\n').filter(l => l.trim() !== '');
  const indentOf = l => l.length - l.trimStart().length;
  let i = 1; // the first line is the type ("MonoBehaviour:")
  const block = indent => {
    if (i < lines.length && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith('- ')) return sequence(indent);
    return map(indent);
  };
  const map = indent => {
    const out = {};
    while (i < lines.length) {
      const l = lines[i], n = indentOf(l);
      if (n < indent) break;
      if (n > indent || l.trimStart().startsWith('- ')) { if (n === indent) break; i++; continue; } // a multi-line scalar's rest
      const m = /^\s*([^:]+?):(?: (.*))?$/.exec(l);
      i++;
      if (!m) continue;
      const rest = m[2] === undefined ? '' : m[2];
      if (rest === '' && i < lines.length && (indentOf(lines[i]) > n || (indentOf(lines[i]) === n && lines[i].trimStart().startsWith('- ')))) out[m[1]] = block(indentOf(lines[i]));
      else out[m[1]] = scalar(rest);
    }
    return out;
  };
  const sequence = indent => {
    const out = [];
    while (i < lines.length && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith('- ')) {
      const item = lines[i].slice(indent + 2);
      if (/^[^:{[]+: ?/.test(item) || /^[^:{[]+:$/.test(item)) {
        lines[i] = ' '.repeat(indent + 2) + item; // the item's first key, as a map's line
        out.push(map(indent + 2));
      } else {
        out.push(scalar(item));
        i++;
      }
    }
    return out;
  };
  return block(2);
}
function scalar(v) {
  v = v.trim();
  if (v.startsWith('{') && v.endsWith('}')) {
    const out = {};
    for (const part of v.slice(1, -1).split(',')) {
      const k = part.indexOf(':');
      if (k > 0) out[part.slice(0, k).trim()] = part.slice(k + 1).trim();
    }
    return out;
  }
  if (v === '[]') return [];
  if (v.length > 1 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
const num = (v, d = 0) => (v === undefined || v === null || v === '' || !Number.isFinite(+v) ? d : +v);

// Sets a modification's property path in an object: "a.b", "a.Array.data[2].c", "a.Array.size".
// As Unity does, a size grows an array with copies of its last element, and an element past the
// end is left alone (variants keep stale overrides of elements a smaller size dropped).
function setPath(obj, propertyPath, value) {
  const tokens = propertyPath.split('.');
  let at = obj;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k], last = k === tokens.length - 1;
    if (t === 'Array') continue;
    if (t === 'size' && Array.isArray(at)) {
      const n = num(value);
      while (at.length < n) at.push(at.length ? JSON.parse(JSON.stringify(at[at.length - 1])) : {});
      at.length = n;
      return;
    }
    const d = /^data\[(\d+)\]$/.exec(t);
    if (d && Array.isArray(at) && +d[1] >= at.length) return;
    const key = d ? +d[1] : t;
    if (last) { at[key] = value; return; }
    if (at[key] === undefined || at[key] === null || typeof at[key] !== 'object') at[key] = tokens[k + 1] === 'Array' ? [] : {};
    at = at[key];
  }
}

// ---------- a file as instantiated: a scene, or a prefab placed somewhere ----------
// overrides: Map(id in this file -> [{ path, value, ref: { fileID, guid, ctx } | null }]), applied in order.
class Ctx {
  constructor(rel, overrides, parentWorld, parentActive) {
    this.rel = rel;
    this.f = file(rel);
    this.overrides = overrides || new Map();
    this.parentWorld = parentWorld || { m: U.I(), q: { x: 0, y: 0, z: 0, w: 1 } };
    this.parentActive = parentActive !== false;
    this.objs = new Map();
    this.worlds = new Map();
    this.actives = new Map();
    this.nested = new Map();
  }
  doc(id) { return this.f.docs.get(String(id)) || null; }
  // a document's object, this instance's overrides applied; references an override sets keep the file
  // they are written in (ctx), for resolving
  obj(id) {
    id = String(id);
    if (this.objs.has(id)) return this.objs.get(id);
    const d = this.doc(id);
    let o = null;
    if (d) {
      if (!this.f.parsed.has(id)) this.f.parsed.set(id, yaml(d.body));
      o = JSON.parse(JSON.stringify(this.f.parsed.get(id)));
      const mods = this.overrides.get(id) || [];
      for (const mod of mods) if (/\.Array\.size$/.test(mod.path)) setPath(o, mod.path, mod.value); // sizes first
      for (const mod of mods) if (!/\.Array\.size$/.test(mod.path)) setPath(o, mod.path, mod.ref ? mod.ref : mod.value);
    }
    this.objs.set(id, o);
    return o;
  }
  // the object a reference names: { ctx, id } where it is defined (a stripped document's own, inside
  // its prefab instance), or null
  resolve(ref) {
    if (!ref || !ref.fileID || ref.fileID === '0') return null;
    const owner = ref.ctx || this;
    if (ref.guid && owner === this && !ref.ctx) {
      const rel = pathOfGuid(ref.guid);
      return rel ? new Ctx(rel).resolve({ fileID: ref.fileID }) : null;
    }
    if (ref.guid) {
      const rel = pathOfGuid(ref.guid);
      return rel ? new Ctx(rel).resolve({ fileID: ref.fileID }) : null;
    }
    if (owner !== this) return owner.resolve({ fileID: ref.fileID });
    const d = this.doc(ref.fileID);
    if (!d) {
      // an object of a nested prefab with no stripped document here (a variant's base's): its id
      // is the instance's XOR its own there
      for (const [id, x] of this.f.docs) {
        if (x.cls !== 1001) continue;
        const inst = this.instance(id);
        const r = inst && inst.resolve({ fileID: U.xorId(ref.fileID, id) });
        if (r) return r;
      }
      return null;
    }
    if (!d.stripped) return { ctx: this, id: String(ref.fileID) };
    const o = this.obj(ref.fileID);
    const inst = this.instance(o.m_PrefabInstance && o.m_PrefabInstance.fileID);
    const src = o.m_CorrespondingSourceObject;
    return inst && src ? inst.resolve({ fileID: src.fileID }) : null;
  }
  // a prefab instance here (by its document's id), instantiated
  instance(id) {
    id = String(id);
    if (this.nested.has(id)) return this.nested.get(id);
    const o = this.obj(id);
    let ctx = null;
    const rel = o && o.m_SourcePrefab && pathOfGuid(o.m_SourcePrefab.guid);
    if (rel && fs.existsSync(path.join(U.REPO, rel)) && /\.prefab$/.test(rel)) {
      const mods = new Map();
      const add = (k, m) => (mods.get(k) || mods.set(k, []).get(k)).push(m);
      const mo = o.m_Modification || {};
      for (const m of Array.isArray(mo.m_Modifications) ? mo.m_Modifications : []) {
        const r = m.objectReference && m.objectReference.fileID && m.objectReference.fileID !== '0' ? { fileID: m.objectReference.fileID, guid: m.objectReference.guid || null, ctx: m.objectReference.guid ? null : this } : null;
        add(String(m.target && m.target.fileID), { path: m.propertyPath, value: m.value === undefined ? '' : m.value, ref: r });
      }
      // this instance's own overrides of objects inside the nested one (their ids here: the
      // instance's XOR theirs there), applied after, as Unity lets the outer win
      for (const [k, list] of this.overrides) for (const m of list) add(U.xorId(k, id), m);
      const parent = mo.m_TransformParent && mo.m_TransformParent.fileID;
      const pw = !parent || parent === '0' ? this.parentWorld : this.worldOfT(parent);
      const pa = !parent || parent === '0' ? this.parentActive : this.activeOfT(parent);
      ctx = new Ctx(rel, mods, pw, pa);
      ctx.outer = this; // what placed it
    }
    this.nested.set(id, ctx);
    return ctx;
  }
  // a transform's world placement: { m (row-major 4x4), q (rotation) }
  worldOfT(tid) {
    tid = String(tid);
    if (this.worlds.has(tid)) return this.worlds.get(tid);
    const r = this.resolve({ fileID: tid });
    let w = this.parentWorld;
    if (r && r.ctx !== this) w = r.ctx.worldOfT(r.id);
    else if (r) {
      const o = this.obj(tid);
      const v = (x, d) => ({ x: num(x && x.x, d), y: num(x && x.y, d), z: num(x && x.z, d) });
      const pos = v(o.m_LocalPosition, 0), scl = v(o.m_LocalScale, 1);
      const q = { x: num(o.m_LocalRotation && o.m_LocalRotation.x), y: num(o.m_LocalRotation && o.m_LocalRotation.y), z: num(o.m_LocalRotation && o.m_LocalRotation.z), w: num(o.m_LocalRotation && o.m_LocalRotation.w, 1) };
      const father = o.m_Father && o.m_Father.fileID;
      const p = !father || father === '0' ? this.parentWorld : this.worldOfT(father);
      w = { m: U.mul(p.m, U.trs(pos, q, scl)), q: U.qmul(p.q, q) };
    }
    this.worlds.set(tid, w);
    return w;
  }
  // is a transform's object active in the hierarchy (as saved)
  activeOfT(tid) {
    tid = String(tid);
    if (this.actives.has(tid)) return this.actives.get(tid);
    this.actives.set(tid, true);
    const r = this.resolve({ fileID: tid });
    let a = this.parentActive;
    if (r && r.ctx !== this) a = r.ctx.activeOfT(r.id);
    else if (r) {
      const o = this.obj(tid);
      const go = this.obj(o.m_GameObject && o.m_GameObject.fileID);
      const father = o.m_Father && o.m_Father.fileID;
      const p = !father || father === '0' ? this.parentActive : this.activeOfT(father);
      a = p && !(go && String(go.m_IsActive) === '0');
    }
    this.actives.set(tid, a);
    return a;
  }
  // the transform of a component's game object, where it is defined: { ctx, id }
  transformOf(componentId) {
    const o = this.obj(componentId);
    const g = this.resolve(o && o.m_GameObject);
    if (!g) return null;
    const go = g.ctx.obj(g.id);
    const first = go && Array.isArray(go.m_Component) && go.m_Component[0] && go.m_Component[0].component;
    return first ? g.ctx.resolve(first) || null : null;
  }
  nameOf(componentId) {
    const o = this.obj(componentId);
    const g = this.resolve(o && o.m_GameObject);
    const go = g && g.ctx.obj(g.id);
    return go ? String(go.m_Name || '') : '';
  }
  // every component of a script (by guid) here and in nested instances: [{ ctx, id }]
  components(scriptGuid) {
    const out = [];
    for (const [id, d] of this.f.docs) {
      if (d.cls === 114 && !d.stripped && d.body.includes(`guid: ${scriptGuid},`)) {
        const o = this.obj(id);
        if (o.m_Script && o.m_Script.guid === scriptGuid) out.push({ ctx: this, id });
      }
      if (d.cls === 1001) {
        const src = /m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]+)/.exec(d.body);
        if (src && contains(src[1], scriptGuid)) {
          const inst = this.instance(id);
          if (inst) out.push(...inst.components(scriptGuid));
        }
      }
    }
    return out;
  }
}
// does a prefab (by guid), or one it nests, hold a script
const containsMemo = new Map();
function contains(prefabGuid, scriptGuid, seen = new Set()) {
  const key = prefabGuid + scriptGuid;
  if (containsMemo.has(key)) return containsMemo.get(key);
  const rel = pathOfGuid(prefabGuid);
  if (!rel || !/\.prefab$/.test(rel) || seen.has(prefabGuid) || !fs.existsSync(path.join(U.REPO, rel))) return false;
  seen.add(prefabGuid);
  const text = file(rel).text;
  const yes = text.includes(`guid: ${scriptGuid},`) || [...text.matchAll(/m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]+)/g)].some(m => contains(m[1], scriptGuid, seen));
  containsMemo.set(key, yes);
  return yes;
}

// ---------- what the page needs ----------
const curve = c => ({
  keys: (c && Array.isArray(c.m_Curve) ? c.m_Curve : []).map(k => ({
    t: num(k.time), v: num(k.value), i: k.inSlope === 'Infinity' || k.inSlope === '-Infinity' ? null : num(k.inSlope), o: k.outSlope === 'Infinity' || k.outSlope === '-Infinity' ? null : num(k.outSlope),
    w: num(k.weightedMode), iw: num(k.inWeight, 1 / 3), ow: num(k.outWeight, 1 / 3)
  })).sort((a, b) => a.t - b.t)
});
const gradient = g => {
  g = g || {};
  const colors = [], alphas = [];
  for (let k = 0; k < num(g.m_NumColorKeys, 2); k++) {
    const c = g['key' + k] || {};
    colors.push([num(g['ctime' + k]) / 65535, num(c.r), num(c.g), num(c.b)]);
  }
  for (let k = 0; k < num(g.m_NumAlphaKeys, 2); k++) alphas.push([num(g['atime' + k]) / 65535, num((g['key' + k] || {}).a, 1)]);
  return { mode: num(g.m_Mode), colors: colors.sort((a, b) => a[0] - b[0]), alphas: alphas.sort((a, b) => a[0] - b[0]) };
};
const color = c => [num(c && c.r, 1), num(c && c.g, 1), num(c && c.b, 1)];

function moodOf(r, materials) {
  const o = r.ctx.obj(r.id);
  const sky = o.skyMaterial && o.skyMaterial.guid ? o.skyMaterial.guid : null;
  if (sky) materials.add(sky);
  // its name for people: the outermost mood prefab it comes through (MoodOak, a variant of
  // MoodForest), else its file and object
  let label = null;
  for (let x = r.ctx; x; x = x.outer) if (/\/Moods\//.test(x.rel)) label = path.basename(x.rel, '.prefab');
  return {
    name: String(o.moodName || ''), label: label || `${path.basename(r.ctx.rel).replace(/\.\w+$/, '')}: ${r.ctx.nameOf(r.id)}`, object: r.ctx.nameOf(r.id), file: r.ctx.rel,
    fogDensity: curve(o.fogDensity), fogColor: gradient(o.fogColor), fogLerpSpeed: num(o.fogLerpSpeed, -1),
    ambientIntensity: curve(o.ambientIntensity), sunIntensity: curve(o.sunIntensity),
    sunColor: color(o.sunColor), useSunColor: num(o.useSunColor) === 1, sunAngle: num(o.sunAngle, 70), useSunAngle: num(o.useSunAngle) === 1,
    seaIntensity: curve(o.seaIntensity), dimAmount: num(o.dimAmount, -999), sky,
    skyTint: gradient(o.skyTint), skyTintLevel: curve(o.skyTintLevel),
    yBottom: num(o.yBottom, 60), yTop: num(o.yTop, 120), darknessWhenOvercast: num(o.darknessWhenOvercast, 0.5), overrideSea: num(o.overrideSea) === 1
  };
}
// a zone's shape, as BiomeZone.PercentFromCenter measures it (ExtVector3's quirks kept: a capsule's
// center offset is added unrotated and its height unscaled, its radius scaled by the lossy z scale;
// a box's center is transformed, its size isn't)
function shapeOf(zoneCtx, o) {
  const at = ref => {
    const r = zoneCtx.resolve(ref);
    if (!r) return null;
    const t = r.ctx.transformOf(r.id);
    return t ? { c: r.ctx.obj(r.id), w: t.ctx.worldOfT(t.id), enabled: String(r.ctx.obj(r.id).m_Enabled) !== '0' } : null;
  };
  const m = w => w.m;
  const box = at(o.box);
  if (box) {
    const c = box.c.m_Center || {}, s = box.c.m_Size || {};
    const p = [num(c.x), num(c.y), num(c.z)], M = m(box.w);
    return { kind: 'box', center: [0, 1, 2].map(r => M[r * 4] * p[0] + M[r * 4 + 1] * p[1] + M[r * 4 + 2] * p[2] + M[r * 4 + 3]), size: [num(s.x, 1), num(s.y, 1), num(s.z, 1)] };
  }
  const cap = at(o.capsule);
  if (cap) {
    const c = cap.c.m_Center || {}, M = m(cap.w);
    const up = [M[1], M[5], M[9]], n = Math.hypot(...up) || 1;
    const lossyZ = Math.hypot(M[2], M[6], M[10]);
    return { kind: 'capsule', position: [M[3], M[7], M[11]], center: [num(c.x), num(c.y), num(c.z)], up: up.map(v => v / n), radius: num(cap.c.m_Radius, 0.5), height: num(cap.c.m_Height, 1), scaledRadius: num(cap.c.m_Radius, 0.5) * lossyZ };
  }
  return null;
}

const guidOf = name => U.scriptGuid(name);
// The last environment, kept in cache/moods.json too, so a restart doesn't read the scenes again
// (about 3 s) unless a file it read has changed since.
const MOODS_CACHE = path.join(__dirname, '..', 'cache', 'moods.json');
const memo = { key: null, value: null };
try {
  const saved = JSON.parse(fs.readFileSync(MOODS_CACHE, 'utf8'));
  Object.assign(memo, { key: saved.key, files: new Map(saved.files), value: saved.value });
} catch { /* none kept yet */ }
// scenes: the Unity scenes being drawn (names), beside Chunk.cs's list.
function environment(scenes = []) {
  const list = [...new Set([...gameScenes(), ...scenes.filter(Boolean)])].filter(s => fs.existsSync(path.join(U.REPO, 'Assets', 'Scenes', s + '.unity')));
  const key = JSON.stringify(list);
  const mtime = rel => { try { return fs.statSync(path.join(U.REPO, rel)).mtimeMs; } catch { return -1; } };
  if (memo.key === key && memo.files && [...memo.files].every(([rel, t]) => mtime(rel) === t)) return memo.value;
  touched = new Set();
  const materials = new Set();
  const moods = [], moodIndex = new Map();
  const moodAt = r => {
    if (!r) return null;
    const k = r.ctx.rel + '|' + r.id + '|' + JSON.stringify(r.ctx.obj(r.id));
    if (!moodIndex.has(k)) { moodIndex.set(k, moods.length); moods.push(moodOf(r, materials)); }
    return moodIndex.get(k);
  };
  const problems = [];
  const zones = [];
  const zoneGuid = guidOf('BiomeZone');
  for (const s of list) {
    let ctx;
    try {
      ctx = new Ctx(`Assets/Scenes/${s}.unity`);
    } catch (error) {
      problems.push(`${s}: ${error.message}`);
      continue;
    }
    for (const z of ctx.components(zoneGuid)) {
      const o = z.ctx.obj(z.id);
      const t = z.ctx.transformOf(z.id);
      const shape = shapeOf(z.ctx, o);
      if (!shape) continue; // the default zone (no shape) is found apart
      const mood = moodAt(z.ctx.resolve(o.moodVisual));
      if (mood === null) { problems.push(`${s}: zone ${z.ctx.nameOf(z.id)} has no mood`); continue; }
      zones.push({ name: z.ctx.nameOf(z.id), scene: s, active: (t ? t.ctx.activeOfT(t.id) : true) && String(o.m_Enabled) !== '0', falloff: num(o.falloffPct, 0.1), seaAltitude: num(o.localSeaAltitude), mood, ...shape });
    }
  }
  // Game.unity's managers
  const game = new Ctx('Assets/Scenes/Game.unity');
  const one = name => game.components(guidOf(name))[0] || null;
  const env = one('EnvironmentManager'), manager = one('BiomeManager');
  const eo = env ? env.ctx.obj(env.id) : {};
  const fogR = env && env.ctx.resolve(eo.fog), seaR = env && env.ctx.resolve(eo.sea), sunR = env && env.ctx.resolve(eo.sun);
  const fo = fogR ? fogR.ctx.obj(fogR.id) : {}, so = seaR ? seaR.ctx.obj(seaR.id) : {};
  let sun = null;
  if (sunR) {
    const t = sunR.ctx.transformOf(sunR.id), lo = sunR.ctx.obj(sunR.id);
    const e = t ? U.quatToEuler(t.ctx.worldOfT(t.id).q) : { x: 50, y: -30, z: 0 };
    sun = { color: color(lo.m_Color), euler: [e.x, e.y, e.z] };
  }
  const dz = manager && manager.ctx.resolve(manager.ctx.obj(manager.id).defaultBiomeZone);
  const defaultMood = dz ? moodAt(dz.ctx.resolve(dz.ctx.obj(dz.id).moodVisual)) : null;
  const skyDefault = eo.skyMaterialDefault && eo.skyMaterialDefault.guid;
  if (skyDefault) materials.add(skyDefault);
  const value = {
    scenes: list, zones, moods, defaultMood, problems,
    sea: seaR ? { mood: moodAt(seaR.ctx.resolve(so.moodVisual)), maxDepth: num(so.maxDepth, 50), darknessWhenOvercast: num(so.darknessWhenOvercast, 0.5), dimAmountDefault: num(so.dimAmountDefault, 0.3) } : null,
    fog: { lerpSpeed: num(fo.fogLerpSpeed, 6), densityMinimum: num(fo.fogDensityMinimum, 0.04) },
    sun,
    sky: { blendMinMult: num(eo.csBlendMinMult, 1), blendMinAdd: num(eo.csBlendMinAdd, 400), blendMaxMult: num(eo.csBlendMaxMult, 1), blendMaxAdd: num(eo.csBlendMaxAdd, 400), blackMult: num(eo.csBlackMult, 1), blackAdd: num(eo.csBlackAdd, 0), materialDefault: skyDefault || null },
    materials: [...materials]
  };
  memo.key = key;
  memo.files = new Map([...touched].map(rel => [rel, fs.statSync(path.join(U.REPO, rel)).mtimeMs]));
  memo.value = value;
  fs.writeFileSync(MOODS_CACHE, JSON.stringify({ key, files: [...memo.files], value }));
  touched = null;
  return value;
}
// the game's scenes, from Chunk.cs's listByBuildIndex (Foyer, the menu, left out), and the scenes
// layout's splits made (splits/*.json newScene), which Chunk.cs doesn't list until Ken adds them
function gameScenes() {
  const cs = path.join(U.REPO, 'Assets', 'Scripts', 'Chunk.cs');
  const text = fs.existsSync(cs) ? fs.readFileSync(cs, 'utf8') : '';
  const splits = path.join(__dirname, '..', 'splits');
  const made = fs.existsSync(splits) ? fs.readdirSync(splits).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(splits, f), 'utf8')).newScene) : [];
  return [...[...text.matchAll(/new Chunk\(buildIndex: \d+, "(\w+)"\)/g)].map(m => m[1]).filter(n => n !== 'Foyer'), ...made];
}

module.exports = { environment, yaml, setPath };

if (require.main === module) {
  const v = environment(process.argv.slice(2));
  console.log(`scenes: ${v.scenes.join(', ')}`);
  for (const z of v.zones) console.log(`zone ${z.scene}/${z.name}${z.active ? '' : ' (inactive)'}: ${z.kind} ${z.kind === 'capsule' ? `at ${z.position.map(n => n.toFixed(1)).join(' ')} r ${z.scaledRadius.toFixed(1)} h ${z.height}` : `at ${z.center.map(n => n.toFixed(1)).join(' ')} size ${z.size.join(' ')}`}, mood ${v.moods[z.mood].label}`);
  console.log('default mood:', v.defaultMood !== null ? v.moods[v.defaultMood].label : null, '| sea mood:', v.sea && v.sea.mood !== null ? v.moods[v.sea.mood].label : null);
  console.log('fog', v.fog, 'sun', v.sun, 'sky', v.sky);
  if (v.problems.length) console.log('problems:', v.problems);
}
