// The obsidian dagger in two materials (Ken, 2026-11-07: the obsidian black and glossy with a
// scalloped normal map, the hilt matte with its relief strong). ObsidianDagger.fbx is one mesh in
// one material, with no edge where the obsidian ends: GridObsidianDagger's part000 (the obsidian)
// and part001 (the hilt) are that mesh cut at z 0.0036, together exactly its surface, each with a
// cap on the cut. This writes into Canopy, and can be run again to retune the look:
//   Assets/Meshes/ObsidianDaggerSplit.asset   one mesh, submesh 0 the obsidian, 1 the hilt, no caps
//   Assets/Texture/OD_Dagger_normal.png       OD_Mat_normal.jpg with scallops baked over the obsidian
//   Assets/Materials/DaggerObsidian.mat, DaggerHilt.mat
//   Assets/Prefabs/Gear/GearDagger.prefab, Items/Dagger.prefab   their model instances unpacked into
//     plain objects, keeping their ids (so rendererToChange still points at the renderer), drawing
//     the new mesh in both materials; readyMaterial the obsidian, as GearDagger swaps slot 0
// The scallops are the lower envelope of shallow bowls, one per flake, seeded along the blade's two
// edges: where bowls meet they leave the sharp ridges of knapped stone. They are baked at each
// texel's place on the mesh, through its tangents, so they follow the real edges, and laid over the
// map's own fractures. The game imports the map at 512 (the dagger is never drawn large), where a
// blade side is about 200 texels: flakes are sized to read at that.
// usage: node tools/dagger-split.js [--seed 7] [--flakes 9] [--slope 0.5] [--keep 0.6]
//        [--gloss 0.985] [--highlight 2] [--tint 0.08] [--hilt-normal 3]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const U = require('./unity.js');

const REPO = U.REPO;
const args = process.argv.slice(2);
const option = (name, value) => (args.includes('--' + name) ? +args[args.indexOf('--' + name) + 1] : value);
const SEED = option('seed', 7), FLAKES = option('flakes', 9), SLOPE = option('slope', 0.5), KEEP = option('keep', 0.6);
const GLOSS = option('gloss', 0.985), HIGHLIGHT = option('highlight', 2), TINT = option('tint', 0.08), HILT_NORMAL = option('hilt-normal', 3);

const MESH = 'Assets/Meshes/ObsidianDaggerSplit.asset';
const NORMAL = 'Assets/Texture/OD_Dagger_normal.png';
const OBSIDIAN = 'Assets/Materials/DaggerObsidian.mat', HILT = 'Assets/Materials/DaggerHilt.mat';
const SOURCE_MAT = 'Assets/Materials/ObsidianDagger.mat', OLD_MATERIAL = '3deeb13f9da2ec747b864720c1c6b17b';
const SOURCE_NORMAL = 'Assets/Texture/OD_Mat_normal.jpg';
const MODEL_GUID = '2ed9ac6de454add428b5e45a27af273c';
const SIZE = 2048;

const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { maxBuffer: 1 << 30 });
const head = file => git('show', `HEAD:${file}`);
const guidOf = file => crypto.createHash('md5').update(`canopy-dagger-split:${file}`).digest('hex');
const idOf = text => BigInt('0x' + crypto.createHash('md5').update(`canopy-dagger-split:${text}`).digest('hex').slice(0, 15)).toString();
const crlf = text => text.replace(/\r?\n/g, '\r\n');
function write(file, text) {
  fs.writeFileSync(path.join(REPO, file), text);
  console.log(`wrote ${file}`);
}

