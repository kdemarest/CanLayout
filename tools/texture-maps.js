// From a seamless photo tile, make a tiling albedo (baked lighting reduced, brightness set) and a
// tangent-space normal map (OpenGL convention, as Unity wants), both wrapping at the edges.
// Usage: node tools/texture-maps.js <tile.png> <size> <outDir> <Name> [--luma 150] [--keep 0.6] [--depth 14] [--preview <file>]
// writes <outDir>/<Name>A.png (albedo) and <Name>N.png (normal); --preview writes a lit 2x2 check.
const { execFileSync } = require('child_process');
const path = require('path');
const [inPath, sizeArg, outDir, NAME] = process.argv.slice(2);
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const opt = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? +process.argv[i + 1] : def; };
const SIZE = +sizeArg, LUMA = opt('--luma', 150), KEEP = opt('--keep', 0.6), DEPTH = opt('--depth', 14);
const W = SIZE, H = SIZE, N = W * H;

// Resize with wrapped edges so the result still tiles.
const buf = execFileSync('magick', [inPath, '-virtual-pixel', 'tile', '-filter', 'Lanczos', '-distort', 'Resize', `${W}x${H}!`, '-depth', '8', 'rgb:-'], { maxBuffer: 1 << 28 });
const toLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = v => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const LIN = new Float32Array(256).map((_, i) => toLin(i));
const rgb = new Float32Array(N * 3);
for (let i = 0; i < N * 3; i++) rgb[i] = LIN[buf[i]];
const lum = new Float32Array(N);
for (let i = 0; i < N; i++) lum[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];

// Gaussian-ish blur: three wrapped box passes each way.
function blur(src, r) {
  if (r < 1) return src.slice();
  let a = src.slice(), b = new Float32Array(N);
  const pass = (from, to, horizontal) => {
    const len = horizontal ? W : H, lines = horizontal ? H : W, n = 2 * r + 1;
    for (let l = 0; l < lines; l++) {
      const at = k => horizontal ? l * W + ((k % W) + W) % W : (((k % H) + H) % H) * W + l;
      let s = 0;
      for (let k = -r; k <= r; k++) s += from[at(k)];
      for (let k = 0; k < len; k++) {
        to[at(k)] = s / n;
        s += from[at(k + r + 1)] - from[at(k - r)];
      }
    }
  };
  for (let p = 0; p < 3; p++) { pass(a, b, true); pass(b, a, false); }
  return a;
}
const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

// Albedo: shading as log luminance; drop its low frequencies, keep KEEP of the rest, then scale so
// the mean luma is LUMA (sRGB 0-255). Chroma is kept by scaling RGB together.
const logL = lum.map(v => Math.log(v + 1e-4));
const low = blur(logL, Math.round(W / 24));
const albedo = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  const target = Math.exp(KEEP * (logL[i] - low[i]));
  const f = target / (lum[i] + 1e-4);
  for (let c = 0; c < 3; c++) albedo[i * 3 + c] = rgb[i * 3 + c] * f;
}
// Find the scale that puts mean sRGB luma at LUMA (a few Newton-free bisection steps).
const lumaAt = s => {
  let t = 0;
  for (let i = 0; i < N; i += 7) {
    const y = 0.2126 * albedo[i * 3] + 0.7152 * albedo[i * 3 + 1] + 0.0722 * albedo[i * 3 + 2];
    t += toSrgb(Math.min(1, y * s));
  }
  return t / Math.ceil(N / 7);
};
let lo = 0, hi = 4;
for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (lumaAt(m) < LUMA) lo = m; else hi = m; }
const scale = (lo + hi) / 2;
const out = Buffer.alloc(N * 3);
for (let i = 0; i < N * 3; i++) out[i] = Math.max(0, Math.min(255, Math.round(toSrgb(Math.min(1, albedo[i] * scale)))));

// Height: brightness, perceptual, with fine noise softened and the large cavities given weight.
const perc = lum.map(v => v ** (1 / 2.2));
const fine = blur(perc, 1), mid = blur(perc, 4), coarse = blur(perc, 12);
const hgt = new Float32Array(N);
for (let i = 0; i < N; i++) hgt[i] = 0.35 * fine[i] + 0.4 * mid[i] + 0.25 * coarse[i];
const hm = mean(hgt);
let hv = 0;
for (let i = 0; i < N; i++) hv += (hgt[i] - hm) ** 2;
const hsd = Math.sqrt(hv / N);
// Normal: n = (-dh/du, -dh/dv, 1); image rows run down and v up, so -dh/dv = +dh/drow.
// Heights in texels: one standard deviation of brightness is DEPTH texels of relief at 1024.
const k = DEPTH * (SIZE / 1024) / hsd;
const at = (x, y) => hgt[(((y % H) + H) % H) * W + (((x % W) + W) % W)];
const nrm = Buffer.alloc(N * 3);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
    let nx = -dx * k, ny = dy * k, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    const i = (y * W + x) * 3;
    nrm[i] = Math.round((nx * 0.5 + 0.5) * 255);
    nrm[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    nrm[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }

const save = (data, file) => execFileSync('magick', ['-size', `${W}x${H}`, '-depth', '8', 'rgb:-', '-strip', file], { input: data });
save(out, path.join(outDir, NAME + 'A.png'));
save(nrm, path.join(outDir, NAME + 'N.png'));

// A lit preview, BarkSimple's way (Lambert plus ambient), sun from the upper left.
const preview = arg('--preview');
if (preview) {
  const sun = [-0.5, 0.5, 0.7], sl = Math.hypot(...sun), amb = 0.35;
  const lit = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const n = [nrm[i * 3] / 127.5 - 1, nrm[i * 3 + 1] / 127.5 - 1, nrm[i * 3 + 2] / 127.5 - 1];
    const ndl = Math.max(0, (n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]) / sl);
    for (let c = 0; c < 3; c++) lit[i * 3 + c] = Math.min(255, Math.round(toSrgb(Math.min(1, LIN[out[i * 3 + c]] * (amb + ndl)))));
  }
  save(lit, preview);
}
console.log(`albedo scale ${scale.toFixed(3)}, height sd ${hsd.toFixed(4)}, normal k ${k.toFixed(1)}`);
