// Draws pieces as Unity's shader drew them and as Canopy's draws them, side by side, to check a
// material conversion before Ken sees it in the headset (Claude, 2026-11-06; Ken: switches and
// previews; docs: Rendering Performance, More Lights, phase 3).
//   node tools/material-preview.js <Piece>... [--yaw 30] [--pitch 20] [--size 360] [--sun 1]
//        [--ambient 0.2] [--normal 1] [--highlight 0.2] [--texture 512] [--out /sdcard/Download/preview.png]
// --normal multiplies every normal map's strength, and --highlight sets General's
// _HighlightStrength over the material's, to judge them by eye. --texture shrinks every texture to
// that size, to see one as the game imports it.
// Each piece (a prefab name, as layout's Piece lines name them) is drawn at LOD0 from its prefab's
// parts (tools/scene.js prepare: meshes and textures as layout fetches them), once per side:
//   Unity   a converted material's copy as it was (Resources/ShaderSwitch, tools/convert-materials.js),
//           else the material itself, by Unity's shader: Standard as Unity's BRDF1 (GGX, Smith,
//           Disney diffuse, Fresnel; metallic or specular setup), Mobile and Legacy Diffuse as
//           Lambert, Mobile/Bumped Specular as its Blinn-Phong
//   Canopy  the material on its Canopy shader, or what convert-materials.js would make of it, by
//           CanopyLighting.cginc exactly (ambient, the sun's N·L, General's Blinn highlight)
// Both under the same light: the Sun's angle in Game.unity (70°, 70°), its color times --sun, a flat
// ambient of --ambient (linear gray; the moods keep it at or under 0.2); no fog, no darkening below
// the sea. Standard's reflections are a guess: the ambient color stands in for its reflection
// probe, which the game bakes from its sky. Linear color space, as Canopy renders; drawn at twice
// the size and halved, for smooth edges. It prints each side's mean brightness.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('./unity.js');
const S = require('./scene.js');
const C = require('./convert-materials.js');

const CACHE = path.join(__dirname, '..', 'cache');
const AMBER = '7e3a885cffdd2a2ecd8c158c849adcca'; // Canopy/Amber
const AMBER_SHELL = '94fe7f169d40a851f173913274667caf'; // Canopy/AmberShell
const HIGHLIGHT = process.argv.includes('--highlight') ? +process.argv[process.argv.indexOf('--highlight') + 1] : null;
const NORMAL_TIMES = process.argv.includes('--normal') ? +process.argv[process.argv.indexOf('--normal') + 1] : 1;
const TEXTURE_LIMIT = process.argv.includes('--texture') ? +process.argv[process.argv.indexOf('--texture') + 1] : null;
const BUILTIN = '0000000000000000f000000000000000';

// ---------- small vector math ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const saturate = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

// ---------- textures ----------
const textures = new Map();
// A cached texture (cache/textures, as layout stores them) as RGBA bytes.
function texture(file) {
  if (!textures.has(file)) {
    const limit = TEXTURE_LIMIT ? ['-resize', `${TEXTURE_LIMIT}x${TEXTURE_LIMIT}>`] : [];
    const [w, h] = execFileSync('magick', [file + '[0]', ...limit, '-format', '%w %h', 'info:']).toString().trim().split(' ').map(Number);
    const data = execFileSync('magick', [file + '[0]', ...limit, '-depth', '8', 'rgba:-'], { maxBuffer: 1 << 28 });
    textures.set(file, { w, h, data });
  }
  return textures.get(file);
}
// Bilinear, repeating, Unity's v up; out: [r, g, b, a] in 0..1 (sRGB bytes as read; srgb: made linear).
function sample(t, u, v, srgb, out) {
  const x = (u - Math.floor(u)) * t.w - 0.5, y = (1 - (v - Math.floor(v))) * t.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => (((yy % t.h) + t.h) % t.h * t.w + (((xx % t.w) + t.w) % t.w)) * 4;
  const i00 = at(x0, y0), i10 = at(x0 + 1, y0), i01 = at(x0, y0 + 1), i11 = at(x0 + 1, y0 + 1);
  for (let c = 0; c < 4; c++) {
    const f = srgb && c < 3 ? i => LINEAR[t.data[i + c]] : i => t.data[i + c] / 255;
    out[c] = (f(i00) * (1 - fx) + f(i10) * fx) * (1 - fy) + (f(i01) * (1 - fx) + f(i11) * fx) * fy;
  }
  return out;
}

