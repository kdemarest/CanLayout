// Cleans a Canopy mesh built of branches (a tree's uncut collider, e.g. the Tangle's), and shows
// what it found for inspection in layout:
//   node tools/mesh-clean.js <Assets/... mesh> [--inspect <Prefix> [--material <name>]] [--skip rejoin] [--write]
//       [--texture-only] [--from <local mesh file>]
// --texture-only does nothing but texture every branch afresh (the last step, below); --from reads
// the mesh from a local file (another tool's output, e.g. tools/mesh-hub.js --out) instead of Canopy's.
// It finds:
//   orphans      pieces of 12 triangles or fewer away from every branch's open end (stray
//                polygons; a tip cap sitting on an open end is kept). Removed.
//   segments     each branch's rings, spread from its base (its widest open end), and each pair
//                of consecutive rings classed by how they are joined: straight across, turned
//                (each ring vertex joined to the next ring's vertex a step round: A B C to E F D),
//                unclear (rings of different sizes), or self-crossing (the segment's triangles
//                cross each other: the hourglass). Where: at the trunk origin (the point the
//                branches grew from, where the most bases gather), at a tip (a branch's last), or
//                elsewhere.
//   flat         a branch that flattens (Ken, 2026-10-28). A ring's roundness: its points, seen square
//                to the branch, their narrower spread over their wider (a line of 1 or 2 vertices: 0;
//                a squashed triangle about 0.58). A ribbon (only among thin branches, middle rings of 4 vertices or fewer:
//                on a trunk the traced layers are no flat rings, and roundness means nothing): its
//                middle rings' mean roundness under 0.4, or more than half of
//                them lines with its middle thin (median thinnest spread, each ring with its
//                neighbours, under 0.6 of the next); cut at its first ring under 0.4. Or a branch
//                flattening partway: a line ring whose points around lie nearly in one plane (under
//                a quarter); cut there. The branch is cut there, its last
//                kept ring merged to a point (as tips are), and everything down branch from the
//                cut goes too: each branch whose base sits inside a removed ring (within its
//                radius of its centre, a little over) and is no thicker than it, and theirs. (A
//                fat branch merely touching a small removed ribbon stays: Ken, 2026-10-28.)
//   mouths       a branch with a second open end, no pinhole, touching no other piece: it ends
//                hollow (Ken, 2026-10-28: one flaring into a ragged, open end). Traced from the end
//                it grows from (the one touching other pieces), its mouth closed to a point as a
//                flat end is (below), then judged by the rules like any branch; never the trunk.
//   sheets       a closed piece (no open end: capped at both, traced from the vertex nearest another
//                piece) whose thickness is under 0.3 of its width (Ken, 2026-10-28). Removed whole;
//                what hung only from it goes as floating.
//   points       a branch that comes to a point (a ring of 1 vertex, or under 0.15 of its median
//                ring radius) after having been wide (half its median or more), with more after it
//                (Ken, 2026-10-28: the stick some Tangle branches end in): everything past the
//                point goes, with what grows from it. The trunk start, where branches begin at
//                MTree's single point, never counts: a branch must be wide before its point, and a
//                point within 1 unit (5 m at the Tangle's scale) of the trunk origin is spared.
//   flat tips    a round branch ending in a flat blade too long to snub (below): its last rings,
//                past the point it closes to, all squashed (roundness under 0.4), two or more, right
//                after a round ring (Ken, 2026-10-28). The blade stays; only its last wide ring
//                closes to a point, with anything past it.
//   flat ends    a branch kept whole whose end collapses (Ken, 2026-10-28): one of its last three
//                rings is a line or squashed (a pinch; an open ring may follow it). Everything
//                past its last round ring before the pinch (3 or more vertices, roundness 0.4 or
//                more; at most three rings, never at the trunk origin) merges into one point, a
//                snub nose: at the
//                middle of those end vertices, but at least half that ring's radius out along the
//                branch, so the nose is never flat.
//   floating     branches in midair (Ken, 2026-10-28): not connected, through branches that touch
//                (their triangles cross, or one's base sits inside the other's tube), to a branch
//                at the trunk origin; branches removed whole above connect nothing. Removed.
//   kinks        a kept branch's middle ring pinched to a line (2 vertices) between round rings
//                (Ken, 2026-10-28): rounded out with two new vertices across the line, at its
//                neighbours' mean radius (UVs between the line's two), and its segments zipped again.
//   pinpoints    a tip ending in 2 or more vertices about 1 cm apart (most end in one) merged into one
//                point (Ken, 2026-10-28), not cut as broken.
//   round starts an exposed start's first segment rebuilt as a clean tube: its rim a regular circle,
//                evenly spaced, lined up with its next ring, then tucked (Ken, 2026-10-28).
//   dense starts a start ring with twice its next ring's vertices or more keeps one per next-ring vertex
//                (the nearest round the branch), zipped again (Ken, 2026-10-28).
//   slivers      after the rest, needle triangles (quality under 0.15, two vertices crowded together)
//                have their short edge collapsed, where the tube stays closed (Ken, 2026-10-28).
//   texture      last, every branch textured afresh from its start to its end: U round it from a
//                reference carried along it, V along it, at its own old proportion (Ken, 2026-10-28).
//   starts       each exposed branch start (an open base whose rim pokes out of every other branch)
//                tucked inside its parent, each rim vertex moved just enough (Ken, 2026-10-28).
//   fixes        each broken segment (self-crossing, or holding a triangle wound inside out: facing
//                against the faces at its corners) rejoined straight across between its two rings:
//                equal rings by the rotation nearest straight, unequal ones zipped by angle around
//                the segment's axis; only which vertices the triangles join changes (positions,
//                normals and UVs stay; at a UV seam each corner takes the copy whose UV is
//                nearest the triangle's others). Rechecked after.
//   broken       a segment the rejoin can't mend (its rings no clean cycles, or the new triangles
//                cross each other or the next segments, or face against them; Ken, 2026-10-28:
//                "destroy those verts and polygons"): if it only held triangles inside out, they are
//                turned round; if it crosses itself, the branch is cut there and its end closed, as
//                a flat one is; in a branch's start (its first two rings, buried in its parent) only
//                the bad triangles go. Never the trunk.
// --inspect writes layout inspection models (cache/inspect/<Prefix>*.obj and .json, placed in a
// scene as "inspect:<Prefix>..." pieces): Clean (the result), Before and After (the rejoined
// segments as they were, red, and are, green), Broken (cut away past mending, red), Turned
// (turned segments left alone, yellow),
// Kinks (rounded out, teal; KinksBefore: as they were, red), Tucked (branch starts moved inside
// their parents, lime; TuckedBefore, red), Orphans (magenta), Floating (purple), Open and OpenCovered (every open
// end capped, exposed red, covered indigo) and Origin (a marker, cyan).
// Changed (red): every triangle the pass changes, as it is now; with Original, the before to Clean's
// after (docs scene Compare Tangle switches between them).
// --material names the Unity material (e.g. BarkBeech) Clean and Original are drawn with when
// layout's Textures is on (else in their colors). --skip rejoin leaves the self-crossing segments as they are (not yet approved). --write writes
// the cleaned mesh over the Canopy file, without the vertices nothing uses any more (log it in
// docs/code/Canopy Changes.md).
const fs = require('fs');
const path = require('path');
const S = require('./scene.js');
const M = require('./unity-mesh.js');

const INSPECT = path.join(__dirname, '..', 'cache', 'inspect');
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function readCanopyMesh(file) {
  const local = path.join(S.REPO, file);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8');
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
  const e = Object.values(idx).find(x => x.path === file);
  if (!e) throw new Error(`${file}: not in the Canopy repo`);
  return S.blobs([e.blob]).get(e.blob).toString();
}

// A segment of p..q crossing triangle a b c strictly inside both: the point, or null.
function segTri(p, q, a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a), d = sub(q, p), h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return null;
  const f = 1 / det, s = sub(p, a), u = f * dot(s, h);
  if (u < 1e-6 || u > 1 - 1e-6) return null;
  const qv = cross(s, e1), v = f * dot(d, qv);
  if (v < 1e-6 || u + v > 1 - 1e-6) return null;
  const t = f * dot(e2, qv);
  return t > 1e-6 && t < 1 - 1e-6;
}
const trisCross = (A, B) => {
  for (const [s, T] of [[A, B], [B, A]]) for (let q = 0; q < 3; q++) if (segTri(s[q], s[(q + 1) % 3], T[0], T[1], T[2])) return true;
  return false;
};