// ---------- the cut pieces ----------
function readPart(name) {
  const text = head(`Assets/Meshes/GridObsidianDagger/GridObsidianDagger_${name}_L0.asset`).toString('latin1');
  const data = Buffer.from(/_typelessdata: ([0-9a-f]*)/.exec(text)[1], 'hex'), ib = Buffer.from(/m_IndexBuffer: ([0-9a-f]*)/.exec(text)[1], 'hex');
  const count = +/m_VertexCount: (\d+)/.exec(text)[1], stride = data.length / count;
  if (stride !== 48) throw new Error(`${name}: expected position, normal, tangent, uv`);
  const [body] = [...text.matchAll(/firstByte: (\d+)\r?\n\s+indexCount: (\d+)\r?\n\s+topology: 0\r?\n\s+baseVertex: 0\r?\n\s+firstVertex: (\d+)\r?\n\s+vertexCount: (\d+)/g)].map(m => m.slice(1).map(Number));
  const [first, indices, firstVertex, vertices] = body;
  if (firstVertex !== 0) throw new Error(`${name}: its surface doesn't start the vertices`);
  const unit = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const verts = [];
  for (let v = 0; v < vertices; v++) {
    const f = k => data.readFloatLE(v * stride + 4 * k);
    // the cutter left some normals and tangents short of unit length
    verts.push({ p: [f(0), f(1), f(2)], n: unit([f(3), f(4), f(5)]), t: [...unit([f(6), f(7), f(8)]), f(9)], uv: [f(10), f(11)] });
  }
  const tris = [];
  for (let i = 0; i < indices; i += 3) tris.push([0, 1, 2].map(k => ib.readUInt16LE(first + 2 * (i + k))));
  return { text, verts, tris };
}

function writeMesh(blade, hilt) {
  const verts = [...blade.verts, ...hilt.verts];
  const data = Buffer.alloc(verts.length * 48);
  verts.forEach((v, i) => [...v.p, ...v.n, ...v.t, ...v.uv].forEach((x, k) => data.writeFloatLE(x, i * 48 + 4 * k)));
  const indices = [...blade.tris.flat(), ...hilt.tris.flat().map(i => i + blade.verts.length)];
  const ib = Buffer.alloc(indices.length * 2);
  indices.forEach((x, i) => ib.writeUInt16LE(x, 2 * i));
  const box = list => {
    const lo = [0, 1, 2].map(a => Math.min(...list.map(v => v.p[a]))), hi = [0, 1, 2].map(a => Math.max(...list.map(v => v.p[a])));
    const vec = f => `{x: ${f(0)}, y: ${f(1)}, z: ${f(2)}}`;
    return { center: vec(a => (lo[a] + hi[a]) / 2), extent: vec(a => (hi[a] - lo[a]) / 2) };
  };
  const submesh = (firstByte, count, firstVertex, list) => {
    const b = box(list);
    return ['  - serializedVersion: 2', `    firstByte: ${firstByte}`, `    indexCount: ${count}`, '    topology: 0', '    baseVertex: 0', `    firstVertex: ${firstVertex}`, `    vertexCount: ${list.length}`, '    localAABB:', `      m_Center: ${b.center}`, `      m_Extent: ${b.extent}`].join('\n');
  };
  const all = box(verts);
  const text = blade.text.replace(/\r\n/g, '\n')
    .replace(/m_Name: .*/, 'm_Name: ObsidianDaggerSplit')
    .replace(/ {2}m_SubMeshes:\n[\s\S]*?(?= {2}m_Shapes:)/, () => `  m_SubMeshes:\n${submesh(0, blade.tris.length * 3, 0, blade.verts)}\n${submesh(blade.tris.length * 6, hilt.tris.length * 3, blade.verts.length, hilt.verts)}\n`)
    .replace(/m_IndexBuffer: [0-9a-f]*/, `m_IndexBuffer: ${ib.toString('hex')}`)
    .replace(/m_VertexCount: \d+/, `m_VertexCount: ${verts.length}`)
    .replace(/m_DataSize: \d+/, `m_DataSize: ${data.length}`)
    .replace(/_typelessdata: [0-9a-f]*/, `_typelessdata: ${data.toString('hex')}`)
    .replace(/( {2}m_LocalAABB:\n {4}m_Center: ).*\n( {4}m_Extent: ).*/, (m, a, b) => `${a}${all.center}\n${b}${all.extent}`);
  write(MESH, crlf(text));
  write(MESH + '.meta', crlf(`fileFormatVersion: 2\nguid: ${guidOf(MESH)}\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 4300000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`));
}

