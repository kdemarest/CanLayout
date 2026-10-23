// Binary FBX reader: the node tree, then its models and meshes, and OBJ output in Unity's terms.
// usage: node tools/fbx.js file.fbx   (prints what it found)
const fs = require('fs');
const zlib = require('zlib');

// ---------- binary node tree ----------
// Each node is { name, props: [...], children: [...] }. Arrays come back as typed arrays.
function parseBinary(buf) {
  if (buf.toString('latin1', 0, 20) !== 'Kaydara FBX Binary  ') throw new Error('not a binary FBX (ASCII FBX is not supported)');
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500; // 64-bit record offsets
  let at = 27;
  const u = () => { const v = wide ? Number(buf.readBigUInt64LE(at)) : buf.readUInt32LE(at); at += wide ? 8 : 4; return v; };
  const array = (type) => {
    const length = buf.readUInt32LE(at), encoding = buf.readUInt32LE(at + 4), size = buf.readUInt32LE(at + 8);
    at += 12;
    let data = buf.subarray(at, at + size);
    at += size;
    if (encoding === 1) data = zlib.inflateSync(data);
    const copy = Buffer.from(data); // aligned copy for typed arrays
    const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.length);
    if (type === 'd') return new Float64Array(ab, 0, length);
    if (type === 'f') return new Float32Array(ab, 0, length);
    if (type === 'i') return new Int32Array(ab, 0, length);
    if (type === 'l') return new BigInt64Array(ab, 0, length);
    if (type === 'b') return new Uint8Array(ab, 0, length);
    throw new Error(`unknown FBX array type ${type}`);
  };
  const prop = () => {
    const type = String.fromCharCode(buf[at++]);
    switch (type) {
      case 'Y': at += 2; return buf.readInt16LE(at - 2);
      case 'C': at += 1; return buf[at - 1] !== 0;
      case 'I': at += 4; return buf.readInt32LE(at - 4);
      case 'F': at += 4; return buf.readFloatLE(at - 4);
      case 'D': at += 8; return buf.readDoubleLE(at - 8);
      case 'L': at += 8; return buf.readBigInt64LE(at - 8);
      case 'S': case 'R': {
        const n = buf.readUInt32LE(at);
        at += 4 + n;
        const raw = buf.subarray(at - n, at);
        return type === 'S' ? raw.toString('utf8') : raw;
      }
      default: return array(type);
    }
  };
  const node = () => {
    const end = u(), count = u();
    u(); // property list length
    const nameLength = buf[at++];
    if (end === 0) return null; // null record ends a list
    const name = buf.toString('latin1', at, at + nameLength);
    at += nameLength;
    const props = [];
    for (let i = 0; i < count; i++) props.push(prop());
    const children = [];
    while (at < end) {
      const child = node();
      if (!child) break;
      children.push(child);
    }
    at = end;
    return { name, props, children };
  };
  const top = [];
  while (at < buf.length - 160) {
    const n = node();
    if (!n) break;
    top.push(n);
  }
  return { version, children: top };
}
const child = (n, name) => n && n.children.find(c => c.name === name);
const children = (n, name) => (n ? n.children.filter(c => c.name === name) : []);

// Properties70 -> { name: [values] }
function properties(n) {
  const out = {};
  for (const p of children(child(n, 'Properties70'), 'P')) out[p.props[0]] = p.props.slice(4);
  return out;
}

