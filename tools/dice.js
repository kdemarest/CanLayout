// Re-chunks a gridded Canopy tree with whole triangles (docs: Rendering Performance, Trees).
// CanopyGrid (github kdemarest/CanopyGrid: Dicer.cs, GridSlicer.cs) made each tree's chunks in
// Unity: Mantis reduced the whole tree to each LOD's quality, then BzKovSoft's slicer cut it with
// planes on a grid (sliceDim / scale apart, from the reduced mesh's bounds), splitting every
// triangle a plane crosses, into partXYZ/L0..Ln meshes. Splitting doubled the trees' triangles.
// This does the cut again from the shipped chunks, in two steps per LOD level:
// 1. Unslice: rebuild the whole tree that level was cut from. Cut vertices lie on the grid planes;
//    pieces of one triangle share edges through cut vertices and lie in one plane, so they are
//    joined and the triangle is rebuilt from its corners (vertices off the planes). Pieces that
//    don't join up (slivers) are kept as they are.
// 2. Dice: each triangle goes whole to the chunk of the cell holding its centre when it reaches no
//    more than --slack (a fraction of a cell, default 0.25) past that cell's faces. Only longer
//    triangles are cut, by every plane they cross; a whole triangle beside a cut one gets the
//    same points on their shared edge (fanned from its centre), so no cracks open.
// The chunk files are rewritten in place (same names and guids; the prefab is untouched), with
// their own vertex layout; a chunk left with no triangles is written empty.
//   node tools/dice.js                  report, for StdTreeLods (the Beech, Oak, Maple and tutorial trees)
//   node tools/dice.js --candidate      write the chunks to layout's cache/candidates/ (the same paths
//                                       as in Canopy), for comparing in Layout (☰ Candidate trees)
//   node tools/dice.js --write          rewrite the chunks in the Canopy working tree
//   options: --prefab <path>, --cell <mesh units> (default: from the part spacing), --slack 0.25
// Meshes are read from the Canopy working tree when checked out (so tip caps from tree-tips.js
// stay, and a rerun gives the same result), else from git.
const fs = require('fs');
const path = require('path');
const S = require('./scene.js');
const T = require('./tree-tips.js');
const M = require('./unity-mesh.js');

const PLANE_EPS = 2e-4; // how near a grid plane a cut vertex is (mesh units)
const COPLANAR = 1e-3; // how far from a piece's plane its neighbor's vertices may be

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => Math.hypot(a[0], a[1], a[2]);
const posKey = p => p.map(x => Math.round(x / 1e-4)).join();

// A vertex: its position in the prefab's space and every channel's values (channel 0, the local
// position, is recomputed when written). Mixing interpolates all channels; normals (channel 1) and
// tangents (channel 2, w kept) are renormalized.
function mix(recs, weights) {
  const pos = [0, 1, 2].map(a => recs.reduce((s, r, i) => s + r.pos[a] * weights[i], 0));
  const attrs = recs[0].attrs.map((ch, c) => {
    if (!ch) return null;
    const v = ch.map((_, d) => recs.reduce((s, r, i) => s + r.attrs[c][d] * weights[i], 0));
    if (c === 1 || c === 2) {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      for (let d = 0; d < 3; d++) v[d] /= l;
      if (c === 2 && v.length > 3) v[3] = recs[0].attrs[c][3];
    }
    return v;
  });
  return { pos, attrs };
}

// ---- 1. unslice ----