// ---------- scallops ----------
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The blade's outline in x and z (its length): each edge's x along z, from the mesh.
function outline(blade) {
  const z = blade.verts.map(v => v.p[2]), z0 = Math.min(...z), z1 = Math.max(...z), bins = 24;
  const lo = Array(bins + 1).fill(Infinity), hi = Array(bins + 1).fill(-Infinity);
  for (const v of blade.verts) {
    const i = Math.round(((v.p[2] - z0) / (z1 - z0)) * bins);
    lo[i] = Math.min(lo[i], v.p[0]);
    hi[i] = Math.max(hi[i], v.p[0]);
  }
  const at = (list, zz) => {
    const f = Math.max(0, Math.min(bins, ((zz - z0) / (z1 - z0)) * bins));
    let a = Math.floor(f), b = Math.ceil(f);
    while (a > 0 && !Number.isFinite(list[a])) a--;
    while (b < bins && !Number.isFinite(list[b])) b++;
    return list[a] + (list[b] - list[a]) * (b > a ? (f - a) / (b - a) : 0);
  };
  return { z0, z1, left: zz => at(lo, zz), right: zz => at(hi, zz) };
}
// One face's flakes: a big row from each edge reaching the middle, a small row of retouch along it.
function flakes(shape, seed) {
  const r = random(seed), out = [];
  const row = (edge, side, count, reach, length) => {
    const step = (shape.z1 - shape.z0) / count;
    for (let i = 0; i <= count; i++) {
      const z = shape.z0 + (i + 0.5 + (r() - 0.5) * 0.7) * step;
      if (z > shape.z1 + step / 2) continue;
      const zc = Math.max(shape.z0, Math.min(shape.z1, z));
      const x = edge(zc), width = Math.max(shape.right(zc) - shape.left(zc), 0.0012);
      // along the edge (a), and into the blade (b), tilted a little toward the tip or the hilt
      const lean = (r() - 0.5) * 0.7, sway = 0.75 + r() * 0.5;
      const b = [-side * Math.cos(lean), Math.sin(lean)], a = [b[1], -b[0]];
      const ra = step * length * sway, rb = width * reach * sway;
      const inset = rb * (0.35 + r() * 0.25);
      out.push({ c: [x + b[0] * inset, zc + b[1] * inset], origin: [x, zc], a, b, ra, rb, depth: Math.min(ra, rb) * (0.8 + r() * 0.4) });
    }
  };
  for (const [edge, side] of [[shape.right, 1], [shape.left, -1]]) {
    row(edge, side, FLAKES, 0.42, 0.8);
    row(edge, side, FLAKES * 2, 0.13, 0.75);
  }
  return out;
}
// The bowls' lower envelope, softened a little so the ridges survive mips: its slope at (x, z).
function slopeAt(list, x, z, soft) {
  let least = Infinity;
  const near = [];
  for (const f of list) {
    const dx = x - f.c[0], dz = z - f.c[1];
    const u = (dx * f.a[0] + dz * f.a[1]) / f.ra, v = (dx * f.b[0] + dz * f.b[1]) / f.rb;
    const height = f.depth * SLOPE * 0.5 * (u * u + v * v - 1);
    near.push([f, u, v, height]);
    if (height < least) least = height;
  }
  let gx = 0, gz = 0, weight = 0;
  for (const [f, u, v, height] of near) {
    const w = Math.exp((least - height) / soft);
    if (w < 1e-4) continue;
    const du = f.depth * SLOPE * u / f.ra, dv = f.depth * SLOPE * v / f.rb;
    let sx = du * f.a[0] + dv * f.b[0], sz = du * f.a[1] + dv * f.b[1];
    // conchoidal ripples, faint rings around where the flake was struck
    const ox = x - f.origin[0], oz = z - f.origin[1], d = Math.hypot(ox, oz) || 1, wave = (2 * Math.PI) / (f.rb * 0.42);
    const ripple = 0.1 * SLOPE * Math.cos(d * wave);
    sx += (ripple * ox) / d;
    sz += (ripple * oz) / d;
    gx += w * sx;
    gz += w * sz;
    weight += w;
  }
  return [gx / weight, gz / weight];
}