// ---------- scene ----------
// { unitScale (cm per unit), upAxis, models: Map(id -> model), geometries: Map(id -> geometry) }
// model: { id, name, parent (id or null), props, geometry (id or null) }
function readScene(buf) {
  const root = parseBinary(buf);
  const gs = properties(child(root, 'GlobalSettings'));
  const objects = child(root, 'Objects');
  const models = new Map(), geometries = new Map();
  for (const n of children(objects, 'Model')) {
    models.set(String(n.props[0]), { id: String(n.props[0]), name: String(n.props[1]).split('\u0000')[0].replace(/^Model::/, ''), kind: n.props[2], props: properties(n), parent: null, geometry: null });
  }
  for (const n of children(objects, 'Geometry')) {
    if (n.props[2] !== 'Mesh') continue;
    geometries.set(String(n.props[0]), { id: String(n.props[0]), name: String(n.props[1]).split('\u0000')[0].replace(/^Geometry::/, ''), node: n });
  }
  const kids = new Map(); // parent id ('0' for the scene root) -> child model ids, in file order
  for (const c of children(child(root, 'Connections'), 'C')) {
    if (c.props[0] !== 'OO') continue;
    const from = String(c.props[1]), to = String(c.props[2]);
    if (geometries.has(from) && models.has(to)) models.get(to).geometry = from;
    else if (models.has(from) && (models.has(to) || to === '0')) {
      if (to !== '0') models.get(from).parent = to;
      if (!kids.has(to)) kids.set(to, []);
      kids.get(to).push(from);
    }
  }
  // Models with meshes in the order Unity reads them: depth first, children in file order.
  const meshOrder = [];
  const walk = id => {
    for (const k of kids.get(id) || []) {
      if (models.get(k).geometry) meshOrder.push(models.get(k));
      walk(k);
    }
  };
  walk('0');
  return {
    version: root.version,
    unitScale: gs.UnitScaleFactor ? gs.UnitScaleFactor[0] : 1,
    upAxis: gs.UpAxis ? gs.UpAxis[0] : 1,
    models, geometries, meshOrder
  };
}

// ---------- geometry ----------
// Triangles of one FBX mesh in its own space: { positions: [[x,y,z]...], normals, uvs } per
// triangle corner. Polygons are fanned; normals and UVs follow their mapping/reference modes.
function triangles(geometry) {
  const n = geometry.node;
  const v = child(n, 'Vertices').props[0];
  const pvi = child(n, 'PolygonVertexIndex').props[0];
  const layer = (name, dataName, indexName) => {
    const l = child(n, name);
    if (!l) return null;
    return {
      data: child(l, dataName).props[0],
      index: child(l, indexName) ? child(l, indexName).props[0] : null,
      mapping: child(l, 'MappingInformationType').props[0],
      reference: child(l, 'ReferenceInformationType').props[0],
      size: dataName === 'UV' ? 2 : 3
    };
  };
  const normals = layer('LayerElementNormal', 'Normals', 'NormalsIndex');
  const uvs = layer('LayerElementUV', 'UV', 'UVIndex');
  const fetch = (l, polyVertex, controlPoint, polygon) => {
    if (!l) return null;
    let i = l.mapping === 'ByPolygonVertex' ? polyVertex : l.mapping === 'ByPolygon' ? polygon : l.mapping === 'AllSame' ? 0 : controlPoint;
    if (l.reference === 'IndexToDirect' && l.index) i = l.index[i];
    return Array.from(l.data.subarray(i * l.size, i * l.size + l.size));
  };
  const out = [];
  let poly = [], polygon = 0;
  for (let k = 0; k < pvi.length; k++) {
    let cp = pvi[k];
    const last = cp < 0;
    if (last) cp = ~cp;
    poly.push({ p: [v[cp * 3], v[cp * 3 + 1], v[cp * 3 + 2]], n: fetch(normals, k, cp, polygon), t: fetch(uvs, k, cp, polygon) });
    if (last) {
      for (let i = 1; i < poly.length - 1; i++) out.push([poly[0], poly[i], poly[i + 1]]);
      poly = [];
      polygon++;
    }
  }
  return out;
}

