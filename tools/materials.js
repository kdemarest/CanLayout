// Material analysis for Canopy's rendering cost (docs: Rendering Performance): every material,
// its shader, and what they do on the GPU, plus which prefabs and scenes use each one.
//   node tools/materials.js                 summary
//   node tools/materials.js <name>          one material or shader's findings
//   node tools/materials.js --json          every finding, as JSON
// The raw text of every .mat, .shader and texture .meta is kept in cache/canopy-sources.json, by
// blob, so each is read (or fetched, when the partial clone lacks it) once ever, and the store is
// one file on this slow storage. cache/material-analysis.json keeps the analysis by blob, and each
// prefab's and scene's material guids by its size and time, so a rerun only reads what changed.
// Run tools/guid-index.js first when Canopy changes. Usage counts only prefabs and scenes (the
// sparse checkout's .prefab and .unity files): a material loaded from code, Resources or another
// .asset counts as unused.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./scene.js');

const CACHE_FILE = path.join(__dirname, '..', 'cache', 'material-analysis.json');
const SOURCES_FILE = path.join(__dirname, '..', 'cache', 'canopy-sources.json');
const VERSION = 1; // bump when what is read changes
const GIT = ['--git-dir=' + process.env.HOME + '/git-repos/Canopy.git'];
const BUILTIN = '0000000000000000f000000000000000';
const BUILTIN_NAMES = { 45: 'Standard (Specular setup)', 46: 'Standard' };
const QUEUES = { Background: 1000, Geometry: 2000, AlphaTest: 2450, Transparent: 3000, Overlay: 4000 };
const BLEND = { Zero: 0, One: 1, DstColor: 2, SrcColor: 3, OneMinusDstColor: 4, SrcAlpha: 5, OneMinusSrcColor: 6, DstAlpha: 7, OneMinusDstAlpha: 8, SrcAlphaSaturate: 9, OneMinusSrcAlpha: 10 };

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
const cache = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === VERSION) return c;
  } catch {
    // none yet
  }
  return { version: VERSION, shaders: {}, materials: {}, textures: {}, usage: {} };
})();

// Raw sources by blob: from canopy-sources.json, else read in one batch (scene.js fetches what
// the partial clone lacks) and added to it.
const sources = (() => {
  try {
    return JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  } catch {
    return {};
  }
})();
let sourcesAdded = 0;
function read(blobs) {
  const want = [...new Set(blobs.filter(Boolean))];
  const missing = want.filter(b => !(b in sources));
  if (missing.length) {
    for (const [b, data] of S.blobs(missing)) sources[b] = data.toString();
    sourcesAdded += missing.length;
  }
  return new Map(want.filter(b => b in sources).map(b => [b, sources[b]]));
}