function bakeNormal(blade) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagger-'));
  const source = path.join(dir, 'source.jpg'), raw = path.join(dir, 'normal.rgb');
  fs.writeFileSync(source, head(SOURCE_NORMAL));
  execFileSync('magick', [source, '-resize', `${SIZE}x${SIZE}!`, '-depth', '8', `rgb:${raw}`]);
  const pixels = fs.readFileSync(raw), original = Buffer.from(pixels);
  const shape = outline(blade);
  const faces = [flakes(shape, SEED * 2 + 1), flakes(shape, SEED * 2 + 2)];
  const soft = 0.000012;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  let texels = 0;
  for (const tri of blade.tris) {
    const [A, B, C] = tri.map(i => blade.verts[i]);
    const px = v => [v.uv[0] * SIZE, (1 - v.uv[1]) * SIZE];
    const [a, b, c] = [px(A), px(B), px(C)];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (!area) continue;
    const x0 = Math.floor(Math.min(a[0], b[0], c[0])) - 2, x1 = Math.ceil(Math.max(a[0], b[0], c[0])) + 2;
    const y0 = Math.floor(Math.min(a[1], b[1], c[1])) - 2, y1 = Math.ceil(Math.max(a[1], b[1], c[1])) + 2;
    const margin = 1.5 / Math.sqrt(Math.abs(area)); // a little past its edges, for filtering
    for (let y = Math.max(0, y0); y <= Math.min(SIZE - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(SIZE - 1, x1); x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const w1 = ((qx - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (qy - a[1])) / area;
        const w2 = ((b[0] - a[0]) * (qy - a[1]) - (qx - a[0]) * (b[1] - a[1])) / area;
        const w0 = 1 - w1 - w2;
        if (w0 < -margin || w1 < -margin || w2 < -margin) continue;
        const mix = key => [0, 1, 2].map(k => A[key][k] * w0 + B[key][k] * w1 + C[key][k] * w2);
        const P = mix('p'), N = unit(mix('n'));
        const T0 = mix('t'), T = unit(T0.map((v, k) => v - N[k] * dot(T0, N)));
        const Bi = cross(N, T).map(v => v * A.t[3]);
        // the height's slope lies in x and z; on the surface, it tips the normal away
        const [gx, gz] = slopeAt(faces[N[1] >= 0 ? 0 : 1], P[0], P[2], soft);
        const g = [gx, 0, gz], along = dot(g, N);
        const tipped = unit([0, 1, 2].map(k => N[k] - (g[k] - along * N[k])));
        const t = [dot(tipped, T), dot(tipped, Bi), dot(tipped, N)];
        // laid over the map's own fractures
        const o = (y * SIZE + x) * 3;
        const e = [0, 1, 2].map(k => (original[o + k] / 255) * 2 - 1);
        const out = unit([t[0] + e[0] * KEEP, t[1] + e[1] * KEEP, t[2] * (1 + (e[2] - 1) * KEEP)]);
        for (let k = 0; k < 3; k++) pixels[o + k] = Math.round((out[k] * 0.5 + 0.5) * 255);
        texels++;
      }
    }
  }
  fs.writeFileSync(raw, pixels);
  execFileSync('magick', ['-size', `${SIZE}x${SIZE}`, '-depth', '8', `rgb:${raw}`, path.join(REPO, NORMAL)]);
  fs.rmSync(dir, { recursive: true });
  console.log(`wrote ${NORMAL}: ${texels} texels of scallops, ${faces[0].length} flakes a face`);
  // the game keeps it at the old map's 512 (the dagger is never drawn large)
  write(NORMAL + '.meta', head(SOURCE_NORMAL + '.meta').toString().replace(/^guid: .*/m, `guid: ${guidOf(NORMAL)}`));
}

// ---------- materials ----------
function material(file, { name, main, tint, gloss, highlight, normalStrength }) {
  const slot = (key, ref) => text => text.replace(new RegExp(`(- ${key}:\\n {8}m_Texture: ).*`), `$1${ref}`);
  let text = head(SOURCE_MAT).toString().replace(/\r\n/g, '\n');
  const normal = `{fileID: 2800000, guid: ${guidOf(NORMAL)}, type: 3}`;
  text = text.replace(/m_Name: .*/, `m_Name: ${name}`)
    .replace(/m_ValidKeywords:\n(?: {2}- .*\n)*/, 'm_ValidKeywords: []\n');
  for (const edit of [slot('_NormalMap', normal), slot('_BumpMap', '{fileID: 0}'), slot('_MetallicGlossMap', '{fileID: 0}')]) text = edit(text);
  if (!main) text = slot('_MainTex', '{fileID: 0}')(text);
  text = text.replace(/- _Glossiness: .*/, `- _Glossiness: ${gloss}\n    - _GlossyReflections: 0\n    - _HighlightStrength: ${highlight}`)
    .replace(/ {4}- _GlossyReflections: 0\n(?= {4}- _Metallic:)/, '')
    .replace(/- _NormalStrength: .*/, `- _NormalStrength: ${normalStrength}`);
  if (tint) text = text.replace(/- _Tint: .*/, `- _Tint: {r: ${tint[0]}, g: ${tint[1]}, b: ${tint[2]}, a: 1}`);
  write(file, crlf(text));
  write(file + '.meta', crlf(`fileFormatVersion: 2\nguid: ${guidOf(file)}\nNativeFormatImporter:\n  externalObjects: {}\n  mainObjectFileID: 2100000\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`));
}

