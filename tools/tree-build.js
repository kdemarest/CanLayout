// Builds a gridded tree's chunks from its source model, from the command line and reproducibly
// (docs: Rendering Performance, Trees). It does what CanopyGrid's Dicer did in Unity, with whole
// triangles instead of sliced ones:
// 1. the source model as Unity imports it (tools/fbx.js modelMesh: normals imported, vertices
//    welded, 8-bit colors; tangents from tools/unity-mesh.js, within a degree of Unity's);
// 2. branch tips closed, once, on the source (tools/tree-tips.js finds them; merged to a point),
//    so every level has them;
// 3. each LOD level made by Mantis LOD (tools/mantis.js, the port of CanopyGrid's simplifier) at
//    its quality, with Dicer's settings (Bare2: every protection off);
//    Faces it leaves twice, or flat, are dropped.
// 4. each level cut into the prefab's chunks keeping triangles whole (tools/dice.js);
// 5. strips (--strips, default L1:skeleton,L2:all), and tubes: "skeleton": every segment as a strip
//    inset inside the mesh (each ring's nearest vertex, inside its flat faces, less 5%), under the
//    level's mesh, filling whatever it lacks (seams with chunks at other levels, branches Mantis
//    dropped), never at L0 where the player is; branch segments as camera-facing strips, two
//    triangles each, which the strip shader widens to the branch's radius and shades as a round
//    cylinder (exact silhouette at any distance). "lost": the segments a level's Mantis mesh no
//    longer covers (its surface not within half the radius of theirs); "all": the whole tree as
//    strips, the thickest segments also 6-sided tubes within --tube-budget (0.2:
//    their extra triangles at most that share of the all-strips cost; see tubeSegments). A strip vertex keeps the ring's centre as its position, the branch's
//    direction times its radius as its normal, its side (-1 or 1) and the bark's v as its uv.
//    Strips go whole into their segment's chunk, to <chunk>.strips.asset beside the chunk;
// 6. LOD cutoffs that spend part of the triangles saved on drawing levels farther (drawnAverage);
//    where the last level is all strips, it is drawn to --far (400 m, the far clip) instead.
//   node tools/tree-build.js              report
//   node tools/tree-build.js --candidate  write the chunks to cache/candidates/ (☰ Candidate trees)
//   node tools/tree-build.js --write      write them into the Canopy working tree
//   options: --source <model path> (Assets/Meshes/ForestTreeCollider.fbx, StdTreeLods' source),
//            --prefab <path> (Assets/Prefabs/Trees/StdTreeLods.prefab), --qualities 100,50,25
//            (one per level, Mantis's percent), --slack 0.25, --scale 10 (to tell tips' size in
//            meters), --fans (tips closed with flat fans where not small or snub: --merge-radius
//            0.05 m, --snub 0.5; see capTips), --no-caps
const fs = require('fs');
const path = require('path');
const S = require('./scene.js');
const F = require('./fbx.js');
const T = require('./tree-tips.js');
const M = require('./unity-mesh.js');
const D = require('./dice.js');
const Mantis = require('./mantis.js');
const U = require('./unity.js');

const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}

// The source model as Unity imports it, with tangents.
function source(modelPath) {
  const entry = Object.values(index).find(e => e.path === modelPath);
  if (!entry) throw new Error(`no ${modelPath} in the guid index`);
  const file = path.join(S.REPO, modelPath);
  const data = fs.existsSync(file) ? fs.readFileSync(file) : S.blobs([entry.blob]).get(entry.blob);
  const scene = F.readScene(data);
  const models = [...scene.models.values()].filter(m => m.geometry);
  if (models.length !== 1) throw new Error(`${modelPath}: expected one mesh, found ${models.length}`);
  const mesh = F.modelMesh(scene, models[0], F.importScale(scene, entry.import));
  mesh.tangents = M.tangents(mesh.positions, mesh.normals, mesh.uvs, mesh.triangles);
  return mesh;
}

