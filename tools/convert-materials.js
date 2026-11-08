// Moves Canopy's materials off Unity's lit shaders onto Canopy's own (Claude, 2026-11-06; Ken:
// retire Unity's shaders, a set at a time, with a switch back and previews; docs: Rendering
// Performance, More Lights, phase 3).
//   node tools/convert-materials.js <Name>... [--write]
//   node tools/convert-materials.js --rewritten <Shader file>... [--write]
// Names are .mat file names; * matches any run (Corals*). Without --write it prints each one's plan:
// the shader it moves to, what it sets, and warnings where Canopy's shader can't match Unity's.
// --write converts in place: the .mat keeps its guid, so prefabs, scenes and Edit/Build's LOD
// prefabs (which keep their source's materials) draw the new shader with nothing else touched.
// Unity's own properties stay in the .mat, unused. A copy of the .mat as it was goes to
// Assets/Resources/ShaderSwitch/<Name> (Unity).mat (a new guid), listed with it in
// ShaderSwitch.asset, which Canopy's ShaderSwitch.cs reads to switch the game back to Unity's
// shaders and forth (and tools/material-preview.js and layout's ☰ View to compare).
//
// What maps (Unity's built-in shaders; Canopy/General's color is texture × detail × tint × brightness):
//   Standard, opaque          → Canopy/General: _Color → _Tint, _BumpMap → _NormalMap at _MainTex's
//                               tiling (Standard tiles every map by _MainTex's), _BumpScale →
//                               _NormalStrength, _Glossiness as is, _Brightness 1
//   Standard, cutout          → Canopy/GeneralCutout, the same plus _Cutoff
//   Mobile/Diffuse, Mobile/Bumped Diffuse, Legacy Diffuse → Canopy/General (white tint but Legacy's _Color)
//   Standard with emission    → Canopy/GlowLit, as General plus its constant glow: _EmissionColor and
//                               _EmissionMap, the same names, kept as they are; no glow texture
//   Mobile/Bumped Specular    → Canopy/General, _Shininess as gloss (its power 8 to 64)
//   Standard, Fade or Transparent → Canopy/TransparentLit: as General, plus _Premultiply for
//                               Transparent (glass), blend factors to match, emission as GlowLit's
//   Particles/Standard Surface, Fade or Transparent → Canopy/TransparentLit, the same plus the
//                               particle's color and flipbook blending; not its soft particles
//   Particles/Standard Surface, opaque or cutout → Canopy/ParticleSolid: _Color → _Tint, _Cutoff,
//                               _Glossiness → _Smoothness, _BumpMap → _NormalMap (the particle's
//                               color multiplies both)
//   Particles/Standard Unlit  → Canopy/ParticleUnlit, its port: the same properties, flipbook
//                               blending by its keyword (_FlipbookMode); not its emission, soft
//                               particles, camera fading, distortion or HSV color mode
//   Mobile/Particles/Additive → Canopy/ParticleUnlit, additive: texture × the particle's color
// Canopy's glow surface shaders → Canopy/GlowLit (written to replace them):
//   GeneralGlowUsingDetailTwo  the same properties (its smoothness was always 0; metallic dropped)
//   GeneralGlowUsingDetail     its glow texture is _DetailTex: that becomes _GlowTex, no detail
//   GlowSurface                the main texture is its own glow (_GlowMode 1: by the brightest
//                              channel, replacing the lit color), untinted, no fade, no detail
//   NoFogEmissiveLight         a flat _Color, lit; its glow, _Color × _EmissionColor (× the normal
//                              map's alpha: 1 in a JPG), as GlowLit's constant glow; no fog
// Others, by shader guid:
//   Oculus/Hands_Transparent   → Canopy/RimLit, the same properties, _InnerLit 1 (Lambert's inner color)
//   FX/Diamond (GemsPack)      → Canopy/Diamond, its port: the same properties
// Not yet: Standard's cutout with emission (no cutout GlowLit); additive, subtractive and
// modulated lit particles. Those print why and are left alone.
// --rewritten: for Canopy's own shaders rewritten in place off Unity's lighting (Goo, ParticleSolid,
// Blank), whose materials don't change. The switch back needs the shader as it was: its text at
// git HEAD, named Canopy/Unity/<name>, goes to ShaderSwitch/Shaders/<file>, and each material on it
// gets a copy on that, paired in ShaderSwitch.asset like a converted one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const U = require('./unity.js');