// ---------- prefabs ----------
// A model instance as plain objects, as Unity's Unpack Prefab leaves it: stripped objects become
// real ones under the same ids, so what points at them still does; a renderer the file never
// named takes the id an outer prefab would use for it (the instance's id XOR the object's). Each
// run starts from the committed prefab.
function unpack(file) {
  const full = path.join(REPO, file);
  const text = head(file).toString('latin1').replace(/\r\n/g, '\n');
  const docs = text.split(/(?=^--- )/m);
  const instance = docs.find(d => /^--- !u!1001 /.test(d) && d.includes(`m_SourcePrefab: {fileID: 100100000, guid: ${MODEL_GUID}`));
  const id = /&(-?\d+)/.exec(instance)[1];
  const mods = {};
  for (const m of instance.matchAll(/- target: \{fileID: (-?\d+), guid: [0-9a-f]+, type: 3\}\n\s+propertyPath: (.*)\n\s+value: ?(.*)\n/g)) (mods[m[1]] = mods[m[1]] || {})[m[2]] = m[3];
  const stripped = cls => docs.find(d => new RegExp(`^--- !u!${cls} &-?\\d+ stripped\\n`).test(d) && d.includes(`m_PrefabInstance: {fileID: ${id}}`));
  const idIn = doc => (doc ? /&(-?\d+)/.exec(doc)[1] : null);
  const goDoc = stripped(1), tDoc = stripped(4), rDoc = stripped(23);
  const go = idIn(goDoc), transform = idIn(tDoc), renderer = idIn(rDoc) || U.xorId(id, '-7511558181221131132'), filter = idOf(`${file}:filter`);
  const t = mods['-8679921383154817045'], r = mods['-7511558181221131132'] || {}, g = mods['919132149155446097'];
  const parent = /m_TransformParent: \{fileID: (-?\d+)/.exec(instance)[1];
  const shell = '  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n';
  // components already added to the object stay on it
  const added = docs.filter(d => d.includes(`m_GameObject: {fileID: ${go}}`) && !d.includes(' stripped\n')).map(d => idIn(d));
  const components = [transform, filter, renderer, ...added].map(c => `  - component: {fileID: ${c}}`).join('\n');
  const flag = (key, fallback) => r[key] ?? fallback;
  // objects added under the instance name it as their father; a real transform lists its children
  const rootOrder = d => +(/m_RootOrder: (\d+)/.exec(d) || [0, 0])[1];
  const children = docs.filter(d => /^--- !u!(4|224) /.test(d) && d.includes(`m_Father: {fileID: ${transform}}`)).sort((a, b) => rootOrder(a) - rootOrder(b)).map(idIn);
  for (const d of docs) {
    if (!/^--- !u!1001 /.test(d) || !d.includes(`m_TransformParent: {fileID: ${transform}}`)) continue;
    const root = docs.find(x => /^--- !u!4 &-?\d+ stripped\n/.test(x) && x.includes(`m_PrefabInstance: {fileID: ${idIn(d)}}`));
    children.push(idIn(root));
  }
  const childList = children.length ? `\n${children.map(c => `  - {fileID: ${c}}`).join('\n')}` : ' []';
  const made = {
    go: `--- !u!1 &${go}\nGameObject:\n${shell}  serializedVersion: 6\n  m_Component:\n${components}\n  m_Layer: ${g.m_Layer ?? 0}\n  m_Name: ${g.m_Name}\n  m_TagString: ${g.m_TagString ?? 'Untagged'}\n  m_Icon: {fileID: 0}\n  m_NavMeshLayer: 0\n  m_StaticEditorFlags: 0\n  m_IsActive: 1\n`,
    transform: `--- !u!4 &${transform}\nTransform:\n${shell}  m_GameObject: {fileID: ${go}}\n  m_LocalRotation: {x: ${t['m_LocalRotation.x']}, y: ${t['m_LocalRotation.y']}, z: ${t['m_LocalRotation.z']}, w: ${t['m_LocalRotation.w']}}\n  m_LocalPosition: {x: ${t['m_LocalPosition.x']}, y: ${t['m_LocalPosition.y']}, z: ${t['m_LocalPosition.z']}}\n  m_LocalScale: {x: ${t['m_LocalScale.x']}, y: ${t['m_LocalScale.y']}, z: ${t['m_LocalScale.z']}}\n  m_Children:${childList}\n  m_Father: {fileID: ${parent}}\n  m_RootOrder: ${t.m_RootOrder}\n  m_LocalEulerAnglesHint: {x: ${t['m_LocalEulerAnglesHint.x']}, y: ${t['m_LocalEulerAnglesHint.y']}, z: ${t['m_LocalEulerAnglesHint.z']}}\n`,
    filter: `--- !u!33 &${filter}\nMeshFilter:\n${shell}  m_GameObject: {fileID: ${go}}\n  m_Mesh: {fileID: 4300000, guid: ${guidOf(MESH)}, type: 2}\n`,
    renderer: `--- !u!23 &${renderer}\nMeshRenderer:\n${shell}  m_GameObject: {fileID: ${go}}\n  m_Enabled: 1\n  m_CastShadows: ${flag('m_CastShadows', 1)}\n  m_ReceiveShadows: ${flag('m_ReceiveShadows', 1)}\n  m_DynamicOccludee: ${flag('m_DynamicOccludee', 1)}\n  m_MotionVectors: ${flag('m_MotionVectors', 1)}\n  m_LightProbeUsage: ${flag('m_LightProbeUsage', 1)}\n  m_ReflectionProbeUsage: ${flag('m_ReflectionProbeUsage', 1)}\n  m_RayTracingMode: 2\n  m_RayTraceProcedural: 0\n  m_RenderingLayerMask: 1\n  m_RendererPriority: 0\n  m_Materials:\n  - {fileID: 2100000, guid: ${guidOf(OBSIDIAN)}, type: 2}\n  - {fileID: 2100000, guid: ${guidOf(HILT)}, type: 2}\n  m_StaticBatchInfo:\n    firstSubMesh: 0\n    subMeshCount: 0\n  m_StaticBatchRoot: {fileID: 0}\n  m_ProbeAnchor: {fileID: 0}\n  m_LightProbeVolumeOverride: {fileID: 0}\n  m_ScaleInLightmap: 1\n  m_ReceiveGI: 1\n  m_PreserveUVs: 0\n  m_IgnoreNormalsForChartDetection: 0\n  m_ImportantGI: 0\n  m_StitchLightmapSeams: 1\n  m_SelectedEditorRenderState: 3\n  m_MinimumChartSize: 4\n  m_AutoUVMaxDistance: 0.5\n  m_AutoUVMaxAngle: 89\n  m_LightmapParameters: {fileID: 0}\n  m_SortingLayerID: 0\n  m_SortingLayer: 0\n  m_SortingOrder: 0\n  m_AdditionalVertexStreams: {fileID: 0}\n`
  };
  const next = docs.filter(d => d !== instance && d !== goDoc && d !== tDoc && d !== rDoc);
  next.push(made.go, made.transform, made.filter, made.renderer);
  let out = next.join('');
  // what the prefab says of the old material: GearDagger's readyMaterial
  out = out.replace(new RegExp(`(readyMaterial: \\{fileID: 2100000, guid: )${OLD_MATERIAL}`), `$1${guidOf(OBSIDIAN)}`);
  fs.writeFileSync(full, crlf(out), 'latin1');
  console.log(`${file}: unpacked ${g.m_Name}`);
}

function main() {
  const blade = readPart('part000'), hilt = readPart('part001');
  writeMesh(blade, hilt);
  bakeNormal(blade);
  material(OBSIDIAN, { name: 'DaggerObsidian', main: false, tint: [TINT, TINT, +(TINT * 1.1).toFixed(3)], gloss: GLOSS, highlight: HIGHLIGHT, normalStrength: 1 });
  material(HILT, { name: 'DaggerHilt', main: true, gloss: 0, highlight: 0, normalStrength: HILT_NORMAL });
  unpack('Assets/Prefabs/Gear/GearDagger.prefab');
  unpack('Assets/Prefabs/Items/Dagger.prefab');
}
main();