function analyse(mesh) {
  const P = mesh.attrs[0], UV = mesh.attrs[4];
  let tris = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) tris.push([mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]]);
  const key = p => p.map(x => Math.round(x * 1e4)).join();
  const wid = new Map(), w = P.map(p => { const k = key(p); if (!wid.has(k)) wid.set(k, wid.size); return wid.get(k); });
  const pos = []; P.forEach((p, i) => { pos[w[i]] = p; });
  const W3 = t => t.map(i => w[i]);
  // neighbours, open edges, pieces
  const nb = new Map(), ef = new Map();
  for (const t of tris) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const x = w[t[a]], y = w[t[b]]; if (x === y) continue;
    (nb.get(x) || nb.set(x, new Set()).get(x)).add(y); (nb.get(y) || nb.set(y, new Set()).get(y)).add(x);
    const k = x < y ? x + ',' + y : y + ',' + x; ef.set(k, (ef.get(k) || 0) + 1);
  }
  const isOpen = (x, y) => ef.get(x < y ? x + ',' + y : y + ',' + x) === 1;
  const pieceOf = new Map(); let np = 0;
  for (const v of nb.keys()) if (!pieceOf.has(v)) { const st = [v]; pieceOf.set(v, np); while (st.length) { const x = st.pop(); for (const y of nb.get(x)) if (!pieceOf.has(y)) { pieceOf.set(y, np); st.push(y); } } np++; }
  const trisOfPiece = new Map();
  tris.forEach((t, i) => { const p = pieceOf.get(w[t[0]]); (trisOfPiece.get(p) || trisOfPiece.set(p, []).get(p)).push(i); });
  const loopsOf = new Map(), inLoop = new Set();
  for (const v of nb.keys()) {
    if (inLoop.has(v) || ![...nb.get(v)].some(u => isOpen(v, u))) continue;
    const loop = [v]; inLoop.add(v); const st = [v];
    while (st.length) { const x = st.pop(); for (const y of nb.get(x)) if (isOpen(x, y) && !inLoop.has(y)) { inLoop.add(y); loop.push(y); st.push(y); } }
    const p = pieceOf.get(v); (loopsOf.get(p) || loopsOf.set(p, []).get(p)).push(loop);
  }
  const centre = ids => [0, 1, 2].map(i => ids.reduce((s, v) => s + pos[v][i], 0) / ids.length);
  const spread = ids => { const c = centre(ids); return ids.reduce((s, v) => s + Math.hypot(...sub(pos[v], c)), 0) / ids.length; };
  // orphans: small pieces not at another piece's open end
  const openMid = [];
  for (const [k, n] of ef) if (n === 1) { const [x, y] = k.split(',').map(Number); openMid.push([pieceOf.get(x), pos[x].map((a, i) => (a + pos[y][i]) / 2)]); }
  const orphans = new Set();
  for (const [p, ts] of trisOfPiece) {
    if (ts.length > 12) continue;
    const c = centre([...new Set(ts.flatMap(t => W3(tris[t])))]);
    const atOpen = openMid.some(([q, m]) => q !== p && Math.hypot(...sub(c, m)) < 0.15);
    if (!atOpen) for (const t of ts) orphans.add(t);
  }
  // self-crossing triangles within a piece (grid of triangle boxes)
  const V = t => tris[t].map(i => P[i]);
  const G = 0.5, grid = new Map(), cell = p => p.map(x => Math.floor(x / G));
  tris.forEach((t, i) => {
    const vs = V(i), lo = cell([0, 1, 2].map(a => Math.min(...vs.map(v => v[a])))), hi = cell([0, 1, 2].map(a => Math.max(...vs.map(v => v[a]))));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = x + ',' + y + ',' + z; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  });
  const selfCrossing = (list, pieceSet) => {
    const out = new Set(), seen = new Set();
    for (const ts of grid.values()) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i], b = ts[j];
      if (list && !list.has(a) && !list.has(b)) continue;
      if (pieceOf.get(w[tris[a][0]]) !== pieceOf.get(w[tris[b][0]])) continue;
      if (pieceSet && !pieceSet.has(pieceOf.get(w[tris[a][0]]))) continue;
      const k = a < b ? a + ',' + b : b + ',' + a;
      if (seen.has(k)) continue;
      seen.add(k);
      const wa = W3(tris[a]), wb = W3(tris[b]);
      if (wa.some(x => wb.includes(x))) continue;
      if (trisCross(V(a), V(b))) { out.add(a); out.add(b); }
    }
    return out;
  };
  const crossingTris = selfCrossing(null, null);
  // triangles wound inside out: facing against the faces at their corners (area weighted)
  const faceN = tris.map(t => cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]])));
  const around = new Map();
  tris.forEach((t, i) => { for (const v of new Set(W3(t))) around.set(v, (around.get(v) || [0, 0, 0]).map((x, j) => x + faceN[i][j])); });
  const insideOut = new Set();
  tris.forEach((t, i) => { const s = [...new Set(W3(t))].reduce((acc, v) => acc.map((x, j) => x + around.get(v)[j]), [0, 0, 0]); if (dot(faceN[i], s) < 0) insideOut.add(i); });
  const near = new Map(), vcell = q => q.map(x => Math.floor(x / G)).join(',');
  for (const v of nb.keys()) { const k = vcell(pos[v]); (near.get(k) || near.set(k, []).get(k)).push(v); }
  // how far welded vertex v of piece p is from another piece (Infinity past a grid cell)
  const nearOther = (v, p) => {
    const c = pos[v].map(x => Math.floor(x / G));
    let d = Infinity;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++)
      for (const u of near.get([c[0] + x, c[1] + y, c[2] + z].join(',')) || []) if (pieceOf.get(u) !== p) d = Math.min(d, Math.hypot(...sub(pos[u], pos[v])));
    return d;
  };
  // mouths: a branch's open end, besides the one it grows from, that is no pinhole (a tip closed to
  // a point leaves one) and touches no other piece (Ken, 2026-10-28: a branch flaring into an open,
  // ragged end, hollow inside). The end it grows from is the one nearest other pieces; it is traced
  // from there, and its mouth closed (snubEnds).
  const mouths = new Map(); // piece -> { from (the loop it grows from), open (its mouths' vertices) }
  for (const [p, ls] of loopsOf) {
    if (ls.length < 2) continue;
    const apart = ls.map(L => L.reduce((s, v) => s + Math.min(nearOther(v, p), 1), 0) / L.length);
    const from = apart.indexOf(Math.min(...apart));
    const open = ls.filter((L, i) => i !== from && spread(L) > 0.05 && apart[i] > 0.5).flat();
    if (open.length) mouths.set(p, { from: ls[from], open });
  }
  // the origin: where the most bases (each piece's widest open loop) gather
  const bases = [...loopsOf.entries()].map(([p, ls]) => ({ p, loop: ls.slice().sort((a, b) => spread(b) - spread(a))[0] }));
  const bc = bases.map(b => ({ ...b, c: centre(b.loop) }));
  let origin = bc.length ? bc[0].c : [0, 0, 0], bestCount = 0;
  for (const a of bc) { const n = bc.filter(b => Math.hypot(...sub(a.c, b.c)) < 1.0).length; if (n > bestCount) { bestCount = n; origin = a.c; } }
  const atOrigin = new Set(bc.filter(b => Math.hypot(...sub(b.c, origin)) < 1.0).map(b => b.p));
  // a mouth's branch is traced from the end it grows from; never the trunk (it reaches the origin)
  for (const [p, m] of [...mouths]) {
    if ([...new Set(trisOfPiece.get(p).flatMap(t => W3(tris[t])))].some(v => Math.hypot(...sub(pos[v], origin)) < 1.0)) mouths.delete(p);
    else bases.find(b => b.p === p).loop = m.from;
  }
  // a closed piece (no open end: capped at both) is traced from the vertex nearest another
  // piece, where it meets the tree (Ken, 2026-10-28: one pinched to a point midway was missed)
  const closedBases = [];
  for (const p of trisOfPiece.keys()) {
    if (loopsOf.has(p)) continue;
    const vs = [...new Set(trisOfPiece.get(p).flatMap(t => W3(tris[t])))];
    let best = null, bd = Infinity;
    for (const v of vs) { const d = nearOther(v, p); if (d < bd) { bd = d; best = v; } }
    // touching nothing: from the vertex nearest the origin
    if (best === null) best = vs.reduce((m, v) => (Math.hypot(...sub(pos[v], origin)) < Math.hypot(...sub(pos[m], origin)) ? v : m));
    closedBases.push({ p, loop: [best] });
  }
  // segments
  const segments = [], ringsByPiece = new Map();
  for (const { p, loop } of bases.concat(closedBases)) {
    const seen = new Set(loop); let layer = [...loop]; const rings = [];
    while (layer.length) { rings.push(layer); const next = new Set(); for (const v of layer) for (const u of nb.get(v)) if (!seen.has(u)) next.add(u); for (const u of next) seen.add(u); layer = [...next]; }
    const ringOf = new Map(); rings.forEach((r, k) => r.forEach(v => ringOf.set(v, k)));
    ringsByPiece.set(p, { rings, ringOf, base: centre(loop), baseR: spread(loop), origin: atOrigin.has(p), mouth: mouths.has(p) ? Math.min(...mouths.get(p).open.map(v => ringOf.get(v))) : -1 });
    for (let k = 0; k + 1 < rings.length; k++) {
      const r1 = rings[k], r2 = rings[k + 1];
      if (r1.length < 3 || r2.length < 2) continue;
      const strip = trisOfPiece.get(p).filter(t => { const ws = W3(tris[t]); return ws.every(v => ringOf.get(v) === k || ringOf.get(v) === k + 1) && ws.some(v => ringOf.get(v) === k) && ws.some(v => ringOf.get(v) === k + 1); });
      const c1 = centre(r1), c2 = centre(r2), axis = unit(sub(c2, c1));
      const flat = d => unit(sub(d, axis.map(x => x * dot(d, axis))));
      const in2 = new Set(r2), turns = [];
      for (const v of r1) { const a = flat(sub(pos[v], c1)); let best = 180; for (const u of nb.get(v)) if (in2.has(u)) { const b = flat(sub(pos[u], c2)); best = Math.min(best, Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI); } if (best < 180) turns.push(best); }
      const turn = turns.length ? turns.reduce((s, x) => s + x, 0) / turns.length : 0;
      const step = 360 / Math.max(r1.length, r2.length);
      const crossing = strip.some(t => crossingTris.has(t));
      const kind = crossing ? 'self-crossing' : turn > step * 0.65 ? 'turned' : turn < step * 0.35 ? 'straight' : 'unclear';
      const where = k === 0 && atOrigin.has(p) ? 'origin' : k + 2 >= rings.length || r2.length <= 2 ? 'tip' : 'other';
      segments.push({ p, k, r1, r2, strip, kind, where, c1, c2, axis, insideOut: strip.some(t => insideOut.has(t)) });
    }
  }
  // which branches touch: their triangles cross, or one's base sits inside the other's tube
  const touching = new Map(); // piece -> set of pieces
  const link = (x, y) => { (touching.get(x) || touching.set(x, new Set()).get(x)).add(y); (touching.get(y) || touching.set(y, new Set()).get(y)).add(x); };
  const tested = new Set();
  for (const ts of grid.values()) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    const x = pieceOf.get(w[tris[ts[i]][0]]), y = pieceOf.get(w[tris[ts[j]][0]]);
    if (x === y || (touching.get(x) && touching.get(x).has(y))) continue;
    const k = ts[i] < ts[j] ? ts[i] + ',' + ts[j] : ts[j] + ',' + ts[i];
    if (tested.has(k)) continue;
    tested.add(k);
    if (trisCross(V(ts[i]), V(ts[j]))) link(x, y);
  }
  const ringList = [];
  for (const [p, { rings }] of ringsByPiece) for (const r of rings) if (r.length >= 2) { const c = centre(r); ringList.push({ p, c, r: r.reduce((q, v) => q + Math.hypot(...sub(pos[v], c)), 0) / r.length }); }
  for (const [p, info] of ringsByPiece) for (const ring of ringList) if (ring.p !== p && Math.hypot(...sub(info.base, ring.c)) < Math.max(ring.r * 1.3, 0.05)) link(p, ring.p);
  // open ends (Ken, 2026-10-28: many branch starts are open tubes not inside the trunk): each open
  // loop but pinholes, with its open edges and whether it is covered: all its rim inside other
  // pieces' faces (inTube), a sibling's not counting; a rim poking out anywhere leaves an opening
  const tubes = [];
  for (const [p, { rings }] of ringsByPiece) {
    const C = rings.map(centre), R = rings.map(spread);
    for (let k = 0; k + 1 < rings.length; k++) if (R[k] > 0 || R[k + 1] > 0) tubes.push({ p, a: C[k], b: C[k + 1], ra: R[k], rb: R[k + 1], na: rings[k].length, nb: rings[k + 1].length });
  }
  // inside a tube's faces: within its inner radius (a ring of n sides lies within cos(180°/n) of
  // its middles' radius), less a tenth, of the line between two consecutive rings' middles
  const innerAt = (t, q) => {
    const ab = sub(t.b, t.a), f = Math.max(0, Math.min(1, dot(sub(q, t.a), ab) / (dot(ab, ab) || 1e-12)));
    const side = n => (n >= 3 ? Math.cos(Math.PI / n) : 0.5);
    return { m: t.a.map((x, i) => x + ab[i] * f), r: 0.9 * (t.ra * side(t.na) + (t.rb * side(t.nb) - t.ra * side(t.na)) * f) };
  };
  // siblings: branches starting at the same place (both at the trunk origin, or their bases within
  // one and a half times their radii); one's open first segment hides nothing of the other's start
  const siblings = (p, q) => {
    const x = ringsByPiece.get(p), y = ringsByPiece.get(q);
    if (!x || !y || x.rings[0].length < 2 || y.rings[0].length < 2) return false;
    return (atOrigin.has(p) && atOrigin.has(q)) || Math.hypot(...sub(x.base, y.base)) < 1.5 * (x.baseR + y.baseR);
  };
  const inTube = (q, p) => tubes.some(t => t.p !== p && !siblings(p, t.p) && (({ m, r }) => Math.hypot(...sub(q, m)) < r)(innerAt(t, q)));
  // the trunk: the biggest piece reaching the origin without starting there
  let trunk = null;
  for (const [p, { rings }] of ringsByPiece) if (!atOrigin.has(p) && rings.some(r => Math.hypot(...sub(centre(r), origin)) < 1.0) && (trunk === null || trisOfPiece.get(p).length > trisOfPiece.get(trunk).length)) trunk = p;
  const openEnds = [];
  for (const [p, ls] of loopsOf) for (const L of ls) {
    if (spread(L) <= 0.05) continue;
    const at = new Set(L), edges = [];
    for (const x of L) for (const y of nb.get(x)) if (x < y && at.has(y) && isOpen(x, y)) edges.push([x, y]);
    openEnds.push({ p, loop: L, edges, c: centre(L), base: ringsByPiece.has(p) && ringsByPiece.get(p).rings[0].includes(L[0]), covered: L.every(v => inTube(pos[v], p)) });
  }
  return { P, UV, tris, w, pos, pieceOf, trisOfPiece, ringsByPiece, orphans, origin, originBases: bestCount, atOrigin, segments, crossingTris, insideOut, selfCrossing, touching, openEnds, tubes, innerAt, siblings, trunk };
}

// Spread of points along their principal axes, largest first (std devs).
function spreads(pts) {
  const c = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] += d[i] * d[j] / pts.length; }
  for (let s = 0; s < 50; s++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(A[i][j]) > Math.abs(A[p][q])) { p = i; q = j; }
    if (Math.abs(A[p][q]) < 1e-14) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), cs = Math.cos(th), sn = Math.sin(th);
    for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = cs * x - sn * y; A[k][q] = sn * x + cs * y; }
    for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = cs * x - sn * y; A[q][k] = sn * x + cs * y; }
  }
  return [A[0][0], A[1][1], A[2][2]].map(v => Math.sqrt(Math.max(0, v))).sort((x, y) => y - x);
}