// What a shader does on the GPU, from its source.
function analyzeShader(src) {
  src = src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const code = src.split('\n').map(l => l.replace(/\/\/.*/, '')).join('\n');
  const count = re => (code.match(re) || []).length;
  const queue = /"Queue"\s*=\s*"(\w+)([+-]\d+)?"/.exec(code);
  const blends = [...code.matchAll(/^\s*Blend\s+(\S+)(?:\s+(\S+))?/gm)].map(m => [m[1], m[2] || '']);
  const zwrite = [...code.matchAll(/^\s*ZWrite\s+(\S+)/gm)].map(m => m[1]);
  const surface = /#pragma\s+surface\b/.test(code);
  const fog = /_FogDensitySquared|_FogDensity\b/.test(code) ? 'canopy' : /UNITY_APPLY_FOG|multi_compile_fog/.test(code) || (surface && !/\bnofog\b/.test(code)) ? 'unity' : 'none';
  return {
    name: (/^\s*Shader\s+"([^"]+)"/m.exec(code) || [])[1] || '',
    queue: queue ? (QUEUES[queue[1]] ?? 2000) + +(queue[2] || 0) : 2000,
    blends, // [src, dst] per pass; [_SrcBlend] style names a material property
    zwrite,
    clip: /\bclip\s*\(|\bdiscard\b|alphatest:/.test(code),
    surface,
    fog,
    fogLevel: /_FogLevel/.test(code), // a property that weakens the fog
    dims: /_DimAltitude/.test(code), // darkens below the sea
    stereo: surface || /UNITY_VERTEX_OUTPUT_STEREO/.test(code), // ready for Multiview
    passes: count(/^\s*Pass\b/gm) || 1,
    textureReads: count(/\b(tex2D\w*|texCUBE\w*|tex2Dlod|UNITY_SAMPLE_TEX\w*)\s*\(/g),
    pow: count(/\bpow\s*\(/g),
    trig: count(/\b(sin|cos|tan|sincos)\s*\(/g)
  };
}

// What the analysis needs from a .mat: its shader, queue, floats, colors and textures.
function analyzeMaterial(text) {
  text = text.replace(/\r\n/g, '\n');
  const shader = /m_Shader: \{fileID: (-?\d+)(?:, guid: ([0-9a-f]+))?/.exec(text) || [];
  const textures = {};
  for (const m of text.matchAll(/- (\w+):\n\s+m_Texture: \{fileID: (-?\d+)(?:, guid: ([0-9a-f]+))?/g)) if (m[3] && m[2] !== '0') textures[m[1]] = m[3];
  return {
    name: (/m_Name: (.*)/.exec(text) || [])[1] || '',
    shader: shader[2] || null,
    shaderFileID: shader[1] || null,
    queue: +((/m_CustomRenderQueue: (-?\d+)/.exec(text) || [])[1] ?? -1),
    floats: Object.fromEntries([...text.matchAll(/^\s+- (_\w+): (-?[\d.e+-]+)$/gm)].map(m => [m[1], +m[2]])),
    colors: Object.fromEntries([...text.matchAll(/^\s+- (_\w+): \{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\}$/gm)].map(m => [m[1], m.slice(2, 6).map(Number)])),
    keywords: ((/m_ShaderKeywords: (.*)/.exec(text) || [])[1] || '').trim().split(/\s+/).filter(Boolean),
    textures
  };
}

// A texture's Android size cap, from its .meta (the Android override if set, else the default).
function analyzeTextureMeta(text) {
  text = text.replace(/\r\n/g, '\n');
  const blocks = text.split(/\n\s+- serializedVersion: \d+\n/);
  const android = blocks.find(b => /buildTarget: Android\b/.test(b) && /overridden: 1/.test(b));
  const fallback = blocks.find(b => /buildTarget: DefaultTexturePlatform\b/.test(b)) || text;
  const size = b => +((/maxTextureSize: (\d+)/.exec(b) || [])[1] || 2048);
  return { maxSize: android ? size(android) : size(fallback), android: Boolean(android) };
}

// Which material guids each prefab and scene in the working tree names.
function usage(materialGuids) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(S.REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(prefab|unity)$/.test(e.name)) files.push(rel);
    }
  })('Assets');
  const used = {};
  const seen = new Set();
  for (const rel of files) {
    seen.add(rel);
    const stat = fs.statSync(path.join(S.REPO, rel));
    let entry = cache.usage[rel];
    if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
      const text = fs.readFileSync(path.join(S.REPO, rel), 'utf8');
      entry = cache.usage[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, guids: [...new Set([...text.matchAll(/guid: ([0-9a-f]{32}), type: 2\}/g)].map(m => m[1]))] };
    }
    for (const g of entry.guids) if (materialGuids.has(g)) (used[g] = used[g] || []).push(rel);
  }
  for (const rel of Object.keys(cache.usage)) if (!seen.has(rel)) delete cache.usage[rel];
  return used;
}