const BUILTIN = '0000000000000000f000000000000000';
const BUILTIN_NAMES = { 7: 'Legacy Shaders/Diffuse', 45: 'Standard (Specular setup)', 46: 'Standard', 210: 'Particles/Standard Surface', 211: 'Particles/Standard Unlit', 10720: 'Mobile/Particles/Additive', 10703: 'Mobile/Diffuse', 10704: 'Mobile/Bumped Diffuse', 10705: 'Mobile/Bumped Specular' };
const SWITCH_DIR = 'Assets/Resources/ShaderSwitch';
const SWITCH_ASSET = SWITCH_DIR + '/ShaderSwitch.asset';
const SWITCH_SCRIPT = 'Assets/Scripts/ShaderSwitch.cs';
// Canopy's targets, by name: their guids from the shaders' .meta files.
const TARGETS = ['General', 'GeneralCutout', 'GlowLit', 'ParticleSolid', 'RimLit', 'ParticleUnlit', 'Diamond', 'TransparentLit'];
const OTHERS = {
  '5e0c88c3d888e4489929314c7c1ebf4b': { from: 'Oculus/Hands_Transparent', to: 'RimLit', edits: [['float', '_InnerLit', 1]] },
  '4443140fbd110a7011005aba44295342': { from: 'FX/Diamond', to: 'Diamond', edits: [] }
};
const shaderGuid = name => {
  const m = /^guid: (\w+)/m.exec(fs.readFileSync(path.join(U.REPO, 'Assets/Shaders', name + '.shader.meta'), 'utf8'));
  if (!m) throw new Error(`Assets/Shaders/${name}.shader.meta: no guid`);
  return m[1];
};

// ---------- reading and editing a .mat's text ----------
// Values are read from the m_SavedProperties lists; edits keep every other line as it is.
function texOf(text, name) {
  const m = new RegExp('\\n    - ' + name + ':\\n        m_Texture: \\{fileID: (-?\\d+)(?:, guid: (\\w+))?[^\\n]*\\n        m_Scale: \\{x: ([^,]+), y: ([^}]+)\\}\\n        m_Offset: \\{x: ([^,]+), y: ([^}]+)\\}').exec(text);
  if (!m) return undefined; // not listed
  return m[1] === '0' || !m[2] ? null : { guid: m[2], scale: [+m[3], +m[4]], offset: [+m[5], +m[6]] };
}
function floatOf(text, name) {
  const m = new RegExp('\\n    - ' + name + ': (-?[\\d.e+-]+)\\n').exec(text);
  return m ? +m[1] : undefined;
}
function colorOf(text, name) {
  const m = new RegExp('\\n    - ' + name + ': \\{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\\}').exec(text);
  return m ? m.slice(1, 5).map(Number) : undefined;
}
// Keywords: m_ShaderKeywords (a space-separated line, older files) or m_ValidKeywords and
// m_InvalidKeywords (lists, Material serializedVersion 8).
function keywordsOf(text) {
  const old = /\n {2}m_ShaderKeywords: ?(.*)\n/.exec(text);
  if (old) return old[1].split(/\s+/).filter(Boolean);
  const list = key => {
    const m = new RegExp('\\n  ' + key + ':( \\[\\])?\\n((?:  - .*\\n)*)').exec(text);
    return m ? m[2].split('\n').map(l => l.replace(/^ {2}- /, '').trim()).filter(Boolean) : [];
  };
  return [...list('m_ValidKeywords'), ...list('m_InvalidKeywords')];
}
function shaderOf(text) {
  const m = /\n {2}m_Shader: \{fileID: (-?\d+), guid: (\w+)/.exec(text);
  return m ? { fileID: +m[1], guid: m[2] } : null;
}
const num = v => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(7)));
// One property's lines in its list, replacing it or inserted in name order (as Unity writes them).
function setEntry(text, list, name, lines) {
  const head = `\n    ${list}:`;
  let at = text.indexOf(head + '\n');
  if (at < 0) {
    const empty = text.indexOf(head + ' []\n');
    if (empty < 0) throw new Error(`no ${list} list`);
    text = text.slice(0, empty) + head + '\n' + text.slice(empty + head.length + 4);
    at = empty;
  }
  const start = at + head.length + 1;
  // the list's entries: lines from start indented "    - " (with their continuation lines)
  const rest = text.slice(start);
  const end = start + (/^(?: {4}- .*\n(?: {8}.*\n)*)*/.exec(rest)[0].length);
  const entries = text.slice(start, end).split(/(?=^ {4}- )/m).filter(Boolean);
  const keyOf = e => /^ {4}- (\w+):/.exec(e)[1];
  const mine = lines.join('\n') + '\n';
  const i = entries.findIndex(e => keyOf(e) === name);
  if (i >= 0) entries[i] = mine;
  else {
    const j = entries.findIndex(e => keyOf(e) > name);
    entries.splice(j < 0 ? entries.length : j, 0, mine);
  }
  return text.slice(0, start) + entries.join('') + text.slice(end);
}
function setTex(text, name, t) {
  const ref = t ? `{fileID: 2800000, guid: ${t.guid}, type: 3}` : '{fileID: 0}';
  const [sx, sy] = t ? t.scale : [1, 1], [ox, oy] = t ? t.offset : [0, 0];
  return setEntry(text, 'm_TexEnvs', name, [`    - ${name}:`, `        m_Texture: ${ref}`, `        m_Scale: {x: ${num(sx)}, y: ${num(sy)}}`, `        m_Offset: {x: ${num(ox)}, y: ${num(oy)}}`]);
}
const setFloat = (text, name, v) => setEntry(text, 'm_Floats', name, [`    - ${name}: ${num(v)}`]);
// A material's values as Tweak set them (web/app.js materialFamily): floats by name, and a texture's
// tiling as <slot>.scale, both ways.
function setTweaks(text, values) {
  for (const [name, v] of Object.entries(values)) {
    const tile = /^(_\w+)\.scale$/.exec(name);
    if (!tile) {
      text = setFloat(text, name, v);
      continue;
    }
    const slot = new RegExp(`(- ${tile[1]}:\\r?\\n\\s+m_Texture:[^\\n]*\\n\\s+m_Scale: )\\{[^}]*\\}`);
    if (!slot.test(text)) throw new Error(`no ${tile[1]} slot`);
    text = text.replace(slot, `$1{x: ${num(v)}, y: ${num(v)}}`);
  }
  return text;
}
const setColor = (text, name, c) => setEntry(text, 'm_Colors', name, [`    - ${name}: {r: ${num(c[0])}, g: ${num(c[1])}, b: ${num(c[2])}, a: ${num(c[3])}}`]);
function setShader(text, guid) {
  return text.replace(/\n {2}m_Shader: \{[^}]*\}/, `\n  m_Shader: {fileID: 4800000, guid: ${guid}, type: 3}`);
}
// Canopy's shaders take no keywords: clear them (the copy keeps Unity's).
function clearKeywords(text) {
  return text.replace(/\n {2}m_ShaderKeywords: ?.*\n/, '\n  m_ShaderKeywords: \n')
    .replace(/\n {2}m_ValidKeywords:(?: \[\])?\n(?: {2}- .*\n)*/, '\n  m_ValidKeywords: []\n')
    .replace(/\n {2}m_InvalidKeywords:(?: \[\])?\n(?: {2}- .*\n)*/, '\n  m_InvalidKeywords: []\n');
}

