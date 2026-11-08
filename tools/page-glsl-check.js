// Compiles the page's patched lit-material fragment shaders without a browser (Claude,
// 2026-11-06; docs: Rendering Performance, More Lights, phase 3): web/app.js's generalLight
// (Canopy/General, GeneralCutout with and without its highlight) and glowLitPatch (GlowLit), taken
// from app.js by their text, applied to three.js's MeshStandardMaterial fragment shader, and
// scripts/ParticleSystem.js's particle shader ports (its HEAD and SHADERS, by their text) and
// web/surface.js's ports of Canopy's shaders (its *_FRAGMENT texts), each
// with its includes expanded, compiled by glslangValidator (pkg glslang) as WebGL2's GLSL ES 3.00
// with the defines three.js adds for a textured, normal-mapped, fogged material. The shaders go
// to cache/page-glsl/. Exits 1 if one fails.
//   node tools/page-glsl-check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const THREE = require(path.join(__dirname, '..', 'web', 'three.js'));
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const grab = (start, end) => {
  const a = app.indexOf(start);
  const b = app.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`web/app.js: no ${start.trim()}`);
  return app.slice(a, b + end.length);
};
const src = grab('    const generalLight = ', '\n    };\n') + '\n' + grab('    function glowLitPatch(d) {', '\n    }\n');
const Surface = { uniforms: { canopySunDirection: { value: new THREE.Vector3() }, canopySunLight: { value: new THREE.Color() }, canopyAmbient: { value: new THREE.Color() } } };
const texture = () => Promise.resolve(null);
const Lights = require(path.join(__dirname, '..', 'web', 'lights.js')).create(THREE); // the point lights (More Lights phase 4)
const { generalLight, glowLitPatch } = new Function('THREE', 'Surface', 'texture', 'Lights', src + '\nreturn { generalLight, glowLitPatch };')(THREE, Surface, texture, Lights);
const expand = s => s.replace(/#include <(\w+)>/g, (m, n) => expand(THREE.ShaderChunk[n]));
const defines = ['STANDARD', 'USE_MAP', 'USE_UV', 'USE_NORMALMAP', 'USE_NORMALMAP_TANGENTSPACE', 'USE_FOG', 'FOG_EXP2'];
const nums = { NUM_DIR_LIGHTS: 1, NUM_POINT_LIGHTS: 0, NUM_SPOT_LIGHTS: 0, NUM_RECT_AREA_LIGHTS: 0, NUM_HEMI_LIGHTS: 0, NUM_DIR_LIGHT_SHADOWS: 0, NUM_POINT_LIGHT_SHADOWS: 0, NUM_SPOT_LIGHT_SHADOWS: 0, NUM_SPOT_LIGHT_MAPS: 0, NUM_SPOT_LIGHT_COORDS: 0, NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS: 0, NUM_CLIPPING_PLANES: 0, UNION_CLIPPING_PLANES: 0, NUM_LIGHT_PROBES: 0 };
// glslang has a built-in average(); three.js's own is renamed here (browsers have none)
const prefix = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;', '#define varying in', 'layout(location = 0) out highp vec4 pc_fragColor;', '#define gl_FragColor pc_fragColor', '#define texture2D texture', '#define textureCube texture', '#define average threeAverage',
  ...defines.map(d => '#define ' + d), ...Object.entries(nums).map(([k, v]) => `#define ${k} ${v}`), 'uniform mat4 viewMatrix;', 'uniform vec3 cameraPosition;', 'uniform bool isOrthographic;',
  THREE.ShaderChunk.colorspace_pars_fragment, 'vec4 linearToOutputTexel( vec4 value ) { return LinearTosRGB( value ); }'].join('\n');
const cases = {
  general: [generalLight({ value: 0.3 })],
  cutout: [generalLight({ value: 0.3 }, true)],
  'cutout, no highlight': [generalLight({ value: 0.3 }, false)],
  glowlit: [generalLight({ value: 0.3 }), glowLitPatch({ values: { _GlowTint: [1, 0.5, 0.2, 1], _EmissionColor: [0.5, 0.5, 0.5, 1] }, glow: { scale: [6, 6], offset: [0, 0] }, map: { scale: [1, 1], offset: [0, 0] }, emission: null })]
};
const OUT = path.join(__dirname, '..', 'cache', 'page-glsl');
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const [name, patches] of Object.entries(cases)) {
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader, vertexShader: '' };
  patches.forEach(p => p(shader));
  const file = path.join(OUT, `${name.replace(/\W+/g, '-')}.frag`);
  fs.writeFileSync(file, prefix + '\n' + expand(shader.fragmentShader));
  try {
    execFileSync('glslangValidator', [file], { stdio: 'pipe' });
    console.log(`${name}: compiles`);
  } catch (e) {
    failed++;
    console.log(`${name}: FAILED\n${e.stdout.toString().split('\n').slice(0, 8).join('\n')}`);
  }
}
// the particle ports: ShaderMaterials, three.js's prefix but no material defines
const ps = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ParticleSystem.js'), 'utf8');
const between = (start, end) => {
  const a = ps.indexOf(start);
  const b = ps.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`scripts/ParticleSystem.js: no ${start.trim()}`);
  return ps.slice(a, b + end.length);
};
const { HEAD, SHADERS } = new Function(between('    const HEAD = `', '`;\n') + '\n' + between('    const SHADERS = {', '\n    };\n') + '\nreturn { HEAD, SHADERS };')();
const particlePrefix = prefix.split('\n').filter(l => !/^#define (STANDARD|USE_|FOG_EXP2|NUM_|UNION_)/.test(l)).join('\n');
for (const [name, look] of Object.entries(SHADERS)) {
  const file = path.join(OUT, `particles-${name.replace(/\W+/g, '-')}.frag`);
  fs.writeFileSync(file, particlePrefix + '\n' + expand(HEAD + look.frag));
  try {
    execFileSync('glslangValidator', [file], { stdio: 'pipe' });
    console.log(`particles ${name}: compiles`);
  } catch (e) {
    failed++;
    console.log(`particles ${name}: FAILED\n${e.stdout.toString().split('\n').slice(0, 8).join('\n')}`);
  }
}
// web/surface.js's ports of Canopy's shaders (the sea's, Water, CloudTextured, Goop, DiffuseGlow,
// Force Field, RimLit): its shader texts, by their text, each *_FRAGMENT compiled
const sf = fs.readFileSync(path.join(__dirname, '..', 'web', 'surface.js'), 'utf8');
const blocks = [...sf.matchAll(/^ {4}const ([A-Z_]+) = `[\s\S]*?^`;$/gm)];
const texts = new Function(blocks.map(m => m[0]).join('\n') + `\nreturn { ${blocks.map(m => m[1]).join(', ')} };`)();
for (const [name, text] of Object.entries(texts)) {
  if (!name.endsWith('_FRAGMENT')) continue;
  const file = path.join(OUT, `surface-${name}.frag`);
  fs.writeFileSync(file, particlePrefix + '\n' + expand(text));
  try {
    execFileSync('glslangValidator', [file], { stdio: 'pipe' });
    console.log(`surface ${name}: compiles`);
  } catch (e) {
    failed++;
    console.log(`surface ${name}: FAILED\n${e.stdout.toString().split('\n').slice(0, 8).join('\n')}`);
  }
}
process.exit(failed ? 1 : 0);