// Closes the open branch tips (tree-tips.js's rule: rings not buried in another branch, at most 6
// sides and 0.5 m across at the tree's scale): each ring merged into one point at its middle,
// closed with no new triangle, the ring's side triangles that become flat dropped later. Each
// vertex keeps its UV, so the bark runs to the point; a fan's corners share the ring's v and
// smear it (Ken, 2026-10-26: merge them all; the grabbed collider keeps its fans). With fans
// (--fans), only a tip small enough (radius at most mergeRadius m) or snub (its last segment no
// longer than snub times its radius) is merged (Ken, 2026-10-25), the rest get flat fans.
function capTips(mesh, scale, fans = false, mergeRadius = 0.05, snub = 0.5) {
  const key = q => q.map(x => Math.round(x * 1e5)).join();
  const first = new Map(), welded = mesh.positions.map((q, i) => {
    const k = key(q);
    if (!first.has(k)) first.set(k, i);
    return first.get(k);
  });
  const found = T.sourceTips({ pos: mesh.positions, indices: mesh.triangles, welded });
  const tips = found.tips.filter(t => t.ring.length <= 6 && t.radius * scale <= 0.5);
  const centre = ids => [0, 1, 2].map(a => ids.reduce((s, i) => s + mesh.positions[i][a], 0) / ids.length);
  let merged = 0;
  for (const t of tips) {
    const c = centre(t.ring), inner = centre(t.inner);
    const segment = Math.hypot(c[0] - inner[0], c[1] - inner[1], c[2] - inner[2]);
    if (!fans || t.radius * scale <= mergeRadius || segment <= snub * t.radius) {
      // every vertex at a ring vertex's place (seams duplicate them) moves to the middle
      const at = new Set(t.ring.map(i => welded[i]));
      const p = c.map(Math.fround);
      mesh.positions.forEach((q, i) => {
        if (at.has(welded[i])) mesh.positions[i] = p;
      });
      merged++;
    } else for (let k = 1; k + 1 < t.ring.length; k++) mesh.triangles.push(t.ring[0], t.ring[k], t.ring[k + 1]);
  }
  return { capped: tips.length - merged, merged, closed: found.closedTips, branches: found.branches };
}

// Triangles drawn, averaged over places a player might be (2000 fixed pseudo-random points in the
// tree's bounds grown by --around m (30: players are in and near trees) around, and 50 m above
// and below), under GridRender's rule by
// distance: a chunk shows the first level whose cutoff its size over its distance reaches (as a
// share of the view's height at fov), else nothing. Every direction counts (no frustum), so it
// compares settings rather than predicting a frame. chunks: [{ centre (m), tris: [per level] }].
function drawnAverage(chunks, size, cutoffs, fov, MARGIN = 150) {
  const lo = [0, 1, 2].map(a => Math.min(...chunks.map(c => c.centre[a])) - (a === 1 ? 50 : MARGIN));
  const hi = [0, 1, 2].map(a => Math.max(...chunks.map(c => c.centre[a])) + (a === 1 ? 50 : MARGIN));
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const k = size / (2 * Math.tan(fov * Math.PI / 360)) * 100;
  let total = 0;
  const N = 2000;
  for (let n = 0; n < N; n++) {
    const p = lo.map((x, a) => x + random() * (hi[a] - x));
    for (const c of chunks) {
      const percent = k / Math.max(Math.hypot(p[0] - c.centre[0], p[1] - c.centre[1], p[2] - c.centre[2]), 1e-3);
      const level = cutoffs.findIndex(cut => percent >= cut);
      if (level >= 0) total += c.tris[level] || 0;
    }
  }
  return total / N;
}

