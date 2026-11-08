// Compiles Canopy's own shaders as Unity would for the Quest, so a mistake shows before Unity is
// opened (Claude, 2026-11-06; Ken: a compiler for the shader conversion, docs: Rendering
// Performance, More Lights):
//   node tools/shader-check.js              every Assets/Shaders shader but the UNUSED_ ones
//   node tools/shader-check.js <name>...    those (file name, path or shader name, in part)
//   node tools/shader-check.js --all        the UNUSED_ ones too
//   node tools/shader-check.js --force      recompile what passed before
// Each CGPROGRAM's vertex and fragment programs (and geometry, if any) go through glslangValidator
// (pkg glslang) as HLSL, against the include files of Canopy's own Unity version
// (ProjectVersion.txt: Unity's builtin_shaders zip, downloaded once into cache/unity-builtin/),
// with the defines Unity's compiler adds for the Quest build (OpenGL ES 3, the Android target's
// API), HLSLSupport.cginc, UnityShaderVariables.cginc and UnityShaderUtilities.cginc first, as
// Unity puts them, and the shader's CGINCLUDE blocks. Each keyword variant is compiled: the
// default (each multi_compile's first keyword, shader_feature's off) and then each other keyword
// on its own; multi_compile_instancing adds INSTANCING_ON; a program with Multiview's stereo macros
// (UNITY_VERTEX_OUTPUT_STEREO) is also compiled with STEREO_MULTIVIEW_ON. Includes are found
// beside the shader (CanopyLighting.cginc), and a change to one of Canopy's .cginc files
// recompiles everything. glslang checks every function, even
// ones nothing calls. Errors name the .shader's own lines. It is not Unity's compiler (HLSLcc):
// it catches what HLSL itself rejects (syntax, types, undefined names), not Unity's own limits.
// Surface shaders and HLSLPROGRAM blocks are only listed: every Unity shader is being replaced
// by Canopy's own vertex and fragment shaders (Ken, 2026-11-06), so they aren't worth compiling.
// Passes are kept in cache/shader-check.json by what was compiled, so a rerun compiles only what
// changed; compiles run on every core. Exits 1 if anything fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const U = require('./unity.js');

const CACHE = path.join(__dirname, '..', 'cache');
const PASSED = path.join(CACHE, 'shader-check.json');
const SHADERS = path.join(U.REPO, 'Assets', 'Shaders');

// ---------- Unity's include files ----------
function unityVersion() {
  const file = path.join(U.REPO, 'ProjectSettings', 'ProjectVersion.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : execFileSync('git', ['-C', U.REPO, 'show', 'HEAD:ProjectSettings/ProjectVersion.txt']).toString();
  const m = /m_EditorVersionWithRevision: (\S+) \((\w+)\)/.exec(text);
  if (!m) throw new Error("ProjectVersion.txt names no version with its revision");
  return { version: m[1], revision: m[2] };
}

// The zip's CGIncludes/ files, written under dir (a zip's central directory, then each entry).
function unzipIncludes(zip, dir) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (!name.startsWith('CGIncludes/') || name.endsWith('/')) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    const out = path.join(dir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, method === 8 ? zlib.inflateRawSync(data) : data);
  }
}