// A ring's roundness: its points seen square to the branch there (along the line from the ring before
// to the ring after; at an end, its one neighbour), their narrower spread over their wider; a line
// of 1 or 2 vertices 0, a squashed triangle about 0.58. Not the traced ring as it lies: at a bend it
// can slant along the branch and read as flat (Ken, 2026-10-28: branch 57's rings 10-12, 0.30 to
// 0.35 as traced, are 0.52 to 0.89 square to the branch).
function ringRoundness(a, rings, k) {
  const r = rings[k];
  if (r.length <= 2) return 0;
  const centre = q => [0, 1, 2].map(i => q.reduce((x, v) => x + a.pos[v][i], 0) / q.length);
  const c = centre(r), d = sub(centre(rings[Math.min(rings.length - 1, k + 1)]), centre(rings[Math.max(0, k - 1)]));
  const axis = Math.hypot(...d) > 1e-9 ? unit(d) : null;
  const s = spreads(r.map(v => { const q = sub(a.pos[v], c), t = axis ? dot(q, axis) : 0; return axis ? q.map((x, i) => x - axis[i] * t) : q; }));
  return s[1] / (s[0] || 1);
}

// Flat branches cut, and everything down branch from them: { removed (triangle set), moved
// (mesh vertex -> new position: a cut end merged to a point), cut (piece -> ring), gone (pieces
// removed whole) }. broken (restitch's: piece -> its first broken segment) are cut there too.
function flatTrims(a, broken = new Map()) {
  const cut = new Map(), why = new Map(); // piece -> { kind: sheet | ribbon | flattens | point | flat tip | broken | downstream, from }
  const thinness = (rings, k) => { const s = spreads([...rings[k - 1], ...rings[k], ...rings[k + 1]].map(v => a.pos[v])); return s[2] / (s[1] || 1); };
  for (const [p, { rings }] of a.ringsByPiece) {
    // a closed piece (capped at both ends, traced from a single vertex) that is a sheet: its
    // thickness under 0.3 of its width. Its traced layers are no cross-sections, so it is judged whole.
    if (rings[0].length === 1) {
      const sp = spreads([...new Set(rings.flat())].map(v => a.pos[v]));
      if (sp[2] < 0.3 * sp[1]) { cut.set(p, 0); why.set(p, { kind: 'sheet', roundness: +(sp[2] / (sp[1] || 1)).toFixed(2) }); continue; }
    }
    const middle = [];
    for (let k = 1; k + 1 < rings.length - 1; k++) middle.push(k);
    const lines = middle.filter(k => rings[k].length <= 2);
    const round = new Map(middle.map(k => [k, ringRoundness(a, rings, k)]));
    const meanRound = middle.length ? middle.reduce((s, k) => s + round.get(k), 0) / middle.length : 1;
    const thin = middle.every(k => rings[k].length <= 4);
    let ribbon = thin && middle.length >= 2 && meanRound < 0.4;
    if (!ribbon && middle.length && lines.length / middle.length > 0.5) {
      const t = middle.map(k => thinness(rings, k)).sort((x, y) => x - y);
      ribbon = t[t.length >> 1] < 0.6;
    }
    if (ribbon) {
      const at = middle.find(k => round.get(k) < 0.4) ?? middle[0];
      cut.set(p, at); why.set(p, { kind: 'ribbon', at, roundness: +meanRound.toFixed(2) });
      continue;
    }
    // a point with more after it: cut past the point (the point ring is the new tip)
    const radii = rings.map(r => { if (r.length < 2) return 0; const c = [0, 1, 2].map(i => r.reduce((q, v) => q + a.pos[v][i], 0) / r.length); return r.reduce((q, v) => q + Math.hypot(...sub(a.pos[v], c)), 0) / r.length; });
    const median = radii.slice().sort((x, y) => x - y)[radii.length >> 1];
    let wide = false, pointAt = -1;
    for (let k = 0; k + 1 < rings.length; k++) {
      if (radii[k] >= 0.5 * median) wide = true;
      const nearOrigin = Math.hypot(...sub([0, 1, 2].map(i => rings[k].reduce((q, v) => q + a.pos[v][i], 0) / rings[k].length), a.origin)) < 1.0;
      if (k >= 1 && wide && (rings[k].length === 1 || radii[k] < 0.15 * median) && !nearOrigin) { pointAt = k; break; }
    }
    if (pointAt > 0) {
      cut.set(p, pointAt + 1); why.set(p, { kind: 'point', at: pointAt });
      continue;
    }
    for (let k = 1; k + 1 < rings.length; k++) {
      if (rings[k].length > 2 || rings[k - 1].length + rings[k].length + rings[k + 1].length < 5) continue;
      if (thinness(rings, k) < 0.25) { cut.set(p, k); why.set(p, { kind: 'flattens', at: k }); break; }
    }
    if (cut.has(p)) continue;
    // a flat tip too long to snub (Ken, 2026-10-28: a round branch ending in a flat blade): its last
    // rings, past the point it closes to, all squashed (roundness under 0.4), two or more, right
    // after a round ring (0.6 or more). Only its last wide ring closes to a point, with anything past
    // it: the blade stays (Ken, 2026-10-28: on branch 57 the blade looked saveable, its end did not).
    let end = rings.length - 1;
    while (end > 1 && radii[end] < 0.1 * median) end--;
    let from = end + 1;
    while (from - 1 >= 2 && ringRoundness(a, rings, from - 1) < 0.4) from--;
    const atOrigin = Math.hypot(...sub([0, 1, 2].map(i => rings[end].reduce((q, v) => q + a.pos[v][i], 0) / rings[end].length), a.origin)) < 1.0;
    if (end - from + 1 >= 2 && ringRoundness(a, rings, from - 1) >= 0.6 && !atOrigin && !snubNose(a, rings)) { cut.set(p, end + 1); why.set(p, { kind: 'flat tip', at: end, from }); }
  }
  // broken past mending (Ken, 2026-10-28: "destroy those verts and polygons"): cut at the broken
  // segment's first ring
  for (const [p, k] of broken) if (!cut.has(p) || cut.get(p) > k) { cut.set(p, k); why.set(p, { kind: 'broken', at: k }); }
  // removed vertices (welded), and branches whose base sits on them, until nothing more goes
  // removed rings: { c (centre), r (mean radius), from (piece) }
  const removedRings = [];
  const take = (p, k) => {
    const { rings } = a.ringsByPiece.get(p);
    for (let j = k; j < rings.length; j++) {
      const r = rings[j], c = [0, 1, 2].map(i => r.reduce((s, v) => s + a.pos[v][i], 0) / r.length);
      removedRings.push({ c, r: r.reduce((s, v) => s + Math.hypot(...sub(a.pos[v], c)), 0) / r.length, from: p });
    }
  };
  for (const [p, k] of cut) if (why.get(p).kind !== 'sheet') take(p, k); // a sheet's layers are no tubes
  const gone = new Set([...cut].filter(([, k]) => k <= 1).map(([p]) => p));
  for (let changed = true; changed;) {
    changed = false;
    for (const [q, info] of a.ringsByPiece) {
      if (gone.has(q)) continue;
      const on = removedRings.find(ring => ring.from !== q && info.baseR <= ring.r * 1.2 && Math.hypot(...sub(info.base, ring.c)) < Math.max(ring.r * 1.3, 0.05));
      if (on && !(cut.has(q) && cut.get(q) <= 1)) {
        gone.add(q); cut.set(q, 0); take(q, 0); why.set(q, { kind: 'downstream', from: on.from }); changed = true;
      }
    }
  }
  const removed = new Set(), moved = new Map();
  for (const [p, k] of cut) {
    const { rings, ringOf } = a.ringsByPiece.get(p);
    for (const t of a.trisOfPiece.get(p)) if (k === 0 || a.tris[t].some(v => (ringOf.get(a.w[v]) ?? -1) >= k)) removed.add(t);
    if (k >= 2) {
      // the kept end closes to a point: past its last round ring, as a snub nose (a line or
      // squashed ring left before the cut would be a flat fin: Ken, 2026-10-28); else the last
      // kept ring closes to its middle, as a tip
      const nose = snubNose(a, rings.slice(0, k));
      const last = rings[k - 1], c = [0, 1, 2].map(i => last.reduce((s, v) => s + a.pos[v][i], 0) / last.length);
      const at = new Set(nose ? nose.ends : last);
      a.P.forEach((q, i) => { if (at.has(a.w[i])) moved.set(i, nose ? nose.point : c); });
    }
  }
  return { removed, moved, cut, gone, why };
}

// A branch end's snub nose, when one of its last three rings is a pinch (a line, or squashed) with
// a round ring within its last four (at most three rings merge), or it has an open mouth (mouth: the
// first ring the mouth reaches; everything from there merges), and it is not at the trunk origin:
// { j (its last round ring before the pinch), ends (the welded vertices past j), point (where they
// merge: at their middle, but at least half ring j's radius out along the branch, so the nose is
// never flat) }, or null.
function snubNose(a, rings, mouth = -1) {
  const centre = r => [0, 1, 2].map(i => r.reduce((s, v) => s + a.pos[v][i], 0) / r.length);
  if (rings.length < 4) return null;
  let j = -1;
  if (mouth >= 2) j = mouth - 1; // an open mouth: closed from the first ring it reaches
  else {
    const flatRing = k => rings[k].length === 2 || (rings[k].length >= 3 && ringRoundness(a, rings, k) < 0.4);
    let pinch = -1;
    for (let k = rings.length - 1; k >= Math.max(1, rings.length - 3); k--) if (flatRing(k)) { pinch = k; break; }
    if (pinch < 0) return null; // ends in a point (a 1-vertex ring) or round
    for (let k = pinch - 1; k >= Math.max(1, rings.length - 4); k--) if (rings[k].length >= 3 && ringRoundness(a, rings, k) >= 0.4) { j = k; break; }
  }
  if (j < 1) return null; // no round ring within the last four: not a pinched tip (Tangle v1's trunk lost its top this way)
  // the trunk start, where the branches begin at MTree's single point, is never an end to snub
  if (Math.hypot(...sub(centre(rings[rings.length - 1]), a.origin)) < 1.0) return null;
  const cj = centre(rings[j]), axis = unit(sub(cj, centre(rings[j - 1])));
  const rj = rings[j].reduce((s, v) => s + Math.hypot(...sub(a.pos[v], cj)), 0) / rings[j].length;
  const ends = rings.slice(j + 1).flat(), ce = centre(ends);
  const out = Math.max(dot(sub(ce, cj), axis), 0.5 * rj);
  const lateral = sub(sub(ce, cj), axis.map(x => x * dot(sub(ce, cj), axis)));
  return { j, ends, point: cj.map((x, i) => x + axis[i] * out + lateral[i]) };
}

// Flat ends made snub points: { moved (mesh vertex -> point), pieces, tris (the end's triangles) }.
// Branches cut or removed by flatTrims are left to it (it snubs the ends it cuts).
function snubEnds(a, flat) {
  const moved = new Map(), pieces = [], tris = new Set();
  for (const [p, { rings, ringOf, mouth }] of a.ringsByPiece) {
    if (flat.cut.has(p)) continue;
    const nose = snubNose(a, rings, mouth);
    if (!nose) continue;
    const at = new Set(nose.ends);
    a.P.forEach((q, i) => { if (at.has(a.w[i])) moved.set(i, nose.point); });
    for (const t of a.trisOfPiece.get(p)) if (a.tris[t].some(v => (ringOf.get(a.w[v]) ?? -1) >= nose.j)) tris.add(t);
    pieces.push(p);
  }
  return { moved, pieces, tris };
}

// Pinpoint tips (Ken, 2026-10-28: "converge verts that are very close together"): a branch whose last
// ring is 2 or more vertices within 0.01 of their middle (30 of the Tangle's tips: 3 vertices about
// 1 cm apart, whose tiny triangles turn every which way), where its others end in one vertex. Merged
// into that one point. Returns { moved (mesh vertex -> point), pieces (piece -> its tip ring) }.
function pinpointTips(a) {
  const moved = new Map(), pieces = new Map();
  for (const [p, { rings }] of a.ringsByPiece) {
    const last = rings[rings.length - 1];
    if (rings.length < 3 || last.length < 2) continue;
    const c = [0, 1, 2].map(i => last.reduce((s, v) => s + a.pos[v][i], 0) / last.length);
    if (last.reduce((s, v) => s + Math.hypot(...sub(a.pos[v], c)), 0) / last.length >= 0.01) continue;
    const at = new Set(last);
    a.P.forEach((q, i) => { if (at.has(a.w[i])) moved.set(i, c); });
    pieces.set(p, rings.length - 1);
  }
  return { moved, pieces };
}

