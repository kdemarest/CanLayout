// Gems on their loci (Ken, 2026-10-29). A gem isn't in the scene: as each stage starts, its
// GemLocus makes it (GemLocus.MakeGem, GemCreatorService.Make): GemTypes (Prefabs/Shared/GemTypes
// .prefab, with Game.unity's additions) gives the locus's ability a shape and a color; the shape's
// gem prefab is made at the locus's gemHolder, keeping its own rotation (relative to the locus)
// and its own world size (Make.cs); everything under its model takes the color's material, and
// its two effects the color's color (Gem.SetBreadcrumbColor). On a locus its breadcrumbs show and
// its puisance doesn't (Gem.UpdateEffects: puisance is for a gem locked in place); the rest only
// play on events. Layout does the same when importing a scene: the gem's parts, its breadcrumbs'
// particle system and their objects join the locus's piece. A locus whose ability has no gem type
// (PickRandom, NoAbility) makes none, as in the game.
const fs = require('fs');
const path = require('path');
const U = require('./unity.js');

const COLORS = ['Yellow', 'White', 'Orange', 'Blue', 'Red', 'Green', 'Black', 'Purple', 'Sea', 'Magenta', 'Runestone'];
let types = null, typesKey = null;
// { byAbility: { id: { shape, color } }, prefabs: { shape: guid }, materials: [guid], colors: [[r, g, b, a]] }
function gemTypes() {
  const key = fs.statSync(path.join(__dirname, '..', 'cache', 'guid-index.json')).mtimeMs;
  if (types && typesKey === key) return types;
  const read = rel => U.parse(fs.readFileSync(path.join(U.REPO, rel), 'utf8'));
  const f = read('Assets/Prefabs/Shared/GemTypes.prefab');
  const out = { byAbility: {}, prefabs: {}, materials: [], colors: [] };
  const addTypes = file => {
    for (const [, guid, body] of file.scripts) {
      if (U.scriptName(guid) !== 'GemType') continue;
      const t = U.scriptFields(body);
      out.byAbility[t.abilityId] = { shape: t.shape ?? 0, color: t.color ?? 0 };
    }
  };
  for (const [, guid, body] of f.scripts) {
    if (U.scriptName(guid) !== 'GemTypes') continue;
    for (const m of body.matchAll(/- gemShape: (\d+)\n {4}gemPrefab: \{fileID: -?\d+, guid: ([0-9a-f]+)/g)) out.prefabs[m[1]] = m[2];
    const fx = U.scriptFields(body);
    COLORS.forEach((c, i) => {
      out.materials[i] = fx[c.toLowerCase()] && fx[c.toLowerCase()].asset;
      const rgba = fx['color' + c] || {};
      out.colors[i] = [rgba.r ?? 1, rgba.g ?? 1, rgba.b ?? 1, rgba.a ?? 1];
    });
  }
  addTypes(f);
  const game = 'Assets/Scenes/Game.unity';
  if (fs.existsSync(path.join(U.REPO, game))) addTypes(read(game)); // its own GemTypes' added types
  types = out;
  typesKey = key;
  return out;
}

// The locus prefab with its gem added (a copy), or the prefab itself when it makes none.
// pieceScale: the locus's world scale, which the gem doesn't take.
function withGem(prefab, pieceScale) {
  const locus = (prefab.read || []).find(s => s.name === 'GemLocus' && !s.off);
  if (!locus) return prefab;
  const t = gemTypes(), type = t.byAbility[locus.fields.abilityId];
  const holder = locus.fields.gemHolder && prefab.objects && prefab.objects[locus.fields.gemHolder.ref];
  const gemGuid = type && t.prefabs[type.shape];
  const gem = gemGuid && U.prefab(gemGuid);
  if (!holder || !gem) return prefab;
  const info = (gem.read || []).find(s => s.name === 'Gem') || { fields: {} };
  // The gem's own keys go behind "gem/", apart from the locus's.
  const P = 'gem/', key = k => (k ? P + k : k);
  const refKey = v => v && v.ref;
  const under = (k, root) => { for (let o = k; o; o = gem.objects[o] && gem.objects[o].father) if (o === root) return true; return false; };
  const model = refKey(info.fields.model), puisance = refKey(info.fields.puisancePfx);
  // Its matrix in the locus's space: at the holder, its prefab's rotation, its own world size.
  const h = holder.m, s = gem.rootTrs.scl;
  const G = U.trs({ x: h[3], y: h[7], z: h[11] }, gem.rootTrs.rot, { x: s.x / (pieceScale.x || 1), y: s.y / (pieceScale.y || 1), z: s.z / (pieceScale.z || 1) });
  const material = t.materials[type.color] || null;
  const color = t.colors[type.color];
  const parts = gem.parts.map(p => ({ ...p, m: U.mul(G, p.m), go: key(p.go), ...(p.lod ? { lod: { key: key(p.lod.key), levels: p.lod.levels } } : {}), ...(model && p.go && under(p.go, model) && material ? { material } : {}) }));
  const prefixFields = fields => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, v && v.ref ? { ref: key(v.ref) } : v]));
  const scripts = (gem.scripts || []).filter(sc => sc.fields && !(puisance && under(sc.go, puisance))).map(sc => ({
    ...sc, id: key(sc.id), go: key(sc.go), ...(sc.renderer ? { renderer: key(sc.renderer) } : {}),
    ...(sc.lod ? { lod: { key: key(sc.lod.key), levels: sc.lod.levels } } : {}),
    // its start color, the gem's (Gem.SetBreadcrumbColor), in Unity's sRGB like the rest
    fields: sc.name === 'ParticleSystem' ? { ...prefixFields(sc.fields), color: { mode: 0, max: color, min: color } } : prefixFields(sc.fields)
  }));
  const objects = Object.fromEntries(Object.entries(gem.objects || {}).map(([k, o]) => [key(k), { ...o, father: o.father ? key(o.father) : null, m: U.mul(G, o.m) }]));
  const lodGroups = Object.fromEntries(Object.entries(gem.lodGroups || {}).map(([k, g]) => {
    const c = Array.isArray(g.center) ? g.center : [g.center.x, g.center.y, g.center.z];
    const w = [0, 1, 2].map(r => G[r * 4] * c[0] + G[r * 4 + 1] * c[1] + G[r * 4 + 2] * c[2] + G[r * 4 + 3]);
    return [key(k), { ...g, center: w, size: g.size * U.maxScale(G), scale: (g.scale || 1) * U.maxScale(G) }];
  }));
  return {
    ...prefab,
    parts: [...prefab.parts, ...parts],
    scripts: [...(prefab.scripts || []), ...scripts],
    objects: { ...prefab.objects, ...objects },
    lodGroups: { ...prefab.lodGroups, ...lodGroups },
    gem: { ability: locus.fields.abilityId, shape: type.shape, color: COLORS[type.color], prefab: gem.name }
  };
}

module.exports = { gemTypes, withGem };