async function includes() {
  const { version, revision } = unityVersion();
  const dir = path.join(CACHE, 'unity-builtin', version);
  const inc = path.join(dir, 'CGIncludes');
  if (!fs.existsSync(path.join(inc, 'UnityCG.cginc'))) {
    const url = `https://download.unity3d.com/download_unity/${revision}/builtin_shaders-${version}.zip`;
    console.log(`fetching Unity ${version}'s shader includes: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    unzipIncludes(Buffer.from(await res.arrayBuffer()), dir);
  }
  return { version, inc };
}

// What Unity's compiler defines and includes ahead of a CGPROGRAM, for the Quest's OpenGL ES 3.
// HLSLcc's _half and _float texture types are its own; glslang takes the plain ones.
const PRELUDE = `#define SHADER_API_GLES3 1
#define SHADER_API_MOBILE 1
#define UNITY_VERSION 202130
#define UNITY_NO_DXT5nm 1
${['Texture2D', 'Texture3D', 'TextureCube', 'sampler2D', 'sampler3D', 'samplerCUBE'].flatMap(t => ['half', 'float'].map(p => `#define ${t}_${p} ${t}`)).join('\n')}
#include "HLSLSupport.cginc"
#include "UnityShaderVariables.cginc"
#include "UnityShaderUtilities.cginc"
`;

// ---------- reading a shader ----------
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// "<file text>" -> { name, programs: [{ line, code, pragmas, lightMode }], includes: [{ line, code }] }.
function readShader(text) {
  const name = (/^\s*Shader\s*"([^"]+)"/m.exec(text) || [])[1] || '?';
  const blocks = [...text.matchAll(/\b(CGINCLUDE|CGPROGRAM|HLSLINCLUDE|HLSLPROGRAM)\b([\s\S]*?)\b(ENDCG|ENDHLSL)\b/g)];
  const includes = blocks.filter(b => b[1] === 'CGINCLUDE').map(b => ({ line: lineAt(text, b.index + b[1].length), code: b[2] }));
  const programs = blocks.filter(b => b[1] !== 'CGINCLUDE').map(b => {
    const pragmas = [...b[2].matchAll(/^[ \t]*#pragma[ \t]+(.*)$/gm)].map(m => m[1].replace(/\/\/.*$/, '').trim().split(/\s+/));
    const pass = text.slice(0, b.index).lastIndexOf('Pass');
    const tags = pass < 0 ? '' : text.slice(pass, b.index);
    const lightMode = (/"LightMode"\s*=\s*"(\w+)"/.exec(tags) || [])[1];
    return { kind: b[1], line: lineAt(text, b.index + b[1].length), code: b[2], pragmas, lightMode };
  });
  return { name, programs, includes };
}

// A program's keyword variants: each a list of keywords defined.
function variants(pragmas) {
  const sets = [];
  for (const [p, ...words] of pragmas) {
    if (/^(multi_compile|shader_feature)(_local)?(_vertex|_fragment)?$/.test(p)) {
      const set = words.map(w => /^_+$/.test(w) ? null : w);
      sets.push(p.startsWith('shader_feature') && set.length === 1 ? [null, set[0]] : set);
    } else if (p === 'multi_compile_instancing') sets.push([null, 'INSTANCING_ON']);
  }
  const base = sets.map(s => s[0]);
  const out = [base];
  sets.forEach((s, i) => s.slice(1).forEach(k => out.push(base.map((b, j) => j === i ? k : b))));
  return out.map(v => v.filter(Boolean));
}

// A program's code with the include files beside its shader (Canopy's own .cginc) written in,
// once each, to see what it uses.
function withLocalIncludes(code, dir, seen = new Set()) {
  return code.replace(/^[ \t]*#include[ \t]+"([^"]+)"/gm, (line, name) => {
    const file = path.resolve(dir, name);
    if (seen.has(file) || !fs.existsSync(file)) return line;
    seen.add(file);
    return withLocalIncludes(fs.readFileSync(file, 'utf8'), path.dirname(file), seen);
  });
}

// A program with Multiview's stereo macros is also compiled as Unity compiles it with Multiview on.
const stereo = code => /UNITY_VERTEX_OUTPUT_STEREO/.test(code);

// ---------- compiling ----------
const STAGES = { vertex: 'vert', fragment: 'frag', geometry: 'geom' };

function jobs(file, text) {
  const shader = readShader(text);
  const label = path.relative(SHADERS, file);
  const out = [], skipped = [];
  shader.programs.forEach((p, n) => {
    const where = `${label} program ${n + 1}`;
    if (p.kind === 'HLSLPROGRAM') return skipped.push(`${where}: HLSLPROGRAM`);
    if (p.pragmas.some(q => q[0] === 'surface')) return skipped.push(`${where}: surface shader (to convert)`);
    const target = p.pragmas.find(q => q[0] === 'target');
    const shaderTarget = target ? Math.round(parseFloat(target[1]) * 10) : 25;
    const pass = { ForwardBase: 'FORWARDBASE', ForwardAdd: 'FORWARDADD', ShadowCaster: 'SHADOWCASTER', Meta: 'META' }[p.lightMode];
    const source = shader.includes.map(i => `#line ${i.line} "${label}"\n${i.code}`).join('\n') + `\n#line ${p.line} "${label}"\n${p.code}`;
    const all = variants(p.pragmas);
    for (const keywords of stereo(withLocalIncludes(p.code, path.dirname(file))) ? all.concat([['STEREO_MULTIVIEW_ON']]) : all) {
      const head = [`#define SHADER_TARGET ${shaderTarget}`, ...(pass ? [`#define UNITY_PASS_${pass} 1`] : []), ...keywords.map(k => `#define ${k} 1`)].join('\n');
      for (const [pragma, stage] of Object.entries(STAGES)) {
        const entry = (p.pragmas.find(q => q[0] === pragma) || [])[1];
        if (entry) out.push({ where: `${where}${keywords.length ? ' [' + keywords.join(' ') + ']' : ''} ${pragma}`, stage, entry, dir: path.dirname(file), code: `${head}\n${PRELUDE}${source}` });
      }
    }
    if (!p.pragmas.some(q => q[0] === 'vertex')) skipped.push(`${where}: no #pragma vertex`);
  });
  return { name: shader.name, jobs: out, skipped };
}