// Removes the cut vertices: each one whose surrounding triangles lie in one plane, or in two meeting
// in a straight crease through it (a cut vertex on an original edge), is taken out and each
// plane's hole is triangulated again, from that plane's own vertices (so UV seams along the crease
// stay); on the mesh's edge, only where its two edge neighbors are in line with it. Neighbors must
// agree on every channel within a plane.
// Removing vertex after vertex undoes the slicing, whatever shape the pieces took.
function unslice(recs, faces, lo, hi, cell) {
  const onPlane = p => [0, 1, 2].some(a => {
    const k = Math.round((p[a] - lo[a]) / cell);
    return k > 0 && lo[a] + k * cell < hi[a] - PLANE_EPS && Math.abs(p[a] - (lo[a] + k * cell)) < PLANE_EPS;
  });
  const weld = new Map();
  const wid = r => {
    const k = posKey(r.pos);
    if (!weld.has(k)) weld.set(k, weld.size);
    return weld.get(k);
  };
  // faces as records; around[w] = live faces touching welded vertex w
  const live = faces.map(f => f.map(v => recs[v]));
  const alive = live.map(() => true);
  const W = live.map(f => f.map(wid));
  const around = new Map();
  const touch = i => W[i].forEach(w => (around.get(w) || around.set(w, new Set()).get(w)).add(i));
  live.forEach((_, i) => touch(i));
  const cuts = [...new Set(recs.filter(r => onPlane(r.pos)).map(wid))];
  const same = (a, b) => a === b || a.attrs.every((ch, c) => c === 0 || !ch || ch.every((x, d) => Math.abs(x - b.attrs[c][d]) < 1e-3));
  let removed = 0;
  for (let pass = 0; pass < 3; pass++) {
    let any = false;
    for (const v of cuts) {
      const fs_ = [...(around.get(v) || [])].filter(i => alive[i]);
      if (!fs_.length) continue;
      // The fan's faces in at most two planes (a cut vertex lies inside one original triangle, or
      // on the edge between two), each plane's faces a run around v.
      const areaOf = i => norm(cross(sub(live[i][1].pos, live[i][0].pos), sub(live[i][2].pos, live[i][0].pos)));
      const order = fs_.slice().sort((x, y) => areaOf(y) - areaOf(x));
      if (areaOf(order[0]) < 1e-12) continue;
      const planes = [];
      for (const i of order) {
        const fit = planes.find(pl => live[i].every(r => Math.abs(dot(pl.n, sub(r.pos, pl.p))) < COPLANAR));
        if (fit) fit.faces.push(i);
        else {
          const ar = areaOf(i);
          if (ar < 1e-12) { planes.length = 3; break; }
          planes.push({ n: cross(sub(live[i][1].pos, live[i][0].pos), sub(live[i][2].pos, live[i][0].pos)).map(x => x / ar), p: live[i][0].pos, faces: [i] });
        }
      }
      if (planes.length > 2) continue;
      const p = live[fs_[0]][W[fs_[0]].indexOf(v)].pos;
      const between = (x, y) => {
        const ab = sub(y, x), t = dot(sub(p, x), ab) / dot(ab, ab);
        return t > 0 && t < 1 && norm(sub(p, x.map((c, i) => c + ab[i] * t))) < PLANE_EPS;
      };
      const chains = [];
      let ok = true;
      for (const pl of planes) {
        // for each face (v, a, b) in winding order, the edge a -> b
        const next = new Map(), rec = new Map();
        for (const i of pl.faces) {
          const k = W[i].indexOf(v);
          const x = W[i][(k + 1) % 3], y = W[i][(k + 2) % 3];
          if (next.has(x)) ok = false;
          next.set(x, y);
          for (const [w, r] of [[x, live[i][(k + 1) % 3]], [y, live[i][(k + 2) % 3]]]) {
            if (rec.has(w) && !same(rec.get(w), r)) ok = false;
            else rec.set(w, r);
          }
        }
        if (!ok) break;
        const into = new Set(next.values());
        const starts = [...next.keys()].filter(x => !into.has(x));
        if (starts.length > 1) { ok = false; break; }
        const ring = [];
        for (let at = starts.length ? starts[0] : next.keys().next().value; at !== undefined && ring.length <= next.size; at = next.get(at)) {
          ring.push(at);
          if (!starts.length && next.get(at) === ring[0]) break;
        }
        const closed = !starts.length;
        if (ring.length !== (closed ? next.size : next.size + 1)) { ok = false; break; }
        chains.push({ ring, rec, closed });
      }
      if (!ok) continue;
      if (chains.length === 2) {
        // two planes meeting in a straight crease through v
        const [c1, c2] = chains;
        if (c1.closed || c2.closed || c1.ring[c1.ring.length - 1] !== c2.ring[0] || c2.ring[c2.ring.length - 1] !== c1.ring[0]) continue;
        if (!between(c1.rec.get(c1.ring[0]).pos, c1.rec.get(c1.ring[c1.ring.length - 1]).pos)) continue;
      } else if (!chains[0].closed) {
        // on the mesh's edge: v in line between the two ends
        const c = chains[0];
        if (!between(c.rec.get(c.ring[0]).pos, c.rec.get(c.ring[c.ring.length - 1]).pos)) continue;
      }
      const tris = [];
      for (const c of chains) if (c.ring.length >= 3) tris.push(...triangulate(c.ring.map(w => c.rec.get(w))));
      for (const i of fs_) alive[i] = false;
      for (const t of tris) {
        live.push(t);
        alive.push(true);
        W.push(t.map(wid));
        touch(live.length - 1);
      }
      around.delete(v);
      removed++;
      any = true;
    }
    if (!any) break;
  }
  const out = live.filter((_, i) => alive[i]);
  const left = cuts.filter(v => [...(around.get(v) || [])].some(i => alive[i])).length;
  return { triangles: out, removed, left, faces: faces.length };
}

