// Leaf outlines for Canopy's tree leaves (docs: Rendering Performance, Leaves): how much of each
// leaf quad is leaf, and the tightest N-cornered outline, so the alpha-tested (clip) pixels that
// are thrown away cost less. Leaves draw with a cutout shader, and every pixel of the quad runs
// it, kept or not.
//   node tools/leaf-fit.js                  every leaf material in use: share of the quad that is
//                                           leaf, and of 4, 5, 6 and 8-cornered outlines
//   node tools/leaf-fit.js <material> ...   those materials (names, e.g. LeafMaple)
//   node tools/leaf-fit.js --json [...]     the outlines' corners in UV (0..1, v up), as JSON
// The mask is the main texture's alpha at the material's _Cutoff, at 256 px (ImageMagick). The
// outline starts as the convex hull of the kept pixels and loses corners one at a time, each time
// dropping the edge whose removal (its neighbors extended to meet) adds the least area, and only
// when the new corner stays inside the texture, so the UVs stay in 0..1. Lobed leaves stay
// convex, so they keep some waste. Each outline is then grown by MARGIN pixels.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./scene.js');
const Uses = require('./uses.js');

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
const SIZE = 256;
const CORNERS = [4, 5, 6, 8];
// Outlines are grown by this many pixels (of SIZE), within the texture: at a distance the GPU
// samples blurrier mipmaps whose alpha spreads past the sharp edge, and the outline should not
// trim it.
const MARGIN = 2;

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const area = p => Math.abs(p.reduce((s, a, i) => {
  const b = p[(i + 1) % p.length];
  return s + a[0] * b[1] - b[0] * a[1];
}, 0)) / 2;

function hull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [], upper = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of points.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Where the lines a1-a2 and b1-b2 meet, or null if parallel.
function meet(a1, a2, b1, b2) {
  const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
  return [a1[0] + t * (a2[0] - a1[0]), a1[1] + t * (a2[1] - a1[1])];
}

// The polygon cut to n corners, each new corner inside [0, size] on both axes.
function shrink(poly, n, size) {
  poly = poly.slice();
  const ccw = cross(poly[0], poly[1], poly[2]) > 0;
  const inside = x => x[0] >= -1e-9 && x[1] >= -1e-9 && x[0] <= size + 1e-9 && x[1] <= size + 1e-9;
  while (poly.length > n) {
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const m = poly.length, p0 = poly[(i - 1 + m) % m], p1 = poly[i], p2 = poly[(i + 1) % m], p3 = poly[(i + 2) % m];
      const x = meet(p0, p1, p3, p2);
      // The new corner must lie beyond the dropped edge (outside it), else the lines diverge.
      if (!x || (cross(p1, p2, x) > 0) === ccw || !inside(x)) continue;
      const added = Math.abs(cross(p1, x, p2)) / 2;
      if (!best || added < best.added) best = { i, x, added };
    }
    if (!best) break;
    const m = poly.length;
    poly.splice(best.i, 2, best.x);
    if (best.i === m - 1) poly.shift(); // the edge wrapped around: its second corner was poly[0]
  }
  return poly;
}

// The convex polygon moved out by d along each edge's normal, its corners kept inside [0, size].
function grow(poly, d, size) {
  const sign = Math.sign(poly.reduce((s, a, i) => { const b = poly[(i + 1) % poly.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0));
  const edges = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = [sign * (b[1] - a[1]) / len * d, -sign * (b[0] - a[0]) / len * d]; // outward
    return [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]]];
  });
  return edges.map((e, i) => {
    const prev = edges[(i - 1 + edges.length) % edges.length];
    const x = meet(prev[0], prev[1], e[0], e[1]) || e[0];
    return x.map(c => Math.min(size, Math.max(0, c)));
  });
}

// A texture's alpha as SIZE x SIZE bytes (row 0 at the top).
function alpha(blob) {
  const data = S.blobs([blob]).get(blob);
  const pgm = execFileSync('magick', ['-', '-alpha', 'extract', '-resize', `${SIZE}x${SIZE}!`, '-depth', '8', 'pgm:-'], { input: data, maxBuffer: 1 << 26 });
  return pgm.subarray(pgm.length - SIZE * SIZE);
}

function fit(material) {
  const entry = Object.values(index).find(e => e.path.endsWith(`/${material}.mat`));
  if (!entry) throw new Error(`no material ${material}`);
  const mat = S.parseMaterial(S.blobs([entry.blob]).get(entry.blob).toString());
  const tex = mat.map && index[mat.map.guid];
  if (!tex) throw new Error(`${material}: no main texture`);
  const a = alpha(tex.blob);
  const pts = [];
  let kept = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (a[y * SIZE + x] < mat.cutoff * 255) continue;
      kept++;
      pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    }
  }
  const h = hull(pts);
  const outlines = CORNERS.map(n => {
    const p = grow(shrink(h, n, SIZE), MARGIN, SIZE);
    // UV: u right, v up (the image's rows run down)
    return { corners: p.length, share: kept / area(p), uv: p.map(([x, y]) => [+(x / SIZE).toFixed(4), +(1 - y / SIZE).toFixed(4)]) };
  });
  return { material, texture: tex.path, cutoff: mat.cutoff, tiling: mat.map.scale, quad: kept / (SIZE * SIZE), hull: { corners: h.length, share: kept / area(h) }, outlines };
}

function leafMaterials() {
  const { used } = Uses.analyze();
  return [...used.keys()].filter(p => /^Assets\/Materials\/Leaf[^/]*\.mat$/.test(p)).map(p => path.basename(p, '.mat')).sort();
}

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a !== '--json');
  const found = (args.length ? args : leafMaterials()).map(fit);
  if (process.argv.includes('--json')) console.log(JSON.stringify(found, null, 1));
  else {
    console.log('Share of the drawn area that is leaf (the rest is clipped away):');
    for (const f of found) {
      const tiled = f.tiling[0] !== 1 || f.tiling[1] !== 1 ? ` (tiled ${f.tiling.join('x')})` : '';
      console.log(`  ${f.material.padEnd(16)} ${path.basename(f.texture).padEnd(16)} cutoff ${f.cutoff}${tiled}: quad ${(100 * f.quad).toFixed(0)}%, ` +
        // an outline that cannot lose more corners inside the texture is shown once
        f.outlines.filter((o, i, all) => !all.slice(0, i).some(p => p.corners === o.corners)).map(o => `${o.corners}-gon ${(100 * o.share).toFixed(0)}%`).join(', ') + `, hull(${f.hull.corners}) ${(100 * f.hull.share).toFixed(0)}%`);
    }
  }
}

module.exports = { fit, shrink, hull };
