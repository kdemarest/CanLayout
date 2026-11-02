// Unity particle systems (Shuriken), read for layout's stand-in, scripts/ParticleSystem.js (Ken,
// 2026-10-29: the Driller's smoke first). A ParticleSystem (class 198) and its renderer (199) become
// a small description of what the stand-in draws: the main settings, emission (rate and bursts),
// the emitter's shape, size, rotation, color and velocity over each particle's life, noise, a
// texture sheet, and the renderer's mode and material. Modules it doesn't do are named in `unsupported`.
// Values that Unity keeps as curves are { mode, scalar, min, max, minKeys, maxKeys } (mode 0 a
// constant, 1 a curve times scalar, 2 between two curves, 3 between two constants; keys
// [time, value, inSlope, outSlope]); colors are { mode, min, max, minGradient, maxGradient }
// (gradients { colors: [[t, r, g, b]], alphas: [[t, a]], fixed }), all in Unity's sRGB.

// The subset of YAML Unity writes: maps by indentation, "- " lists (of maps, the first key on the
// dash's line, or of scalars), {flow: maps}, [] and plain scalars (numbers become numbers).
function parseYaml(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('%'));
  let i = 0;
  const indentOf = l => l.length - l.trimStart().length;
  const scalar = v => {
    v = v.trim();
    if (v === '' || v === '~') return null;
    if (v === '[]') return [];
    if (v.startsWith('{') && v.endsWith('}')) {
      const out = {};
      for (const m of v.slice(1, -1).matchAll(/(\w+): ([^,]*)/g)) out[m[1]] = scalar(m[2]);
      return out;
    }
    return v !== '' && Number.isFinite(+v) ? +v : v;
  };
  const block = indent => {
    // a map (or a list) whose lines are at this indentation
    if (i < lines.length && lines[i].trimStart().startsWith('- ') && indentOf(lines[i]) === indent) {
      const list = [];
      while (i < lines.length && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith('- ')) {
        const first = lines[i].trimStart().slice(2);
        const kv = /^(\w+):(?: (.*))?$/.exec(first);
        if (!kv) { list.push(scalar(first)); i++; continue; }
        // a map: its first key is on the dash's line, the rest two deeper
        lines[i] = ' '.repeat(indent + 2) + first;
        list.push(block(indent + 2));
      }
      return list;
    }
    const map = {};
    while (i < lines.length && indentOf(lines[i]) === indent && !lines[i].trimStart().startsWith('- ')) {
      const m = /^\s*([\w.]+):(?: (.*))?$/.exec(lines[i]);
      i++;
      if (!m) continue;
      if (m[2] !== undefined && m[2].trim() !== '') { map[m[1]] = scalar(m[2]); continue; }
      // nested: a deeper map, or a list at this or a deeper indentation
      if (i < lines.length && (indentOf(lines[i]) > indent || (indentOf(lines[i]) === indent && lines[i].trimStart().startsWith('- ')))) map[m[1]] = block(indentOf(lines[i]));
      else map[m[1]] = null;
    }
    return map;
  };
  return block(lines.length ? indentOf(lines[0]) : 0);
}

