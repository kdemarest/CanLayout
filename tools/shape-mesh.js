// Triangles for placeholder shapes (tools/shapes.js), the same solids web/app.js draws, for
// writing as model files (tools/make-shapes.js). Points are in the asset's Unity space, after
// the shape's scale, turn and at. Every solid is convex, so each triangle is turned to face
// away from the solid's middle; faces are flat (one normal per triangle).
const U = require('./unity.js');

const TAU = Math.PI * 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// A ring of n points at height y, angle measured as Three.js does (x = r sin, z = r cos).
const ring = (r, y, n, turn = 0) => Array.from({ length: n }, (_, i) => {
  const a = turn + i / n * TAU;
  return [r * Math.sin(a), y, r * Math.cos(a)];
});
// Side quads between two rings, plus the caps (a cap of radius 0 is a point and is skipped).
function frustum(bottom, top, h, n, turn = 0) {
  const lo = ring(bottom, 0, n, turn), hi = ring(top, h, n, turn), tris = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]);
    if (i > 0 && i < n - 1) {
      tris.push([lo[0], lo[i], lo[i + 1]]);
      if (top > 0) tris.push([hi[0], hi[i], hi[i + 1]]);
    }
  }
  return tris;
}
// A grid over the sphere: phi around (0..arc), theta down from the top (0..thetaEnd).
function sphereGrid(r, arc, thetaEnd, across, down) {
  const at = (u, v) => {
    const phi = u / across * arc, theta = v / down * thetaEnd;
    return [-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta)];
  };
  const tris = [];
  for (let v = 0; v < down; v++) for (let u = 0; u < across; u++) {
    tris.push([at(u, v), at(u + 1, v), at(u + 1, v + 1)], [at(u, v), at(u + 1, v + 1), at(u, v + 1)]);
  }
  return { tris, at };
}
function box(w, h, d) {
  const x = w / 2, z = d / 2;
  const c = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], [-x, h, -z], [x, h, -z], [x, h, z], [-x, h, z]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return quads.flatMap(([a, b, e, f]) => [[c[a], c[b], c[e]], [c[a], c[e], c[f]]]);
}
// Three.js's dodecahedron: 20 corners; each of the 12 faces is the 5 corners nearest one of the
// icosahedron's corners, fanned.
function dodecahedron(size) {
  const t = (1 + Math.sqrt(5)) / 2, r = 1 / t, s = size / 2 / Math.sqrt(3);
  const corners = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) corners.push([a, b, c]);
  for (const a of [-1, 1]) for (const b of [-1, 1]) corners.push([0, a * r, b * t], [a * r, b * t, 0], [a * t, 0, b * r]);
  const normals = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) normals.push([0, a * t, b], [a * t, b, 0], [a, 0, b * t]);
  const tris = [];
  for (const n of normals) {
    const face = corners.map(p => [p, dot(p, n)]).sort((p, q) => q[1] - p[1]).slice(0, 5).map(p => p[0]);
    // Order the five around the face normal.
    const mid = face.reduce((m, p) => [m[0] + p[0] / 5, m[1] + p[1] / 5, m[2] + p[2] / 5], [0, 0, 0]);
    const e1 = unit(sub(face[0], mid)), e2 = cross(unit(n), e1);
    face.sort((p, q) => Math.atan2(dot(sub(p, mid), e2), dot(sub(p, mid), e1)) - Math.atan2(dot(sub(q, mid), e2), dot(sub(q, mid), e1)));
    for (let i = 1; i < 4; i++) tris.push([face[0], face[i], face[i + 1]]);
  }
  return tris.map(tri => tri.map(p => [p[0] * s, p[1] * s + size / 2, p[2] * s]));
}