// A planar polygon (in winding order) as triangles, by ear clipping (convex ones fan the same).
function triangulate(poly) {
  const n = cross(sub(poly[1].pos, poly[0].pos), sub(poly[2].pos, poly[0].pos));
  for (let i = 2; i + 1 < poly.length; i++) {
    const m = cross(sub(poly[i].pos, poly[0].pos), sub(poly[i + 1].pos, poly[0].pos));
    for (let a = 0; a < 3; a++) n[a] += m[a];
  }
  const out = [];
  const left = poly.slice();
  let guard = 0;
  while (left.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < left.length; i++) {
      const a = left[(i - 1 + left.length) % left.length], b = left[i], c = left[(i + 1) % left.length];
      if (dot(cross(sub(b.pos, a.pos), sub(c.pos, a.pos)), n) <= 0) continue; // reflex or flat
      const inside = left.some(p => p !== a && p !== b && p !== c &&
        dot(cross(sub(b.pos, a.pos), sub(p.pos, a.pos)), n) > 0 && dot(cross(sub(c.pos, b.pos), sub(p.pos, b.pos)), n) > 0 && dot(cross(sub(a.pos, c.pos), sub(p.pos, c.pos)), n) > 0);
      if (inside) continue;
      out.push([a, b, c]);
      left.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  for (let i = 1; i + 1 < left.length; i++) out.push([left[0], left[i], left[i + 1]]);
  return out;
}

// ---- 2. dice ----

function dice(triangles, cells, cell, slack) {
  // cells: Map "x,y,z" -> { centre }; a triangle's home is the cell of its centre.
  const lo = [0, 1, 2].map(a => Math.min(...[...cells.values()].map(c => c.centre[a])) - cell / 2);
  const cellOf = p => p.map((x, a) => Math.floor((x - lo[a]) / cell));
  const fits = (t, c) => [0, 1, 2].every(a => t.every(r => r.pos[a] >= lo[a] + (c[a] - slack) * cell - 1e-9 && r.pos[a] <= lo[a] + (c[a] + 1 + slack) * cell + 1e-9));
  const centreOf = t => [0, 1, 2].map(a => (t[0].pos[a] + t[1].pos[a] + t[2].pos[a]) / 3);
  const ids = new Map();
  const id = r => {
    const k = posKey(r.pos);
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const tri = triangles.map(t => ({ t, ids: t.map(id), home: cellOf(centreOf(t)) }));
  const split = new Set(tri.filter(x => !fits(x.t, x.home)).map((_, i) => i));
  const splitList = tri.map((x, i) => i).filter(i => !fits(tri[i].t, tri[i].home));
  split.clear();
  splitList.forEach(i => split.add(i));
  // Points where grid planes cross an edge, the same for both triangles sharing it: computed from
  // the edge's ends in a fixed order (by id), sorted along the edge from its lower-id end.
  const planesCrossing = (p, q, a) => {
    const out = [];
    const k0 = Math.floor((Math.min(p[a], q[a]) - lo[a]) / cell) + 1, k1 = Math.ceil((Math.max(p[a], q[a]) - lo[a]) / cell) - 1;
    for (let k = k0; k <= k1; k++) out.push(lo[a] + k * cell);
    return out;
  };
  function edgePoints(ra, rb, ia, ib) {
    const [r0, r1] = ia < ib ? [ra, rb] : [rb, ra];
    const pts = [];
    for (let a = 0; a < 3; a++) {
      for (const c of planesCrossing(r0.pos, r1.pos, a)) {
        const t = (c - r0.pos[a]) / (r1.pos[a] - r0.pos[a]);
        if (t > 1e-9 && t < 1 - 1e-9) pts.push({ t, rec: mix([r0, r1], [1 - t, t]) });
      }
    }
    pts.sort((x, y) => x.t - y.t);
    return ia < ib ? pts : pts.reverse().map(x => ({ t: 1 - x.t, rec: x.rec }));
  }
  const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const splitEdges = new Set();
  for (const i of split) for (let k = 0; k < 3; k++) splitEdges.add(edgeKey(tri[i].ids[k], tri[i].ids[(k + 1) % 3]));
  const out = new Map(); // cell key -> triangles
  const put = (c, t) => {
    const k = c.join();
    (out.get(k) || out.set(k, []).get(k)).push(t);
  };
  let pieces = 0, fanned = 0;
  tri.forEach((x, i) => {
    // The triangle's outline with every plane point on its edges.
    const ring = [];
    let extra = false;
    for (let k = 0; k < 3; k++) {
      const a = x.t[k], b = x.t[(k + 1) % 3];
      ring.push({ rec: a });
      if (split.has(i) || splitEdges.has(edgeKey(x.ids[k], x.ids[(k + 1) % 3]))) {
        const pts = edgePoints(a, b, x.ids[k], x.ids[(k + 1) % 3]);
        if (pts.length) extra = true;
        for (const p of pts) ring.push({ rec: p.rec });
      }
    }
    if (!split.has(i)) {
      if (!extra) put(x.home, x.t);
      else {
        // a whole triangle beside a cut one: fan from its centre through the shared points
        const mid = mix(x.t, [1 / 3, 1 / 3, 1 / 3]);
        for (let k = 0; k < ring.length; k++) put(x.home, [mid, ring[k].rec, ring[(k + 1) % ring.length].rec]);
        fanned++;
      }
      return;
    }
    // A cut triangle: clip its outline into each cell it reaches; points on its edges are the
    // shared ones above, points inside it come from clipping.
    const cellsHit = new Map();
    clip(ring.map(r => r.rec), 0);
    function clip(poly, axis) {
      if (poly.length < 3) return;
      if (axis === 3) {
        const c = cellOf([0, 1, 2].map(a => poly.reduce((s, r) => s + r.pos[a], 0) / poly.length));
        for (let k = 1; k + 1 < poly.length; k++) put(c, [poly[0], poly[k], poly[k + 1]]);
        cellsHit.set(c.join(), true);
        pieces++;
        return;
      }
      const ps = poly.map(r => r.pos[axis]);
      const k0 = Math.floor((Math.min(...ps) - lo[axis]) / cell), k1 = Math.floor((Math.max(...ps) - lo[axis]) / cell);
      for (let k = k0; k <= k1; k++) {
        const a = lo[axis] + k * cell, b = a + cell;
        clip(slab(poly, axis, a, b), axis + 1);
      }
    }
    // The part of a convex polygon between two planes; vertices already on a plane are kept.
    function slab(poly, axis, a, b) {
      return half(half(poly, axis, a, 1), axis, b, -1);
    }
    function half(poly, axis, c, side) {
      const out2 = [];
      const inside = r => side * (r.pos[axis] - c) >= -1e-9;
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k], q = poly[(k + 1) % poly.length];
        const ip = inside(p), iq = inside(q);
        if (ip) out2.push(p);
        if (ip !== iq) {
          const t = (c - p.pos[axis]) / (q.pos[axis] - p.pos[axis]);
          const onP = Math.abs(p.pos[axis] - c) < 1e-9, onQ = Math.abs(q.pos[axis] - c) < 1e-9;
          if (!onP && !onQ) out2.push(existing(p, q, t) || mix([p, q], [1 - t, t]));
        }
      }
      return out2;
    }
    // A crossing on one of the triangle's edges is the shared point already in the ring.
    function existing(p, q, t) {
      const pos = p.pos.map((x, a) => x + (q.pos[a] - x) * t);
      return ring.map(r => r.rec).find(r => Math.hypot(...sub(r.pos, pos)) < 1e-7) || null;
    }
  });
  return { cells: out, split: split.size, pieces, fanned };
}