// ---------- transforms ----------
const DEG = Math.PI / 180;
function mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  return o;
}
const T = v => [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1];
const S = v => [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1];
// FBX euler (degrees) in the default XYZ order: R = Rz * Ry * Rx.
function R(e) {
  const [x, y, z] = e.map(a => a * DEG);
  const rx = [1, 0, 0, 0, 0, Math.cos(x), -Math.sin(x), 0, 0, Math.sin(x), Math.cos(x), 0, 0, 0, 0, 1];
  const ry = [Math.cos(y), 0, Math.sin(y), 0, 0, 1, 0, 0, -Math.sin(y), 0, Math.cos(y), 0, 0, 0, 0, 1];
  const rz = [Math.cos(z), -Math.sin(z), 0, 0, Math.sin(z), Math.cos(z), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return mul(rz, mul(ry, rx));
}
const neg = v => v.map(x => -x);
const transpose3 = m => [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
// A model's geometric transform (applied to its mesh only, not inherited).
function geometricMatrix(props) {
  const g = k => props[k] || null;
  return mul(T(g('GeometricTranslation') || [0, 0, 0]), mul(R(g('GeometricRotation') || [0, 0, 0]), S(g('GeometricScaling') || [1, 1, 1])));
}

// ---------- to OBJ for the viewer ----------
// The mesh Unity makes from one FBX model, in the cache's convention. Unity imports an FBX by
// negating X (right- to left-handed) and reversing winding; the cache stores Unity meshes with
// X negated back (see asset-mesh.js). The two cancel, so vertices stay as in the file: in the
// model's own space with its geometric transform, less its pivot, times the import scale.
// Unity resets each node's pivot on import, moving the node's origin to its pivot (e.g. an
// engine modeled in place on a jet gets its origin at the engine). importScale is the
// .meta's Scale Factor times, when Convert Units is on, the file's unit (UnitScaleFactor cm)
// in meters.
function modelToObj(scene, model, importScale, label) {
  const g = scene.geometries.get(model.geometry);
  if (!g) throw new Error(`model ${model.name} has no mesh`);
  const pivot = model.props.RotationPivot || model.props.ScalingPivot || [0, 0, 0];
  const m = mul(T(neg(pivot)), geometricMatrix(model.props));
  const nm = transpose3(invert3(m)); // for normals
  const tris = triangles(g);
  const L = ['# from ' + label];
  const vs = [], vts = [], vns = [], fs = [];
  const f6 = x => +x.toFixed(6);
  let i = 0;
  for (const tri of tris) {
    const ids = [];
    for (const c of tri) {
      const p = apply(m, c.p);
      vs.push('v ' + [p[0] * importScale, p[1] * importScale, p[2] * importScale].map(f6).join(' '));
      if (c.t) vts.push('vt ' + c.t.map(f6).join(' '));
      if (c.n) {
        const n = normalize(apply3(nm, c.n));
        vns.push('vn ' + n.map(f6).join(' '));
      }
      ids.push(++i);
    }
    const ref = k => `${k}/${tri[0].t ? k : ''}/${tri[0].n ? k : ''}`;
    fs.push('f ' + ids.map(ref).join(' '));
  }
  return L.concat(vs, vts, vns, fs).join('\n') + '\n';
}
// A model file used whole (placed directly in a prefab), as one OBJ in its root's space: every
// mesh with its node transforms, pivots reset as Unity does. A file with one top node becomes
// that node (Unity makes it the prefab's root); else the root is the file itself. The root's own
// scale is kept in the mesh when keepRootScale (the instance didn't set its own scale).
function wholeModelToObj(scene, importScale, keepRootScale, label) {
  const local = p => {
    const v = (k, d) => p[k] || d;
    const pre = R(v('PreRotation', [0, 0, 0])), post = R(v('PostRotation', [0, 0, 0]));
    const rp = v('RotationPivot', [0, 0, 0]), sp = v('ScalingPivot', [0, 0, 0]);
    return [T(v('Lcl Translation', [0, 0, 0])), T(v('RotationOffset', [0, 0, 0])), T(rp), pre, R(v('Lcl Rotation', [0, 0, 0])), transpose3(post),
      T(neg(rp)), T(v('ScalingOffset', [0, 0, 0])), T(sp), S(v('Lcl Scaling', [1, 1, 1])), T(neg(sp))].reduce(mul);
  };
  const world = new Map();
  const W = m => {
    if (!world.has(m.id)) world.set(m.id, m.parent ? mul(W(scene.models.get(m.parent)), local(m.props)) : local(m.props));
    return world.get(m.id);
  };
  const tops = [...scene.models.values()].filter(m => !m.parent);
  let base = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (tops.length === 1) {
    const r = tops[0], pivot = r.props.RotationPivot || r.props.ScalingPivot || [0, 0, 0];
    const rw = mul(W(r), T(pivot));
    base = invert4(rw);
    if (keepRootScale) base = mul(S([0, 1, 2].map(c => Math.hypot(rw[c], rw[4 + c], rw[8 + c]))), base);
  }
  const L = ['# from ' + label + ' (whole file)'];
  const vs = [], vts = [], vns = [], fs = [];
  const f6 = x => +x.toFixed(6);
  let i = 0;
  for (const model of scene.meshOrder) {
    const m = mul(base, mul(W(model), geometricMatrix(model.props)));
    const nm = transpose3(invert3(m));
    for (const tri of triangles(scene.geometries.get(model.geometry))) {
      const ids = [];
      for (const c of tri) {
        const p = apply(m, c.p);
        vs.push('v ' + p.map(x => f6(x * importScale)).join(' '));
        if (c.t) vts.push('vt ' + c.t.map(f6).join(' '));
        if (c.n) vns.push('vn ' + normalize(apply3(nm, c.n)).map(f6).join(' '));
        ids.push(++i);
      }
      fs.push('f ' + ids.map(k => `${k}/${tri[0].t ? k : ''}/${tri[0].n ? k : ''}`).join(' '));
    }
  }
  if (!i) throw new Error('no meshes in the file');
  return L.concat(vs, vts, vns, fs).join('\n') + '\n';
}
function invert4(m) {
  const r = invert3(m);
  const t = apply3(r, [m[3], m[7], m[11]]);
  r[3] = -t[0]; r[7] = -t[1]; r[11] = -t[2];
  return r;
}
const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const apply3 = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[4] * p[0] + m[5] * p[1] + m[6] * p[2], m[8] * p[0] + m[9] * p[1] + m[10] * p[2]];
const normalize = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
function invert3(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, 0, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, 0, C / det, -(a * h - b * g) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1];
}