function analyze() {
  // No -l: sizes would make the partial clone fetch every blob it lacks, one at a time.
  const tree = execFileSync('git', GIT.concat(['ls-tree', '-r', 'HEAD']), { maxBuffer: 1 << 30 }).toString().trim().split('\n').map(l => {
    const [meta, file] = l.split('\t');
    return { file, blob: meta.split(/\s+/)[2] };
  });
  const byPath = new Map(tree.map(t => [t.file, t]));
  // Uncommitted entries whose file has since gone (the index is rebuilt by tools/guid-index.js).
  const present = e => !e.local || fs.existsSync(path.join(S.REPO, e.path));
  const materials = Object.entries(index).filter(([, e]) => e.path.endsWith('.mat') && present(e));
  // Materials and shaders not yet in the cache.
  const texts = read(materials.map(([, e]) => !cache.materials[e.blob] && e.blob));
  for (const [, e] of materials) if (!cache.materials[e.blob] && texts.get(e.blob)) cache.materials[e.blob] = analyzeMaterial(texts.get(e.blob).toString());
  const shaderGuids = [...new Set(materials.map(([, e]) => cache.materials[e.blob] && cache.materials[e.blob].shader))].filter(g => g && g !== BUILTIN && index[g]);
  const allShaders = Object.entries(index).filter(([, e]) => e.path.endsWith('.shader') && present(e)).map(([g]) => g);
  const shaderTexts = read([...new Set([...shaderGuids, ...allShaders])].map(g => !cache.shaders[index[g].blob] && index[g].blob));
  for (const g of new Set([...shaderGuids, ...allShaders])) {
    const b = index[g].blob;
    if (!cache.shaders[b] && shaderTexts.get(b)) cache.shaders[b] = analyzeShader(shaderTexts.get(b).toString());
  }
  // Texture metas: from the working tree when changed there (the PNGs converted from TIF), else git.
  const textureGuids = new Set(materials.flatMap(([, e]) => Object.values((cache.materials[e.blob] || {}).textures || {})));
  const metaOf = g => {
    const p = index[g] && index[g].path + '.meta';
    if (!p) return null;
    if (index[g].local && fs.existsSync(path.join(S.REPO, p))) return { text: fs.readFileSync(path.join(S.REPO, p), 'utf8') };
    return byPath.get(p) ? { blob: byPath.get(p).blob } : null;
  };
  const metaTexts = read([...textureGuids].map(g => { const m = metaOf(g); return m && m.blob && !cache.textures[m.blob] && m.blob; }));
  const textures = {};
  for (const g of textureGuids) {
    const m = metaOf(g);
    if (!m) continue;
    const found = m.text ? analyzeTextureMeta(m.text) : cache.textures[m.blob] || (metaTexts.get(m.blob) && (cache.textures[m.blob] = analyzeTextureMeta(metaTexts.get(m.blob).toString())));
    // Source size only for textures in the working tree (free to read); git's would fetch them.
    const local = path.join(S.REPO, index[g].path);
    if (found) textures[g] = { path: index[g].path, bytes: fs.existsSync(local) ? fs.statSync(local).size : null, ...found };
  }
  const used = usage(new Set(materials.map(([g]) => g)));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  if (sourcesAdded) fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources));

  // One finding per material.
  const out = [];
  for (const [g, e] of materials) {
    const m = cache.materials[e.blob];
    if (!m) continue;
    const builtin = m.shader === BUILTIN || !m.shader;
    const sh = !builtin && index[m.shader] ? cache.shaders[index[m.shader].blob] : null;
    const queue = m.queue !== -1 ? m.queue : sh ? sh.queue : 2000;
    const blendValue = name => m.floats[name.replace(/[[\]]/g, '')];
    const blended = sh ? sh.blends.some(([src, dst]) => {
      if (/^off$/i.test(src)) return false;
      const s = src.startsWith('[') ? blendValue(src) : BLEND[src], d = dst.startsWith('[') ? blendValue(dst) : BLEND[dst];
      return !(s === 1 && d === 0) && s !== undefined;
    }) : m.floats._Mode >= 2 || m.keywords.some(k => /_ALPHABLEND_ON|_ALPHAPREMULTIPLY_ON/.test(k));
    const clip = sh ? sh.clip : m.floats._Mode === 1 || m.keywords.includes('_ALPHATEST_ON');
    out.push({
      material: e.path,
      guid: g,
      shader: builtin ? `built-in ${BUILTIN_NAMES[m.shaderFileID] || 'fileID ' + m.shaderFileID}` : sh ? `${sh.name} (${index[m.shader].path})` : `missing ${m.shader}`,
      queue,
      blended,
      clip,
      backToFront: queue > 2500 && !blended, // opaque or clipped work Unity sorts as transparent
      fog: sh ? sh.fog : 'unity',
      fogLevel: sh && sh.fogLevel ? m.floats._FogLevel ?? 1 : null,
      dims: sh ? sh.dims : false,
      stereo: sh ? sh.stereo : true,
      textureReads: sh ? sh.textureReads : null,
      pow: sh ? sh.pow : null,
      trig: sh ? sh.trig : null,
      textures: Object.entries(m.textures).map(([slot, t]) => ({ slot, ...(textures[t] || { path: index[t] ? index[t].path : t }) })),
      usedBy: used[g] || []
    });
  }
  const shaders = allShaders.map(g => ({ guid: g, path: index[g].path, ...cache.shaders[index[g].blob], materials: out.filter(f => f.shader.endsWith(`(${index[g].path})`)) }));
  return { materials: out, shaders };
}

