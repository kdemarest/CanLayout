// Mantis LOD's mesh simplifier, ported from its managed C# plugin (CanopyGrid,
// Assets/MantisLODEditor/Plugins/Managed/MantisLOD.cs, (c) Mingfen Wang), which CanopyGrid's Dicer
// ran on each tree to make its LODs. It collapses half-edges onto existing vertices, cheapest
// first (cost: edge length squared, weighted by the curvature of the faces around it, with
// penalties for breaking UV, color, normal or material seams and for boundaries), and records
// every collapse, so any quality can be read back. Kept close to the original, quirks included
// (its heap's Remove only sifts down), so it picks the same collapses; costs are rounded to 32-bit
// floats as C# does.
//   simplify(mesh, quality, flags) -> triangle indices (into the mesh's own vertices)
//   mesh: { positions: [[x,y,z]], triangles: [i,...] (one submesh), uvs, colors, normals } (optional channels)
//   quality: 0-100 (Mantis's: the share of collapses NOT applied)
//   flags: { protect_boundary, protect_detail, protect_symmetry, protect_normal, protect_shape,
//            use_detail_map, detail_boost }
const f32 = Math.fround;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sqr = a => dot(a, a);
const normalized = a => {
  const l = Math.sqrt(sqr(a));
  return l > 1e-5 ? a.map(x => x / l) : [0, 0, 0]; // Unity's Vector3.normalized
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Unity's vector ==: the difference's squared length under 1e-10.
const same = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
  return s < 9.99999944e-11;
};

// A binary min-heap of half-edges by cost (1-based, as the original).
class MinHeap {
  constructor() { this.c = [null]; }
  last() { return this.c.length - 1; }
  less(current, other) { return other.cost < current.cost; } // Compare(current, other)
  push(e) {
    this.c.push(e);
    e.pq = this.last();
    this.up(this.last());
  }
  remove(i) {
    if (this.last() === 0) return false;
    this.c[i].pq = -1;
    this.c[i] = this.c[this.last()];
    this.c[i].pq = i;
    this.down(i);
    this.c.pop();
    return true;
  }
  top() { return this.last() === 0 ? null : this.c[1]; }
  up(i) {
    const cur = this.c[i];
    let p = i >> 1;
    while (i > 1) {
      if (this.less(this.c[p], cur)) {
        this.c[i] = this.c[p];
        this.c[i].pq = i;
        i = p;
        p >>= 1;
      } else break;
    }
    this.c[i] = cur;
    cur.pq = i;
  }
  down(i) {
    const cur = this.c[i];
    let l = i * 2;
    while (l <= this.last()) {
      if (l < this.last() && this.less(this.c[l], this.c[l + 1])) l++;
      if (this.less(cur, this.c[l])) {
        this.c[i] = this.c[l];
        this.c[i].pq = i;
        i = l;
        l *= 2;
      } else break;
    }
    this.c[i] = cur;
    cur.pq = i;
  }
}