// The tree's skeleton: every branch (a piece; tree-tips.js) as rings, breadth-first layers of its
// vertices from its base loop (buried in its parent; the trunk's is its bottom). A ring: its
// centre, radius, sides, the bark's v and its color (averages).
function skeleton(mesh) {
  const key = q => q.map(x => Math.round(x * 1e5)).join();
  const first = new Map(), welded = mesh.positions.map((q, i) => {
    const k = key(q);
    if (!first.has(k)) first.set(k, i);
    return first.get(k);
  });
  const tm = { pos: mesh.positions, indices: mesh.triangles, welded };
  const pieceOf = T.pieces(tm);
  const found = T.sourceTips(tm);
  const nbr = new Map();
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    for (let a = 0; a < 3; a++) {
      const x = welded[mesh.triangles[t + a]], y = welded[mesh.triangles[t + (a + 1) % 3]];
      if (x === y) continue;
      (nbr.get(x) || nbr.set(x, new Set()).get(x)).add(y);
      (nbr.get(y) || nbr.set(y, new Set()).get(y)).add(x);
    }
  }
  const avg = (ids, f) => f(ids[0]).map((_, a) => ids.reduce((s, i) => s + f(i)[a], 0) / ids.length);
  const spread = ids => { const c = avg(ids, i => mesh.positions[i]); return ids.reduce((s, i) => s + Math.hypot(...mesh.positions[i].map((x, a) => x - c[a])), 0) / ids.length; };
  // A branch grows from its base, buried in its parent; a piece with none (the trunk, and 10
  // branches whose base pokes out) from its widest open loop, a clean cycle or not: the largest
  // clean one could lie partway along (branch 589 started from a 4-sided loop, its base 11-sided
  // but not a clean cycle, and its "rings" ran along it: a tube 19 m across; Ken, 2026-10-26).
  const base = new Map();
  for (const b of found.bases) base.set(pieceOf[b.ring[0]], b.ring);
  const widest = new Map();
  for (const l of T.loops(tm).loops) {
    const p = pieceOf[l.ring[0]];
    if (base.has(p)) continue;
    const r = spread(l.ring);
    if (!widest.has(p) || widest.get(p).r < r) widest.set(p, { ring: l.ring, r });
  }
  for (const [p, w] of widest) base.set(p, w.ring);
  const branches = [];
  let cut = 0;
  for (const ring of base.values()) {
    const seen = new Set(ring.map(i => welded[i]));
    let layer = [...seen];
    const rings = [];
    while (layer.length) {
      const c = avg(layer, i => mesh.positions[i]);
      const r = layer.reduce((s, i) => s + Math.hypot(...mesh.positions[i].map((x, a) => x - c[a])), 0) / layer.length;
      // a layer half again as wide as the last is no ring across the branch: it ends there
      if (rings.length && r > 1.5 * rings[rings.length - 1].r) {
        cut++;
        break;
      }
      // rIn: a radius surely inside the mesh there: the ring's nearest vertex, inside its flat faces
      // (cos(pi / sides)), less 5% (the trunk's noise pushes vertices in and out)
      const near = Math.min(...layer.map(i => Math.hypot(...mesh.positions[i].map((x, a) => x - c[a]))));
      const rIn = layer.length >= 3 ? 0.95 * near * Math.cos(Math.PI / layer.length) : 0;
      rings.push({ c, r, rIn, n: layer.length, v: avg(layer, i => mesh.uvs[i])[1], color: avg(layer, i => mesh.colors[i]) });
      const next = new Set();
      for (const v of layer) for (const u of nbr.get(v) || []) if (!seen.has(u)) next.add(u);
      for (const u of next) seen.add(u);
      layer = [...next];
    }
    if (rings.length > 1) branches.push({ rings });
  }
  // A branch's first ring lies on its parent's surface (often slanted, where they meet), so a
  // strip starting there leaves a wedge open beside the parent. Each branch starts instead at the
  // nearest point on a thicker branch's centreline near its base: the first segment reaches into
  // the parent and fills the junction (Ken, 2026-10-26).
  const nearestOn = (p, a, b) => {
    const ab = b.map((x, i) => x - a[i]), t = Math.max(0, Math.min(1, ab.reduce((s2, x, i) => s2 + x * (p[i] - a[i]), 0) / (ab.reduce((s2, x) => s2 + x * x, 0) || 1)));
    const q = a.map((x, i) => x + ab[i] * t);
    return { q, d: Math.hypot(...q.map((x, i) => x - p[i])), t };
  };
  for (const b of branches) {
    const base = b.rings[0];
    let best = null;
    for (const o of branches) {
      if (o === b) continue;
      for (let k = 0; k + 1 < o.rings.length; k++) {
        const n = nearestOn(base.c, o.rings[k].c, o.rings[k + 1].c);
        const r = o.rings[k].r + (o.rings[k + 1].r - o.rings[k].r) * n.t;
        if (r > base.r && n.d < 1.5 * r && (!best || n.d < best.d)) best = { ...n, r };
      }
    }
    if (best && best.d > 1e-6) b.rings.unshift({ ...base, c: best.q });
  }
  branches.cut = cut;
  return branches;
}

// Distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
function pointTriangle(p, a, b, c) {
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]], dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const at = (o, u, k) => [o[0] + u[0] * k, o[1] + u[1] * k, o[2] + u[2] * k];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = b;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = at(a, ab, d1 / (d1 - d3));
    else if (d6 >= 0 && d5 <= d6) q = c;
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = at(a, ac, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) q = at(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    else {
      const den = 1 / (va + vb + vc);
      q = at(at(a, ab, vb * den), ac, vc * den);
    }
  }
  return Math.hypot(...sub(p, q));
}

// The skeleton's segments the mesh (triangles over positions) no longer covers: four points around
// each segment's middle, on its surface, average farther than half its radius from the mesh.
function lostSegments(branches, positions, tri) {
  const CELL = 0.25;
  const grid = new Map();
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  for (let t = 0; t < tri.length; t += 3) {
    const p = [0, 1, 2].map(k => positions[tri[t + k]]);
    const lo = [0, 1, 2].map(a => Math.floor(Math.min(...p.map(q => q[a])) / CELL)), hi = [0, 1, 2].map(a => Math.floor(Math.max(...p.map(q => q[a])) / CELL));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = cellKey(x, y, z);
      (grid.get(k) || grid.set(k, []).get(k)).push(t);
    }
  }
  const nearest = (p, reach) => {
    let best = Infinity;
    const r = Math.ceil(reach / CELL), c = p.map(x => Math.floor(x / CELL));
    for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) {
      for (const t of grid.get(cellKey(c[0] + x, c[1] + y, c[2] + z)) || []) best = Math.min(best, pointTriangle(p, positions[tri[t]], positions[tri[t + 1]], positions[tri[t + 2]]));
    }
    return best;
  };
  const lost = new Set();
  branches.forEach((b, bi) => {
    for (let k = 0; k + 1 < b.rings.length; k++) {
      const a = b.rings[k], c = b.rings[k + 1];
      const mid = a.c.map((x, i) => (x + c.c[i]) / 2), r = (a.r + c.r) / 2;
      const axis = a.c.map((x, i) => c.c[i] - x), len = Math.hypot(...axis) || 1;
      const u = axis.map(x => x / len);
      const any = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const p1 = [u[1] * any[2] - u[2] * any[1], u[2] * any[0] - u[0] * any[2], u[0] * any[1] - u[1] * any[0]];
      const l1 = Math.hypot(...p1);
      const e1 = p1.map(x => x / l1), e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
      let sum = 0;
      for (const [dir, sign] of [[e1, 1], [e1, -1], [e2, 1], [e2, -1]]) sum += Math.min(nearest(mid.map((x, i) => x + dir[i] * r * sign), Math.max(2 * r, CELL)), 2 * r);
      if (sum / 4 > 0.5 * r) lost.add(`${bi}:${k}`);
    }
  });
  return lost;
}

// Strip quads for chosen segments ("branch:segment"; null for every one): two triangles each,
// as records the chunk writer takes (channels 0 position, 1 normal, 2 tangent, 3 color, 4 uv).
// inset: strips at each ring's rIn, inside the mesh (the skeleton under L1), else its full radius.
function stripQuads(branches, chosen, tubes = new Set(), inset = false) {
  const quads = [];
  branches.forEach((b, bi) => {
    const R = b.rings;
    const dir = k => {
      const p = R[Math.max(0, k - 1)].c, q = R[Math.min(R.length - 1, k + 1)].c;
      const d = q.map((x, i) => x - p[i]), l = Math.hypot(...d) || 1;
      return d.map(x => x / l);
    };
    const width = k => Math.max(inset ? R[k].rIn : R[k].r, 1e-4);
    const vertex = (k, side) => ({ pos: R[k].c, attrs: [R[k].c, dir(k).map(x => x * width(k)), [1, 0, 0, 1], R[k].color, [side, R[k].v], null, null, null] });
    for (let k = 0; k + 1 < R.length; k++) {
      if (chosen && !chosen.has(`${bi}:${k}`)) continue;
      let a = vertex(k, -1), b2 = vertex(k, 1);
      // the first strip after a tube starts back inside it, by its radius, overlapping the tube
      // instead of starting at its rim (Ken, 2026-10-26)
      if (k > 0 && tubes.has(`${bi}:${k - 1}`) && !tubes.has(`${bi}:${k}`)) {
        const back = R[k].c.map((x, i) => x - dir(k)[i] * R[k].r);
        a = { pos: back, attrs: [back, ...a.attrs.slice(1)] };
        b2 = { pos: back, attrs: [back, ...b2.attrs.slice(1)] };
      }
      let c = vertex(k + 1, -1), d = vertex(k + 1, 1);
      // likewise a strip before a tube runs on into it
      if (k + 1 < R.length - 1 && tubes.has(`${bi}:${k + 1}`) && !tubes.has(`${bi}:${k}`)) {
        const on = R[k + 1].c.map((x, i) => x + dir(k + 1)[i] * R[k + 1].r);
        c = { pos: on, attrs: [on, ...c.attrs.slice(1)] };
        d = { pos: on, attrs: [on, ...d.attrs.slice(1)] };
      }
      quads.push({ mid: R[k].c.map((x, i) => (x + R[k + 1].c[i]) / 2), ends: [R[k].c, R[k + 1].c], radius: Math.max(R[k].r, R[k + 1].r), tris: [[a, b2, c], [b2, d, c]] });
    }
  });
  return quads;
}