function compile(job, inc, dir) {
  return new Promise(resolve => {
    const file = path.join(dir, crypto.randomBytes(6).toString('hex') + '.hlsl');
    fs.writeFileSync(file, job.code);
    execFile('glslangValidator', ['-V', '-D', '-e', job.entry, '-S', job.stage, '-I' + job.dir, '-I' + inc, file, '-o', file + '.spv'], (error, stdout, stderr) => {
      fs.rmSync(file, { force: true });
      fs.rmSync(file + '.spv', { force: true });
      const errors = String(stdout + stderr).split('\n').filter(l => /^ERROR: (?!\d+ compilation errors)/.test(l)).map(l => l.slice(7));
      resolve(error ? (errors.length ? errors : [String(stdout + stderr).trim() || error.message]) : null);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all'), force = args.includes('--force');
  const names = args.filter(a => !a.startsWith('--')).map(a => a.toLowerCase());
  const { version, inc } = await includes();
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.shader') && (all || names.length || !e.name.startsWith('UNUSED_'))) files.push(p);
    }
  })(SHADERS);
  const passed = force || !fs.existsSync(PASSED) ? {} : JSON.parse(fs.readFileSync(PASSED, 'utf8'));
  // Canopy's own include files (CanopyLighting.cginc): a change to any recompiles everything
  const cgincs = crypto.createHash('sha1');
  for (const f of fs.readdirSync(SHADERS).filter(n => n.endsWith('.cginc')).sort()) cgincs.update(f + '\n' + fs.readFileSync(path.join(SHADERS, f), 'utf8'));
  const own = cgincs.digest('hex');
  const now = {};
  const work = [], skipped = [];
  let shaders = 0;
  for (const file of files.sort()) {
    const text = fs.readFileSync(file, 'utf8');
    const s = jobs(file, text);
    if (names.length && !names.some(n => path.relative(SHADERS, file).toLowerCase().includes(n) || s.name.toLowerCase().includes(n))) continue;
    shaders++;
    skipped.push(...s.skipped);
    for (const job of s.jobs) {
      job.key = crypto.createHash('sha1').update(`${version}\n${own}\n${job.stage}\n${job.entry}\n${job.code}`).digest('hex');
      if (passed[job.key]) now[job.key] = 1;
      else work.push(job);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-check-'));
  const failures = [];
  let next = 0;
  const start = Date.now();
  await Promise.all(Array.from({ length: Math.max(1, os.cpus().length) }, async () => {
    while (next < work.length) {
      const job = work[next++];
      const errors = await compile(job, inc, dir);
      if (errors) failures.push({ where: job.where, errors });
      else now[job.key] = 1;
    }
  }));
  fs.rmSync(dir, { recursive: true, force: true });
  // keep earlier passes of shaders not checked this time
  fs.writeFileSync(PASSED, JSON.stringify(names.length ? { ...passed, ...now } : now));
  for (const s of skipped) console.log(`skipped ${s}`);
  for (const f of failures.sort((a, b) => a.where.localeCompare(b.where))) console.log(`FAILED ${f.where}\n  ${[...new Set(f.errors)].slice(0, 6).join('\n  ')}`);
  const total = Object.keys(now).length + failures.length;
  console.log(`${shaders} shaders, ${total} compiles (${work.length} run in ${((Date.now() - start) / 1000).toFixed(1)} s, the rest unchanged), ${failures.length} failed, ${skipped.length} programs skipped; Unity ${version}'s includes`);
  process.exitCode = failures.length ? 1 : 0;
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { readShader, variants };
