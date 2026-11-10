// The Tangle's hub (Ken, 2026-10-28): its trunk origin, where some 70 branch starts crowd into one
// knot, is hidden in a ball, and the trunk widened so it runs smoothly into the ball:
//   node tools/mesh-hub.js <Assets/... mesh> --radius <mesh units> [--ease <rings, default 3>]
//       [--inspect <Prefix> [--material <name>]] [--write | --out <local file>] [--ball <Assets/... .asset to write>]
// The ball's centre is the trunk origin (tools/mesh-clean.js's analyse: where the most branch bases
// gather). The trunk's first ring with its centre inside the ball is put on the ball (each vertex
// out along its ring to 0.98 of the radius, so the ball's flat facets still cover it); the rings
// below it, back to the ease'th, are widened towards a straight line from the ring before them to
// that one, eased out (1 - (1 - t)^2 of the way, t the share of the length from that ring), never
// narrowed. Trunk triangles with every corner inside the ball go. Branches are left as they are.
// Normals are recomputed where positions moved. The ball (--ball) is a latitude-longitude sphere in
// the same mesh units, written in the vertex format of a GridTangle piece (its texture as the
// trunk's: once round the equator, as many times per unit pole to pole as the trunk along its
// length), its poles hidden: the north one where the biggest branch leaving the ball at 25° above
// its equator or more comes out of it (the widened trunk covers the ball from about 12° below its
// equator down, so the south pole, as far below, is inside the trunk). --inspect writes layout
// layers <Prefix> (the mesh, front faces), <Prefix>Inside (its back faces, red) and <Prefix>Ball;
// --write writes the mesh over the Canopy file, without the vertices nothing uses any more (log it
// in docs/code/Canopy Changes.md); --out writes it to a local file instead (for tools/mesh-clean.js
// --texture-only --from <file>, so the texture is made afresh after the trunk is widened).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./scene.js');
const M = require('./unity-mesh.js');
const MC = require('./mesh-clean.js');

const INSPECT = path.join(__dirname, '..', 'cache', 'inspect');
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };

// A layout layer, as mesh-clean writes them (Unity's X negated, winding reversed).
function layer(name, P, N, tris, look, uv = null) {
  fs.mkdirSync(INSPECT, { recursive: true });
  const used = [...new Set(tris.flat())], at = new Map(used.map((v, i) => [v, i + 1]));
  const f6 = x => +x.toFixed(5);
  const lines = [`# ${name}: layout/tools/mesh-hub.js`];
  for (const v of used) lines.push('v ' + [-P[v][0], P[v][1], P[v][2]].map(f6).join(' '));
  if (uv) for (const v of used) lines.push('vt ' + uv[v].map(f6).join(' '));
  for (const v of used) lines.push('vn ' + [-N[v][0], N[v][1], N[v][2]].map(f6).join(' '));
  for (const t of tris) lines.push('f ' + [t[0], t[2], t[1]].map(v => `${at.get(v)}/${uv ? at.get(v) : ''}/${at.get(v)}`).join(' '));
  fs.writeFileSync(path.join(INSPECT, name + '.obj'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(INSPECT, name + '.json'), JSON.stringify(look));
}

// A latitude-longitude sphere: centre c, radius r, poles along axis; nu columns round, nv rows pole
// to pole; texture u once round, v per unit pole to pole. Wound as the Tangle's triangles are (their
// cross product outward). Returns { P, N, UV, tris }.
function sphere(c, r, axis, nu, nv, vPerUnit) {
  const ref = unit(Math.abs(axis[1]) < 0.9 ? cross(axis, [0, 1, 0]) : cross(axis, [1, 0, 0])), side = cross(axis, ref);
  const P = [], N = [], UV = [], tris = [];
  for (let j = 0; j <= nv; j++) {
    const lat = Math.PI * j / nv; // from the south pole
    for (let i = 0; i <= nu; i++) {
      const lon = 2 * Math.PI * i / nu;
      const n = [0, 1, 2].map(k => -Math.cos(lat) * axis[k] + Math.sin(lat) * (Math.cos(lon) * ref[k] + Math.sin(lon) * side[k]));
      P.push(c.map((x, k) => x + r * n[k])); N.push(n); UV.push([i / nu, lat * r * vPerUnit]);
    }
  }
  const id = (i, j) => j * (nu + 1) + i;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const q = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
    for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      if (new Set(t.map(v => P[v].map(x => x.toFixed(6)).join())).size < 3) continue; // at a pole
      const n = cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]));
      tris.push(dot(n, N[t[0]]) >= 0 ? t : [t[0], t[2], t[1]]);
    }
  }
  return { P, N, UV, tris };
}