// Tubes for the thickest segments, within a budget: segments taken thickest first, each a SIDES-sided
// tube (2 SIDES triangles, beside its strip), until the extra triangles reach budget times
// what the whole tree costs in strips. A tube has real depth, so a branch reaching into it is
// hidden there, as on the real tree; strips are flat through their axis, so a branch reaching into
// a thick strip shows across it (Ken, 2026-10-26: the trunk's joins). Returns "branch:segment"s.
const SIDES = 6;
function tubeSegments(branches, budget) {
  const all = [];
  branches.forEach((b, bi) => b.rings.slice(0, -1).forEach((r, k) => all.push({ id: `${bi}:${k}`, r: Math.max(r.r, b.rings[k + 1].r) })));
  all.sort((x, y) => y.r - x.r);
  const allowed = budget * all.length * 2;
  const chosen = new Set();
  let extra = 0;
  for (const seg of all) {
    if (extra + 2 * SIDES > allowed) break;
    chosen.add(seg.id);
    extra += 2 * SIDES;
  }
  return { chosen, radius: chosen.size ? Math.min(...all.slice(0, chosen.size).map(x => x.r)) : 0 };
}

// SIDES-sided tubes for chosen segments, as mesh triangles (records like the chunks': position,
// normal out from the axis, tangent around it, color, uv with u around and the bark's v). Each
// branch's rings share one frame carried along it (parallel transport), so segments meet without
// twisting. Wound to face out. Returns quads-like items { mid, radius, tris } for placeStrips.
function tubeQuads(branches, chosen) {
  const out = [];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  branches.forEach((b, bi) => {
    const R = b.rings;
    if (!R.some((_, k) => chosen.has(`${bi}:${k}`))) return;
    const dir = k => unit(R[Math.min(R.length - 1, k + 1)].c.map((x, i) => x - R[Math.max(0, k - 1)].c[i]));
    // frame per ring: p perpendicular to the branch, carried from ring to ring
    let p = cross(dir(0), Math.abs(dir(0)[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    const frames = R.map((ring, k) => {
      const a = dir(k);
      p = unit(p.map((x, i) => x - a[i] * dot(p, a)));
      return { a, p, q: cross(a, p) };
    });
    const ringVerts = k => Array.from({ length: SIDES + 1 }, (_, j) => {
      const t = (j / SIDES) * 2 * Math.PI, f = frames[k];
      const n = f.p.map((x, i) => x * Math.cos(t) + f.q[i] * Math.sin(t));
      const tangent = unit(f.p.map((x, i) => -x * Math.sin(t) + f.q[i] * Math.cos(t)));
      const pos = R[k].c.map((x, i) => x + n[i] * R[k].r);
      return { pos, attrs: [pos, n, [...tangent, 1], R[k].color, [j / SIDES, R[k].v], null, null, null] };
    });
    for (let k = 0; k + 1 < R.length; k++) {
      if (!chosen.has(`${bi}:${k}`)) continue;
      const v = ringVerts(k), w = ringVerts(k + 1), tris = [];
      for (let j = 0; j < SIDES; j++) {
        for (const t of [[v[j], v[j + 1], w[j + 1]], [v[j], w[j + 1], w[j]]]) {
          const fn = cross(t[1].pos.map((x, i) => x - t[0].pos[i]), t[2].pos.map((x, i) => x - t[0].pos[i]));
          tris.push(dot(fn, t[0].attrs[1]) >= 0 ? t : [t[0], t[2], t[1]]);
        }
      }
      out.push({ mid: R[k].c.map((x, i) => (x + R[k + 1].c[i]) / 2), ends: [R[k].c, R[k + 1].c], radius: Math.max(R[k].r, R[k + 1].r), tris });
    }
  });
  return out;
}

// Strip quads (and tubes) into a level's chunks: each into every chunk whose cell its segment
// passes through (else the chunk nearest its middle). Chunks pick their LOD levels apart, so at a
// boundary between levels a segment drawn by only one chunk could be drawn by neither: its mesh in
// a chunk now at this level, its strip in one at the other (Ken, 2026-10-26: gaps). Copies where
// both draw it are the same and lie over each other.
function placeStrips(g, level, quads) {
  const mine = g.chunks.filter(c => c.level === level);
  const byCell = new Map(mine.map(c => [g.cellKey(g.parts.get(c.part)), c]));
  const plans = new Map(mine.map(c => [c, { c, tris: [], pad: 0 }]));
  for (const q of quads) {
    const hit = new Set();
    for (let i = 0; i <= 8; i++) {
      const c = byCell.get(g.cellKey(q.ends[0].map((x, a) => x + (q.ends[1][a] - x) * i / 8)));
      if (c) hit.add(c);
    }
    if (!hit.size) hit.add(mine.slice().sort((x, y) => Math.hypot(...g.parts.get(x.part).map((v, i) => v - q.mid[i])) - Math.hypot(...g.parts.get(y.part).map((v, i) => v - q.mid[i])))[0]);
    for (const c of hit) {
      const p = plans.get(c);
      p.tris.push(...q.tris);
      p.pad = Math.max(p.pad, q.radius);
    }
  }
  return [...plans.values()];
}

function writeStrips(g, plans, target, suffix = '.strips.asset') {
  for (const p of plans) {
    const template = M.readMesh(g.textOf(p.c));
    const vmap = new Map(), vlist = [], triangles = [];
    for (const t of p.tris) {
      for (const r of t) {
        const local = r.pos.map((x, a) => (x - p.c.offset[a]) / p.c.scale[a]);
        const attrs = template.channels.map((ch, ci) => (ci === 0 ? local : ch.dim ? r.attrs[ci] : null));
        const k = attrs.map(ch => (ch ? ch.map(x => x.toPrecision(7)).join() : '')).join('|');
        if (!vmap.has(k)) {
          vmap.set(k, vlist.length);
          vlist.push(attrs);
        }
        triangles.push(vmap.get(k));
      }
    }
    const attrs = template.channels.map((ch, ci) => (ch.dim ? vlist.map(v => v[ci]) : null));
    if (!attrs[0]) attrs[0] = [];
    const name = (/m_Name: (.*)/.exec(template.text) || [])[1].trim() + suffix.replace(/^\.(\w+)\.asset$/, '_$1');
    const file = target(p.c.path.replace(/\.asset$/, suffix));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, M.writeMesh(template, name, { attrs, triangles }, p.pad));
  }
  return plans.length;
}

function main() {
  const modelPath = option('--source', 'Assets/Meshes/ForestTreeCollider.fbx');
  const prefab = option('--prefab', 'Assets/Prefabs/Trees/StdTreeLods.prefab');
  const qualities = option('--qualities', '100,50,25').split(',').map(Number);
  const slack = +option('--slack', 0.25), scale = +option('--scale', 10);
  const write = process.argv.includes('--write'), candidate = process.argv.includes('--candidate');
  const target = p => (candidate ? path.join(__dirname, '..', 'cache', 'candidates', p) : path.join(S.REPO, p));
  const mesh = source(modelPath);
  console.log(`${modelPath}: ${mesh.triangles.length / 3} triangles, ${mesh.positions.length} vertices`);
  if (!process.argv.includes('--no-caps')) {
    const c = capTips(mesh, scale, process.argv.includes('--fans'), +option('--merge-radius', 0.05), +option('--snub', 0.5));
    console.log(`  tips: ${c.merged} merged to a point, ${c.capped} capped with a fan (of ${c.branches} branches; ${c.closed} already close to a point)`);
  }
  const g = D.grid(prefab, 0);
  if (g.levels.length !== qualities.length) throw new Error(`${prefab} has ${g.levels.length} levels; give as many --qualities`);
  console.log(`${prefab}: ${g.parts.size} parts, cell ${+g.cell.toFixed(4)} mesh units, slack ${slack}`);
  const progressive = Mantis.progressive({ positions: mesh.positions, triangles: mesh.triangles, normals: mesh.normals, colors: mesh.colors, uvs: mesh.uvs },
    { protect_boundary: 0, protect_detail: 0, protect_symmetry: 0, protect_normal: 0, protect_shape: 0, use_detail_map: 0, detail_boost: 10 });
  // A vertex as the dicer takes it: its place and every channel, at Unity's channel numbers
  // (0 position, 1 normal, 2 tangent, 3 color, 4 uv).
  const recs = mesh.positions.map((p, v) => ({ pos: p, attrs: [p, mesh.normals[v], mesh.tangents[v], mesh.colors[v], mesh.uvs[v], null, null, null] }));
  let written = 0;
  const planned = [], stripPlans = [];
  const stripRule = Object.fromEntries(option('--strips', 'L1:skeleton,L2:all').split(',').filter(Boolean).map(x => x.split(':')));
  const branches = Object.keys(stripRule).length ? skeleton(mesh) : [];
  if (branches.length) console.log(`skeleton: ${branches.length} branches, ${branches.reduce((s, b) => s + b.rings.length - 1, 0)} segments (${branches.cut} ended early where a layer was no ring)`);
  g.levels.forEach((level, n) => {
    const rule = stripRule[level];
    const tri = rule === 'all' ? [] : qualities[n] >= 100 ? mesh.triangles : progressive(qualities[n]);
    // Mantis can leave a face twice, or flat: drop repeats (same corners, same winding) and faces
    // with two corners in one place.
    const triangles = [], seen = new Set();
    let dropped = 0;
    for (let k = 0; k < tri.length; k += 3) {
      const t = [recs[tri[k]], recs[tri[k + 1]], recs[tri[k + 2]]];
      const keys = t.map(r => r.pos.join());
      const turn = keys.indexOf([...keys].sort()[0]);
      const id = [0, 1, 2].map(i => keys[(turn + i) % 3]).join('|');
      if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2] || seen.has(id)) {
        dropped++;
        continue;
      }
      seen.add(id);
      triangles.push(t);
    }
    const placed = D.placeLevel(g, level, triangles, slack);
    const before = D.check(triangles), after = D.check(placed.all);
    const shipped = g.chunks.filter(c => c.level === level).reduce((s, c) => s + M.readMesh(g.textOf(c)).triangles.length / 3, 0);
    console.log(`${level} (quality ${qualities[n]}): ${triangles.length} triangles whole${dropped ? ` (${dropped} repeated or flat dropped)` : ''}; diced: ${placed.summary}; shipped now ${shipped}`);
    console.log(`  check: area ${before.area.toFixed(3)} -> ${after.area.toFixed(3)}, open edges ${before.open} -> ${after.open}`);
    planned.push(placed.plans);
    if (write || candidate) written += D.writePlans(g, placed.plans, target);
    // strips: for the segments this level's mesh lost, or all of them
    let strips = [];
    if (rule === 'all') {
      // the thickest segments as tubes too, within the budget, and every segment a strip: in a tube
      // the strip rounds its hexagonal outline and keeps the strips unbroken where a branch turns
      // from tube to strip; the tube gives the depth (Ken, 2026-10-26)
      const tubes = tubeSegments(branches, +option('--tube-budget', 0.2));
      const meshPlans = placeStrips(g, level, tubeQuads(branches, tubes.chosen));
      planned[planned.length - 1] = meshPlans;
      if (write || candidate) written += D.writePlans(g, meshPlans, target);
      console.log(`  tubes: ${tubes.chosen.size} segments of radius ${(tubes.radius * scale).toFixed(2)} m and more, ${SIDES} sides, ${meshPlans.reduce((s2, p) => s2 + p.tris.length, 0)} triangles`);
      strips = placeStrips(g, level, stripQuads(branches, null, tubes.chosen));
    }
    else if (rule === 'skeleton') {
      // every segment, inset inside the mesh: fills whatever the level's mesh lacks (seams with
      // neighbouring chunks at other levels, branches Mantis dropped) and hides under it elsewhere.
      // Not at L0, where the player is (Ken, 2026-10-26).
      strips = placeStrips(g, level, stripQuads(branches, null, new Set(), true));
    } else if (rule === 'lost') {
      const lost = lostSegments(branches, mesh.positions, tri);
      strips = placeStrips(g, level, stripQuads(branches, lost));
    }
    stripPlans.push(strips);
    if (strips.length) {
      console.log(`  strips: ${strips.reduce((s, p) => s + p.tris.length, 0) / 2} segments (${rule}), ${strips.reduce((s, p) => s + p.tris.length, 0)} triangles`);
      if (write || candidate) written += writeStrips(g, strips, target);
    }
  });
  // LOD cutoffs that spend part of the triangles saved (--lod-spend, 0.5) on drawing levels
  // farther: the GridGroup's cutoffs scaled by one factor (distances by its inverse) until the
  // candidate draws, on average, the shipped tree's triangles less (1 - spend) of the saving.
  const grid = U.gridSettings(path.basename(prefab, '.prefab'));
  const fov = +option('--fov', 90), spend = +option('--lod-spend', 0.5), around = +option('--around', 30);
  const byPart = (tris, count) => {
    const out = new Map();
    g.levels.forEach((level, n) => {
      for (const c of g.chunks.filter(x => x.level === level)) {
        const e = out.get(c.part) || out.set(c.part, { centre: g.parts.get(c.part).map(x => x * scale), tris: [] }).get(c.part);
        e.tris[n] = count(c, n);
      }
    });
    return [...out.values()];
  };
  const shippedChunks = byPart(null, c => M.readMesh(g.textOf(c)).triangles.length / 3);
  const candidateChunks = byPart(null, (c, n) => (planned[n].find(p => p.c === c) || { tris: [] }).tris.length + ((stripPlans[n] || []).find(p => p.c === c) || { tris: [] }).tris.length);
  const size = grid.objectSize * scale;
  const shippedAvg = drawnAverage(shippedChunks, size, grid.cutoffs, fov, around);
  const sameAvg = drawnAverage(candidateChunks, size, grid.cutoffs, fov, around);
  const goal = sameAvg + (shippedAvg - sameAvg) * spend;
  // --lod-mode uniform: every cutoff scaled alike; far (default): the levels keep their cutoffs
  // but the last, where a chunk stops drawing (the worst pop), moves out.
  const mode = option('--lod-mode', 'far');
  const scaled = m => (mode === 'uniform' ? grid.cutoffs.map(c => c * m) : grid.cutoffs.map((c, i) => (i === grid.cutoffs.length - 1 ? c * m : c)));
  let a = 0.005, b = 1;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (drawnAverage(candidateChunks, size, scaled(m), fov, around) > goal) a = m;
    else b = m;
  }
  let cutoffs = scaled((a + b) / 2).map(c => +c.toFixed(2));
  if (stripRule[g.levels[g.levels.length - 1]] === 'all') {
    // the last level is strips: cheap enough to draw out to the far clip
    const far = +option('--far', 400);
    cutoffs = [...grid.cutoffs.slice(0, -1), +(size / (2 * Math.tan(fov * Math.PI / 360) * far) * 100).toFixed(2)];
  }
  const metres = cs => cs.map(c => Math.round(size / (2 * Math.tan(fov * Math.PI / 360) * c / 100))).join('/');
  console.log(`LOD cutoffs (% of view height, ${fov} degree view): shipped ${grid.cutoffs.join('/')} (levels end at ${metres(grid.cutoffs)} m), drawing on average ${Math.round(shippedAvg)} triangles; the candidate at those draws ${Math.round(sameAvg)}; chosen (${stripRule[g.levels[g.levels.length - 1]] === 'all' ? 'last level strips, to --far' : `spending ${spend * 100}% of the saving, ${mode}`}): ${cutoffs.join('/')} (levels end at ${metres(cutoffs)} m), drawing ${Math.round(drawnAverage(candidateChunks, size, cutoffs, fov, around))}`);
  // The candidate's cutoffs beside its meshes, for Layout (☰ Candidate trees uses them).
  if (candidate) {
    const file = path.join(__dirname, '..', 'cache', 'candidates', prefab + '.lod.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cutoffs }));
  }
  if (write || candidate) console.log(`wrote ${written} chunk meshes${candidate ? ' to cache/candidates' : ''}`);
}

if (require.main === module) main();

module.exports = { source, capTips, skeleton, tubeSegments, tubeQuads, stripQuads, placeStrips };