// Broken segments: self-crossing (the hourglass), or holding a triangle wound inside out (Ken,
// 2026-10-28). Each is rejoined straight across; one that can't be (its rings no clean cycles), or
// whose new triangles still cross each other or the next segments, or face against them, is broken
// past mending: one that only holds triangles wound inside out (not crossing itself) has those
// triangles turned round (Ken, 2026-10-28: a whole branch went for one); else past a branch's first
// two rings it is cut there (flatTrims); in its start, buried in its parent, only the bad triangles go
// (inside out or crossing), so the branch stays. Returns { fixes: [{ seg, tris }], flipped (triangles
// turned round), broken (piece -> its first broken segment past its start), dropped
// (start triangles removed), reasons ("piece,segment" -> why it could not be mended), trunk (how many
// broken segments of the trunk's, never cut, are left) }. tips (pinpointTips' pieces): a segment into
// a pinpoint tip is left to it (merged to a point, it is a plain cone).
function restitch(a, tips = new Map()) {
  const fixes = [], broken = new Map(), dropped = new Set(), reasons = new Map(), flipped = new Set();
  let trunk = 0;
  const bySeg = new Map(a.segments.map(s => [s.p + ',' + s.k, s]));
  const T = t => t.map(v => a.P[v]);
  const shares = (x, y) => x.some(v => y.some(u => a.w[u] === a.w[v]));
  const normal = t => cross(sub(a.P[t[1]], a.P[t[0]]), sub(a.P[t[2]], a.P[t[0]]));
  for (const seg of a.segments) {
    if (seg.kind !== 'self-crossing' && !seg.insideOut) continue;
    if (tips.get(seg.p) === seg.k + 1) continue;
    const r = rejoin(a, seg);
    let ok = !!r;
    if (!ok) reasons.set(seg.p + ',' + seg.k, 'its rings are not clean cycles');
    if (ok) {
      const next = [seg.k - 1, seg.k + 1].map(k => bySeg.get(seg.p + ',' + k)).filter(Boolean).flatMap(s => s.strip).map(t => a.tris[t]);
      for (let i = 0; i < r.length && ok; i++) for (const x of r.slice(i + 1).concat(next)) if (!shares(r[i], x) && trisCross(T(r[i]), T(x))) { ok = false; reasons.set(seg.p + ',' + seg.k, 'rejoined, it still crosses itself or the next segments'); break; }
      // facing: with the next segments' faces at its corners
      for (const t of ok ? r : []) {
        const s = next.filter(x => shares(t, x)).reduce((acc, x) => acc.map((y, j) => y + normal(x)[j]), [0, 0, 0]);
        if (dot(normal(t), s) < 0) { ok = false; reasons.set(seg.p + ',' + seg.k, 'rejoined, a triangle still faces against the next segments'); break; }
      }
    }
    if (ok) fixes.push({ seg, tris: r });
    else if (seg.kind !== 'self-crossing') for (const t of seg.strip.filter(t => a.insideOut.has(t))) flipped.add(t);
    else if (seg.p === a.trunk) trunk++;
    else if (seg.k <= 1) for (const t of seg.strip.filter(t => a.insideOut.has(t) || a.crossingTris.has(t))) dropped.add(t);
    else if (!(broken.get(seg.p) <= seg.k)) broken.set(seg.p, seg.k);
  }
  // inside out outside any segment (between a ring's own vertices, or a closed piece's): turned round
  const inStrip = new Set(a.segments.flatMap(s => s.strip));
  for (const t of a.insideOut) if (!inStrip.has(t) && a.pieceOf.get(a.w[a.tris[t][0]]) !== a.trunk) flipped.add(t);
  return { fixes, flipped, broken, dropped, reasons, trunk };
}

// Rejoins a segment's strip straight across between its two rings: returns new triangles (mesh
// vertex indices), or null when the rings are not clean cycles.
function rejoin(a, seg) {
  const o1 = ringOrder(a, seg.strip, seg.r1), o2 = ringOrder(a, seg.strip, seg.r2);
  if (!o1 || !o2) return null;
  return zip({ o1, o2, c1: seg.c1, c2: seg.c2, axis: seg.axis, at: v => a.pos[v], copies: copiesIn(a, seg.strip), P: a.P, UV: a.UV });
}
// A ring's welded vertices in order round it, from the ring edges among strip's triangles, or null
// when they are not one clean cycle.
function ringOrder(a, strip, r) {
  if (r.length < 3) return r.slice();
  const ring = new Set(r), adj = new Map();
  for (const t of strip) for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
    const x = a.w[a.tris[t][i]], y = a.w[a.tris[t][j]];
    if (x !== y && ring.has(x) && ring.has(y)) { (adj.get(x) || adj.set(x, new Set()).get(x)).add(y); (adj.get(y) || adj.set(y, new Set()).get(y)).add(x); }
  }
  if (!r.every(v => adj.has(v) && adj.get(v).size === 2)) return null;
  const out = [r[0]]; let prev = null, cur = r[0];
  while (out.length < r.length) { const next = [...adj.get(cur)].find(x => x !== prev && !out.includes(x)); if (next === undefined) return null; out.push(next); prev = cur; cur = next; }
  return out;
}
// welded vertex -> the mesh vertices strip's triangles use there
function copiesIn(a, strip) {
  const copies = new Map();
  for (const t of strip) for (const v of a.tris[t]) (copies.get(a.w[v]) || copies.set(a.w[v], new Set()).get(a.w[v])).add(v);
  return copies;
}
// Zips two ordered rings (welded vertices, positions at(v)) by angle round the axis: triangles of
// mesh vertices, each corner the copy nearest the triangle's others in UV, wound outward; or null
// when a corner has no copy.
function zip({ o1, o2, c1, c2, axis, at, copies, P, UV }) {
  const ref = unit(sub(sub(at(o1[0]), c1), axis.map(x => x * dot(sub(at(o1[0]), c1), axis))));
  const side = cross(axis, ref);
  const angle = (v, c) => { const d = sub(at(v), c); return Math.atan2(dot(d, side), dot(d, ref)); };
  const norm = x => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const dir = (o, c) => { if (o.length < 3) return 1; let s = 0; for (let i = 0; i < o.length; i++) { const d = norm(angle(o[(i + 1) % o.length], c) - angle(o[i], c)); s += d < Math.PI ? 1 : -1; } return s >= 0 ? 1 : -1; };
  if (dir(o1, c1) < 0) o1 = o1.slice().reverse();
  if (dir(o2, c2) < 0) o2 = o2.slice().reverse();
  // start each ring at its vertex nearest the reference direction, then zip by angle
  const startAt = (o, c) => { let best = 0, bd = Infinity; o.forEach((v, i) => { const d = norm(angle(v, c)); const dd = Math.min(d, 2 * Math.PI - d); if (dd < bd) { bd = dd; best = i; } }); return o.slice(best).concat(o.slice(0, best)); };
  o1 = startAt(o1, c1); o2 = startAt(o2, c2);
  const unwrap = (o, c) => { const out = []; let last = null; for (const v of o) { let a0 = angle(v, c); if (last !== null) while (a0 < last) a0 += 2 * Math.PI; out.push(a0); last = a0; } return out; };
  const a1 = unwrap(o1, c1), a2 = unwrap(o2, c2);
  const out = [];
  let i = 0, j = 0;
  const n1 = o1.length, n2 = o2.length;
  while (i < n1 || j < n2) {
    const ni = i < n1 ? a1[(i + 1) % n1] + (i + 1 >= n1 ? 2 * Math.PI : 0) : Infinity;
    const nj = j < n2 ? a2[(j + 1) % n2] + (j + 1 >= n2 ? 2 * Math.PI : 0) : Infinity;
    if (ni <= nj) { out.push([o1[i % n1], o1[(i + 1) % n1], o2[j % n2]]); i++; } else { out.push([o1[i % n1], o2[(j + 1) % n2], o2[j % n2]]); j++; }
  }
  // corners: the mesh vertex at each welded position, nearest in UV to the others
  const result = [];
  for (const tw of out) {
    if (new Set(tw).size < 3) continue;
    let best = null, bd = Infinity;
    const c = tw.map(x => [...(copies.get(x) || [])]);
    if (c.some(x => !x.length)) return null;
    for (const p of c[0]) for (const q of c[1]) for (const r of c[2]) {
      const d = UV ? Math.hypot(UV[p][0] - UV[q][0], UV[p][1] - UV[q][1]) + Math.hypot(UV[q][0] - UV[r][0], UV[q][1] - UV[r][1]) + Math.hypot(UV[r][0] - UV[p][0], UV[r][1] - UV[p][1]) : 0;
      if (d < bd) { bd = d; best = [p, q, r]; }
    }
    // wound to face outward, away from the axis (where the vertices are: at, by welded vertex)
    const [A, B, C] = tw.map(at);
    const n = cross(sub(B, A), sub(C, A));
    const mid = [0, 1, 2].map(k => (A[k] + B[k] + C[k]) / 3);
    const t = dot(sub(mid, c1), axis);
    const outward = sub(mid, c1.map((x, k) => x + axis[k] * t));
    result.push(dot(n, outward) >= 0 ? best : [best[0], best[2], best[1]]);
  }
  return result;
}

// Branch starts tucked in (Ken, 2026-10-28: many start as open tubes not inside the branch they
// grow from): each exposed base's parent is the branch whose tube holds most of its rim (else the
// nearest, within its radius; the trunk for a branch from the trunk origin), never a sibling; each rim vertex outside the parent's faces moves just enough:
// back along the child, else (a child wider than its parent) in towards the parent's middle line, so
// even a thicker child starts wholly inside; a slide is shared with the rim vertices either side
// (0.6, then 0.3), so the rim is pulled in rather than notched. round (roundStarts'): a start made
// round is tucked from its new rim. skip: triangles already changed, left alone. Returns
// { moved (welded vertex -> position), bases, stuck (no parent in reach), tris (touching moved) }.
function tuckBases(a, skip, round = null) {
  const centre = r => [0, 1, 2].map(i => r.reduce((s, v) => s + a.pos[v][i], 0) / r.length);
  const nearest = (q, t) => { const ab = sub(t.b, t.a), f = Math.max(0, Math.min(1, dot(sub(q, t.a), ab) / (dot(ab, ab) || 1e-12))); return { f, m: t.a.map((x, i) => x + ab[i] * f) }; };
  const inside = (q, ts) => ts.some(t => { const { m, r } = a.innerAt(t, q); return Math.hypot(...sub(q, m)) < r; });
  const moved = new Map(), bases = [], stuck = [], tris = new Set();
  for (const e of a.openEnds) {
    if (!e.base || e.covered) continue;
    const { rings, ringOf } = a.ringsByPiece.get(e.p);
    const touching = a.trisOfPiece.get(e.p).filter(t => a.tris[t].some(v => ringOf.get(a.w[v]) === 0));
    if (touching.some(t => skip.has(t)) || rings.length < 2) continue;
    // the parent: most rim vertices inside its tube (generously), else nearest to its surface
    const byPiece = new Map();
    for (const t of a.tubes) if (t.p !== e.p && !a.siblings(e.p, t.p)) (byPiece.get(t.p) || byPiece.set(t.p, []).get(t.p)).push(t);
    let parent = null, most = 0, gap = Infinity;
    // a branch from the trunk origin grows from the trunk, however far its start sits from it
    if (a.atOrigin.has(e.p) && a.trunk !== null && byPiece.has(a.trunk)) { parent = a.trunk; most = 1; }
    else for (const [q, ts] of byPiece) {
      const n = e.loop.filter(v => ts.some(t => { const { f, m } = nearest(a.pos[v], t); return Math.hypot(...sub(a.pos[v], m)) < t.ra + (t.rb - t.ra) * f; })).length;
      const g = Math.min(...e.loop.map(v => Math.min(...ts.map(t => { const { f, m } = nearest(a.pos[v], t); return Math.hypot(...sub(a.pos[v], m)) - (t.ra + (t.rb - t.ra) * f); }))));
      if (n > most || (n === most && g < gap)) { parent = q; most = n; gap = g; }
    }
    const ts = parent === null ? [] : byPiece.get(parent);
    const reach = Math.max(...ts.map(t => Math.max(t.ra, t.rb)), 0);
    if (!most && gap > reach) { stuck.push(e.p); continue; }
    const back = unit(sub(centre(rings[0]), centre(rings[1]))); // from the child into its parent
    const rim = round && round.loops.get(e.p), loop = rim || e.loop, at = v => (rim && round.moved.get(v)) || a.pos[v];
    // each outside rim vertex's slide back along the child (or, if no slide gets it in, a pull in
    // towards the parent's middle line)
    const slide = new Map(), pull = new Map();
    const slides = dir => {
      slide.clear(); pull.clear();
      for (const v of loop) {
        const q = at(v);
        if (inside(q, ts)) continue;
        let s = 0;
        for (let k = 1; k <= 40 && !s; k++) if (inside(q.map((x, i) => x + dir[i] * reach * 2 * k / 40), ts)) s = reach * 2 * k / 40;
        if (s) { slide.set(v, s); continue; }
        let best = null;
        for (const t of ts) { const { m, r } = a.innerAt(t, q), d = Math.hypot(...sub(q, m)); if (!best || d - r < best.d - best.r) best = { m, d, r }; }
        pull.set(v, best.m.map((x, i) => x + (q[i] - x) * (0.9 * best.r) / (best.d || 1)));
      }
    };
    let dir = back;
    slides(dir);
    // a start made round keeps its circle: if sliding back doesn't get every vertex in, the whole rim
    // slides one way instead, towards the parent's middle line from the rim's middle (vertices pulled
    // sideways one by one drag the rim across its own tube)
    if (rim && pull.size) {
      const rc = [0, 1, 2].map(i => rim.reduce((q, v) => q + at(v)[i], 0) / rim.length);
      let best = null;
      for (const t of ts) { const { m, r } = a.innerAt(t, rc), d = Math.hypot(...sub(rc, m)); if (!best || d - r < best.d - best.r) best = { m, d, r }; }
      dir = unit(sub(best.m, rc));
      slides(dir);
    }
    // the slides shared with the rim vertices either side, 0.6 of it one along and 0.3 two along
    // (Ken, 2026-10-28: pulling the rim in a bit instead of a V notch): deeper in is still inside
    const rimNb = new Map(loop.map(v => [v, []]));
    if (rim) rim.forEach((v, i) => rimNb.get(v).push(rim[(i + 1) % rim.length], rim[(i + rim.length - 1) % rim.length]));
    else for (const [x, y] of e.edges) { rimNb.get(x).push(y); rimNb.get(y).push(x); }
    const share = new Map();
    for (const [v, s] of slide) {
      const one = rimNb.get(v), two = [...new Set(one.flatMap(u => rimNb.get(u)))].filter(u => u !== v && !one.includes(u));
      for (const [u, f] of [[v, 1], ...one.map(u => [u, 0.6]), ...two.map(u => [u, 0.3])]) share.set(u, Math.max(share.get(u) || 0, s * f));
    }
    let n = 0;
    for (const v of loop) {
      const to = pull.get(v) || (share.get(v) ? at(v).map((x, i) => x + dir[i] * share.get(v)) : null);
      if (!to) continue;
      moved.set(v, to);
      n++;
    }
    if (!n) continue;
    for (const t of touching) tris.add(t);
    bases.push({ p: e.p, parent, moved: n });
  }
  return { moved, bases, stuck, tris };
}