function main() {
  const file = process.argv[2], R = +arg('--radius', NaN), ease = +arg('--ease', 3);
  if (!file || !(R > 0)) {
    console.log('usage: node tools/mesh-hub.js <Assets/... mesh> --radius <mesh units> [--ease <rings>] [--inspect <Prefix> [--material <name>]] [--write] [--ball <Assets/... .asset>]');
    process.exit(2);
  }
  const mesh = M.readMesh(MC.readCanopyMesh(file));
  const a = MC.analyse(mesh), O = a.origin;
  const P = mesh.attrs[0].map(p => p.slice());
  const { rings } = a.ringsByPiece.get(a.trunk);
  const centre = r => [0, 1, 2].map(i => r.reduce((s, v) => s + a.pos[v][i], 0) / r.length);
  const radius = r => { const c = centre(r); return r.reduce((s, v) => s + Math.hypot(...sub(a.pos[v], c)), 0) / r.length; };
  const kIn = rings.findIndex(r => Math.hypot(...sub(centre(r), O)) < R);
  if (kIn < ease + 1) throw new Error(`the trunk's first ring inside the ball is ring ${kIn}: too few rings below it to ease over`);
  // the entry ring on the ball, each vertex out along its ring
  const moved = new Map(); // welded vertex -> position
  const cIn = centre(rings[kIn]);
  for (const v of rings[kIn]) {
    const d = sub(a.pos[v], cIn), f = sub(cIn, O), A = dot(d, d), B = 2 * dot(f, d), K = dot(f, f) - (0.98 * R) ** 2;
    const s = (-B + Math.sqrt(Math.max(0, B * B - 4 * A * K))) / (2 * A);
    moved.set(v, cIn.map((x, i) => x + d[i] * s));
  }
  const rIn = rings[kIn].reduce((s, v) => s + Math.hypot(...sub(moved.get(v), cIn)), 0) / rings[kIn].length;
  // the rings below, widened towards the line from the anchor ring to the entry ring, eased out
  const kA = kIn - ease, along = [0];
  for (let k = kA + 1; k <= kIn; k++) along.push(along[along.length - 1] + Math.hypot(...sub(centre(rings[k]), centre(rings[k - 1]))));
  const total = along[along.length - 1], widened = [];
  for (let k = kA + 1; k < kIn; k++) {
    const t = along[k - kA] / total, r0 = radius(rings[k]), line = radius(rings[kA]) + (rIn - radius(rings[kA])) * t;
    const r1 = Math.max(r0, r0 + (line - r0) * (1 - (1 - t) ** 2)), c = centre(rings[k]);
    for (const v of rings[k]) moved.set(v, c.map((x, i) => x + (a.pos[v][i] - x) * r1 / r0));
    widened.push({ k, from: r0, to: r1 });
  }
  P.forEach((p, i) => { if (moved.has(a.w[i])) P[i] = moved.get(a.w[i]); });
  // trunk triangles wholly inside the ball go
  const trunkTris = new Set(a.trisOfPiece.get(a.trunk));
  const inBall = v => Math.hypot(...sub(P[v], O)) < R;
  const gone = new Set([...trunkTris].filter(t => a.tris[t].every(inBall)));
  const tris = a.tris.filter((t, i) => !gone.has(i));
  // normals: recomputed from the faces where a corner moved (each position's faces, area weighted)
  const N = mesh.attrs[1].map(n => n.slice()), key = p => p.map(x => Math.round(x * 1e4)).join(), sums = new Map();
  for (const t of tris) {
    const n = cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]));
    for (const v of t) { const k = key(P[v]); sums.set(k, (sums.get(k) || [0, 0, 0]).map((x, i) => x + n[i])); }
  }
  P.forEach((p, i) => { if (moved.has(a.w[i])) N[i] = unit(sums.get(key(p)) || N[i]); });
  const check = MC.analyse({ attrs: [P], triangles: tris.flat() });
  const s5 = x => (x * 5).toFixed(1);
  console.log(`${file}: ball at the trunk origin ${O.map(x => x.toFixed(3)).join(' ')} (mesh units), radius ${R} (${s5(R)} m at the Tangle's scale)`);
  console.log(`trunk: ring ${kIn} put on the ball (radius ${s5(radius(rings[kIn]))} m to ${s5(rIn)} m); widened, eased from ring ${kA}: ${widened.map(x => `ring ${x.k} ${s5(x.from)} m to ${s5(x.to)} m`).join(', ')}`);
  console.log(`trunk triangles wholly inside the ball removed: ${gone.size}; ${a.tris.length} triangles to ${tris.length}; self-crossing ${a.crossingTris.size} -> ${check.crossingTris.size}, inside out ${a.insideOut.size} -> ${check.insideOut.size}`);
  // the ball's north pole where the biggest branch leaving it 25° up or more comes out (its ring
  // centres crossing the ball), so the branch hides it and the trunk the south pole
  let up = [0, 1, 0], best = -1, through = null;
  for (const [p, info] of a.ringsByPiece) {
    if (p === a.trunk) continue;
    const C = info.rings.map(centre), d = q => Math.hypot(...sub(q, O));
    const k = C.findIndex((q, j) => j + 1 < C.length && d(q) < R && d(C[j + 1]) >= R);
    if (k < 0) continue;
    const f = (R - d(C[k])) / (d(C[k + 1]) - d(C[k])), e = unit(sub(C[k].map((x, i) => x + (C[k + 1][i] - x) * f), O));
    if (e[1] >= Math.sin(25 * Math.PI / 180) && radius(info.rings[k + 1]) > best) { best = radius(info.rings[k + 1]); up = e; through = p; }
  }
  if (through === null) console.log('ball: no branch leaves it 25° up or more; its north pole points straight up, uncovered');
  const vPerUnit = 0.105 * 5; // the trunk's bark: about 0.105 repeats a metre along it, 5 m a unit
  const ball = sphere(O, R, up, 48, 24, vPerUnit);
  console.log(`ball: ${ball.tris.length} triangles, north pole ${(90 - Math.acos(up[1]) * 180 / Math.PI).toFixed(0)}° above its equator${through === null ? '' : `, inside branch ${through} (${s5(best)} m radius) where it leaves`}, bark ${(Math.PI * R * vPerUnit).toFixed(2)} times pole to pole, once round`);
  const inspect = arg('--inspect', null);
  if (inspect) {
    const material = arg('--material', null);
    const guid = material ? S.materialGuid(material) : null;
    layer(inspect, P, N, tris, { color: '#b8ae9c', opacity: 1, side: 'front', source: file, ...(guid ? { material: guid } : {}) }, mesh.attrs[4]);
    layer(inspect + 'Inside', P, N, tris, { color: '#ff3b30', opacity: 1, side: 'back', source: file });
    layer(inspect + 'Ball', ball.P, ball.N, ball.tris, { color: '#8a6f4e', opacity: 1, ...(guid ? { material: guid } : {}) }, ball.UV);
    console.log(`inspection models: cache/inspect/${inspect}{,Inside,Ball}.obj`);
  }
  const ballFile = arg('--ball', null);
  if (ballFile) {
    // GridTangle's pieces' vertex format: position, normal, colour (as their trunk's: 1 0 0 0.87), uv
    const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
    const piece = Object.values(idx).find(e => /^Assets\/Meshes\/GridTangle\/GridTangle_part\d+_L0\.asset$/.test(e.path));
    const template = M.readMesh(S.blobs([piece.blob]).get(piece.blob).toString());
    const attrs = template.channels.map((c, ci) => (!c.dim ? null : ci === 0 ? ball.P : ci === 1 ? ball.N : ci === 4 ? ball.UV : ci === 3 ? ball.P.map(() => [1, 0, 0, 0.87]) : null));
    if (attrs.some((x, ci) => template.channels[ci].dim && !x)) throw new Error(`${piece.path}: a vertex channel the ball has no values for`);
    const target = path.join(S.REPO, ballFile);
    fs.writeFileSync(target, M.writeMesh(template, path.basename(ballFile).replace(/\.[^.]+$/, ''), { attrs, triangles: ball.tris.flat() }));
    if (!fs.existsSync(target + '.meta')) fs.writeFileSync(target + '.meta', `fileFormatVersion: 2\nguid: ${crypto.randomBytes(16).toString('hex')}\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 4300000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`);
    console.log(`wrote ${ballFile} (${fs.readFileSync(target + '.meta', 'utf8').match(/guid: (\w+)/)[1]})`);
  }
  const out = arg('--out', null);
  if (process.argv.includes('--write') || out) {
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    const attrs = mesh.attrs.map(ch => ch && ch.slice());
    attrs[0] = P; attrs[1] = N;
    const used = [...new Set(tris.flat())].sort((x, y) => x - y), to = new Map(used.map((v, i) => [v, i]));
    const where = out || path.join(S.REPO, file);
    fs.writeFileSync(where, M.writeMesh(mesh, name, { attrs: attrs.map(ch => ch && used.map(v => ch[v])), triangles: tris.flat().map(v => to.get(v)) }));
    console.log(`wrote ${out || file}: ${used.length} vertices (were ${mesh.attrs[0].length})`);
  }
}

if (require.main === module) main();
module.exports = { sphere };
