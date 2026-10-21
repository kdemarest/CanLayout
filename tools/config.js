// layout's settings for viewing Unity scenes: layout/unity.json, defaults plus per-scene
// sections (a scene's values replace the defaults; its show and hide lists add to them).
//   treeLod     LOD of tree chunks to show (0 is full detail)
//   treeChunks  path pattern of tree chunk meshes, e.g. "Meshes/Grid*"
//   maxTexture  largest texture side kept in the cache, in pixels
//   show        rules forcing objects on, even when the scene or prefab switches them off
//   hide        rules removing objects
// A rule is "kind:pattern", * matching anything. Kinds: prefab (a piece's prefab, or
// "Prefab/Object" for an object inside it), object, mesh, material, folder (prefab or mesh
// folder, e.g. "Prefabs/PFX").
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'unity.json');
const KINDS = ['prefab', 'object', 'mesh', 'material', 'folder'];

function load(scene) {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const d = raw.defaults || {}, s = (raw.scenes || {})[scene] || {};
  const rules = list => (list || []).map(r => {
    const m = /^(\w+):(.+)$/.exec(r);
    if (!m || !KINDS.includes(m[1])) throw new Error(`unity.json: bad rule "${r}"; use kind:pattern with kind one of ${KINDS.join(', ')}`);
    return { kind: m[1], pattern: m[2], re: glob(m[2]) };
  });
  return {
    treeLod: s.treeLod ?? d.treeLod ?? 0,
    treeChunks: glob('*' + (s.treeChunks ?? d.treeChunks ?? 'Meshes/Grid*')),
    maxTexture: s.maxTexture ?? d.maxTexture ?? 1024,
    show: [...rules(d.show), ...rules(s.show)],
    hide: [...rules(d.hide), ...rules(s.hide)]
  };
}
const glob = p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
const mtime = () => fs.statSync(FILE).mtimeMs;

// Does a rule match a part of a piece? material is the material's name (or '').
function matches(rule, piece, part, material) {
  const folder = p => (p || '').replace(/^Assets\//, '').replace(/\/[^/]*$/, '');
  switch (rule.kind) {
    case 'prefab': {
      const [pre, obj] = rule.pattern.split('/');
      if (!obj) return glob(pre).test(piece);
      return glob(pre).test(part.prefab || '') && glob(obj).test(part.object || '');
    }
    case 'object': return rule.re.test(part.object || '');
    case 'mesh': return rule.re.test((part.mesh && part.mesh.name) || '');
    case 'material': return rule.re.test(material || '');
    case 'folder': return rule.re.test(folder(part.source)) || rule.re.test(folder(part.mesh && part.mesh.path));
  }
  return false;
}

// The parts of a piece to draw: switched-off parts only if a show rule names them, minus any
// a hide rule names. materialName(guid) gives a material's name for material rules.
function visibleParts(config, piece, parts, materialName = () => '') {
  const hit = (rules, part) => rules.some(r => matches(r, piece, part, materialName(part.material)));
  return parts.filter(part => (!part.off || hit(config.show, part)) && !hit(config.hide, part));
}

module.exports = { load, mtime, visibleParts, FILE };