// Exposed branch starts made round (Ken, 2026-10-28: "those areas are already chaos ... make them
// more round first, and then do a proportional tuck"): an exposed start's first segment rebuilt as a
// clean tube. Its rim becomes a regular circle, evenly spaced, square to the branch, as far back as
// it was: as many vertices as the next ring, its mean radius, turned to line up with it, so the
// segment runs straight. It reuses the old rim's vertices, one per next-ring vertex (the nearest round
// the branch); the rest go. Never the trunk. skip: triangles already changed, left alone. Returns
// { removed (triangles), added, moved (welded vertex -> position), loops (piece -> its new rim, in
// order), starts: [{ p, from, to, tris, now }] }.
function roundStarts(a, skip) {
  const removed = new Set(), added = [], moved = new Map(), loops = new Map(), starts = [];
  const exposed = new Set(a.openEnds.filter(e => e.base && !e.covered).map(e => e.p));
  for (const seg of a.segments) {
    if (seg.k !== 0 || !exposed.has(seg.p) || seg.p === a.trunk || seg.r2.length < 3 || seg.r1.length < seg.r2.length) continue;
    if (seg.strip.some(t => skip.has(t))) continue;
    const o1 = ringOrder(a, seg.strip, seg.r1), o2 = ringOrder(a, seg.strip, seg.r2);
    if (!o1 || !o2) continue;
    const n = o2.length, axis = seg.axis, back = axis.map(x => -x), L = Math.hypot(...sub(seg.c1, seg.c2));
    const flat = d => sub(d, axis.map(x => x * dot(d, axis)));
    const ref = unit(flat(sub(a.pos[o2[0]], seg.c2))), side = cross(axis, ref);
    const angle = v => { const d = sub(a.pos[v], seg.c2); return Math.atan2(dot(d, side), dot(d, ref)); };
    const th = o2.map(angle);
    // the way o2 runs round, and its offset from evenly spaced (a circular mean)
    let turn = 0;
    for (let i = 0; i < n; i++) { const d = th[(i + 1) % n] - th[i]; turn += Math.atan2(Math.sin(d), Math.cos(d)); }
    const sense = turn >= 0 ? 1 : -1;
    const off = Math.atan2(th.reduce((q, t, i) => q + Math.sin(t - sense * 2 * Math.PI * i / n), 0), th.reduce((q, t, i) => q + Math.cos(t - sense * 2 * Math.PI * i / n), 0));
    const r = o2.reduce((q, v) => q + Math.hypot(...flat(sub(a.pos[v], seg.c2))), 0) / n;
    const c = seg.c2.map((x, i) => x + back[i] * L);
    // the old rim vertex nearest round the branch to each new place, each used once
    const angle1 = v => { const d = sub(a.pos[v], seg.c1); return Math.atan2(dot(d, side), dot(d, ref)); };
    const kept = [], used = new Set();
    for (let i = 0; i < n; i++) {
      const t = off + sense * 2 * Math.PI * i / n;
      let best = null, bd = Infinity;
      for (const v of o1) { if (used.has(v)) continue; const d = Math.abs(Math.atan2(Math.sin(angle1(v) - t), Math.cos(angle1(v) - t))); if (d < bd) { bd = d; best = v; } }
      used.add(best); kept.push(best);
      moved.set(best, c.map((x, j) => x + r * (Math.cos(t) * ref[j] + Math.sin(t) * side[j])));
    }
    const z = zip({ o1: kept, o2, c1: c, c2: seg.c2, axis, at: v => moved.get(v) || a.pos[v], copies: copiesIn(a, seg.strip), P: a.P, UV: a.UV });
    if (!z) { for (const v of kept) moved.delete(v); continue; }
    for (const t of seg.strip) removed.add(t);
    added.push(...z);
    loops.set(seg.p, kept);
    starts.push({ p: seg.p, from: o1.length, to: n, tris: seg.strip, now: z.length });
  }
  return { removed, added, moved, loops, starts };
}

// Dense branch starts simplified (Ken, 2026-10-28: "anywhere that goes from 18 verts to five seems
// like possible waste"): a branch whose start ring has twice its next ring's vertices or more keeps
// one start vertex for each of the next ring's (the nearest round the branch), and the two are zipped
// again; the start's other vertices go. Never the trunk. skip: triangles already changed, left alone.
// Returns { removed (triangles), added, starts: [{ p, from, to, tris, now }] }.
function simplifyStarts(a, skip) {
  const removed = new Set(), added = [], starts = [];
  for (const seg of a.segments) {
    if (seg.k !== 0 || seg.r2.length < 3 || seg.r1.length < 2 * seg.r2.length) continue;
    if (seg.p === a.trunk || seg.strip.some(t => skip.has(t))) continue;
    const o1 = ringOrder(a, seg.strip, seg.r1), o2 = ringOrder(a, seg.strip, seg.r2);
    if (!o1 || !o2) continue;
    const d0 = sub(a.pos[o1[0]], seg.c1), ref = unit(sub(d0, seg.axis.map(x => x * dot(d0, seg.axis)))), side = cross(seg.axis, ref);
    const angle = (v, c) => { const d = sub(a.pos[v], c); return Math.atan2(dot(d, side), dot(d, ref)); };
    const keep = new Set();
    for (const u of o2) {
      let best = null, bd = Infinity;
      for (const v of o1) {
        if (keep.has(v)) continue;
        const d = Math.abs(angle(v, seg.c1) - angle(u, seg.c2)), dd = Math.min(d, 2 * Math.PI - d);
        if (dd < bd) { bd = dd; best = v; }
      }
      keep.add(best);
    }
    const kept = o1.filter(v => keep.has(v));
    const z = zip({ o1: kept, o2, c1: seg.c1, c2: seg.c2, axis: seg.axis, at: v => a.pos[v], copies: copiesIn(a, seg.strip), P: a.P, UV: a.UV });
    if (!z) continue;
    for (const t of seg.strip) removed.add(t);
    added.push(...z);
    starts.push({ p: seg.p, from: o1.length, to: kept.length, tris: seg.strip, now: z.length });
  }
  return { removed, added, starts };
}

// Kinks unkinked (Ken, 2026-10-28): a kept branch's middle ring that is a line (2 vertices) between
// round rings, where the tube pinches flat and opens again. The ring is rounded out: two new
// vertices across the line, at its neighbours' mean radius, and its two segments zipped again.
// skip: triangles already changed (cut, removed, snubbed), left alone. Returns { kinks, removed
// (triangles replaced), added (triangles), verts (new mesh vertices: each channel's values) }.
function unkinks(a, mesh, skip) {
  const centre = r => [0, 1, 2].map(i => r.reduce((s, v) => s + a.pos[v][i], 0) / r.length);
  const radius = r => { const c = centre(r); return r.reduce((s, v) => s + Math.hypot(...sub(a.pos[v], c)), 0) / r.length; };
  const kinks = [], removed = new Set(), added = [], verts = [];
  const P = mesh.attrs[0].slice(), UV = mesh.attrs[4] && mesh.attrs[4].slice();
  const extra = new Map(); // new welded id -> position
  let nextW = a.pos.length;
  for (const [p, { rings, ringOf }] of a.ringsByPiece) {
    for (let k = 1; k + 2 < rings.length; k++) {
      const [x, y] = rings[k];
      if (rings[k].length !== 2 || rings[k - 1].length < 3 || rings[k + 1].length < 3) continue;
      const stripOf = (i, j) => a.trisOfPiece.get(p).filter(t => { const rs = a.tris[t].map(v => ringOf.get(a.w[v])); return rs.every(q => q === i || q === j) && rs.includes(i) && rs.includes(j); });
      const s1 = stripOf(k - 1, k), s2 = stripOf(k, k + 1);
      if (s1.concat(s2).some(t => skip.has(t) || removed.has(t))) continue;
      const o0 = ringOrder(a, s1, rings[k - 1]), o2 = ringOrder(a, s2, rings[k + 1]);
      if (!o0 || !o2) continue;
      const c0 = centre(rings[k - 1]), c2 = centre(rings[k + 1]), c = centre(rings[k]);
      const axis = unit(sub(c2, c0)), along = sub(a.pos[y], a.pos[x]);
      const across = unit(cross(axis, sub(along, axis.map(q => q * dot(along, axis)))));
      const r = (radius(rings[k - 1]) + radius(rings[k + 1])) / 2;
      const copies = copiesIn(a, s1.concat(s2));
      const cx = [...copies.get(x)][0], cy = [...copies.get(y)][0];
      const fresh = [1, -1].map(sgn => {
        const at = c.map((q, i) => q + across[i] * r * sgn), id = nextW++, m = P.length;
        extra.set(id, at); copies.set(id, new Set([m]));
        const vals = mesh.attrs.map((ch, ci) => (ch ? (ci === 0 ? at : ci === 4 ? ch[cx].map((u, d) => (u + ch[cy][d]) / 2) : ch[cx].slice()) : null));
        P.push(at); if (UV) UV.push(vals[4]);
        verts.push(vals);
        return id;
      });
      const ring = [x, fresh[0], y, fresh[1]];
      const at = v => extra.get(v) || a.pos[v];
      // each segment zipped round its own axis (the branch bends at every ring)
      const z1 = zip({ o1: o0, o2: ring, c1: c0, c2: c, axis: unit(sub(c, c0)), at, copies, P, UV });
      const z2 = zip({ o1: ring, o2: o2, c1: c, c2, axis: unit(sub(c2, c)), at, copies, P, UV });
      if (!z1 || !z2) { P.length -= 2; if (UV) UV.length -= 2; verts.length -= 2; continue; }
      for (const t of s1.concat(s2)) removed.add(t);
      added.push(...z1, ...z2);
      kinks.push({ p, k, at: c });
    }
  }
  return { kinks, removed, added, verts };
}

