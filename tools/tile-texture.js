// Make an image tile seamlessly by overlapping each edge strip with the opposite
// edge and stitching along a minimum-error cut (image-quilting style).
// Usage: node tools/tile-texture.js <in.png> <out.png>   (layout's materials/ were made this way)
const { execFileSync } = require('child_process');
const [inPath, outPath] = process.argv.slice(2);

function load(p) {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', p]).toString().split(' ').map(Number);
  const buf = execFileSync('magick', [p, '-depth', '8', 'rgb:-'], { maxBuffer: 1 << 28 });
  return { w, h, d: new Float32Array(buf) };
}
function save(img, p) {
  const buf = Buffer.alloc(img.w * img.h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.max(0, Math.min(255, Math.round(img.d[i])));
  execFileSync('magick', ['-size', `${img.w}x${img.h}`, '-depth', '8', 'rgb:-', p], { input: buf });
}
function transpose(img) {
  const out = { w: img.h, h: img.w, d: new Float32Array(img.d.length) };
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      for (let c = 0; c < 3; c++) out.d[(x * out.w + y) * 3 + c] = img.d[(y * img.w + x) * 3 + c];
  return out;
}

// Cheapest vertical path through cost[h][w], wrapping so the path's end row meets its start row.
function cutPath(cost, w, h) {
  let best = { total: Infinity, path: null };
  const acc = new Float64Array(w * h), from = new Int32Array(w * h);
  for (let s = 0; s < w; s += 2) {
    for (let x = 0; x < w; x++) acc[x] = Math.abs(x - s) <= 1 ? cost[x] : Infinity;
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let bx = x, bv = acc[(y - 1) * w + x];
        if (x > 0 && acc[(y - 1) * w + x - 1] < bv) { bv = acc[(y - 1) * w + x - 1]; bx = x - 1; }
        if (x < w - 1 && acc[(y - 1) * w + x + 1] < bv) { bv = acc[(y - 1) * w + x + 1]; bx = x + 1; }
        acc[y * w + x] = bv + cost[y * w + x];
        from[y * w + x] = bx;
      }
    }
    for (let x = Math.max(0, s - 1); x <= Math.min(w - 1, s + 1); x++) {
      const total = acc[(h - 1) * w + x];
      if (total < best.total) {
        const path = new Int32Array(h);
        path[h - 1] = x;
        for (let y = h - 1; y > 0; y--) path[y - 1] = from[y * w + path[y]];
        best = { total, path };
      }
    }
  }
  return best;
}

// Wrap horizontally: overlap the right strip (width ov) onto the left strip and cut between them.
function wrapX(img, ov) {
  const { w, h, d } = img;
  const raw = new Float32Array(ov * h);
  for (let y = 0; y < h; y++)
    for (let k = 0; k < ov; k++) {
      let e = 0;
      for (let c = 0; c < 3; c++) {
        const diff = d[(y * w + w - ov + k) * 3 + c] - d[(y * w + k) * 3 + c];
        e += diff * diff;
      }
      raw[y * ov + k] = e;
    }
  // Blur the error so the cut avoids crossing holes, and keep it off the strip ends.
  const R = 3, cost = new Float32Array(ov * h);
  for (let y = 0; y < h; y++)
    for (let k = 0; k < ov; k++) {
      let s = 0, n = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dk = -R; dk <= R; dk++) {
          const yy = (y + dy + h) % h, kk = k + dk;
          if (kk < 0 || kk >= ov) continue;
          s += raw[yy * ov + kk]; n++;
        }
      const edge = Math.min(k, ov - 1 - k) < 8 ? 1e6 : 0;
      cost[y * ov + k] = s / n + edge;
    }
  const { total, path } = cutPath(cost, ov, h);
  const nw = w - ov, out = { w: nw, h, d: new Float32Array(nw * h * 3) };
  const F = 3; // feather half-width in pixels
  for (let y = 0; y < h; y++)
    for (let x = 0; x < nw; x++) {
      let t = 1; // weight of the original pixel at x
      if (x < ov) t = Math.max(0, Math.min(1, (x - path[y] + F) / (2 * F)));
      for (let c = 0; c < 3; c++) {
        const orig = d[(y * w + x) * 3 + c];
        const wrapped = x < ov ? d[(y * w + w - ov + x) * 3 + c] : orig;
        out.d[(y * nw + x) * 3 + c] = t * orig + (1 - t) * wrapped;
      }
    }
  return { out, score: total / h };
}

function bestWrapX(img) {
  let best = null;
  for (let ov = 120; ov <= 240; ov += 20) {
    const r = wrapX(img, ov);
    console.log(`  overlap ${ov}: cut error ${r.score.toFixed(0)}`);
    if (!best || r.score < best.score) best = { ...r, ov };
  }
  console.log(`  chose overlap ${best.ov}`);
  return best.out;
}

const img = load(inPath);
console.log('horizontal wrap');
const a = bestWrapX(img);
console.log('vertical wrap');
const b = transpose(bestWrapX(transpose(a)));
save(b, outPath);
console.log(`${img.w}x${img.h} -> ${b.w}x${b.h}`);