// The model for a mesh reference: by the mesh name Unity listed (meta table), else by the
// name of the game object holding it, else the file's only mesh, or its only one that is not
// a lower LOD (LOD1 and beyond). Failing all that, a guess: the mesh with the most triangles.
// (Newer Unity .meta files no longer list which internal id is which mesh.)
function findModel(scene, meshName, objectName, fileID) {
  const withMesh = [...scene.models.values()].filter(m => m.geometry);
  // Older Unity ids number a model's meshes 4300000, 4300002, ... in reading order.
  const old = /^43(\d{5})$/.exec(String(fileID || ''));
  if (old && +old[1] % 2 === 0 && scene.meshOrder[+old[1] / 2]) return scene.meshOrder[+old[1] / 2];
  const byName = name => name && withMesh.find(m => m.name === name || scene.geometries.get(m.geometry).name === name);
  const top = withMesh.filter(m => !/lod[1-9]\d*$/i.test(m.name));
  const largest = () => top.slice().sort((a, b) => triangleCount(scene, b) - triangleCount(scene, a))[0] || null;
  return byName(meshName) || byName(objectName) || (withMesh.length === 1 ? withMesh[0] : top.length === 1 ? top[0] : largest());
}
function triangleCount(scene, model) {
  const pvi = child(scene.geometries.get(model.geometry).node, 'PolygonVertexIndex').props[0];
  return pvi.length;
}
// Unity's import scale for a model, from its .meta settings (guid-index "import").
function importScale(scene, settings) {
  const s = settings || {};
  return (s.globalScale ?? 1) * (s.useFileScale === 0 ? 1 : scene.unitScale / 100);
}

module.exports = { parseBinary, readScene, triangles, modelToObj, wholeModelToObj, findModel, importScale, mul, T, R, S, neg };

if (require.main === module) {
  const scene = readScene(fs.readFileSync(process.argv[2]));
  console.log(`FBX ${scene.version}, unit ${scene.unitScale} cm, up axis ${scene.upAxis}`);
  for (const m of scene.models.values()) {
    const g = m.geometry && scene.geometries.get(m.geometry);
    const t = g ? triangles(g) : [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const tri of t) for (const c of tri) c.p.forEach((x, k) => { lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); });
    const p = m.props;
    console.log(`  ${m.name} (${m.kind})${m.parent ? ' parent ' + scene.models.get(m.parent).name : ''}${g ? `: ${t.length} tris, size ${hi.map((h, k) => (h - lo[k]).toFixed(2)).join(' x ')}` : ''}`
      + ` T ${(p['Lcl Translation'] || [0, 0, 0]).map(v => v.toFixed(2))} R ${(p['Lcl Rotation'] || [0, 0, 0]).map(v => v.toFixed(1))} S ${(p['Lcl Scaling'] || [1, 1, 1]).map(v => v.toFixed(2))}`
      + (p.PreRotation ? ` Pre ${p.PreRotation.map(v => v.toFixed(1))}` : '') + (p.GeometricTranslation || p.GeometricRotation || p.GeometricScaling ? ' (geometric)' : ''));
  }
}