// Checks on a set of triangles (records): surface area, and open edges (used by one triangle,
// vertices joined by position), so a crack the cutting opened would show as more of them.
function check(tris) {
  const count = new Map();
  let area = 0;
  for (const t of tris) {
    area += norm(cross(sub(t[1].pos, t[0].pos), sub(t[2].pos, t[0].pos))) / 2;
    const k = t.map(r => posKey(r.pos));
    for (let i = 0; i < 3; i++) {
      if (k[i] === k[(i + 1) % 3]) continue;
      const e = k[i] < k[(i + 1) % 3] ? k[i] + '|' + k[(i + 1) % 3] : k[(i + 1) % 3] + '|' + k[i];
      count.set(e, (count.get(e) || 0) + 1);
    }
  }
  let open = 0;
  for (const n of count.values()) if (n === 1) open++;
  return { area, open };
}

// A gridded tree's chunks (from its prefab): each with its level (L0...), part, offset and
// text, the parts' cell centres, the cell size, and the cell key of a point.
function grid(prefab, cellSize) {
  const chunks = T.prefabMeshes(prefab).map(c => ({ ...c, level: (/_(L\d+)\.asset$/.exec(c.path) || [])[1], part: (/_(part\d+)_L\d+\.asset$/.exec(c.path) || [])[1] })).filter(c => c.level && c.part);
  const onDisk = new Map(chunks.filter(c => fs.existsSync(path.join(S.REPO, c.path))).map(c => [c.path, fs.readFileSync(path.join(S.REPO, c.path), 'utf8')]));
  const blobs = S.blobs(chunks.filter(c => !onDisk.has(c.path)).map(c => c.blob));
  const textOf = c => onDisk.get(c.path) || blobs.get(c.blob).toString();
  // Cells: each part's centre is its L0 chunk's offset (CanopyGrid put parts at cell centres).
  const parts = new Map();
  for (const c of chunks) if (!parts.has(c.part) || c.level === 'L0') parts.set(c.part, c.offset);
  const centres = [...parts.values()];
  const spacing = a => Math.min(...centres.flatMap(p => centres.map(q => Math.abs(p[a] - q[a]))).filter(d => d > 1e-4));
  const cell = cellSize || Math.min(spacing(0), spacing(1), spacing(2));
  const loCell = [0, 1, 2].map(a => Math.min(...centres.map(p => p[a])) - cell / 2);
  const cellKey = p => p.map((x, a) => Math.floor((x - loCell[a]) / cell)).join();
  const levels = [...new Set(chunks.map(c => c.level))].sort();
  return { chunks, textOf, parts, cell, loCell, cellKey, levels };
}