// ---------- the plan ----------
// What a material becomes: { from, to (a TARGETS name) or null, edits [[kind, name, value]],
// warnings [], blocked (why not) }.
// The glow surface shaders, by file name (their guids from the .meta files), and their names.
const GLOW_SURFACES = { GeneralGlowDetailTwo: 'Canopy/GeneralGlowUsingDetailTwo', GeneralGlowDetail: 'Canopy/GeneralGlowUsingDetail', GlowNormal: 'Canopy/GlowSurface', NoFogEmissiveLight: 'Canopy/NoFogEmissiveLight' };
const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function glowPlan(text, file, out) {
  out.from = GLOW_SURFACES[file];
  const f = (name, d) => floatOf(text, name) ?? d;
  const c = (name, d) => colorOf(text, name) || d;
  const t = name => texOf(text, name) || null;
  const white = [1, 1, 1, 1];
  const e = out.edits;
  const metal = f('_Metallic', 0); // only GeneralGlowUsingDetailTwo reads it; the others' are leftovers
  if (file === 'GeneralGlowDetailTwo' && metal > 0) out.warnings.push(`metallic ${num(metal)}: GlowLit has none`);
  if (file === 'GeneralGlowDetailTwo' || file === 'GeneralGlowDetail') {
    const two = file === 'GeneralGlowDetailTwo';
    const glow = t(two ? '_GlowTex' : '_DetailTex');
    if (!glow) {
      out.blocked = 'no glow texture: the surface shader\'s white default glowed everywhere, which GlowLit\'s black one doesn\'t';
      return out;
    }
    e.push(['color', '_Tint', c('_Tint', [0.5, 0.5, 0.5, 1])], ['float', '_Brightness', f('_Brightness', 1)], ['tex', '_DetailTex', two ? t('_DetailTex') : null],
      ['float', '_NormalStrength', f('_NormalStrength', 1)], ['float', '_Glossiness', two ? 0 : f('_Glossiness', 0.5)], ['tex', '_GlowTex', glow],
      ['color', '_GlowTint', c('_GlowTint', [0.5, 0.5, 0.5, 1])], ['float', '_GlowFogLevel', f('_GlowFogLevel', 1)], ['float', '_GlowFades', 1]);
  } else if (file === 'GlowNormal') {
    const main = t('_MainTex');
    if (!main) {
      out.blocked = 'no main texture: GlowSurface glowed white everywhere';
      return out;
    }
    e.push(['color', '_Tint', white], ['float', '_Brightness', 1], ['tex', '_DetailTex', null], ['float', '_NormalStrength', f('_NormalStrength', 1)],
      ['float', '_Glossiness', f('_Glossiness', 0.5)], ['tex', '_GlowTex', main], ['color', '_GlowTint', white], ['float', '_GlowFogLevel', 1], ['float', '_GlowFades', 0], ['float', '_GlowMode', 1]);
  } else {
    // NoFogEmissiveLight: Unity makes each color linear before the shader multiplies them
    const color = c('_Color', white), glow = c('_EmissionColor', [0, 0, 0, 1]);
    const bump = t('_BumpMap');
    const bumpPath = bump && U.index()[bump.guid] && U.index()[bump.guid].path;
    if (bump && !/\.jpe?g$/i.test(bumpPath || '')) out.warnings.push(`its glow was × its normal map's alpha (${bumpPath || 'missing'}): dropped`);
    e.push(['tex', '_MainTex', null], ['color', '_Tint', color], ['float', '_Brightness', 1], ['tex', '_DetailTex', null], ['tex', '_NormalMap', bump],
      ['float', '_NormalStrength', 1], ['float', '_Glossiness', f('_Glossiness', 0.5)], ['tex', '_GlowTex', null],
      ['color', '_EmissionColor', [0, 1, 2].map(i => toGamma(toLinear(color[i]) * toLinear(glow[i]))).concat([1])], ['tex', '_EmissionMap', null], ['float', '_FogLevel', 0]);
  }
  if (file !== 'NoFogEmissiveLight') e.push(['float', '_GlowThreshold', f('_GlowThreshold', 0.5)], ['float', '_GlowBrightness', f('_GlowBrightness', 100)], ['color', '_EmissionColor', [0, 0, 0, 1]], ['float', '_FogLevel', 1]);
  out.to = 'GlowLit';
  return out;
}
// Standard's Fade (2) and Transparent (3), and lit particles' (Particles/Standard Surface).
function transparentPlan(text, kw, { mode, particle }, out) {
  if (mode > 3) {
    out.blocked = `${particle ? 'Particles/Standard Surface' : 'Standard'}'s mode ${mode} (additive, subtractive or modulated): Canopy/TransparentLit is Fade or Transparent`;
    return out;
  }
  const main = texOf(text, '_MainTex') || null;
  const st = main ? { scale: main.scale, offset: main.offset } : { scale: [1, 1], offset: [0, 0] };
  const bump = kw.includes('_NORMALMAP') ? texOf(text, '_BumpMap') || null : null;
  const emits = kw.includes('_EMISSION') && ((colorOf(text, '_EmissionColor') || [0, 0, 0]).slice(0, 3).some(v => v > 0) || texOf(text, '_EmissionMap'));
  const map = texOf(text, '_MetallicGlossMap');
  const fromAlbedo = floatOf(text, '_SmoothnessTextureChannel') === 1;
  out.to = 'TransparentLit';
  out.edits.push(['color', '_Tint', colorOf(text, '_Color') || [1, 1, 1, 1]], ['float', '_Brightness', 1], ['tex', '_NormalMap', bump ? { guid: bump.guid, ...st } : null],
    ['float', '_NormalStrength', floatOf(text, '_BumpScale') ?? 1], ['float', '_Glossiness', map || fromAlbedo ? floatOf(text, '_GlossMapScale') ?? 1 : floatOf(text, '_Glossiness') ?? 0.5],
    ['float', '_VertexColor', particle ? 1 : 0], ['float', '_FlipbookMode', particle && kw.includes('_REQUIRE_UV2') ? 1 : 0], ['float', '_Premultiply', mode === 3 ? 1 : 0],
    ['float', '_SrcBlend', mode === 3 ? 1 : 5], ['float', '_DstBlend', 10], ['float', '_Cull', particle ? floatOf(text, '_Cull') ?? 2 : 2]);
  if (!emits) out.edits.push(['color', '_EmissionColor', [0, 0, 0, 1]]);
  const metal = floatOf(text, '_Metallic') || 0;
  if (metal > 0 || map) out.warnings.push(`metallic ${map ? '(a map)' : num(metal)}: TransparentLit has none`);
  if (particle && kw.includes('_FADING_ON')) out.warnings.push('its soft particles and camera fading are dropped');
  if (particle && kw.some(k => /^_COLOR(OVERLAY|COLOR|ADDSUBDIFF)_ON$/.test(k))) out.warnings.push('its color mode isn\'t a multiply: TransparentLit multiplies');
  if (!particle && kw.some(k => /^(_COLOR(OVERLAY|COLOR|ADDSUBDIFF)_ON|_FADING_ON|EFFECT_BUMP)$/.test(k))) out.warnings.push('its particle keywords (left from Particles/Standard Surface) did nothing on Standard: dropped');
  return out;
}
function particlePlan(text, kw, out) {
  const mode = floatOf(text, '_Mode') || 0;
  if (mode >= 2) return transparentPlan(text, kw, { mode, particle: true }, out);
  const main = texOf(text, '_MainTex') || null;
  const st = main ? { scale: main.scale, offset: main.offset } : { scale: [1, 1], offset: [0, 0] };
  const bump = kw.includes('_NORMALMAP') ? texOf(text, '_BumpMap') || null : null;
  out.to = 'ParticleSolid';
  out.edits.push(['color', '_Tint', colorOf(text, '_Color') || [1, 1, 1, 1]], ['float', '_Cutoff', mode === 1 ? floatOf(text, '_Cutoff') ?? 0.5 : 0],
    ['float', '_CullMode', 2], ['tex', '_NormalMap', bump ? { guid: bump.guid, ...st } : null], ['float', '_NormalStrength', floatOf(text, '_BumpScale') ?? 1],
    ['float', '_Smoothness', floatOf(text, '_Glossiness') ?? 0.5], ['float', '_Metallic', 0]);
  if ((floatOf(text, '_Metallic') || 0) > 0) out.warnings.push(`metallic ${num(floatOf(text, '_Metallic'))}: ParticleSolid has none`);
  if (kw.includes('_EMISSION')) out.warnings.push('its emission is dropped');
  if (kw.includes('_REQUIRE_UV2')) out.warnings.push('its flipbook blending is dropped');
  if (kw.some(k => /^_COLOR(OVERLAY|COLOR|ADDSUBDIFF)_ON$/.test(k))) out.warnings.push('its color mode isn\'t a multiply: ParticleSolid multiplies');
  return out;
}
function unlitParticlePlan(text, kw, id, out) {
  const e = out.edits;
  if (id === 10720) {
    out.to = 'ParticleUnlit';
    e.push(['color', '_Color', [1, 1, 1, 1]], ['float', '_Mode', 4], ['float', '_ColorMode', 0], ['float', '_FlipbookMode', 0], ['float', '_SrcBlend', 5],
      ['float', '_DstBlend', 1], ['float', '_ZWrite', 0], ['float', '_Cull', 0]);
    return out;
  }
  const missing = [['_EMISSION', 'emission'], ['_FADING_ON', 'camera fading'], ['SOFTPARTICLES_ON', 'soft particles'], ['EFFECT_BUMP', 'distortion'], ['_COLORCOLOR_ON', 'the HSV color mode']].filter(([k]) => kw.includes(k));
  if (missing.length) {
    out.blocked = `Particles/Standard Unlit's ${missing.map(m => m[1]).join(', ')}: Canopy/ParticleUnlit hasn't it`;
    return out;
  }
  out.to = 'ParticleUnlit';
  e.push(['float', '_FlipbookMode', kw.includes('_REQUIRE_UV2') ? 1 : 0]);
  return out;
}
function plan(text) {
  const shader = shaderOf(text);
  const from = shader && shader.guid === BUILTIN ? BUILTIN_NAMES[shader.fileID] || `built-in ${shader.fileID}` : shader ? shader.guid : 'none';
  const out = { from, to: null, edits: [], warnings: [], blocked: null };
  const targetGuids = Object.fromEntries(TARGETS.map(t => [shaderGuid(t), t]));
  if (shader && targetGuids[shader.guid]) {
    out.from = `Canopy/${targetGuids[shader.guid]}`;
    out.blocked = `already on ${out.from}`;
    return out;
  }
  const glowFile = shader && Object.keys(GLOW_SURFACES).find(g => shaderGuid(g) === shader.guid);
  if (glowFile) return glowPlan(text, glowFile, out);
  const other = shader && OTHERS[shader.guid];
  if (other) return Object.assign(out, { from: other.from, to: other.to, edits: other.edits.slice() });
  if (!shader || shader.guid !== BUILTIN || !BUILTIN_NAMES[shader.fileID]) {
    out.blocked = `its shader (${from}) isn't one this converts yet`;
    return out;
  }
  const kw = keywordsOf(text);
  const id = shader.fileID;
  if (id === 210) return particlePlan(text, kw, out);
  if (id === 211 || id === 10720) return unlitParticlePlan(text, kw, id, out);
  const standard = id === 45 || id === 46;
  const mode = standard ? floatOf(text, '_Mode') || 0 : 0;
  const main = texOf(text, '_MainTex') || null;
  const st = main ? { scale: main.scale, offset: main.offset } : { scale: [1, 1], offset: [0, 0] };
  const bump = [10704, 10705].includes(id) || (standard && kw.includes('_NORMALMAP')) ? texOf(text, '_BumpMap') || null : null;
  if (standard && mode >= 2) return transparentPlan(text, kw, { mode, particle: false }, out);
  const emission = standard && kw.includes('_EMISSION') && ((colorOf(text, '_EmissionColor') || [0, 0, 0]).slice(0, 3).some(v => v > 0) || texOf(text, '_EmissionMap'));
  if (emission && mode === 1) {
    out.blocked = 'Standard\'s cutout with emission: no cutout Canopy/GlowLit';
    return out;
  }
  out.to = emission ? 'GlowLit' : standard && mode === 1 ? 'GeneralCutout' : 'General';
  const e = out.edits;
  if (emission) e.push(['tex', '_GlowTex', null], ['float', '_FogLevel', 1]);
  e.push(['tex', '_NormalMap', bump ? { guid: bump.guid, ...st } : null]);
  e.push(['float', '_NormalStrength', standard ? floatOf(text, '_BumpScale') ?? 1 : 1]);
  e.push(['color', '_Tint', standard || id === 7 ? colorOf(text, '_Color') || [1, 1, 1, 1] : [1, 1, 1, 1]]);
  e.push(['float', '_Brightness', 1]);
  // Standard's detail albedo (×2, by its mask) isn't General's plain multiply: none, unless asked.
  const detail = standard && kw.includes('_DETAIL_MULX2') && texOf(text, '_DetailAlbedoMap');
  e.push(['tex', '_DetailTex', null]);
  if (detail) out.warnings.push('its detail albedo (Standard\'s ×2, masked) is dropped: General multiplies its detail straight, darkening');
  if (standard) {
    const gloss = floatOf(text, '_Glossiness') ?? 0.5;
    const map = texOf(text, '_MetallicGlossMap');
    const fromAlbedo = floatOf(text, '_SmoothnessTextureChannel') === 1;
    e.push(['float', '_Glossiness', map || fromAlbedo ? floatOf(text, '_GlossMapScale') ?? 1 : gloss]);
    if (map || fromAlbedo) out.warnings.push(`its smoothness came from ${map ? 'the metallic map' : 'the albedo'}'s alpha: _GlossMapScale taken as gloss`);
    const metal = floatOf(text, '_Metallic') || 0;
    if (metal > 0.3 || map) out.warnings.push(`metallic ${map ? '(a map)' : num(metal)}: General has none (no tinted highlight, no darker diffuse)`);
    if (id === 45) out.warnings.push('Standard (Specular setup)\'s _SpecColor: General\'s highlight is white');
    if (kw.includes('_PARALLAXMAP')) out.warnings.push('its parallax (height) map is dropped');
    if (texOf(text, '_OcclusionMap') && (floatOf(text, '_OcclusionStrength') ?? 1) > 0) out.warnings.push('its occlusion map is dropped');
  } else if (id === 10705) {
    const shininess = floatOf(text, '_Shininess') ?? 0.078125;
    e.push(['float', '_Glossiness', Math.min(1, Math.max(0, (shininess * 128 - 8) / 56))]);
    out.warnings.push(`Mobile/Bumped Specular's highlight (power ${num(shininess * 128)}, by the texture's alpha) approximated by gloss`);
  } else e.push(['float', '_Glossiness', 0]);
  if (out.to === 'GeneralCutout') e.push(['float', '_Cutoff', floatOf(text, '_Cutoff') ?? 0.5], ['float', '_CullMode', 2]);
  return out;
}
function apply(text, p) {
  let t = clearKeywords(setShader(text, shaderGuid(p.to)));
  for (const [kind, name, v] of p.edits) t = kind === 'tex' ? setTex(t, name, v) : kind === 'float' ? setFloat(t, name, v) : setColor(t, name, v);
  return t;
}