// Triangles of one shape in its own space, before scale, turn and at.
function solid(shape) {
  const [a, b, c] = shape.size, tip = shape.tip || 0;
  switch (shape.kind) {
    case 'box': return box(a, b, c);
    case 'cylinder': return frustum(a, a, b, shape.sides || 24);
    case 'cone': return frustum(a, a * tip, b, shape.sides || 24);
    case 'pyramid':
      return frustum(1, tip, b, 4, Math.PI / 4).map(tri => tri.map(p => [p[0] * a / Math.SQRT2, p[1], p[2] * c / Math.SQRT2]));
    case 'sphere': return sphereGrid(a, TAU, Math.PI, 24, 16).tris.map(tri => tri.map(p => [p[0], p[1] + a, p[2]]));
    case 'hemisphere': {
      const arc = (shape.arc || 360) / 360 * TAU, across = 24, down = 8;
      const { tris, at } = sphereGrid(a, arc, Math.PI / 2, across, down);
      for (let u = 0; u < across; u++) tris.push([[0, 0, 0], at(u, down), at(u + 1, down)]); // the disc underneath
      if (shape.arc && shape.arc < 360) for (const u of [0, across]) for (let v = 0; v < down; v++) tris.push([[0, 0, 0], at(u, v), at(u, v + 1)]);
      return tris;
    }
    case 'dodecahedron': return dodecahedron(a);
    case 'prism': {
      const corner = (x, y, z) => [x, y, z], z = c / 2;
      const f = [corner(-a / 2, 0, -z), corner(a / 2, 0, -z), corner(0, b, -z)], k = f.map(p => [p[0], p[1], z]);
      return [f, k, [f[0], f[1], k[1]], [f[0], k[1], k[0]], [f[1], f[2], k[2]], [f[1], k[2], k[1]], [f[2], f[0], k[0]], [f[2], k[0], k[2]]];
    }
  }
  throw new Error(`no solid for ${shape.kind}`);
}

// [{ p: [3 points], n: normal }] for one shape (not "use"), in the asset's space.
function triangles(shape) {
  let tris = solid(shape).filter(tri => Math.hypot(...cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))) > 1e-12);
  // Outward: away from the middle of all the points (the solids are convex).
  const all = tris.flat(), mid = all.reduce((m, p) => [m[0] + p[0] / all.length, m[1] + p[1] / all.length, m[2] + p[2] / all.length], [0, 0, 0]);
  tris = tris.map(tri => {
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const centre = [0, 1, 2].map(i => (tri[0][i] + tri[1][i] + tri[2][i]) / 3);
    return dot(n, sub(centre, mid)) < 0 ? [tri[0], tri[2], tri[1]] : tri;
  });
  const sc = shape.scale || [1, 1, 1], at = shape.at, q = U.eulerToQuat({ x: shape.turn[0], y: shape.turn[1], z: shape.turn[2] });
  const rotate = p => {
    // q p q^-1
    const { x, y, z, w } = q, v = p;
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
  };
  const place = p => { const r = rotate([p[0] * sc[0], p[1] * sc[1], p[2] * sc[2]]); return [r[0] + at[0], r[1] + at[1], r[2] + at[2]]; };
  return tris.map(tri => {
    const p = tri.map(place);
    return { p, n: unit(cross(sub(p[1], p[0]), sub(p[2], p[0]))) };
  });
}

// An OBJ file of triangles given in Unity space. Unity reads an .obj with X negated and the
// winding reversed, so both are done here and it gets the points back as given. UVs are a box
// projection (1 per meter, by each face's main axis): Canopy/General's normal map needs
// tangents, which Unity can't make for a mesh with no UVs.
function toObj(tris, label) {
  const f6 = x => +x.toFixed(6) || 0;
  const v = [], vt = [], vn = [], f = [];
  tris.forEach((t, i) => {
    const a = t.n.map(Math.abs), uv = a[0] >= a[1] && a[0] >= a[2] ? p => [p[2], p[1]] : a[1] >= a[2] ? p => [p[0], p[2]] : p => [p[0], p[1]];
    for (const p of [t.p[0], t.p[2], t.p[1]]) {
      v.push(`v ${f6(-p[0])} ${f6(p[1])} ${f6(p[2])}`);
      vt.push(`vt ${uv(p).map(f6).join(' ')}`);
    }
    vn.push(`vn ${f6(-t.n[0])} ${f6(t.n[1])} ${f6(t.n[2])}`);
    const k = i * 3;
    f.push(`f ${k + 1}/${k + 1}/${i + 1} ${k + 2}/${k + 2}/${i + 1} ${k + 3}/${k + 3}/${i + 1}`);
  });
  return [`# ${label}, placeholder from docs Shape lines (layout/tools/make-shapes.js)`, `o ${label}`, ...v, ...vt, ...vn, ...f].join('\n') + '\n';
}

module.exports = { triangles, toObj };