// An inspection model in layout's mesh form (Unity's X negated, winding reversed, as cached
// meshes are), with its color; inflate pushes it out along its normals (mesh units) so a
// highlight laid over the same surface doesn't flicker against it.
// skin: { uv (per vertex), material (a Unity material's guid) }, drawn with it when layout's
// Textures is on.
// the mesh the layers were made from (Assets/...), named in each layer's .json: the server's probe
// adds the branch and ring there (tools/mesh-why.js)
let inspectSource = null;
function writeInspect(name, P, N, list, color, opacity = 1, inflate = 0, skin = null, extra = {}) {
  fs.mkdirSync(INSPECT, { recursive: true });
  const used = [...new Set(list.flat())], at = new Map(used.map((v, i) => [v, i + 1]));
  const f6 = x => +x.toFixed(5);
  const uv = skin && skin.uv;
  const lines = [`# ${name}: layout/tools/mesh-clean.js`];
  for (const v of used) { const p = N && inflate ? P[v].map((x, i) => x + N[v][i] * inflate) : P[v]; lines.push('v ' + [-p[0], p[1], p[2]].map(f6).join(' ')); }
  if (uv) for (const v of used) lines.push('vt ' + [uv[v][0], uv[v][1]].map(f6).join(' '));
  if (N) for (const v of used) lines.push('vn ' + [-N[v][0], N[v][1], N[v][2]].map(f6).join(' '));
  const corner = v => (N || uv ? `${at.get(v)}/${uv ? at.get(v) : ''}${N ? '/' + at.get(v) : ''}` : at.get(v));
  for (const [a, b, c] of list) lines.push('f ' + [a, c, b].map(corner).join(' '));
  fs.writeFileSync(path.join(INSPECT, name + '.obj'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(INSPECT, name + '.json'), JSON.stringify({ color, opacity, ...(skin && skin.material ? { material: skin.material } : {}), ...(inspectSource ? { source: inspectSource } : {}), ...extra }));
}
// A small octahedron marker at p (mesh units), size s.
function marker(p, s) {
  const P = [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]].map(d => d.map((x, i) => x + p[i]));
  const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  return { P, F };
}

// Slivers (Ken, 2026-10-28: "sliver triangles that do not add visual value"): triangles of quality
// under 0.15 (4√3 area over the sum of squared edges; 1 equilateral) that are needles (the shortest
// edge under a quarter of the longest: two vertices crowded together) have that edge collapsed, both
// ends merged at its middle, when the edge is shared by exactly two triangles, its ends by exactly two
// neighbours (so the tube stays closed), and neither end is on an open rim (a start tucked just inside
// its parent would poke out again). No vertex is touched twice in a pass. Caps (one wide angle) are
// left: flipping their long edge joins vertices two rings apart, scrambling the rings every rule here
// traces (27 more starts read as exposed). P: positions (mesh vertices), tris: mesh vertex triangles.
// Returns { P, tris, needles, changed: [{ at }] }.
function slivers(P, tris) {
  const key = p => p.map(x => Math.round(x * 1e4)).join();
  const wid = new Map(), w = P.map(p => { const k = key(p); if (!wid.has(k)) wid.set(k, wid.size); return wid.get(k); });
  const ek = (x, y) => (x < y ? x + ',' + y : y + ',' + x);
  const nb = new Map(), byEdge = new Map();
  tris.forEach((t, i) => { for (const [j, k] of [[0, 1], [1, 2], [2, 0]]) { const x = w[t[j]], y = w[t[k]]; if (x === y) continue; (nb.get(x) || nb.set(x, new Set()).get(x)).add(y); (nb.get(y) || nb.set(y, new Set()).get(y)).add(x); (byEdge.get(ek(x, y)) || byEdge.set(ek(x, y), []).get(ek(x, y))).push(i); } });
  const rim = new Set();
  for (const [e, list] of byEdge) if (list.length === 1) for (const x of e.split(',')) rim.add(+x);
  const quality = t => { const [A, B, C] = t.map(v => P[v]), s2 = dot(sub(B, A), sub(B, A)) + dot(sub(C, B), sub(C, B)) + dot(sub(A, C), sub(A, C)); return s2 ? 2 * Math.sqrt(3) * Math.hypot(...cross(sub(B, A), sub(C, A))) / s2 : 0; };
  const used = new Set(), merge = new Map(), changed = [];
  for (const t of tris) {
    if (quality(t) >= 0.15) continue;
    const edges = [[0, 1], [1, 2], [2, 0]].map(([j, k]) => ({ j, k, l: Math.hypot(...sub(P[t[k]], P[t[j]])) })).sort((x, y) => x.l - y.l);
    if (edges[0].l >= 0.25 * edges[2].l) continue; // a cap
    const x = w[t[edges[0].j]], y = w[t[edges[0].k]];
    if (used.has(x) || used.has(y) || rim.has(x) || rim.has(y) || (byEdge.get(ek(x, y)) || []).length !== 2) continue;
    if ([...nb.get(x)].filter(z => nb.get(y).has(z)).length !== 2) continue;
    const m = P[t[edges[0].j]].map((c, n) => (c + P[t[edges[0].k]][n]) / 2);
    merge.set(x, m); merge.set(y, m);
    for (const z of [x, y, ...nb.get(x), ...nb.get(y)]) used.add(z);
    changed.push({ at: m });
  }
  const P2 = P.map((p, i) => merge.get(w[i]) || p);
  const area = t => Math.hypot(...cross(sub(P2[t[1]], P2[t[0]]), sub(P2[t[2]], P2[t[0]])));
  return { P: P2, tris: tris.filter(t => area(t) > 1e-9), needles: changed.length, changed };
}

// Every branch textured afresh from its start to its end (Ken, 2026-10-28: re-stitching segments by
// position left their texture twisted; 846 of v5's triangles smeared across over half its width).
// U: the angle round the branch, from a reference carried ring to ring along it (so U never spins as
// the branch bends and its seam runs straight, starting on the underside). V: the distance along
// it, each vertex by its own place along the branch (a traced ring can slant), at the branch's own
// proportion of along to round as it had it (the trunk about 4.8, branches about 1.9), so the bark
// keeps its look. Seam vertices get a copy each side; a single-vertex ring (a tip, a closed end) a
// copy per triangle at its neighbours' U. Each branch keeps its old texture's handedness, so it is
// not mirrored. b: analyse() of the mesh (attrs[0], tris). Returns { attrs, tris, stats }.
function retexture(b, attrs, tris) {
  const old = attrs[4];
  const centre = r => [0, 1, 2].map(i => r.reduce((s, v) => s + b.pos[v][i], 0) / r.length);
  const uOf = new Map(), vOf = new Map(), mirror = new Map(), ratios = [];
  const signedArea = uv => (uv[1][0] - uv[0][0]) * (uv[2][1] - uv[0][1]) - (uv[2][0] - uv[0][0]) * (uv[1][1] - uv[0][1]);
  const firstCopy = new Map();
  b.w.forEach((w, i) => { if (!firstCopy.has(w)) firstCopy.set(w, i); });
  for (const [p, { rings }] of b.ringsByPiece) {
    const C = rings.map(centre), R = rings.map((r, k) => r.reduce((s, v) => s + Math.hypot(...sub(b.pos[v], C[k])), 0) / r.length);
    const n = rings.length;
    // each ring's direction along the branch, and the reference round it carried from ring to ring
    const T = C.map((c, k) => { const d = sub(C[Math.min(n - 1, k + 1)], C[Math.max(0, k - 1)]); return Math.hypot(...d) > 1e-9 ? unit(d) : null; });
    for (let k = 0; k < n; k++) if (!T[k]) T[k] = T[k - 1] || [0, 1, 0];
    const perp = (x, t) => sub(x, t.map(c => c * dot(x, t)));
    let ref = perp([0, -1, 0], T[0]);
    if (Math.hypot(...ref) < 0.1) ref = perp([1, 0, 0], T[0]);
    ref = unit(ref);
    // the branch's old proportion of along to round: its V per length over its U per length round
    const oldV = r => r.reduce((s, v) => s + old[firstCopy.get(v)][1], 0) / r.length, own = [];
    for (let k = 0; k + 1 < n; k++) {
      const len = Math.hypot(...sub(C[k + 1], C[k])), rr = (R[k] + R[k + 1]) / 2;
      if (rings[k].length >= 3 && rings[k + 1].length >= 3 && len > 1e-6 && rr > 1e-6) own.push(Math.abs(oldV(rings[k + 1]) - oldV(rings[k])) / len * 2 * Math.PI * rr);
    }
    const ratio = own.length ? own.sort((x, y) => x - y)[own.length >> 1] : 1.94;
    ratios.push(ratio);
    let V = 0, lastR = R.find(x => x > 1e-6) || 1;
    for (let k = 0; k < n; k++) {
      if (k) { ref = unit(perp(ref, T[k])); const rr = (R[k - 1] + R[k]) / 2 || lastR; V -= ratio * Math.hypot(...sub(C[k], C[k - 1])) / (2 * Math.PI * rr); }
      if (R[k] > 1e-6) lastR = R[k];
      const side = cross(T[k], ref);
      for (const v of rings[k]) {
        const d = sub(b.pos[v], C[k]), along = dot(d, T[k]);
        vOf.set(v, V - ratio * along / (2 * Math.PI * lastR));
        if (rings[k].length > 1) uOf.set(v, (((Math.atan2(dot(d, side), dot(d, ref)) / (2 * Math.PI)) % 1) + 1) % 1);
      }
    }
    mirror.set(p, false);
  }
  // a triangle's corners' U, wrapped to one side of the seam; a corner with none (a tip) at the others'
  const cornerU = (t, flip) => {
    let us = t.map(v => (uOf.has(b.w[v]) ? (flip ? 1 - uOf.get(b.w[v]) : uOf.get(b.w[v])) : null));
    const known = us.filter(u => u !== null);
    if (known.length && Math.max(...known) - Math.min(...known) > 0.5) us = us.map(u => (u !== null && u < 0.5 ? u + 1 : u));
    const k2 = us.filter(u => u !== null), m = k2.length ? k2.reduce((x, y) => x + y, 0) / k2.length : 0;
    return us.map(u => (u === null ? m : u));
  };
  // handedness: each branch as its old texture was
  const byPiece = new Map();
  tris.forEach(t => { const p = b.pieceOf.get(b.w[t[0]]); (byPiece.get(p) || byPiece.set(p, []).get(p)).push(t); });
  for (const [p, ts] of byPiece) {
    let was = 0, now = 0;
    for (const t of ts) {
      const o = t.map(v => old[v]);
      if (Math.max(...o.map(x => x[0])) - Math.min(...o.map(x => x[0])) < 0.5) was += Math.sign(signedArea(o));
      const us = cornerU(t, false);
      now += Math.sign(signedArea(t.map((v, i) => [us[i], vOf.get(b.w[v])])));
    }
    mirror.set(p, Math.sign(was) !== 0 && Math.sign(was) !== Math.sign(now));
  }
  // the new vertices: one per welded vertex and U (seam copies, tip copies)
  const out = attrs.map(ch => (ch ? [] : null)), at = new Map(), newTris = [];
  let wide = 0;
  for (const t of tris) {
    const p = b.pieceOf.get(b.w[t[0]]), us = cornerU(t, mirror.get(p));
    if (t.every(v => uOf.has(b.w[v])) && Math.max(...us) - Math.min(...us) > 0.25) wide++;
    newTris.push(t.map((v, i) => {
      const key = b.w[v] + '|' + us[i].toFixed(5);
      if (!at.has(key)) {
        at.set(key, out[0].length);
        attrs.forEach((ch, ci) => { if (ch) out[ci].push(ci === 4 ? [us[i], vOf.get(b.w[v])] : ch[v]); });
      }
      return at.get(key);
    }));
  }
  ratios.sort((x, y) => x - y);
  return { attrs: out, tris: newTris, stats: { wide, mirrored: [...mirror.values()].filter(Boolean).length, branches: byPiece.size, ratio: ratios[ratios.length >> 1], vertices: out[0].length } };
}