function progressive(mesh, flags) {
  const lockBoundary = Boolean(flags.protect_boundary), lockDetail = Boolean(flags.protect_detail);
  const lockSymmetry = Boolean(flags.protect_symmetry), lockNormal = Boolean(flags.protect_normal);
  const lockShape = Boolean(flags.protect_shape), useDetailMap = Boolean(flags.use_detail_map);
  const detailBoost = flags.detail_boost ?? 10;
  const uvs = mesh.uvs || [], colors = mesh.colors || [], normals = mesh.normals || [];
  const vertices = [], faces = [], edges = [], trace = [];
  const pq = new MinHeap();
  // load_mesh_from_array: vertices by exact position (the original's hash is exact)
  const MAX = [0, 0, 0], MIN = [0, 0, 0];
  const unique = new Map(), imap = [];
  for (const p of mesh.positions) {
    const k = p.join();
    if (!unique.has(k)) {
      for (let a = 0; a < 3; a++) {
        if (p[a] > MAX[a]) MAX[a] = p[a];
        if (p[a] < MIN[a]) MIN[a] = p[a];
      }
      unique.set(k, vertices.length);
      vertices.push({ alive: true, onBoundary: false, onSymmetry: false, position: p, edges: [] });
    }
    imap.push(unique.get(k));
  }
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const i0 = imap[t[i]], i1 = imap[t[i + 1]], i2 = imap[t[i + 2]];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    const f = { alive: true, mat: 0, edge: null, n: [0, 0, 0] };
    const three = [0, 1, 2].map(() => ({ alive: true, pq: -1, vertex: null, index: 0, face: f, next: null, cost: 0 }));
    for (let j = 0; j < 3; j++) {
      three[j].next = three[(j + 1) % 3];
      const v = vertices[imap[t[i + j]]];
      three[j].vertex = v;
      three[j].index = t[i + j];
      v.edges.push(three[j]);
      edges.push(three[j]);
    }
    f.edge = three[0];
    faces.push(f);
  }
  const maxSquareLength = f32(sqr(sub(MAX, MIN)));
  let faceCount = faces.length;

  const faceNormal = f => {
    const e = f.edge;
    f.n = normalized(cross(sub(e.next.vertex.position, e.vertex.position), sub(e.next.next.vertex.position, e.vertex.position))).map(f32);
  };
  const isBoundaryEdge = e => {
    const from = e.vertex, to = e.next.vertex;
    let count = 0;
    for (const fe of from.edges) {
      for (const te of to.edges) {
        if (fe.face === te.face) { count++; break; }
      }
    }
    return count === 1;
  };
  const isSymmetryEdge = e => {
    const from = e.vertex, to = e.next.vertex;
    const mf = [], mt = [];
    for (const fe of from.edges) if (fe.next.vertex === to) mf.push(fe.next.next.index);
    for (const te of to.edges) if (te.next.vertex === from) mt.push(te.next.next.index);
    if (mf.length !== mt.length) return false;
    for (const fi of mf) {
      let sym = false;
      for (const ti of mt) {
        if (fi === ti) continue;
        if (uvs.length > 0 && same(uvs[fi], uvs[ti])) { sym = true; break; }
      }
      if (!sym) return false;
    }
    return true;
  };

  function cost(e) {
    const from = e.vertex, to = e.next.vertex;
    const squareLength = f32(sqr(sub(to.position, from.position)));
    const indexMaps = [], matMaps = [], common = [];
    for (const fe of from.edges) {
      for (const te of to.edges) {
        if (fe.face === te.face) {
          indexMaps.push(fe.index);
          matMaps.push(fe.face.mat);
          common.push(fe.face);
          break;
        }
      }
    }
    let brokenNormal = false, brokenColor = false, brokenUv = false, brokenMat = false;
    let maxCurvature = -3.4028235e38, worstShape = 0;
    for (const fe of from.edges) {
      let isCommon = false, minCurvature = 3.4028235e38;
      for (const cf of common) {
        const curvature = f32((1 - dot(fe.face.n, cf.n)) * 0.5);
        if (curvature < minCurvature) minCurvature = curvature;
        if (fe.face === cf) isCommon = true;
      }
      if (minCurvature > maxCurvature) maxCurvature = minCurvature;
      if (isCommon) continue;
      if (lockShape) {
        const v1 = to, v2 = fe.next.vertex, v3 = fe.next.next.vertex;
        const e1 = normalized(sub(v2.position, v1.position)), e2 = normalized(sub(v3.position, v2.position)), e3 = normalized(sub(v1.position, v3.position));
        const c1 = dot(e3, e1), c2 = dot(e1, e2), c3 = dot(e2, e3);
        const shape = f32((Math.max(c1, c2, c3) - Math.min(c1, c2, c3)) * 0.5);
        if (shape > worstShape) worstShape = shape;
      }
      if (lockNormal && !brokenNormal) {
        if (!indexMaps.some(idx => normals.length === 0 || same(normals[fe.index], normals[idx]))) brokenNormal = true;
      }
      if (!useDetailMap && !brokenColor) {
        if (!indexMaps.some(idx => colors.length === 0 || same(colors[fe.index], colors[idx]))) brokenColor = true;
      }
      if (!brokenUv) {
        if (!indexMaps.some(idx => uvs.length === 0 || same(uvs[fe.index], uvs[idx]))) brokenUv = true;
      }
      if (!brokenMat && !matMaps.some(m => fe.face.mat === m)) brokenMat = true;
    }
    const pen = b => (b ? maxSquareLength : 0);
    const symmetryPunish = lockSymmetry && from.onSymmetry && !to.onSymmetry ? maxSquareLength : 0;
    let boundaryPunish = 0, maxBoundaryCurvature = 0;
    if (lockBoundary) {
      if (from.onBoundary || to.onBoundary) boundaryPunish = maxSquareLength;
    } else if (from.onBoundary) {
      if (to.onBoundary) {
        for (const fe of from.edges) {
          if (isBoundaryEdge(fe.next.next)) {
            const p0 = fe.next.next.vertex.position, p1 = from.position, p2 = to.position;
            const bc = f32((1 - dot(normalized(sub(p1, p0)), normalized(sub(p2, p1)))) * 0.5);
            if (bc > maxBoundaryCurvature) maxBoundaryCurvature = bc;
          }
        }
      } else boundaryPunish = maxSquareLength;
    }
    if (lockDetail) maxCurvature = f32(maxCurvature * maxCurvature);
    const detailWeight = useDetailMap && colors.length > 0 ? 1 + detailBoost * colors[e.index][0] : 1;
    if (maxCurvature < 1e-6) maxCurvature = f32(1e-6);
    const cw = 20, bw = 20, sw = 1;
    return f32(squareLength * detailWeight * ((maxCurvature * cw + maxBoundaryCurvature * bw + worstShape * sw) / (cw + bw + sw)) +
      boundaryPunish + pen(brokenNormal) + pen(brokenColor) + pen(brokenUv) + symmetryPunish + pen(brokenMat));
  }

  // calculate_cost_of_edges
  faces.forEach(faceNormal);
  for (const e of edges) {
    if (!isBoundaryEdge(e)) continue;
    e.vertex.onBoundary = true;
    e.next.vertex.onBoundary = true;
  }
  for (const e of edges) {
    if (!isSymmetryEdge(e)) continue;
    e.vertex.onSymmetry = true;
    e.next.vertex.onSymmetry = true;
  }
  for (const e of edges) {
    e.cost = cost(e);
    pq.push(e);
  }

  function contract(edge) {
    const from = edge.vertex, to = edge.next.vertex;
    const indexMaps = [], common = [];
    for (const fe of from.edges) {
      for (const te of to.edges) {
        if (fe.face === te.face) {
          if (fe.next.vertex === to) indexMaps.push([fe.index, fe.next.index]);
          else if (fe.next.next.vertex === to) indexMaps.push([fe.index, fe.next.next.index]);
          common.push(fe.face);
          break;
        }
      }
    }
    const one = { safe: true, from, to, erased: [], updated: [] };
    const symDiff = [];
    for (const fe of from.edges) {
      if (common.includes(fe.face)) continue;
      fe.vertex = to;
      let best = indexMaps[indexMaps.length - 1][1];
      for (const [k, val] of indexMaps) {
        if (uvs.length === 0 || same(uvs[fe.index], uvs[k])) { best = val; break; }
      }
      one.updated.push({ edge: fe, from: fe.index, to: best });
      fe.index = best;
      symDiff.push(fe);
    }
    for (const te of to.edges) if (!common.includes(te.face)) symDiff.push(te);
    to.edges = symDiff;
    for (const te of to.edges) {
      te.cost = cost(te);
      te.next.cost = cost(te.next);
      te.next.next.cost = cost(te.next.next);
      pq.remove(te.pq);
      pq.push(te);
      pq.remove(te.next.pq);
      pq.push(te.next);
      pq.remove(te.next.next.pq);
      pq.push(te.next.next);
      faceNormal(te.face);
    }
    for (const cf of common) {
      cf.alive = false;
      faceCount--;
      one.erased.push(cf);
      cf.edge.alive = cf.edge.next.alive = cf.edge.next.next.alive = false;
      pq.remove(cf.edge.pq);
      pq.remove(cf.edge.next.pq);
      pq.remove(cf.edge.next.next.pq);
      let finder = cf.edge;
      do {
        if (finder.vertex !== from && finder.vertex !== to) {
          const k = finder.vertex.edges.indexOf(finder);
          if (k >= 0) finder.vertex.edges.splice(k, 1);
          break;
        }
        finder = finder.next;
      } while (finder !== cf.edge);
    }
    from.alive = false;
    if (edge.cost >= maxSquareLength) one.safe = false;
    trace.push(one);
  }
  while (faceCount > 0 && pq.top() !== null) contract(pq.top());
  let position = trace.length;

  function traceTo(goal) {
    for (;;) {
      if (position === goal) break;
      if (position > goal) {
        position--;
        for (const u of trace[position].updated) {
          u.edge.vertex = trace[position].from;
          u.edge.index = u.from;
        }
      } else {
        if (!trace[position].safe) break;
        for (const u of trace[position].updated) {
          u.edge.vertex = trace[position].to;
          u.edge.index = u.to;
        }
        position++;
      }
    }
    return position;
  }
  traceTo(0);

  // get_triangle_list at a quality (MantisLODSimpler.get_triangle_list)
  return function triangles(quality) {
    if (trace.length === 0) return [];
    let goal = Math.trunc(f32(trace.length * f32(1 - f32(quality * 0.01))) + 0.5);
    goal = Math.max(Math.min(goal, trace.length), 0);
    goal = traceTo(goal);
    const out = [];
    let counter = trace.length;
    for (let i = trace.length - 1; i >= 0; i--) {
      if (counter === goal) break;
      for (const f of trace[i].erased) out.push(f.edge.index, f.edge.next.index, f.edge.next.next.index);
      counter--;
    }
    return out;
  };
}

function simplify(mesh, quality, flags = {}) {
  return progressive(mesh, flags)(quality);
}

module.exports = { simplify, progressive };
