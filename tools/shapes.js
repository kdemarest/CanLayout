// Placeholder shapes for assets that have no model yet: "- Shape:" lines indented under an
// "- Asset:" line in docs, e.g.
//   - Asset: 🔴 Model: Burl - 1m, uncut
//     - Shape: dodecahedron 1
//   - Asset: 🔴 Model: Burl Knife - arched blade
//     - Shape: box 0.03 0.12 0.03
//     - Shape: prism 0.05 0.22 0.006 at 0 0.12 0
// Sizes in meters, Unity axes. Each shape rests on its origin (its base at y = 0), moved by
// "at x y z" and turned by "turn rx ry rz" (degrees, Unity order); "color #rrggbb" tints it;
// "sides N" makes a cylinder or cone N-sided; "tip f" cuts a cone or pyramid off flat, its top
// f times the base (a snub nose); "scale x y z" stretches it; "arc degrees" keeps a wedge of a
// hemisphere.
// "use <Name>" draws another asset's shapes, or a Unity prefab, e.g. "use Wood boards at 0 1 0";
// with "color" every part of it takes that color.
const KINDS = {
  box: ['width', 'height', 'depth'],
  cylinder: ['radius', 'height'],
  cone: ['radius', 'height'],
  pyramid: ['width', 'height', 'depth'], // a rectangular base, width by depth
  sphere: ['radius'],
  hemisphere: ['radius'], // a dome, flat side down
  dodecahedron: ['size'],
  prism: ['width', 'height', 'depth'], // a triangle, width wide and height tall, extruded depth thick
  use: [] // followed by a name
};
const OPTIONS = ['at', 'turn', 'color', 'sides', 'tip', 'scale', 'arc'];

// "prism 0.05 0.22 0.006 at 0 0.12 0" -> { kind, size: [...], at, turn, color }; throws if bad.
function parseShape(text) {
  const words = text.trim().split(/\s+/);
  const kind = (words.shift() || '').toLowerCase();
  if (!KINDS[kind]) throw new Error(`unknown shape "${kind}"; use ${Object.keys(KINDS).join(', ')}`);
  const numbers = n => {
    const out = words.splice(0, n).map(Number);
    if (out.length !== n || out.some(v => !Number.isFinite(v))) throw new Error(`${kind} needs ${n} numbers there`);
    return out;
  };
  const shape = { kind, size: numbers(KINDS[kind].length), at: [0, 0, 0], turn: [0, 0, 0], color: null };
  if (shape.size.some(v => v <= 0)) throw new Error(`${kind} sizes must be above 0 (${KINDS[kind].join(' ')})`);
  if (kind === 'use') {
    const name = [];
    while (words.length && !OPTIONS.includes(words[0].toLowerCase())) name.push(words.shift());
    if (!name.length) throw new Error('use needs a name: an asset with shapes, or a Unity prefab');
    shape.name = name.join(' ');
  }
  while (words.length) {
    const key = words.shift().toLowerCase();
    if (key === 'at') shape.at = numbers(3);
    else if (key === 'turn') shape.turn = numbers(3);
    else if (key === 'color' && /^#[0-9a-f]{6}$/i.test(words[0] || '')) shape.color = words.shift();
    else if (key === 'sides' && (kind === 'cylinder' || kind === 'cone') && /^\d+$/.test(words[0] || '') && +words[0] >= 3) shape.sides = +words.shift();
    else if (key === 'tip' && (kind === 'cone' || kind === 'pyramid') && +words[0] >= 0 && +words[0] < 1) shape.tip = +words.shift();
    else if (key === 'scale') {
      shape.scale = numbers(3);
      if (shape.scale.some(v => v <= 0)) throw new Error('scale must be above 0');
    } else if (key === 'arc' && kind === 'hemisphere' && +words[0] > 0 && +words[0] <= 360) shape.arc = +words.shift();
    else throw new Error(`unexpected "${key}"; after the sizes use at x y z, turn rx ry rz, color #rrggbb, scale x y z, sides N (cylinder, cone; 3 or more), tip f (cone, pyramid; 0 to below 1), arc degrees (hemisphere)`);
  }
  return shape;
}

// One docs "- Asset:" line, or null: { chip, type, name, count, unity, desc }.
// "- Asset: 🔴 Model: Burl shard x3 as BurlShard - cutaway" names the Unity prefab with "as";
// without it the prefab is the name in PascalCase (unityName). "as" may name a model file
// instead ("as LeafSingle.fbx"), placed whole. Lines that only reuse an asset
// defined elsewhere ("- Asset: Burl") have no chip or type.
function assetLine(line) {
  const m = /^\s*- Asset: (?:(🔴|🟡|🟢) (\w+): )?(.+?)(?: x(\d+))?(?: as (.+?))?(?: - (.*))?$/u.exec(line);
  if (!m) return null;
  return { chip: m[1] || null, type: m[2] || null, name: m[3].replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').trim(), count: m[4] ? +m[4] : 1, unity: m[5] || null, desc: m[6] || '' };
}
// The Unity prefab name for a docs asset: "Shark's tooth" -> SharksTooth, "Half-burl" -> HalfBurl.
function unityName(name, specifier) {
  if (specifier) return specifier;
  return name.replace(/['’]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
}

// Shapes in one docs file, by asset name: { shapes: { name: [shape] }, unity: { name: prefab
// name from "as" }, errors: ["line N: ..."] }. A Shape line belongs to the Asset line above it.
function shapesIn(text) {
  const shapes = {}, unity = {}, errors = [];
  let asset = null;
  text.split('\n').forEach((line, i) => {
    const a = assetLine(line);
    if (a) {
      asset = a.name;
      if (a.unity) unity[a.name] = a.unity;
      return;
    }
    const s = /^\s+- Shape:\s*(.*)$/.exec(line);
    if (!s) {
      if (line.trim() && !/^\s/.test(line)) asset = null; // any other unindented line ends the asset
      return;
    }
    if (!asset) return errors.push(`line ${i + 1}: a Shape line must be indented under an Asset line`);
    try {
      const shape = parseShape(s[1]);
      (shapes[asset] = shapes[asset] || []).push(shape);
    } catch (error) {
      errors.push(`line ${i + 1}: ${error.message}`);
    }
  });
  return { shapes, unity, errors };
}

// Every Asset line and Shape line in the docs vault (skipping source/ and build/):
// { assets: { name: { chip, type, unity, source } } (defining lines only), shapes, sources,
// errors: ["docs/<file> line N: ..."] }.
function readDocs(docs) {
  const fs = require('fs'), path = require('path');
  const assets = {}, shapes = {}, sources = {}, errors = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['source', 'build'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const text = fs.readFileSync(p, 'utf8'), rel = path.relative(docs, p);
        for (const line of text.split('\n')) {
          const a = assetLine(line);
          if (a && a.chip) assets[a.name] = { chip: a.chip, type: a.type, unity: a.unity, source: rel };
        }
        const found = shapesIn(text);
        for (const [name, list] of Object.entries(found.shapes)) {
          shapes[name] = list;
          sources[name] = rel;
        }
        errors.push(...found.errors.map(err => `docs/${rel} ${err}`));
      }
    }
  })(docs);
  return { assets, shapes, sources, errors };
}

module.exports = { KINDS, parseShape, shapesIn, assetLine, unityName, readDocs };