// Floating branches (Ken, 2026-10-28: "these midair dudes"): those not connected, through
// branches that touch (their triangles cross, or one's base sits inside the other's tube), to a
// branch at the trunk origin. Branches in gone (removed whole) connect nothing.
function floating(a, gone = new Set()) {
  const reached = new Set([...a.atOrigin].filter(p => !gone.has(p))), queue = [...reached];
  while (queue.length) {
    const x = queue.shift();
    for (const y of a.touching.get(x) || []) if (!reached.has(y) && !gone.has(y)) { reached.add(y); queue.push(y); }
  }
  return new Set([...a.trisOfPiece.keys()].filter(p => !reached.has(p) && !gone.has(p)));
}

// Only the texture, afresh (--texture-only): layers <Prefix> (front faces, textured with --material)
// and <Prefix>Inside (back faces, red) with --inspect; --write as below.
function textureOnly(file, mesh) {
  const a = analyse(mesh);
  const attrs = mesh.attrs.map(ch => ch && ch.slice());
  const wideBefore = a.tris.filter(t => { const u = t.map(v => attrs[4][v][0]); return Math.max(...u) - Math.min(...u) > 0.5; }).length;
  const tex = retexture(a, attrs, a.tris);
  const wideAfter = tex.tris.filter(t => { const u = t.map(v => tex.attrs[4][v][0]); return Math.max(...u) - Math.min(...u) > 0.5; }).length;
  console.log(`${file}: ${a.tris.length} triangles; texture: every branch textured afresh (${tex.stats.branches} branches, proportion along to round median ${tex.stats.ratio.toFixed(2)}, ${tex.stats.mirrored} turned to keep their handedness): triangles across over half the texture's width ${wideBefore} -> ${wideAfter}; ${mesh.attrs[0].length} vertices -> ${tex.stats.vertices}`);
  const inspect = process.argv.indexOf('--inspect');
  if (inspect > 0) {
    const prefix = process.argv[inspect + 1] || 'Mesh';
    inspectSource = file;
    const named = process.argv.indexOf('--material'), material = named > 0 ? S.materialGuid(process.argv[named + 1]) : null;
    writeInspect(prefix, tex.attrs[0], tex.attrs[1], tex.tris, '#b8ae9c', 1, 0, { uv: tex.attrs[4], material }, { side: 'front' });
    writeInspect(prefix + 'Inside', tex.attrs[0], tex.attrs[1], tex.tris, '#ff3b30', 1, 0, null, { side: 'back' });
    console.log(`inspection models: cache/inspect/${prefix}{,Inside}.obj`);
  }
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(S.REPO, file), M.writeMesh(mesh, path.basename(file).replace(/\.[^.]+$/, ''), { attrs: tex.attrs, triangles: tex.tris.flat() }));
    console.log(`wrote ${file}`);
  }
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('usage: node tools/mesh-clean.js <Assets/... mesh> [--inspect <Prefix> [--material <name>]] [--skip rejoin] [--write]');
    process.exit(2);
  }
  const from = process.argv.indexOf('--from');
  const text = from > 0 ? fs.readFileSync(process.argv[from + 1], 'utf8') : readCanopyMesh(file);
  const mesh = M.readMesh(text);
  if (process.argv.includes('--texture-only')) return textureOnly(file, mesh);
  const a = analyse(mesh);
  const counts = {};
  for (const s of a.segments) { counts[s.kind] = counts[s.kind] || { origin: 0, tip: 0, other: 0 }; counts[s.kind][s.where]++; }
  console.log(`${file}: ${a.tris.length} triangles; trunk origin at ${a.origin.map(x => x.toFixed(2)).join(', ')} (mesh units), ${a.originBases} branch bases there`);
  console.log(`orphans: ${a.orphans.size} triangles in small pieces away from any open end (removed)`);
  for (const [k, c] of Object.entries(counts)) console.log(`${k}: ${c.origin + c.tip + c.other} segments (trunk origin ${c.origin}, tip ${c.tip}, other ${c.other})`);
  const pin = pinpointTips(a);
  const stitch = restitch(a, pin.pieces);
  const flat = flatTrims(a, stitch.broken);
  const flatCut = [...flat.cut.values()].filter(k => k > 0).length;
  console.log(`flat: ${flatCut} branches cut partway where they flatten, ${flat.gone.size} removed whole (flat from their base, or growing from removed geometry): ${flat.removed.size} triangles`);
  const floats = floating(a, flat.gone), floatTris = [...floats].flatMap(p => a.trisOfPiece.get(p)).filter(t => !flat.removed.has(t) && !a.orphans.has(t));
  console.log(`floating: ${floats.size} branches in midair, connected to nothing that reaches the trunk origin (removed): ${floatTris.length} more triangles`);
  const removed = new Set([...a.orphans, ...flat.removed, ...floatTris, ...stitch.dropped]), added = [], before = [], after = [];
  const snub = snubEnds(a, flat);
  // kinks: what is cut, removed or snubbed is left alone
  const changed = new Set([...removed, ...snub.tris, ...a.tris.flatMap((t, i) => (t.some(v => flat.moved.has(v)) ? [i] : []))]);
  const kinks = unkinks(a, mesh, changed);
  for (const t of kinks.removed) removed.add(t);
  added.push(...kinks.added);
  console.log(`kinks: ${kinks.kinks.length} rings pinched to a line midway along a branch, rounded out (${kinks.verts.length} new vertices)`);
  const round = roundStarts(a, changed);
  console.log(`round starts: ${round.starts.length} exposed branch starts rebuilt as a regular circle lined up with their next ring (${round.removed.size} triangles became ${round.added.length})`);
  const tuck = tuckBases(a, changed, round);
  console.log(`branch starts: ${tuck.bases.length} tucked inside their parents (${tuck.moved.size} rim vertices moved)${tuck.stuck.length ? `; ${tuck.stuck.length} with no parent in reach` : ''}`);
  for (const t of round.removed) removed.add(t);
  added.push(...round.added);
  const starts = simplifyStarts(a, removed);
  for (const t of starts.removed) removed.add(t);
  added.push(...starts.added);
  console.log(`dense starts: ${starts.starts.length} start rings with twice their next ring's vertices or more cut to one per next-ring vertex: ${starts.removed.size} triangles became ${starts.added.length}`);
  // rejoin each broken segment that can be mended (self-crossing, or with a triangle inside out)
  let fixed = 0;
  const rejoined = [];
  const skips = new Set(process.argv.includes('--skip') ? process.argv[process.argv.indexOf('--skip') + 1].split(',') : []);
  for (const { seg, tris: r } of skips.has('rejoin') ? [] : stitch.fixes) {
    if (seg.strip.some(t => removed.has(t))) continue; // trimmed away
    for (const t of seg.strip) { removed.add(t); before.push(a.tris[t]); }
    added.push(...r); after.push(...r);
    rejoined.push({ seg, n: r.length });
    fixed++;
  }
  // triangles wound inside out in segments that can't be rejoined: turned round
  let flips = 0;
  for (const t of stitch.flipped) {
    if (removed.has(t)) continue;
    removed.add(t); added.push([a.tris[t][0], a.tris[t][2], a.tris[t][1]]);
    flips++;
  }
  console.log(`flipped: ${flips} triangles wound inside out (where a segment could not be rejoined, or outside any segment) turned round`);
  const brokenWhy = [...flat.why].filter(([, y]) => y.kind === 'broken');
  console.log(`broken: ${a.insideOut.size} triangles wound inside out; ${stitch.broken.size} branches broken past mending (a segment that can't be rejoined cleanly), cut there (${[...flat.removed].filter(t => brokenWhy.some(([p]) => a.pieceOf.get(a.w[a.tris[t][0]]) === p)).length} triangles); ${stitch.dropped.size} bad triangles dropped from branch starts${stitch.trunk ? `; ${stitch.trunk} broken segments in the trunk left alone` : ''}`);
  console.log(`pinpoint tips: ${pin.pieces.size} branches end in vertices about 1 cm apart; each merged to one point`);
  console.log(`flat ends: ${snub.pieces.length} branches end in a line or a squashed ring; each end merged to a snub point`);
  // cut ends merged to points, flat ends to snub points; triangles that became flat dropped
  const attrs = mesh.attrs.map((ch, ci) => ch && ch.concat(kinks.verts.map(v => v[ci])));
  attrs[0] = attrs[0].map((p, i) => (flat.moved.has(i) ? flat.moved.get(i) : snub.moved.has(i) ? snub.moved.get(i) : pin.moved.get(i) || tuck.moved.get(a.w[i]) || round.moved.get(a.w[i]) || p));
  const area = t => Math.hypot(...cross(sub(attrs[0][t[1]], attrs[0][t[0]]), sub(attrs[0][t[2]], attrs[0][t[0]])));
  let clean = a.tris.filter((t, i) => !removed.has(i)).concat(added).filter(t => area(t) > 1e-9);
  const sl = slivers(attrs[0], clean);
  attrs[0] = sl.P; clean = sl.tris;
  console.log(`slivers: ${sl.needles} needles (two vertices crowded together) collapsed: ${clean.length} triangles`);
  // twins: two triangles on the same three corners. Wound opposite ways they are a flat fin, seen
  // from both sides (and z-fighting: Ken, 2026-10-28): both go. Wound the same way, one copy goes.
  const corners = t => t.map(v => attrs[0][v].map(x => Math.round(x * 1e4)).join(','));
  const byCorners = new Map();
  clean.forEach((t, i) => { const k = corners(t).slice().sort().join('|'); (byCorners.get(k) || byCorners.set(k, []).get(k)).push(i); });
  const drop = new Set();
  let fins = 0, copies = 0;
  for (const list of byCorners.values()) {
    if (list.length < 2) continue;
    const turn = i => { const c = corners(clean[i]), m = c.indexOf(c.slice().sort()[0]); return c[(m + 1) % 3] < c[(m + 2) % 3]; };
    const ways = new Set(list.map(turn));
    if (ways.size > 1) { list.forEach(i => drop.add(i)); fins++; } else { list.slice(1).forEach(i => drop.add(i)); copies++; }
  }
  clean = clean.filter((t, i) => !drop.has(i));
  console.log(`twins: ${fins} flat fins (a triangle and its reverse) removed, ${copies} duplicate triangles dropped`);
  // normals recomputed from the triangles (Ken, 2026-10-28: the lighting looked wrong): the
  // Tangle's own are against their faces at 1,264 vertices and over 60° off at 2,587 more. Each
  // vertex takes its position's faces, area weighted, so UV seams stay smooth.
  const faceSum = new Map(), at = p => p.map(x => Math.round(x * 1e4)).join(',');
  for (const t of clean) {
    const n = cross(sub(attrs[0][t[1]], attrs[0][t[0]]), sub(attrs[0][t[2]], attrs[0][t[0]]));
    for (const v of t) { const k = at(attrs[0][v]), s = faceSum.get(k) || [0, 0, 0]; faceSum.set(k, s.map((x, i) => x + n[i])); }
  }
  let turned = 0;
  attrs[1] = attrs[1].map((n, v) => {
    const s = faceSum.get(at(attrs[0][v])), l = s && Math.hypot(...s);
    if (!l) return n;
    const m = s.map(x => x / l);
    if (dot(m, n) < 0.5) turned++;
    return m;
  });
  console.log(`normals: recomputed from the triangles; ${turned} were over 60° off their faces`);
  // recheck: do the rejoined segments still cross themselves?
  const check = analyse({ attrs, triangles: clean.flat() });
  const kinked = new Set(kinks.added);
  console.log(`rejoined ${fixed} broken segments; after: ${check.crossingTris.size} self-crossing triangles left (were ${a.crossingTris.size}; ${[...check.crossingTris].filter(i => kinked.has(clean[i])).length} of them in rounded kinks), ${check.insideOut.size} inside out (were ${a.insideOut.size}); ${clean.length} triangles`);
  // The change log (Ken, 2026-10-28: so questions about a spot are answered from it): a header,
  // then one line per change: the rule, the branch (piece), the rings it changed, the input mesh's
  // triangles (and each one's middle, mesh units), how many welded vertices, and the rule's
  // measures. cache/mesh-clean/<mesh>.jsonl, rewritten each run; tools/mesh-why.js reads it.
  const log = [];
  {
    const mid = t => [0, 1, 2].map(i => +((a.P[t[0]][i] + a.P[t[1]][i] + a.P[t[2]][i]) / 3).toFixed(3));
    const note = (rule, p, ts, extra = {}) => {
      const info = a.ringsByPiece.get(p), list = [...ts];
      const rs = info ? list.flatMap(t => a.tris[t].map(v => info.ringOf.get(a.w[v]))).filter(x => x !== undefined) : [];
      log.push({ rule, piece: p, rings: info ? info.rings.length : 0, atOrigin: a.atOrigin.has(p), ...extra, changedRings: rs.length ? [Math.min(...rs), Math.max(...rs)] : null, tris: list, verts: new Set(list.flatMap(t => a.tris[t].map(v => a.w[v]))).size, at: list.map(t => mid(a.tris[t])) });
    };
    const byPiece = ts => { const m = new Map(); for (const t of ts) { const p = a.pieceOf.get(a.w[a.tris[t][0]]); (m.get(p) || m.set(p, []).get(p)).push(t); } return m; };
    const closing = p => a.trisOfPiece.get(p).filter(t => a.tris[t].some(v => flat.moved.has(v)));
    for (const [p, ts] of byPiece(a.orphans)) note('orphan', p, ts, { why: '12 triangles or fewer, away from every open end: removed' });
    for (const [p, y] of flat.why) {
      const cut = flat.cut.get(p), gone = a.trisOfPiece.get(p).filter(t => flat.removed.has(t));
      const why = y.kind === 'broken' ? `segment ${y.at} broken past mending (${stitch.reasons.get(p + ',' + y.at) || '?'}): cut from ring ${cut}, ring ${cut - 1} closed to a point`
        : cut === 0 ? `${y.kind}: removed whole` : `${y.kind}: cut from ring ${cut}, the end closed to a point`;
      note(y.kind === 'broken' ? 'broken' : 'flat', p, gone, { kind: y.kind, cut, detail: y, why });
      if (cut > 0) note('closed', p, closing(p), { why: `the end left by the ${y.kind} cut, merged to a point` });
    }
    for (const p of floats) note('floating', p, a.trisOfPiece.get(p).filter(t => floatTris.includes(t)), { why: 'connected to nothing that reaches the trunk origin: removed' });
    for (const [p, ts] of byPiece([...stitch.flipped].filter(t => !flat.removed.has(t) && !a.orphans.has(t) && !floatTris.includes(t)))) note('flipped', p, ts, { why: 'wound inside out, in a segment that could not be rejoined: turned round' });
    for (const [p, ts] of byPiece(stitch.dropped)) note('broken start', p, ts, { why: 'inside out or crossing in its first two rings, and could not be rejoined: only these triangles removed' });
    for (const [p, k] of pin.pieces) if (!flat.cut.has(p) && !snub.pieces.includes(p)) note('pinpoint tip', p, a.trisOfPiece.get(p).filter(t => a.tris[t].some(v => pin.moved.has(v))), { ring: k, why: `its tip, ring ${k}, is ${a.ringsByPiece.get(p).rings[k].length} vertices about 1 cm apart: merged to one point` });
    for (const p of snub.pieces) note('flat end', p, a.trisOfPiece.get(p).filter(t => snub.tris.has(t)), { why: 'ends in a line or squashed ring (or an open mouth): merged to a snub point' });
    const kinkTris = byPiece(kinks.removed);
    for (const k of kinks.kinks) note('kink', k.p, (kinkTris.get(k.p) || []).filter(t => a.tris[t].some(v => Math.abs(a.ringsByPiece.get(k.p).ringOf.get(a.w[v]) - k.k) <= 1)), { ring: k.k, why: `ring ${k.k} pinched to a line: rounded out, its two segments zipped again` });
    const tuckTris = byPiece(tuck.tris);
    for (const b of tuck.bases) {
      const ts = tuckTris.get(b.p) || [], vs = new Set(ts.flatMap(t => a.tris[t].map(v => a.w[v])));
      const moves = [...vs].filter(v => tuck.moved.has(v)).map(v => Math.hypot(...sub(tuck.moved.get(v), a.pos[v])));
      note('tuck', b.p, ts, { parent: b.parent, rimMoved: b.moved, maxMove: +Math.max(0, ...moves).toFixed(3), why: `start poked out of its parent ${b.parent}: ${b.moved} rim vertices moved inside it` });
    }
    for (const p of tuck.stuck) note('tuck stuck', p, [], { why: 'start exposed, but no parent in reach: left' });
    for (const x of sl.changed) log.push({ rule: 'sliver', piece: null, rings: 0, atOrigin: false, changedRings: null, tris: [], verts: 2, at: [x.at.map(c => +c.toFixed(3))], why: 'a sliver with two vertices crowded together: its short edge collapsed, the two merged at its middle' });
    for (const x of round.starts) note('round start', x.p, x.tris, { from: x.from, to: x.to, newTris: x.now, why: `exposed start (rim of ${x.from}) rebuilt as a regular circle of ${x.to}, lined up with its next ring, then tucked` });
    for (const x of starts.starts) note('simplified start', x.p, x.tris, { from: x.from, to: x.to, newTris: x.now, why: `start ring of ${x.from} vertices, its next of ${x.to}: kept ${x.to}, zipped again (${x.tris.length} triangles became ${x.now})` });
    for (const { seg, n } of rejoined) note('rejoin', seg.p, seg.strip, { segment: seg.k, kind: seg.kind, insideOut: seg.insideOut, newTris: n, why: `segment ${seg.k} ${seg.kind === 'self-crossing' ? 'crossed itself' : 'held a triangle wound inside out'}: rejoined straight across` });
    const dir = path.join(__dirname, '..', 'cache', 'mesh-clean');
    fs.mkdirSync(dir, { recursive: true });
    const head = { file, run: new Date().toISOString(), triangles: a.tris.length, after: clean.length, origin: a.origin, trunk: a.trunk, note: 'triangles are the input mesh\'s; points in mesh units' };
    fs.writeFileSync(path.join(dir, path.basename(file).replace(/\.[^.]+$/, '') + '.jsonl'), [head, ...log].map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log(`change log: cache/mesh-clean/${path.basename(file).replace(/\.[^.]+$/, '')}.jsonl (${log.length} changes; node tools/mesh-why.js)`);
  }
  // the texture, afresh, last (every change of shape above)
  if (attrs[4]) {
    const wideBefore = clean.filter(t => { const u = t.map(v => attrs[4][v][0]); return Math.max(...u) - Math.min(...u) > 0.5; }).length;
    const tex = retexture(check, attrs, clean);
    attrs.forEach((ch, ci) => { attrs[ci] = tex.attrs[ci]; });
    clean = tex.tris;
    console.log(`texture: every branch textured afresh, start to end (${tex.stats.branches} branches; their proportion along to round, median ${tex.stats.ratio.toFixed(2)}; ${tex.stats.mirrored} turned to keep their old handedness): triangles across over half the texture's width ${wideBefore} before; now ${tex.stats.wide} across over a quarter; ${tex.stats.vertices} vertices`);
  }
  const inspect = process.argv.indexOf('--inspect');
  if (inspect > 0) {
    const prefix = process.argv[inspect + 1] || 'Mesh';
    inspectSource = file;
    const N = mesh.attrs[1];
    const named = process.argv.indexOf('--material'), material = named > 0 ? S.materialGuid(process.argv[named + 1]) : null;
    writeInspect(prefix + 'Clean', attrs[0], attrs[1], clean, '#b8ae9c', 1, 0, { uv: attrs[4], material });
    const brokenTris = new Set([...brokenWhy.flatMap(([p]) => a.trisOfPiece.get(p)).filter(t => flat.removed.has(t)), ...stitch.dropped]);
    writeInspect(prefix + 'Flat', a.P, N, [...flat.removed].filter(t => !brokenTris.has(t)).map(t => a.tris[t]), '#ff8c1a', 1, 0.006);
    writeInspect(prefix + 'Broken', a.P, N, [...brokenTris].map(t => a.tris[t]), '#ff3b30', 1, 0.006);
    writeInspect(prefix + 'Snub', attrs[0], attrs[1], [...snub.tris].filter(t => !removed.has(t)).map(t => a.tris[t]).filter(t => area(t) > 1e-9), '#3d8bff', 1, 0.006);
    writeInspect(prefix + 'Original', a.P, N, a.tris, '#9aa3b2', 1, 0, { uv: mesh.attrs[4], material });
    // everything this pass changes, where it is now: removed, rejoined, closed, unkinked or tucked
    const changedAll = new Set([...removed, ...snub.tris, ...tuck.tris, ...a.tris.flatMap((t, i) => (t.some(v => flat.moved.has(v) || pin.moved.has(v)) ? [i] : []))]);
    writeInspect(prefix + 'Changed', a.P, N, [...changedAll].map(t => a.tris[t]), '#ff3b30', 1, 0.006);
    writeInspect(prefix + 'Before', a.P, N, before, '#ff3b30', 0.45, 0.012);
    // what is kept is shown where Clean has it: after cut ends and flat ends closed to points
    writeInspect(prefix + 'After', attrs[0], attrs[1], after.filter(t => area(t) > 1e-9), '#34c759', 1, 0.006);
    writeInspect(prefix + 'Turned', attrs[0], attrs[1], a.segments.filter(s => s.kind === 'turned').flatMap(s => s.strip.filter(t => !removed.has(t)).map(t => a.tris[t])).filter(t => area(t) > 1e-9), '#ffd60a', 1, 0.006);
    writeInspect(prefix + 'Kinks', attrs[0], attrs[1], kinks.added, '#30d5c8', 1, 0.006);
    writeInspect(prefix + 'KinksBefore', a.P, N, [...kinks.removed].map(t => a.tris[t]), '#ff3b30', 0.45, 0.012);
    writeInspect(prefix + 'Tucked', attrs[0], attrs[1], [...tuck.tris].filter(t => !removed.has(t)).map(t => a.tris[t]).filter(t => area(t) > 1e-9), '#a3e635', 1, 0.006);
    writeInspect(prefix + 'TuckedBefore', a.P, N, [...tuck.tris].filter(t => !removed.has(t)).map(t => a.tris[t]), '#ff3b30', 0.45, 0.012);
    writeInspect(prefix + 'Orphans', a.P, N, [...a.orphans].map(t => a.tris[t]), '#ff2dc8');
    writeInspect(prefix + 'Floating', a.P, N, floatTris.map(t => a.tris[t]), '#bf5af2', 1, 0.006);
    // open ends, each capped with a fan to its middle so the opening shows, exposed or covered
    for (const [name, covered, color] of [['Open', false, '#ff453a'], ['OpenCovered', true, '#5e5ce6']]) {
      const ends = check.openEnds.filter(e => e.covered === covered), CP = [], CF = [];
      const vi = new Map(), at = v => { if (!vi.has(v)) { vi.set(v, CP.length); CP.push(check.pos[v]); } return vi.get(v); };
      for (const e of ends) { const m = CP.length; CP.push(e.c); for (const [x, y] of e.edges) CF.push([at(x), at(y), m]); }
      writeInspect(prefix + name, CP, null, CF, color);
    }
    console.log(`open ends: ${check.openEnds.filter(e => !e.covered).length} exposed, ${check.openEnds.filter(e => e.covered).length} covered (all their rim inside other branches)`);
    const mk = marker(a.origin, 0.3);
    writeInspect(prefix + 'Origin', mk.P, null, mk.F, '#00e5ff');
    console.log(`inspection models: ${path.relative(path.join(__dirname, '..'), INSPECT)}/${prefix}{Clean,Original,Changed,Before,After,Turned,Flat,Broken,Snub,Kinks,KinksBefore,Tucked,TuckedBefore,Orphans,Floating,Open,OpenCovered,Origin}.obj`);
  }
  if (process.argv.includes('--write')) {
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    // only the vertices still used, in their old order
    const used = [...new Set(clean.flat())].sort((x, y) => x - y), to = new Map(used.map((v, i) => [v, i]));
    const out = M.writeMesh(mesh, name, { attrs: attrs.map(ch => ch && used.map(v => ch[v])), triangles: clean.flat().map(v => to.get(v)) });
    console.log(`${used.length} vertices (were ${mesh.attrs[0].length})`);
    fs.writeFileSync(path.join(S.REPO, file), out);
    console.log(`wrote ${file}`);
  }
}

if (require.main === module) main();
module.exports = { readCanopyMesh, analyse, rejoin, restitch, flatTrims, snubEnds, floating, unkinks, roundStarts, tuckBases, spreads };