// One level's triangles (records in the prefab's space) diced into that level's chunks: plans
// [{ c (chunk), tris }] and what happened.
function placeLevel(g, level, triangles, slack) {
  const mine = g.chunks.filter(c => c.level === level);
  const byCell = new Map(mine.map(c => [g.cellKey(g.parts.get(c.part)), c]));
  const cells = new Map([...g.parts.values()].map(p => [g.cellKey(p), { centre: p }]));
  const d = dice(triangles, cells, g.cell, slack);
  let tris = 0, orphans = 0, empty = 0;
  const plans = mine.map(c => ({ c, tris: [...(d.cells.get(g.cellKey(g.parts.get(c.part))) || [])] }));
  for (const [k, ts] of d.cells) {
    if (byCell.has(k)) continue;
    // no chunk of this level in that cell: the nearest one takes it
    const [x, y, z] = k.split(',').map(Number);
    const centre = [x, y, z].map((i, a) => g.loCell[a] + (i + 0.5) * g.cell);
    const near = mine.slice().sort((p, q) => norm(sub(g.parts.get(p.part), centre)) - norm(sub(g.parts.get(q.part), centre)))[0];
    plans.find(p => p.c === near).tris.push(...ts);
    orphans += ts.length;
  }
  for (const p of plans) {
    tris += p.tris.length;
    if (!p.tris.length) empty++;
  }
  const summary = `${tris} triangles in ${mine.length} chunks, ${d.split} cut into ${d.pieces} pieces, ${d.fanned} fanned beside them${orphans ? `, ${orphans} moved to a neighbor chunk` : ''}${empty ? `, ${empty} chunks left empty` : ''}`;
  return { plans, tris, summary, all: plans.flatMap(p => p.tris) };
}