// ---------- meshes ----------
// A cached OBJ (X negated from Unity) as Unity-space corners placed by M (row-major), with
// tangents from the uvs, as the shaders' TANGENT (w: the bitangent's side, cross(N, T) · B).
function placedMesh(file, M) {
  const vs = [], vts = [], vns = [], faces = [];
  let submeshes = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.split(/\s+/);
    if (t[0] === '#' && t[1] === 'submeshes') submeshes = t.slice(2).filter(Boolean).map(Number);
    if (t[0] === 'v') vs.push([-t[1], +t[2], +t[3]]);
    else if (t[0] === 'vt') vts.push([+t[1], +t[2]]);
    else if (t[0] === 'vn') vns.push([-t[1], +t[2], +t[3]]);
    else if (t[0] === 'f') {
      const c = t.slice(1).filter(Boolean).map(k => k.split('/').map(n => (n ? +n - 1 : -1)));
      for (let i = 1; i < c.length - 1; i++) faces.push([c[0], c[i], c[i + 1]]);
    }
  }
  const P = p => [0, 1, 2].map(r => M[r * 4] * p[0] + M[r * 4 + 1] * p[1] + M[r * 4 + 2] * p[2] + M[r * 4 + 3]);
  const N = n => norm([0, 1, 2].map(r => M[r * 4] * n[0] + M[r * 4 + 1] * n[1] + M[r * 4 + 2] * n[2]));
  const keyOf = c => c.join('/');
  const corners = new Map(); // key -> { p, uv, n, t: [], b: [] }
  const tris = [];
  for (const f of faces) {
    const cs = f.map(c => {
      const k = keyOf(c);
      if (!corners.has(k)) corners.set(k, { p: P(vs[c[0]]), uv: c[1] >= 0 ? vts[c[1]] : [0, 0], n: c[2] >= 0 ? N(vns[c[2]]) : null, t: [0, 0, 0], b: [0, 0, 0] });
      return corners.get(k);
    });
    const e1 = sub(cs[1].p, cs[0].p), e2 = sub(cs[2].p, cs[0].p);
    const fn = norm(cross(e1, e2));
    for (const c of cs) if (!c.n) c.n = fn;
    const du1 = cs[1].uv[0] - cs[0].uv[0], dv1 = cs[1].uv[1] - cs[0].uv[1], du2 = cs[2].uv[0] - cs[0].uv[0], dv2 = cs[2].uv[1] - cs[0].uv[1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) > 1e-12) {
      const r = 1 / det;
      const T = [0, 1, 2].map(a => (e1[a] * dv2 - e2[a] * dv1) * r), B = [0, 1, 2].map(a => (e2[a] * du1 - e1[a] * du2) * r);
      for (const c of cs) for (let a = 0; a < 3; a++) {
        c.t[a] += T[a];
        c.b[a] += B[a];
      }
    }
    // which submesh it's in: faces come in submesh order
    let slot = 0, past = 0;
    while (slot < submeshes.length && tris.length >= past + submeshes[slot]) past += submeshes[slot++];
    cs.submesh = slot;
    tris.push(cs);
  }
  for (const c of corners.values()) {
    let t = sub(c.t, c.n.map(x => x * dot(c.n, c.t)));
    if (Math.hypot(...t) < 1e-9) t = Math.abs(c.n[0]) < 0.9 ? cross(c.n, [1, 0, 0]) : cross(c.n, [0, 1, 0]);
    c.t = norm(t);
    c.w = dot(cross(c.n, c.t), c.b) < 0 ? -1 : 1;
  }
  return tris;
}