// ---------- files ----------
// New files get stable guids (md5 of 'canopy-shader-switch:' + path, as layout's other generators do),
// so converting again after an undo writes the same ones.
const guidOf = rel => crypto.createHash('md5').update('canopy-shader-switch:' + rel).digest('hex');
const META = {
  shader: g => `fileFormatVersion: 2\nguid: ${g}\nShaderImporter:\n  externalObjects: {}\n  defaultTextures: []\n  nonModifiableTextures: []\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`,
  mat: g => `fileFormatVersion: 2\nguid: ${g}\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 2100000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`,
  asset: g => `fileFormatVersion: 2\nguid: ${g}\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 11400000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`,
  folder: g => `fileFormatVersion: 2\nguid: ${g}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`
};
const abs = rel => path.join(U.REPO, rel);
const guidOfMeta = rel => (/^guid: (\w+)/m.exec(fs.readFileSync(abs(rel) + '.meta', 'utf8')) || [])[1];
function writeNew(rel, text, meta) {
  fs.writeFileSync(abs(rel), text);
  if (meta && !fs.existsSync(abs(rel) + '.meta')) fs.writeFileSync(abs(rel) + '.meta', meta(guidOf(rel)));
}
// ShaderSwitch.asset's pairs: [[converted guid, original guid]].
function switchPairs() {
  if (!fs.existsSync(abs(SWITCH_ASSET))) return [];
  return [...fs.readFileSync(abs(SWITCH_ASSET), 'utf8').matchAll(/- converted: \{fileID: 2100000, guid: (\w+), type: 2\}\n\s+original: \{fileID: 2100000, guid: (\w+), type: 2\}/g)].map(m => [m[1], m[2]]);
}
function writeSwitch(pairs) {
  const script = guidOfMeta(SWITCH_SCRIPT);
  if (!script) throw new Error(`${SWITCH_SCRIPT}.meta: missing (ShaderSwitch.cs is Canopy's half of the switch)`);
  const lines = pairs.map(([c, o]) => `  - converted: {fileID: 2100000, guid: ${c}, type: 2}\n    original: {fileID: 2100000, guid: ${o}, type: 2}\n`).join('');
  const text = `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_GameObject: {fileID: 0}\n  m_Enabled: 1\n  m_EditorHideFlags: 0\n  m_Script: {fileID: 11500000, guid: ${script}, type: 3}\n  m_Name: ShaderSwitch\n  m_EditorClassIdentifier: \n  pairs:${pairs.length ? '\n' + lines : ' []\n'}`;
  writeNew(SWITCH_ASSET, text, META.asset);
}
// The materials named (each a .mat file name, * for any run), from the guid index.
function materialsNamed(names) {
  const all = Object.entries(U.index()).filter(([, e]) => e.path.endsWith('.mat') && !e.path.startsWith(SWITCH_DIR + '/'));
  const out = [];
  for (const n of names) {
    const re = new RegExp('^' + n.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    const hits = all.filter(([, e]) => re.test(path.basename(e.path, '.mat')));
    if (!hits.length) throw new Error(`${n}: no material by that name`);
    if (!n.includes('*') && hits.length > 1) throw new Error(`${n}: ${hits.length} materials have that name (${hits.map(([, e]) => e.path).join(', ')})`);
    for (const [guid, e] of hits) if (!out.some(o => o.guid === guid)) out.push({ guid, path: e.path, name: path.basename(e.path, '.mat') });
  }
  return out;
}

const switchDir = () => {
  fs.mkdirSync(abs(SWITCH_DIR), { recursive: true });
  if (!fs.existsSync(abs(SWITCH_DIR) + '.meta')) fs.writeFileSync(abs(SWITCH_DIR) + '.meta', META.folder(guidOf(SWITCH_DIR)));
};
// --rewritten (see the top): each shader as it was, and a copy of each material on it on that.
function keepRewritten(files, write, pairs) {
  let copied = 0;
  for (const file of files) {
    const rel = `Assets/Shaders/${file}.shader`;
    const old = execFileSync('git', ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git', 'show', 'HEAD:' + rel]).toString();
    const name = (/Shader\s+"([^"]+)"/.exec(old) || [])[1];
    if (!name) throw new Error(`${rel} at HEAD: no Shader name`);
    if (old === fs.readFileSync(abs(rel), 'utf8')) throw new Error(`${rel}: not rewritten yet (the same as at HEAD)`);
    const copyRel = `${SWITCH_DIR}/Shaders/${file}.shader`;
    const guid = shaderGuid(file);
    const mats = Object.entries(U.index()).filter(([, e]) => e.path.endsWith('.mat') && !e.path.startsWith(SWITCH_DIR + '/') && fs.existsSync(abs(e.path)))
      .filter(([, e]) => (shaderOf(fs.readFileSync(abs(e.path), 'utf8').replace(/\r\n/g, '\n')) || {}).guid === guid);
    console.log(`${name} (${rel}): as it was → ${copyRel}, ${name.replace(/^Canopy\//, 'Canopy/Unity/')}; copies of ${mats.map(([, e]) => path.basename(e.path, '.mat')).join(', ') || 'no materials'}`);
    if (!write) continue;
    switchDir();
    fs.mkdirSync(abs(SWITCH_DIR + '/Shaders'), { recursive: true });
    if (!fs.existsSync(abs(SWITCH_DIR + '/Shaders') + '.meta')) fs.writeFileSync(abs(SWITCH_DIR + '/Shaders') + '.meta', META.folder(guidOf(SWITCH_DIR + '/Shaders')));
    writeNew(copyRel, old.replace(`Shader "${name}"`, `Shader "${name.replace(/^Canopy\//, 'Canopy/Unity/')}"`), META.shader);
    const oldGuid = guidOfMeta(copyRel);
    for (const [g, e] of mats) {
      const raw = fs.readFileSync(abs(e.path), 'utf8');
      const eol = raw.includes('\r\n') ? t => t.replace(/\n/g, '\r\n') : t => t;
      const n = path.basename(e.path, '.mat');
      const copy = `${SWITCH_DIR}/${n} (Unity).mat`;
      if (pairs.some(([c]) => c === g)) continue; // copied before
      if (fs.existsSync(abs(copy))) throw new Error(`${copy} already exists`);
      writeNew(copy, eol(setShader(raw.replace(/\r\n/g, '\n'), oldGuid).replace(/\n {2}m_Name: .*\n/, `\n  m_Name: ${n} (Unity)\n`)), META.mat);
      pairs.push([g, guidOfMeta(copy)]);
      copied++;
    }
  }
  return copied;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const names = args.filter(a => !a.startsWith('--'));
  if (!names.length) {
    console.error('usage: node tools/convert-materials.js [--rewritten] <Name>... [--write]');
    process.exit(2);
  }
  const pairs = switchPairs();
  if (args.includes('--rewritten')) {
    const copied = keepRewritten(names, write, pairs);
    if (write) {
      writeSwitch(pairs);
      execFileSync('node', ['tools/guid-index.js'], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
      console.log(`copied ${copied}; ${SWITCH_ASSET} lists ${pairs.length}`);
    } else console.log('(plan only: --write copies)');
    return;
  }
  const mats = materialsNamed(names);
  let converted = 0;
  for (const m of mats) {
    // Unity writes LF, but some files came from Windows with CRLF: read as LF, written as found.
    const raw = fs.readFileSync(abs(m.path), 'utf8');
    const eol = raw.includes('\r\n') ? t => t.replace(/\n/g, '\r\n') : t => t;
    const text = raw.replace(/\r\n/g, '\n');
    const p = plan(text);
    console.log(`${m.name} (${m.path}): ${p.from} → ${p.to ? 'Canopy/' + p.to : 'not converted: ' + p.blocked}`);
    for (const [kind, name, v] of p.edits) console.log(`  ${name} = ${kind === 'tex' ? (v ? `${v.guid} tiling ${v.scale.map(num).join(' ')} offset ${v.offset.map(num).join(' ')}` : 'none') : Array.isArray(v) ? v.map(num).join(' ') : num(v)}`);
    for (const w of p.warnings) console.log(`  warning: ${w}`);
    if (!write || !p.to) continue;
    switchDir();
    // the copy as it was: named for the material, its folder's name added if two share a name
    const clash = mats.some(o => o !== m && o.name === m.name) || fs.existsSync(abs(`${SWITCH_DIR}/${m.name} (Unity).mat`));
    const copyName = `${m.name}${clash ? ' ' + path.basename(path.dirname(m.path)) : ''} (Unity)`;
    const copy = `${SWITCH_DIR}/${copyName}.mat`;
    if (fs.existsSync(abs(copy))) throw new Error(`${copy} already exists`);
    writeNew(copy, eol(text.replace(/\n {2}m_Name: .*\n/, `\n  m_Name: ${copyName}\n`)), META.mat);
    fs.writeFileSync(abs(m.path), eol(apply(text, p)));
    if (!pairs.some(([c]) => c === m.guid)) pairs.push([m.guid, guidOfMeta(copy)]);
    converted++;
  }
  if (write && converted) {
    writeSwitch(pairs);
    // layout's guid index: the copies are new files, the converted .mat files changed
    execFileSync('node', ['tools/guid-index.js'], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    console.log(`converted ${converted}; ${SWITCH_ASSET} lists ${pairs.length}`);
  } else if (!write) console.log('(plan only: --write converts)');
}

if (require.main === module) main();
module.exports = { setTweaks, plan, apply, keywordsOf, texOf, floatOf, colorOf, switchPairs, SWITCH_DIR, SWITCH_ASSET };