const keysOf = c => ((c && c.m_Curve) || []).map(k => [k.time, k.value, k.inSlope, k.outSlope]);
function curve(c) {
  if (!c) return { mode: 0, scalar: 0 };
  const out = { mode: c.minMaxState || 0, scalar: c.scalar ?? 0 };
  if (out.mode === 3) out.min = c.minScalar ?? 0;
  if (out.mode === 1 || out.mode === 2) out.maxKeys = keysOf(c.maxCurve);
  if (out.mode === 2) out.minKeys = keysOf(c.minCurve);
  return out;
}
const rgba = c => (c ? [c.r ?? 1, c.g ?? 1, c.b ?? 1, c.a ?? 1] : [1, 1, 1, 1]);
function gradientOf(g) {
  if (!g) return null;
  const colors = [], alphas = [];
  for (let k = 0; k < (g.m_NumColorKeys || 0); k++) { const c = g['key' + k] || {}; colors.push([(g['ctime' + k] || 0) / 65535, c.r ?? 1, c.g ?? 1, c.b ?? 1]); }
  for (let k = 0; k < (g.m_NumAlphaKeys || 0); k++) alphas.push([(g['atime' + k] || 0) / 65535, (g['key' + k] || {}).a ?? 1]);
  return { colors, alphas, fixed: g.m_Mode === 1 };
}
function color(c) {
  if (!c) return { mode: 0, max: [1, 1, 1, 1] };
  const out = { mode: c.minMaxState || 0, max: rgba(c.maxColor), min: rgba(c.minColor) };
  if ([1, 3, 4].includes(out.mode)) out.maxGradient = gradientOf(c.maxGradient);
  if (out.mode === 3) out.minGradient = gradientOf(c.minGradient);
  return out;
}
const vec = v => (v ? [v.x ?? 0, v.y ?? 0, v.z ?? 0] : [0, 0, 0]);

// The modules the stand-in does; others, when on, are listed as unsupported.
const DONE = ['InitialModule', 'EmissionModule', 'ShapeModule', 'SizeModule', 'RotationModule', 'ColorModule', 'VelocityModule', 'UVModule', 'NoiseModule'];

// Sets a property by Unity's path ("InitialModule.startSize.scalar", "m_Bursts.Array.data[0].time"),
// as a prefab instance's modification does; a list's size is left to the items set.
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length; i++) {
    let k = parts[i];
    if (k === 'Array') {
      if (parts[i + 1] === 'size') return;
      const m = /^data\[(\d+)\]$/.exec(parts[i + 1] || '');
      if (!m) return;
      i++;
      k = +m[1];
    }
    if (i === parts.length - 1) { o[k] = value; return; }
    if (o[k] === null || typeof o[k] !== 'object') o[k] = parts[i + 1] === 'Array' ? [] : {};
    o = o[k];
  }
}