// ---------- the two looks ----------
// A side's look from a .mat's text: how it shades, its colors and maps.
function lookOf(text, files) {
  const sh = /\n {2}m_Shader: \{fileID: (-?\d+), guid: (\w+)/.exec(text) || [];
  const id = sh[2] === BUILTIN ? +sh[1] : null;
  if (sh[2] === AMBER) return amberLook(text, files);
  if (sh[2] === AMBER_SHELL) return { ...amberLook(text, files), name: 'Canopy/AmberShell', model: 'amberShell', body: C.floatOf(text, '_Body') ?? 0.5 };
  const kw = C.keywordsOf(text);
  const tex = name => {
    const t = C.texOf(text, name);
    return t && files[t.guid] ? { ...files[t.guid], scale: t.scale, offset: t.offset } : null;
  };
  const col = (name, d) => (C.colorOf(text, name) || d).map((v, i) => (i < 3 ? toLinear(v) : v));
  const f = (name, d) => C.floatOf(text, name) ?? d;
  const main = tex('_MainTex');
  const st = main ? { scale: main.scale, offset: main.offset } : { scale: [1, 1], offset: [0, 0] };
  const withSt = t => (t ? { ...t, ...st } : null); // Standard and Mobile tile every map by _MainTex's
  const canopy = { 'Canopy/General': '70f970fb0365c514d978918d4586c7ae', 'Canopy/GeneralCutout': 'ebe22678b5768a3488ab42da883139af', 'Canopy/GlowLit': 'f84c73360c4fffcacea53c6a90b2506d' };
  // Canopy's glow surface shaders (lit by Unity's Standard), drawn on the Unity side
  const surfaces = { 'Canopy/GeneralGlowUsingDetailTwo': '102cf4af2823f2a4883bbb80150a5116', 'Canopy/GeneralGlowUsingDetail': '39fa458f5d1f0cd409d779f60fa76275', 'Canopy/GlowSurface': '83243daf621a86b47a39a75ae04431c2', 'Canopy/NoFogEmissiveLight': '034d503d9b0ef10459bd8ba620aa069e' };
  const surface = Object.keys(surfaces).find(k => surfaces[k] === sh[2]);
  const name = id !== null ? { 7: 'Legacy Diffuse', 45: 'Standard (Specular setup)', 46: 'Standard', 10703: 'Mobile/Diffuse', 10704: 'Mobile/Bumped Diffuse', 10705: 'Mobile/Bumped Specular' }[id] : surface || Object.keys(canopy).find(k => canopy[k] === sh[2]);
  if (!name) throw new Error(`a shader this can't draw (${sh[1]}, ${sh[2]})`);
  const look = { name, main, cutoff: null, emission: null, glow: null };
  // Standard's emission, by its keyword, and GlowLit's constant glow, by its color: the color times
  // the map (white without one) at _MainTex's tiling.
  const emits = id === 45 || id === 46 ? kw.includes('_EMISSION') : name === 'Canopy/GlowLit';
  const emission = col('_EmissionColor', [0, 0, 0, 1]);
  if (emits && emission.slice(0, 3).some(v => v > 0)) look.emission = { color: emission, map: withSt(tex('_EmissionMap')) };
  // A thresholded glow (GlowLit's, and the surface shaders' it replaces): where the glow texture's
  // average (mode 1: brightest channel) is over the threshold, its color squared × tint ×
  // brightness / fog level, no highlight, and (mode 1) no lit color. The game's glow fade is 1.
  const glow = (t, tint, mode, fogLevel) => (t ? { tex: t, tint: tint.slice(0, 3), threshold: f('_GlowThreshold', 0.5), brightness: f('_GlowBrightness', 100), fogLevel, mode } : null);
  if (name === 'Canopy/GlowLit') look.glow = glow(tex('_GlowTex'), col('_GlowTint', [0.5, 0.5, 0.5, 1]), f('_GlowMode', 0), f('_GlowFogLevel', 1));
  if (surface) {
    const two = surface === 'Canopy/GeneralGlowUsingDetailTwo', detailGlow = surface === 'Canopy/GeneralGlowUsingDetail';
    const tint = col('_Tint', [0.5, 0.5, 0.5, 1]).map((v, i) => (i < 3 ? v * f('_Brightness', 1) : v));
    const standard = { model: 'standard', metallic: two ? f('_Metallic', 0) : 0, specColor: null, highlights: true, normalScale: f('_NormalStrength', 1) };
    if (two || detailGlow) {
      Object.assign(look, standard, { color: tint, detail: two ? tex('_DetailTex') : null, normal: tex('_NormalMap'), smoothness: two ? 0 : f('_Glossiness', 0.5) });
      look.glow = glow(tex(two ? '_GlowTex' : '_DetailTex'), col('_GlowTint', [0.5, 0.5, 0.5, 1]), 0, f('_GlowFogLevel', 1));
    } else if (surface === 'Canopy/GlowSurface') {
      Object.assign(look, standard, { color: [1, 1, 1, 1], normal: tex('_NormalMap'), smoothness: f('_Glossiness', 0.5) });
      look.glow = glow(main, [1, 1, 1], 1, 1);
    } else {
      const color = col('_Color', [1, 1, 1, 1]);
      Object.assign(look, standard, { main: null, color, normal: tex('_BumpMap'), normalScale: 1, smoothness: f('_Glossiness', 0.5) });
      look.emission = { color: color.map((v, i) => v * emission[i]), map: null };
    }
    return look;
  }
  if (id === 45 || id === 46) {
    const mode = f('_Mode', 0);
    Object.assign(look, {
      model: 'standard', color: col('_Color', [1, 1, 1, 1]), normal: kw.includes('_NORMALMAP') ? withSt(tex('_BumpMap')) : null,
      normalScale: f('_BumpScale', 1), smoothness: f('_Glossiness', 0.5), metallic: id === 46 ? f('_Metallic', 0) : null,
      specColor: id === 45 ? col('_SpecColor', [0.2, 0.2, 0.2, 1]) : null, highlights: !kw.includes('_SPECULARHIGHLIGHTS_OFF'),
      cutoff: mode === 1 ? f('_Cutoff', 0.5) : null
    });
  } else if (id !== null) {
    Object.assign(look, {
      model: id === 10705 ? 'blinn' : 'lambert', color: id === 7 ? col('_Color', [1, 1, 1, 1]) : [1, 1, 1, 1],
      normal: id === 10704 || id === 10705 ? withSt(tex('_BumpMap')) : null, normalScale: 1, shininess: f('_Shininess', 0.078125)
    });
  } else {
    const detail = tex('_DetailTex');
    Object.assign(look, {
      model: 'general', color: col('_Tint', [0.5, 0.5, 0.5, 1]), brightness: f('_Brightness', 1), normal: tex('_NormalMap'),
      normalScale: f('_NormalStrength', 1) * NORMAL_TIMES, gloss: f('_Glossiness', 0), highlight: HIGHLIGHT ?? f('_HighlightStrength', 0.2), detail, cutoff: name === 'Canopy/GeneralCutout' ? f('_Cutoff', 0.5) : null
    });
  }
  return look;
}
// The lit color of one pixel, linear. n, t: world normal and tangent (normalized), w its side; L
// toward the sun; V toward the eye. Returns null where a cutout drops it. Emission adds after.
function shade(look, uv, n, t, w, L, V, light, tmp) {
  let l = look, glow = null;
  if (look.glow) {
    const g = look.glow;
    const s = sample(texture(g.tex.file), uv[0] * g.tex.scale[0] + g.tex.offset[0], uv[1] * g.tex.scale[1] + g.tex.offset[1], g.tex.srgb ?? true, tmp).slice(0, 3);
    const level = g.mode ? Math.max(...s) : (s[0] + s[1] + s[2]) / 3;
    if (level > g.threshold) {
      glow = s.map((v, c) => v * v * g.tint[c] * g.brightness / g.fogLevel);
      l = { ...look, gloss: 0, smoothness: 0, color: g.mode ? [0, 0, 0, 1] : look.color };
    }
  }
  let lit = shadeLit(l, uv, n, t, w, L, V, light, tmp);
  if (!lit) return lit;
  if (glow) lit = lit.map((v, c) => v + glow[c]);
  if (!look.emission) return lit;
  const { color, map } = look.emission;
  const m = map ? sample(texture(map.file), uv[0] * map.scale[0] + map.offset[0], uv[1] * map.scale[1] + map.offset[1], map.srgb ?? true, tmp) : [1, 1, 1];
  return lit.map((v, c) => v + color[c] * m[c]);
}
// Canopy/Amber (Assets/Shaders/Amber.shader), its sky a stand-in for the fog color.
function amberLook(text, files) {
  const tex = name => {
    const t = C.texOf(text, name);
    return t && files[t.guid] ? { ...files[t.guid], scale: t.scale, offset: t.offset } : null;
  };
  const f = (name, d) => C.floatOf(text, name) ?? d;
  return { name: 'Canopy/Amber', model: 'amber', main: tex('_MainTex'), normal: tex('_NormalMap'), normalScale: f('_NormalStrength', 1) * NORMAL_TIMES, cutoff: null, emission: null, glow: null, color: [1, 1, 1, 1],
    brightness: f('_Brightness', 1), gloss: f('_Glossiness', 0.9), highlight: HIGHLIGHT ?? f('_HighlightStrength', 1.5), rim: (C.colorOf(text, '_RimColor') || [1, 0.77, 0.16, 1]).map((v, i) => (i < 3 ? toLinear(v) : v)),
    depth: f('_Depth', 0.05), rimReach: f('_RimReach', 1), glowLevel: f('_Glow', 0.55), through: f('_Through', 1.6), reflect: f('_Reflect', 0.3) };
}
function amberLit(look, uv, n, t, w, L, V, light, tmp) {
  const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const sat = x => Math.min(1, Math.max(0, x));
  const b = cross(n, t).map(v => v * w);
  const nv = sat(dot(n, V));
  const here = [...sample(texture(look.main.file), uv[0], uv[1], look.main.srgb, tmp)];
  const thick = nv, edge = 1 - nv;
  const fold = Math.min(Math.min(uv[0], 1 - uv[0], uv[1], 1 - uv[1]) * 2, Math.abs(Math.abs(uv[0] * 2 - 1) + Math.abs(uv[1] * 2 - 1) - 1));
  const reach = sat(fold * 10) * sat(thick * 3);
  const sh = [dot(V, t) / (nv + 0.35), dot(V, b) / (nv + 0.35)];
  const clampUv = x => Math.min(0.999, Math.max(0.001, x));
  const behind = [...sample(texture(look.main.file), clampUv(uv[0] - sh[0] * look.depth * reach), clampUv(uv[1] - sh[1] * look.depth * reach), look.main.srgb, tmp)];
  const inside = [0, 1, 2].map(c => here[c] + (behind[c] - here[c]) * 0.65);
  const k = sat(edge * edge * edge * (1.2 - thick) * look.rimReach);
  const color = inside.map((v, c) => v + (look.rim[c] - v) * k);
  const bent = norm([0, 1, 2].map(a => L[a] + n[a] * 0.35));
  const toward = Math.pow(sat(-dot(V, bent)), 4), gathered = sat(-dot(n, L));
  const s = sample(texture(look.normal.file), uv[0], uv[1], look.normal.srgb ?? false, tmp);
  const x = (s[0] * 2 - 1) * look.normalScale, y = (s[1] * 2 - 1) * look.normalScale, z = s[2] * 2 - 1;
  const N = norm([0, 1, 2].map(a => x * t[a] + y * b[a] + z * n[a]));
  const nl = Math.max(dot(N, L), 0), H = norm([0, 1, 2].map(a => L[a] + V[a])), nh = Math.max(dot(N, H), 0);
  const n8 = Math.pow(nh, 8), n64 = Math.pow(nh, 64), spec = (n8 + (n64 - n8) * look.gloss) * look.highlight * look.gloss;
  const dv = dot(V, N), R = [0, 1, 2].map(a => 2 * dv * N[a] - V[a]);
  const sky = smooth(0.45, 0.85, R[1]), fresnel = 0.04 + 0.96 * Math.pow(edge, 5);
  const { sun, ambient } = light;
  return [0, 1, 2].map(c => {
    const lit = look.glowLevel * (ambient[c] + 0.5 * sun[c]) + look.through * sun[c] * (toward * (1.15 - thick) + 0.35 * gathered * (1 - 0.5 * thick));
    const albedo = color[c] * 0.55 * look.brightness;
    return ambient[c] * albedo + nl * sun[c] * albedo + spec * sun[c] + color[c] * lit * look.brightness + ([0.6, 0.7, 0.85][c] + 0.3) * (0.3 + color[c]) * sky * look.reflect * (0.25 + fresnel);
  });
}
// Canopy/AmberShell: premultiplied, its alpha fourth.
function amberShellLit(look, uv, n, t, w, L, V, light, tmp) {
  const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const sat = x => Math.min(1, Math.max(0, x));
  const b = cross(n, t).map(v => v * w);
  const nv = sat(dot(n, V)), edge = 1 - nv;
  const here = [...sample(texture(look.main.file), uv[0], uv[1], look.main.srgb, tmp)];
  const thick = nv;
  const alpha = look.body + (1 - look.body) * edge * edge;
  const k = sat(edge * edge * edge * (1.2 - thick));
  const color = [0, 1, 2].map(c => here[c] + (look.rim[c] - here[c]) * k);
  const bent = norm([0, 1, 2].map(a => L[a] + n[a] * 0.35));
  const toward = Math.pow(sat(-dot(V, bent)), 4), gathered = sat(-dot(n, L));
  const s = sample(texture(look.normal.file), uv[0], uv[1], look.normal.srgb ?? false, tmp);
  const x = (s[0] * 2 - 1) * look.normalScale, y = (s[1] * 2 - 1) * look.normalScale, z = s[2] * 2 - 1;
  const N = norm([0, 1, 2].map(a => x * t[a] + y * b[a] + z * n[a]));
  const nl = Math.max(dot(N, L), 0), H = norm([0, 1, 2].map(a => L[a] + V[a])), nh = Math.max(dot(N, H), 0);
  const n8 = Math.pow(nh, 8), n64 = Math.pow(nh, 64), spec = (n8 + (n64 - n8) * look.gloss) * look.highlight * look.gloss;
  const dv = dot(V, N), R = [0, 1, 2].map(a => 2 * dv * N[a] - V[a]);
  const sky = smooth(0.45, 0.85, R[1]), fresnel = 0.04 + 0.96 * Math.pow(edge, 5);
  const { sun, ambient } = light;
  const rgb = [0, 1, 2].map(c => {
    const lit = look.glowLevel * (ambient[c] + 0.5 * sun[c]) + look.through * sun[c] * (toward * (1.15 - thick) + 0.35 * gathered * (1 - 0.5 * thick));
    const albedo = color[c] * 0.55 * look.brightness * alpha;
    return ambient[c] * albedo + nl * sun[c] * albedo + spec * sun[c] + color[c] * lit * look.brightness * alpha + ([0.6, 0.7, 0.85][c] + 0.3) * (0.3 + color[c]) * sky * look.reflect * (0.25 + fresnel);
  });
  return [...rgb, alpha];
}
function shadeLit(look, uv, n, t, w, L, V, light, tmp) {
  if (look.model === 'amber') return amberLit(look, uv, n, t, w, L, V, light, tmp);
  if (look.model === 'amberShell') return amberShellLit(look, uv, n, t, w, L, V, light, tmp);
  const albedo = [1, 1, 1];
  let alpha = 1;
  if (look.main) {
    const m = sample(texture(look.main.file), uv[0] * look.main.scale[0] + look.main.offset[0], uv[1] * look.main.scale[1] + look.main.offset[1], look.main.srgb ?? true, tmp);
    albedo[0] = m[0];
    albedo[1] = m[1];
    albedo[2] = m[2];
    alpha = m[3];
  }
  if (look.detail) {
    const d = sample(texture(look.detail.file), uv[0] * look.detail.scale[0] + look.detail.offset[0], uv[1] * look.detail.scale[1] + look.detail.offset[1], look.detail.srgb ?? true, tmp);
    for (let c = 0; c < 3; c++) albedo[c] *= d[c];
  }
  const k = look.model === 'general' ? look.brightness : 1;
  for (let c = 0; c < 3; c++) albedo[c] *= look.color[c] * k;
  if (look.cutoff !== null && alpha * (look.model === 'general' ? 1 : look.color[3]) < look.cutoff) return null;
  let N = n;
  if (look.normal) {
    const s = sample(texture(look.normal.file), uv[0] * look.normal.scale[0] + look.normal.offset[0], uv[1] * look.normal.scale[1] + look.normal.offset[1], look.normal.srgb ?? false, tmp);
    const x = (s[0] * 2 - 1) * look.normalScale, y = (s[1] * 2 - 1) * look.normalScale, z = s[2] * 2 - 1;
    const b = cross(n, t).map(v => v * w);
    N = norm([0, 1, 2].map(a => x * t[a] + y * b[a] + z * n[a]));
  }
  const nl = Math.max(dot(N, L), 0);
  const H = norm([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
  const nh = Math.max(dot(N, H), 0);
  const { sun, ambient } = light;
  if (look.model === 'general') {
    // CanopyLighting.cginc's CanopyLight
    const n8 = Math.pow(nh, 8), n64 = Math.pow(nh, 64);
    const spec = look.gloss === 0 ? 0 : (n8 + (n64 - n8) * look.gloss) * look.highlight * look.gloss;
    return [0, 1, 2].map(c => ambient[c] * albedo[c] + nl * sun[c] * albedo[c] + spec * sun[c]);
  }
  if (look.model === 'lambert') return [0, 1, 2].map(c => albedo[c] * (ambient[c] + sun[c] * nl));
  if (look.model === 'blinn') {
    // Mobile/Bumped Specular: MobileBlinnPhong, its gloss the texture's alpha
    const spec = Math.pow(nh, look.shininess * 128) * alpha;
    return [0, 1, 2].map(c => albedo[c] * (ambient[c] + sun[c] * nl) + sun[c] * spec * (nl > 0 ? 1 : 0));
  }
  // Standard: UnityStandardBRDF.cginc BRDF1_Unity_PBS, metallic or specular setup
  let specColor, oneMinusReflectivity;
  if (look.metallic !== null) {
    specColor = albedo.map(a => 0.04 + (a - 0.04) * look.metallic);
    oneMinusReflectivity = 0.96 - look.metallic * 0.96;
  } else {
    specColor = look.specColor.slice(0, 3);
    oneMinusReflectivity = 1 - Math.max(...specColor);
  }
  const diffColor = albedo.map(a => a * oneMinusReflectivity);
  const smooth = look.smoothness, pr = 1 - smooth;
  const nv = Math.abs(dot(N, V)), lh = saturate(dot(L, H));
  const fd90 = 0.5 + 2 * lh * lh * pr;
  const pow5 = x => x * x * x * x * x;
  const diffuseTerm = (1 + (fd90 - 1) * pow5(1 - nl)) * (1 + (fd90 - 1) * pow5(1 - nv)) * nl;
  const r = Math.max(pr * pr, 0.002);
  const vis = 0.5 / (nl * (nv * (1 - r) + r) + nv * (nl * (1 - r) + r) + 1e-5);
  const a2 = r * r, d = (nh * a2 - nh) * nh + 1;
  const D = a2 / Math.PI / (d * d + 1e-7);
  const specTerm = look.highlights && specColor.some(v => v > 0) ? Math.max(0, vis * D * Math.PI * nl) : 0;
  const surfaceReduction = 1 / (r * r + 1);
  const grazing = saturate(smooth + (1 - oneMinusReflectivity));
  return [0, 1, 2].map(c => diffColor[c] * (ambient[c] + sun[c] * diffuseTerm)
    + specTerm * sun[c] * (specColor[c] + (1 - specColor[c]) * pow5(1 - lh))
    + surfaceReduction * ambient[c] * (specColor[c] + (grazing - specColor[c]) * pow5(1 - nv)));
}

// ---------- drawing ----------
// The pixels of the triangles seen (orthographic, framed to fit): per pixel its triangle and
// barycentric weights, nearest first; back faces (by their normals) culled, as Unity culls.
function rasterize(tris, size, yaw, pitch, framing = tris) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const F = [-sy * cp, -sp, -cy * cp]; // where the eye looks (yaw 0: along -Z, at a piece's front)
  const R = norm(cross([0, 1, 0], F)), Up = cross(F, R); // Unity's left-handed cross
  const V = F.map(x => -x);
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const tri of framing) for (const c of tri) {
    const x = dot(c.p, R), y = dot(c.p, Up);
    lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
    hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
  }
  const k = (size * 0.9) / Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6);
  const mx = (lo[0] + hi[0]) / 2, my = (lo[1] + hi[1]) / 2;
  const depth = new Float32Array(size * size).fill(Infinity), id = new Int32Array(size * size).fill(-1);
  const b1 = new Float32Array(size * size), b2 = new Float32Array(size * size);
  tris.forEach((tri, ti) => {
    if (dot(norm([0, 1, 2].map(a => tri[0].n[a] + tri[1].n[a] + tri[2].n[a])), V) <= 0) return;
    const s = tri.map(c => [(dot(c.p, R) - mx) * k + size / 2, size / 2 - (dot(c.p, Up) - my) * k, dot(c.p, F)]);
    const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
    if (Math.abs(area) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((px - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (py - s[0][1])) / area;
      const w2 = ((s[1][0] - s[0][0]) * (py - s[0][1]) - (px - s[0][0]) * (s[1][1] - s[0][1])) / area;
      if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
      const z = s[0][2] + (s[1][2] - s[0][2]) * w1 + (s[2][2] - s[0][2]) * w2;
      const i = y * size + x;
      if (z >= depth[i]) continue;
      depth[i] = z;
      id[i] = ti;
      b1[i] = w1;
      b2[i] = w2;
    }
  });
  return { id, b1, b2, V };
}
// One side drawn: RGB bytes (sRGB), the mean brightness of the piece's pixels.
function draw(tris, looks, g, size, light, cutoutPass, under = null) {
  const out = Buffer.alloc(size * size * 3), linear = new Float32Array(size * size * 3);
  const bg = [0.18, 0.2, 0.22];
  let sum = 0, count = 0;
  const tmp = [0, 0, 0, 0];
  for (let i = 0; i < size * size; i++) {
    let c = under ? [under[i * 3], under[i * 3 + 1], under[i * 3 + 2]] : bg; // a blended pass: what it blends over
    const ti = g.id[i];
    if (ti >= 0) {
      const tri = tris[ti], w1 = g.b1[i], w2 = g.b2[i], w0 = 1 - w1 - w2;
      const lerp = key => [0, 1, 2].map(a => tri[0][key][a] * w0 + tri[1][key][a] * w1 + tri[2][key][a] * w2);
      const uv = [0, 1].map(a => tri[0].uv[a] * w0 + tri[1].uv[a] * w1 + tri[2].uv[a] * w2);
      const lit = shade(looks[tri.part], uv, norm(lerp('n')), norm(lerp('t')), tri[0].w, light.L, g.V, light, tmp);
      if (lit) {
        c = lit.length === 4 ? [0, 1, 2].map(a => lit[a] + (1 - lit[3]) * c[a]) : lit;
        sum += 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        count++;
      } else cutoutPass.dropped++;
    }
    for (let a = 0; a < 3; a++) {
      linear[i * 3 + a] = c[a];
      out[i * 3 + a] = Math.round(saturate(toSrgb(saturate(c[a]))) * 255);
    }
  }
  return { rgb: out, mean: count ? sum / count : 0, linear };
}

// ---------- pieces ----------
// A piece's LOD0 parts, each with its two looks.
function pieceParts(name) {
  const { library, materials, problems } = S.prepare([name]);
  const entry = library[name];
  if (!entry) throw new Error(`${name}: no such piece (${problems.join('; ')})`);
  const pairs = new Map(C.switchPairs());
  const idx = U.index();
  const parts = [];
  // a mesh with several materials: each slot draws its own submesh
  const drawn = entry.parts.flatMap(p => (p.materials ? [p.material, ...p.materials.slice(1)].map((material, slot) => ({ ...p, material, slot })) : [p]));
  for (const part of drawn) {
    if (part.off || !part.obj || U.isLodBeyondZero(part.mesh.name || '')) continue;
    const d = part.material && materials[part.material];
    if (!d) continue;
    const files = {};
    // each with whether Unity decodes it from sRGB (its import setting; unknown, by its slot)
    for (const slot of ['map', 'normal', 'detail', 'emission', 'glow']) if (d[slot] && d[slot].url) files[d[slot].guid] = { file: path.join(CACHE, d[slot].url), srgb: d[slot].srgb };
    const read = g => fs.readFileSync(path.join(U.REPO, idx[g].path), 'utf8').replace(/\r\n/g, '\n');
    const now = read(part.material);
    let unity = now, canopy = now, note = '';
    if (pairs.has(part.material)) {
      unity = read(pairs.get(part.material));
      // the copy's maps may not be fetched yet: the converted material names the same textures
      const extra = S.shapeMaterials([pairs.get(part.material)], []);
      const e = extra[pairs.get(part.material)];
      for (const slot of ['map', 'normal', 'detail', 'emission', 'glow']) if (e && e[slot] && e[slot].url) files[e[slot].guid] = { file: path.join(CACHE, e[slot].url), srgb: e[slot].srgb };
    } else {
      const p = C.plan(now);
      if (p.to) {
        canopy = C.apply(now, p);
        note = ' (planned)';
      } else if (!/Canopy/.test(p.blocked || '')) note = ` (not converted: ${p.blocked})`;
    }
    const mat = path.basename(idx[part.material].path, '.mat');
    try {
      parts.push({ part, unity: lookOf(unity, files), canopy: lookOf(canopy, files), name: mat, note });
    } catch (error) {
      console.warn(`${name}: ${mat} left out: ${error.message}`); // a shader this can't draw
    }
  }
  return parts;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => {
    const i = args.indexOf('--' + k);
    return i >= 0 ? args[i + 1] : d;
  };
  const values = new Set(['--yaw', '--pitch', '--size', '--sun', '--ambient', '--normal', '--highlight', '--texture', '--out'].flatMap(k => [args.indexOf(k) + 1]).filter(i => i > 0));
  const names = args.filter((a, i) => !a.startsWith('--') && !values.has(i));
  if (!names.length) {
    console.error('usage: node tools/material-preview.js <Piece>... [--yaw 30] [--pitch 20] [--size 360] [--sun 1] [--ambient 0.2] [--normal 1] [--highlight 0.2] [--out file.png]');
    process.exit(2);
  }
  const size = +opt('size', 360), big = size * 2;
  const yaw = (+opt('yaw', 30) * Math.PI) / 180, pitch = (+opt('pitch', 20) * Math.PI) / 180;
  const out = opt('out', '/sdcard/Download/preview.png');
  // Game.unity's Sun: euler (70, 70, 0), its color (sRGB, made linear) times --sun; L toward it
  const ex = (70 * Math.PI) / 180, ey = (70 * Math.PI) / 180;
  const forward = [Math.cos(ex) * Math.sin(ey), -Math.sin(ex), Math.cos(ex) * Math.cos(ey)];
  const sunColor = [1, 0.95686275, 0.8392157].map(toLinear).map(v => v * +opt('sun', 1));
  const light = { L: forward.map(x => -x), sun: sunColor, ambient: [1, 1, 1].map(() => +opt('ambient', 0.2)) };
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'matpreview-'));
  const rows = [];
  try {
    for (const name of names) {
      const parts = pieceParts(name);
      if (!parts.length) throw new Error(`${name}: no drawn LOD0 parts with materials`);
      const tris = [];
      parts.forEach((p, pi) => {
        const placed = placedMesh(path.join(CACHE, p.part.obj.replace(/\?.*$/, '')), p.part.m);
        const last = Math.max(...placed.map(tri => tri.submesh)); // a slot past it draws the last one again
        for (const tri of placed) {
          if (p.part.slot !== undefined && tri.submesh !== Math.min(p.part.slot, last)) continue;
          tri.part = pi;
          tris.push(tri);
        }
      });
      // what blends goes over the rest: two passes, framed alike
      const blends = tri => parts[tri.part].canopy.model === 'amberShell';
      const solid = tris.filter(t => !blends(t)), clear = tris.filter(blends);
      const g = rasterize(solid, big, yaw, pitch, tris), gClear = clear.length ? rasterize(clear, big, yaw, pitch, tris) : null;
      const sides = [];
      for (const side of ['unity', 'canopy']) {
        const looks = parts.map(p => p[side]);
        const dropped = { dropped: 0 };
        const base = draw(solid, looks, g, big, light, dropped);
        const { rgb, mean } = gClear ? draw(clear, looks, gClear, big, light, dropped, base.linear) : base;
        const raw = path.join(tmpDir, `${rows.length}-${side}.rgb`);
        fs.writeFileSync(raw, rgb);
        const label = `${name}: ${[...new Set(looks.map(l => l.name))].join(', ')}`;
        const png = path.join(tmpDir, `${rows.length}-${side}.png`);
        execFileSync('magick', ['-size', `${big}x${big}`, '-depth', '8', 'rgb:' + raw, '-resize', '50%', '-gravity', 'north', '-fill', 'white', '-pointsize', String(Math.max(12, Math.round(size / 24))), '-annotate', '+0+6', label, png]);
        sides.push(png);
        console.log(`${name} ${side === 'unity' ? 'Unity ' : 'Canopy'}: ${parts.map(p => p.name + p.note).filter((v, i, a) => a.indexOf(v) === i).join(', ')}; mean brightness ${mean.toFixed(3)} (linear)`);
      }
      const row = path.join(tmpDir, `row${rows.length}.png`);
      execFileSync('magick', [...sides, '+append', row]);
      rows.push(row);
    }
    execFileSync('magick', [...rows, '-append', out]);
    console.log(`wrote ${out}: Unity's on the left, Canopy's on the right`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { lookOf, shade };