// Writes each planned chunk, with its own file's vertex layout, to target(path).
function writePlans(g, plans, target) {
  for (const p of plans) {
    const template = M.readMesh(g.textOf(p.c));
    // shared vertices: same position and channels
    const vmap = new Map(), vlist = [];
    const triangles = [];
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
    const name = (/m_Name: (.*)/.exec(template.text) || [])[1].trim();
    fs.mkdirSync(path.dirname(target(p.c.path)), { recursive: true });
    fs.writeFileSync(target(p.c.path), M.writeMesh(template, name, { attrs, triangles }));
  }
  return plans.length;
}

function main() {
  const prefab = option('--prefab', 'Assets/Prefabs/Trees/StdTreeLods.prefab');
  const slack = +option('--slack', 0.25);
  const write = process.argv.includes('--write'), candidate = process.argv.includes('--candidate');
  const target = p => (candidate ? path.join(__dirname, '..', 'cache', 'candidates', p) : path.join(S.REPO, p));
  const g = grid(prefab, +option('--cell', 0));
  console.log(`${prefab}: ${g.parts.size} parts, cell ${+g.cell.toFixed(4)} mesh units, slack ${slack}`);
  let written = 0;
  for (const level of g.levels) {
    const mine = g.chunks.filter(c => c.level === level);
    const recs = [], faces = [];
    for (const c of mine) {
      const m = M.readMesh(g.textOf(c));
      const base = recs.length;
      for (let v = 0; v < m.attrs[0].length; v++) recs.push({ pos: m.attrs[0][v].map((x, a) => x * c.scale[a] + c.offset[a]), attrs: m.attrs.map(ch => ch && ch[v]) });
      for (let t = 0; t < m.triangles.length; t += 3) faces.push([m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]].map(x => base + x));
    }
    const lo = [0, 1, 2].map(a => Math.min(...recs.map(r => r.pos[a])));
    const hi = [0, 1, 2].map(a => Math.max(...recs.map(r => r.pos[a])));
    const whole = unslice(recs, faces, lo, hi, g.cell);
    const placed = placeLevel(g, level, whole.triangles, slack);
    const before = check(faces.map(f => f.map(i => recs[i]))), after = check(placed.all);
    console.log(`  check: area ${before.area.toFixed(3)} -> ${after.area.toFixed(3)}, open edges ${before.open} -> ${after.open}`);
    console.log(`${level}: ${whole.faces} triangles now; rebuilt ${whole.triangles.length} whole (${whole.removed} cut vertices removed, ${whole.left} left); diced: ${placed.summary} (${(100 * placed.tris / whole.faces).toFixed(0)}%)`);
    if (write || candidate) written += writePlans(g, placed.plans, target);
  }
  if (write || candidate) console.log(`wrote ${written} chunk meshes${candidate ? ' to cache/candidates' : ''}`);
}

if (require.main === module) main();

module.exports = { unslice, dice, triangulate, grid, placeLevel, writePlans, check };
