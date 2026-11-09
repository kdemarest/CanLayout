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
//   tweakWorkers  Tweak (the sliders button right of fullscreen): Canopy folders whose prefabs a
//               worker can reshape live, { "<folder prefix>": [command, args...] }; a piece's
//               prefab at <prefix><Family>/... runs the command with "<prefix><Family>" added,
//               relative paths from layout/ (modl's obj/serve.py speaks the protocol)
//   treeChunks  path pattern of tree chunk meshes, e.g. "Meshes/Grid*"
//   maxTexture  largest texture side kept in the cache, in pixels
//   show        rules forcing objects on, even when the scene or prefab switches them off
//   hide        rules removing objects
//   symbols     progress flags code sets at run time, for the page's conditions (tools/conditions.js
//               symbols): { "Underwater": 0 }, in every mode; a composed scene's "- Symbols:" win
//   stage       the stage a scene plays in when its name (<Stage>Scene) is not one of StageId's,
//               for Stage and StageName in the page's conditions: "Oak" for HawthornScene, split
//               from OakScene and played in the Oak stage until it has its own (Claude, 2026-11-03)
//   include     scenes (docs/scenes) every scene from Canopy includes: an imported area, or a
//               composed scene on one (["World"]: its Sea, Wind and Sky)
//   environment what Canopy's shaders get (ShaderVars.cs) and its sky, for the page:
//               sunDirection (Unity world, toward the sun), sunColor and fogColor (#rrggbb),
//               ambient (Canopy's ambient intensity, 0 to 1), fogDensity (the fog never thins
//               below Game.unity's fogDensityMinimum, 0.014); sky (a material name: Game.unity's
//               skybox); seaLevel (null: where Sea.prefab has it, SeaCanonicalAltitude's 135; a
//               scene whose biome sets its own, as a BiomeZone does, says so, e.g. TutorialScene's
//               200.48). The sea itself is Sea.prefab, run by layout/scripts' stand-ins. The game
//               sets the light per biome and mood at run time, so those are stand-ins; per scene the
//               values merge. live (true): the page works the sun, ambient, fog and sky out each
//               frame from where the camera is, as the game's EnvironmentManager does from its
//               BiomeZones' moods (tools/moods.js, web/environment.js; Claude, 2026-11-03), and
//               these values stand only until it has; false keeps them.
// A rule is "kind:pattern", * matching anything. Kinds: prefab (a piece's prefab, or
// "Prefab/Object" for an object inside it), object, mesh, material, folder (prefab or mesh
// folder, e.g. "Prefabs/PFX").
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'unity.json');
const KINDS = ['prefab', 'object', 'mesh', 'material', 'folder'];
const ENVIRONMENT = {
  live: true, sunDirection: [-0.4, 1, 0.6], sunColor: '#ffffff', sunIntensity: 1, ambient: 0.5, fogColor: '#808080', fogDensity: 0.014,
  seaLevel: null, sky: 'CanSky',
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
  skyBlendMin: 60, skyBlendMax: 300, skyBlackMult: -9, skyBlackAdd: 1200, skyTint: '#808080', skyTintLevel: 0, skyRadius: null,
  // LeafSplit's leaves in the wind (Ken, 2026-10-31): Canopy's iLeafCutWind shader's properties, the
  // same defaults (web/app.js windPatch draws its motion), to tune here and then set on the material.
  // The levels, the direction and the gusts are LeafGust's (scripts/LeafGust.js; ☰ World sets the
  // levels). sway and flutter: how far wind at strength 1 (medium) turns a leaf downwind and across
  // its face (the share of downwind or the face's direction added to the leaf's: 1 turns a leaf
  // across the wind 45 degrees), the steady wind and gusts added; frequency (flutters a second); the wave gusts' gustLength (m between them), gustSpeed (m/s) and gustShape
  // (they lull to stillness between them: the higher, the shorter the gusts and longer the calms;
  // 1, as long as each other); near: the share of it all at the eye, growing to all of it at
  // nearDistance m (calm close up, against VR sickness: Ken, 2026-10-31); fadeDistance (m: no sway
  // beyond it, full to half of it).
  // sway and flutter an eighth of what they were (Ken, 2026-11-02: 25% as vigorous, then half that)
  leafWind: { sway: 0.075, flutter: 0.01875, frequency: 1.5, gustLength: 12, gustSpeed: 4, gustShape: 2, near: 0.25, nearDistance: 8, fadeDistance: 1000 }
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
    tweakWorkers: { ...d.tweakWorkers, ...s.tweakWorkers },
    maxTexture: s.maxTexture ?? d.maxTexture ?? 1024,
    show: [...rules(d.show), ...rules(s.show)],
    hide: [...rules(d.hide), ...rules(s.hide)],
    include: s.include ?? d.include ?? [],
    // An outland's scene (Black Isle, the aerial island where Hawthorn's thrusters are: Ken,
    // 2026-11-09) is part of its biome's (partOf), with no stage of its own: it plays as that scene.
    partOf: s.partOf ?? null,
    stage: s.stage ?? (s.partOf ? ((raw.scenes || {})[s.partOf] || {}).stage ?? (/^(\w+)Scene$/.exec(s.partOf) || [])[1] ?? null : null) ?? d.stage ?? null,
    // areas drawn with this scene's whenever it is open: Game's World with every Canopy scene, as the
    // game always has Game.unity loaded (defaults; Ken, 2026-11-09), Hawthorn's outland Black Isle
    with: [...new Set([...(d.with || []), ...(s.with || [])])],
    // where in the scene each place is and the stage it shows from (Ken, 2026-11-09): [{ path, from, title }]
    places: s.places ?? [],
    // after the places: a path naming its stage (Game's World/<Stage>Biome/...), a regex
    stagePath: s.stagePath ? new RegExp(s.stagePath) : null,
    title: s.title ?? null, // the name of its area when not its scene's (BlackIsleScene: Black Isle)
    symbols: { ...d.symbols, ...s.symbols },
    environment: { ...ENVIRONMENT, ...d.environment, ...s.environment, leafWind: { ...ENVIRONMENT.leafWind, ...(d.environment || {}).leafWind, ...(s.environment || {}).leafWind } }
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
// What an imported area bakes in, for its Unity scene: the unity.json settings tools/scene.js
// extractArea reads (show and hide rules, tree chunks, grid and leaf settings), which scripts have
// stand-ins, and tools/unity.js's READER (how prefabs are read). An area is
// re-imported only when this changes (Ken, 2026-10-29: most unity.json changes are read at load
// time, so they need no re-import).
function extractKey(scene) {
  const c = load(scene), rules = list => list.map(r => `${r.kind}:${r.pattern}`);
  // which C# scripts have stand-ins (layout/scripts/): an area keeps theirs only
  const standIns = fs.existsSync(STANDINS) ? fs.readdirSync(STANDINS).filter(f => f.endsWith('.js')).sort() : [];
  return JSON.stringify({ show: rules(c.show), hide: rules(c.hide), treeChunks: c.treeChunks.source, gridDrawsInactiveParts: c.gridDrawsInactiveParts, gridLodByDistance: c.gridLodByDistance, leafThinning: c.leafThinning, standIns, reader: require('./unity.js').READER, substitute: (JSON.parse(fs.readFileSync(FILE, 'utf8')).defaults || {}).substitute || [] });
}
const STANDINS = path.join(__dirname, '..', 'scripts');

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

// The parts of a piece to draw: switched-off parts only if a show rule names them or a condition
// may switch them on (when: tools/conditions.js; offSaved marks them off as saved), minus any a
// hide rule names. A part a show rule names is drawn in every mode. materialName(guid) gives a
// material's name for material rules.
function visibleParts(config, piece, parts, materialName = () => '') {
  const hit = (rules, part) => rules.some(r => matches(r, piece, part, materialName(part.material)));
  const out = [];
  for (const part of parts) {
    if (hit(config.hide, part)) continue;
    if (hit(config.show, part)) {
      const plain = { ...part };
      for (const k of ['when', 'never', 'offSaved']) delete plain[k];
      out.push(plain);
    } else if (!part.off) out.push(part);
    else if (part.when && !part.never) out.push({ ...part, offSaved: true });
  }
  return out;
}

module.exports = { load, extractKey, visibleParts, FILE, cullDistance };