// systemText: the ParticleSystem document's body; rendererText: its ParticleSystemRenderer's (or
// null); props, rprops: an instance's modifications of them, by property path.
function describe(systemText, rendererText, props = null, rprops = null) {
  const after = s => { const m = /^\w+:\s*$/m.exec(s); return m ? s.slice(m.index + m[0].length) : s; }; // past "ParticleSystem:"
  const ps = parseYaml(after(systemText));
  const r = rendererText ? parseYaml(after(rendererText)) : {};
  for (const [k, v] of Object.entries(props || {})) setPath(ps, k, v);
  for (const [k, v] of Object.entries(rprops || {})) setPath(r, k, v && v.asset ? { guid: v.asset } : v);
  const on = m => Boolean(ps[m] && ps[m].enabled);
  const init = ps.InitialModule || {}, em = ps.EmissionModule || {}, sh = ps.ShapeModule || {};
  const material = r.m_Materials && r.m_Materials[0] && r.m_Materials[0].guid ? { asset: r.m_Materials[0].guid } : null;
  const unsupported = Object.keys(ps).filter(k => /Module$/.test(k) && on(k) && !DONE.includes(k));
  if (r.m_RenderMode === 4) unsupported.push('mesh particles');
  // Noise moves particles; what else it can do isn't done (Canopy uses none of it, 2026-10-29)
  const nm = ps.NoiseModule || {};
  if (on('NoiseModule') && nm.remapEnabled) unsupported.push('noise remap');
  for (const [k, what] of [['rotationAmount', 'noise on rotation'], ['sizeAmount', 'noise on size']]) if (on('NoiseModule') && nm[k] && (nm[k].scalar || nm[k].minMaxState)) unsupported.push(what);
  if (r.m_RenderMode === 1) unsupported.push('stretched billboards (drawn as billboards)');
  return {
    duration: ps.lengthInSec ?? 5, looping: Boolean(ps.looping), prewarm: Boolean(ps.prewarm), playOnAwake: ps.playOnAwake !== 0,
    startDelay: curve(ps.startDelay), simulationSpeed: ps.simulationSpeed ?? 1,
    cullingMode: ps.cullingMode ?? 0, // off screen: 0 automatic, 1 pause and catch up, 2 pause, 3 always simulate
    world: ps.moveWithTransform === 1, // simulation space: 0 local, 1 world (2, custom, is taken as local)
    maxParticles: init.maxNumParticles ?? 1000,
    lifetime: curve(init.startLifetime), speed: curve(init.startSpeed), size: curve(init.startSize),
    rotation: curve(init.startRotation), randomizeRotation: init.randomizeRotationDirection || 0,
    color: color(init.startColor), gravity: curve(init.gravityModifier),
    emission: on('EmissionModule') ? {
      rate: curve(em.rateOverTime),
      bursts: (em.m_Bursts || []).map(b => ({ time: b.time || 0, count: curve(b.countCurve), cycles: b.cycleCount ?? 1, interval: b.repeatInterval ?? 0.01, probability: b.probability ?? 1 }))
    } : null,
    shape: on('ShapeModule') ? {
      type: sh.type ?? 4, angle: sh.angle ?? 25, length: sh.length ?? 5, radius: (sh.radius && sh.radius.value) ?? 1,
      thickness: sh.radiusThickness ?? 1, arc: (sh.arc && sh.arc.value) ?? 360, box: vec(sh.m_Scale),
      position: vec(sh.m_Position), rotation: vec(sh.m_Rotation), scale: vec(sh.m_Scale),
      randomDirection: sh.randomDirectionAmount || 0, spherical: sh.sphericalDirectionAmount || 0
    } : null,
    sizeOverLife: on('SizeModule') ? curve(ps.SizeModule.curve) : null,
    rotationOverLife: on('RotationModule') ? curve(ps.RotationModule.curve) : null,
    colorOverLife: on('ColorModule') ? color(ps.ColorModule.gradient) : null,
    // strength per axis (all one unless separateAxes), over each particle's life; frequency; the
    // field's scroll speed; damping (strength over frequency); octaves; quality (0 1D, 1 2D, 2 3D);
    // how much of it moves the particle (positionAmount, 1 when unsaved)
    noise: on('NoiseModule') ? {
      strength: [curve(nm.strength), curve(nm.separateAxes ? nm.strengthY : nm.strength), curve(nm.separateAxes ? nm.strengthZ : nm.strength)],
      frequency: nm.frequency ?? 0.5, scroll: curve(nm.scrollSpeed), damping: nm.damping !== 0,
      octaves: nm.octaves || 1, octaveMultiplier: nm.octaveMultiplier ?? 0.5, octaveScale: nm.octaveScale ?? 2,
      quality: nm.quality ?? 2, position: nm.positionAmount ? curve(nm.positionAmount) : { mode: 0, scalar: 1 }
    } : null,
    velocityOverLife: on('VelocityModule') ? { x: curve(ps.VelocityModule.x), y: curve(ps.VelocityModule.y), z: curve(ps.VelocityModule.z), world: Boolean(ps.VelocityModule.inWorldSpace) } : null,
    sheet: on('UVModule') ? { tilesX: ps.UVModule.tilesX || 1, tilesY: ps.UVModule.tilesY || 1, row: ps.UVModule.animationType === 1 ? (ps.UVModule.rowMode === 0 || ps.UVModule.randomRow ? -1 : ps.UVModule.rowIndex || 0) : null, frame: curve(ps.UVModule.frameOverTime), start: curve(ps.UVModule.startFrame), cycles: ps.UVModule.cycles || 1 } : null,
    renderMode: r.m_RenderMode || 0, renderOn: r.m_Enabled !== 0,
    applyColorSpace: r.m_ApplyActiveColorSpace !== 0, // colors to linear for the shader (Unity's default when unsaved) minSize: r.m_MinParticleSize ?? 0, maxSize: r.m_MaxParticleSize ?? 0.5,
    material, unsupported
  };
}

module.exports = { parseYaml, describe };
