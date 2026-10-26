// layout's settings for viewing Unity scenes: layout/unity.json, defaults plus per-scene
// sections (a scene's values replace the defaults; its show and hide lists add to them).
//   near, far   the camera's clip planes, in meters: the game's (Game.unity's OVRCameraRig camera,
//               both eyes: 0.03 and 400; FarClipManager may pull far in at run time)
//   farClip     FarClipManager's settings (Game.unity), for ☰ Fog far clip: { threshold (the share
//               of light the fog must hide: 0.95), min, max (m) }; the clip is where Canopy's fog,
//               exp2(-(density distance)^2), hides that much, within min and max
//   culling     ☰ Culling, a stand-in for Unity's CullingGroup: { perFrame (share of pieces checked
//               each frame: 0.05), margin (m a piece must pass beyond its distance before it is
//               hidden: 6), default ("fog": where the fog hides farClip.threshold, or meters),
//               rules: [{ rule, distance }] (rule as in show/hide; the first that matches) }
//   lodFov      the headset's vertical field of view per eye, in degrees, for choosing LOD levels
//               as the game does (Unity's LODGroup and GridRender measure screen height)
//   lodBias     Unity's LOD bias (QualitySettings, Android's level: 1)
//   gridDrawsInactiveParts  draw a GridRender tree's chunks under its inactive Parts object, as
//               GridRender does (it skips only disabled renderers); false: as Unity would
//   gridLodByDistance  pick GridRender chunk levels by distance (the fix in Canopy's
//               GridRender.TestLoDs, 2026-10-25), not by the screen height of a vertical segment
//   leafThinning  LeafSplit's thinning, for previewing it here when a scene's LeafSplit has none
//               ({ start, end (m), keep (share left at end), grow, fade (share of ranks a
//               leaf shrinks out over) }; keep 1 is off)
//   treeChunks  path pattern of tree chunk meshes, e.g. "Meshes/Grid*"
//   maxTexture  largest texture side kept in the cache, in pixels
//   show        rules forcing objects on, even when the scene or prefab switches them off
//   hide        rules removing objects
//   environment what Canopy's shaders get (ShaderVars.cs) and its sky and sea, for the page:
//               sunDirection (Unity world, toward the sun), sunColor and fogColor (#rrggbb),
//               ambient (Canopy's ambient intensity, 0 to 1), fogDensity (the fog never thins
//               below Game.unity's fogDensityMinimum, 0.014); seaLevel (Sea.prefab's SeaCanonicalAltitude; a BiomeZone may set its own,
//               TutorialScene's is 200.48), dimAmount and dimDepth (how dark below the
//               waterline, and within how many meters: Sea.prefab), sky and sea (material names:
//               Game.unity's skybox, Sea.prefab's surface), seaTile (meters its normal map
//               spans: the 840 m surface at tiling 12). The game sets the light per biome and
//               mood at run time, so those are stand-ins; per scene the values merge.
// A rule is "kind:pattern", * matching anything. Kinds: prefab (a piece's prefab, or
// "Prefab/Object" for an object inside it), object, mesh, material, folder (prefab or mesh
// folder, e.g. "Prefabs/PFX").
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'unity.json');
const KINDS = ['prefab', 'object', 'mesh', 'material', 'folder'];
const ENVIRONMENT = {
  sunDirection: [-0.4, 1, 0.6], sunColor: '#ffffff', ambient: 0.5, fogColor: '#808080', fogDensity: 0.014,
  seaLevel: 135, dimAmount: 0.3, dimDepth: 3, sky: 'CanSky', sea: 'WaterSurface', seaTile: 70,
  // CanSky.shader's globals, as Game.unity's EnvironmentManager sets them from the head's height
  // y (ManageSky): fog color below y + skyBlendMin, blending to the sky texture from y + skyBlendMax
  // (the shader measures the blend from BlendMax, so up to y + 2 skyBlendMax - skyBlendMin), black
  // below skyBlackMult y + skyBlackAdd, and above BlendMax the mood's tint (skyTint, skyTintLevel:
  // stand-ins, the game varies them by mood and depth). Heights are of the skybox's points:
  // skyRadius is how far around the camera Unity draws it; null: ten times the far clip (4000 at
  // the game's 400). Evidence: only then does the black line (1200 - 9 y) fall where the sea ends
  // (the far clip), about 2 degrees below its edge seen from well above the sea, so fog fills
  // down to the sea's edge and the depths look black, as Ken describes the game (2026-10-26).
  // A bigger radius thins the horizon band and brings the black up to the horizon.
  skyBlendMin: 60, skyBlendMax: 300, skyBlackMult: -9, skyBlackAdd: 1200, skyTint: '#808080', skyTintLevel: 0, skyRadius: null
};

function load(scene) {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const d = raw.defaults || {}, s = (raw.scenes || {})[scene] || {};
  const rules = list => (list || []).map(r => {
    const m = /^(\w+):(.+)$/.exec(r);
    if (!m || !KINDS.includes(m[1])) throw new Error(`unity.json: bad rule "${r}"; use kind:pattern with kind one of ${KINDS.join(', ')}`);
    return { kind: m[1], pattern: m[2], re: glob(m[2]) };
  });
  return {
    near: s.near ?? d.near ?? 0.03,
    far: s.far ?? d.far ?? 400,
    farClip: { threshold: 0.95, min: 10, max: 400, ...d.farClip, ...s.farClip },
    culling: cullingOf({ perFrame: 0.05, margin: 6, default: 'fog', rules: [], ...d.culling, ...s.culling }, [...((d.culling || {}).rules || []), ...((s.culling || {}).rules || [])]),
    lodFov: s.lodFov ?? d.lodFov ?? 90,
    lodBias: s.lodBias ?? d.lodBias ?? 1,
    gridDrawsInactiveParts: s.gridDrawsInactiveParts ?? d.gridDrawsInactiveParts ?? true,
    gridLodByDistance: s.gridLodByDistance ?? d.gridLodByDistance ?? true,
    leafThinning: { start: 40, end: 200, keep: 1, grow: true, fade: 0.05, ...d.leafThinning, ...s.leafThinning },
    treeChunks: glob('*' + (s.treeChunks ?? d.treeChunks ?? 'Meshes/Grid*')),
    maxTexture: s.maxTexture ?? d.maxTexture ?? 1024,
    show: [...rules(d.show), ...rules(s.show)],
    hide: [...rules(d.hide), ...rules(s.hide)],
    environment: { ...ENVIRONMENT, ...d.environment, ...s.environment }
  };
}
// The culling settings with their rules parsed (each "kind:pattern" with a distance).
function cullingOf(c, rules) {
  return { ...c, rules: rules.map(r => {
    const m = /^(\w+):(.+)$/.exec(r.rule || '');
    if (!m || !KINDS.includes(m[1])) throw new Error(`unity.json: bad culling rule "${r.rule}"`);
    return { kind: m[1], pattern: m[2], re: glob(m[2]), distance: r.distance };
  }) };
}
// A piece's cull distance: the first culling rule that matches it, else the default.
function cullDistance(config, piece) {
  const c = config.culling;
  const part = { prefab: piece.name, object: '', source: piece.source || '', mesh: null };
  const hit = c.rules.find(r => matches(r, piece.name, part, ''));
  return hit ? hit.distance : c.default;
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

module.exports = { load, mtime, visibleParts, FILE, cullDistance };