function summary({ materials, shaders }) {
  const live = materials.filter(f => f.usedBy.length);
  const list = (title, rows) => {
    console.log(`\n${title} (${rows.length})`);
    for (const r of rows) console.log('  ' + r);
  };
  console.log(`${materials.length} materials (${live.length} used by prefabs or scenes), ${shaders.length} shaders`);
  list('Shaders in use: materials, used materials; flags', shaders.filter(s => s.materials.some(f => f.usedBy.length)).sort((a, b) => b.materials.length - a.materials.length).map(s => {
    const flags = [s.clip && 'clip', s.blends.some(([x]) => !/^off$/i.test(x)) && 'blend', s.surface && 'surface', `fog ${s.fog}`, s.fogLevel && 'fogLevel', s.dims && 'dims', !s.stereo && 'NOT stereo', `${s.textureReads} tex`, s.pow && `${s.pow} pow`, s.trig && `${s.trig} trig`].filter(Boolean).join(', ');
    return `${s.name} ${s.materials.length}/${s.materials.filter(f => f.usedBy.length).length}: ${flags}`;
  }));
  list('Opaque or clipped, but queued above 2500 (sorted back to front), used', live.filter(f => f.backToFront).sort((a, b) => a.queue - b.queue).map(f => `${f.queue} ${path.basename(f.material)}${f.clip ? ' (clip)' : ''}`));
  list('Weak fog (_FogLevel under 1), used', live.filter(f => f.fogLevel !== null && f.fogLevel < 1).map(f => `${f.fogLevel} ${path.basename(f.material)}`));
  list('No fog at all, used', live.filter(f => f.fog === 'none').map(f => `${path.basename(f.material)} (${f.shader.replace(/ \(.*/, '')})`));
  const notStereo = shaders.filter(s => !s.stereo && s.materials.some(f => f.usedBy.length));
  list('Shaders in use without stereo macros (Multiview)', notStereo.map(s => s.path));
  list('Unused shaders (no material)', shaders.filter(s => !s.materials.length).map(s => s.path));
  console.log(`\nUnused materials: ${materials.length - live.length} (see --json; code, Resources or .asset files may still load some)`);
  const seen = new Set();
  const big = live.flatMap(f => f.textures).filter(t => t.maxSize && !seen.has(t.path) && seen.add(t.path)).sort((a, b) => b.maxSize - a.maxSize).slice(0, 15);
  list('Largest textures in use (Android size cap)', big.map(t => `${t.maxSize}${t.android ? ' (Android)' : ''} ${t.path}`));
}

if (require.main === module) {
  const arg = process.argv[2];
  const found = analyze();
  if (arg === '--json') console.log(JSON.stringify(found, null, 1));
  else if (arg) {
    const hit = [...found.materials.filter(f => path.basename(f.material, '.mat').toLowerCase() === arg.toLowerCase()), ...found.shaders.filter(s => s.name.toLowerCase() === arg.toLowerCase() || path.basename(s.path, '.shader').toLowerCase() === arg.toLowerCase()).map(s => ({ ...s, materials: s.materials.map(f => `${f.material}${f.usedBy.length ? ` (${f.usedBy.length} uses)` : ' (unused)'}`) }))];
    console.log(hit.length ? JSON.stringify(hit, null, 1) : `no material or shader named ${arg}`);
  } else summary(found);
}

module.exports = { analyze, analyzeShader, analyzeMaterial };
