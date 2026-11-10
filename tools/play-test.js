// Game mode's items (web/play.js) in Node, with a fake page (Claude, 2026-11-08): taking, swapping,
// dropping, collecting, eating, rings, the dagger and fireflies, gems at the Gem Station, starting
// over. `node tools/play-test.js`; exits 1 if a check fails.
const path = require('path');
const L = path.join(__dirname, '..', 'web') + '/';
const THREE = require(L + 'three.js');
const els = {};
const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', clientWidth: 100, classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, bottom: 100 }), setPointerCapture() {} });
const dots = [];
global.document = { getElementById: el, body: el('body'), createElement: () => { const d = el('dot' + dots.length); d.remove = () => {}; dots.push(d); return d; } };
global.document.body.appendChild = () => {};
global.window = { innerWidth: 400, innerHeight: 800, addEventListener() {} };
global.localStorage = { getItem: () => null, setItem() {} };
const counts = {};
const Play = require(L + 'play.js');
const scene = new THREE.Scene(), world = new THREE.Group(); scene.add(world);
const camera = new THREE.PerspectiveCamera(55, 0.5, 0.03, 400);
camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1); camera.updateMatrixWorld();
let station = false;
const takenGroups = [];
const play = Play.create({ THREE, camera, scene, world, count: n => (counts[n] = (counts[n] || 0) + 1), atGemStation: () => station, wardensLeft: () => 0, guardedPiece: () => null, objectOfPath: () => null, onTaken: g => takenGroups.push(g) });
const ff = { stages: { Tutorial: 0, Beech: 1, Tangle: 2, Oak: 3, Hawthorn: 10 }, order: ['Tutorial', 'Beech', 'Tangle', 'Hawthorn', 'Oak'], abilities: { 1: 'NoAbility', 113: 'Stout', 120: 'SeaSkip' }, configs: { 3: { inventory: { amberAmount: 80, mana: 4, thrusterCount: 0, daggerCount: 1, fuelDuration: 150 }, rings: [{ id: 113, ability: 'Stout', color: [1, 0.8, 0.3] }, null, { id: 1, ability: 'NoAbility' }, null, null, null, null, null, null, null] } }, symbols: {} };
play.configure(ff, 'Oak');
let inv = play.inventory();
const ok = (c, m) => { if (!c) { console.log('FAIL', m, JSON.stringify(play.inventory())); process.exitCode = 1; } else console.log('ok  ', m); };
ok(inv.amberAmount === 80 && inv.mana === 4 && inv.fingers[0] === 'Stout', 'config inventory and rings');
ok(/data-field="mana"/.test(els.hudCounts.innerHTML) && /data-field="daggerCount"/.test(els.hudCounts.innerHTML) && !/fuelDuration/.test(els.hudCounts.innerHTML) && !/thrusterCount/.test(els.hudCounts.innerHTML), 'display: mana (Oak), dagger, no fuel without thrusters');
// a piece with an amber item (2 LOD meshes) and a plain mesh
function piece(kind, at, extra = {}) {
  const g = new THREE.Group(); g.position.set(...at); g.updateMatrix(); world.add(g);
  const item = { kind, key: 'k1', ...extra };
  const meshes = [0, 1].map(l => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial()); m.matrixAutoUpdate = false; m.userData.part = { item }; m.userData.lod = { key: 'a', levels: [l] }; g.add(m); return m; });
  const rock = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); rock.userData.part = {}; g.add(rock);
  scene.updateMatrixWorld(true);
  return { g, meshes, rock };
}
const amber = piece('Amber', [0, 0, -2], { amberToAdd: 5 });
const fuel = piece('Fuel', [1, 0, -2], { fuelSecondsToAdd: 30 });
const far = piece('Gem', [0, 0, -10]);
ok(play.tapHit({ object: far.meshes[0], distance: 10 }, 5, 5) && dots.length === 1 && !play.inventory().held, 'out of reach: red dot, nothing taken');
ok(play.tapHit({ object: amber.rock, distance: 1 }, 5, 5) === false, 'non-item: not handled (hop)');
ok(play.tapHit({ object: amber.meshes[1], distance: 2 }, 5, 5) && play.inventory().held === 'Amber', 'amber taken');
ok(amber.meshes.every(m => !m.layers.test(camera.layers)) && amber.rock.layers.test(camera.layers), 'its meshes (all levels) hidden, the rest not');
ok(play.tapHit({ object: fuel.meshes[0], distance: 2 }, 5, 5) && play.inventory().held === 'Fuel', 'swap: fuel held');
const c = new THREE.Box3().setFromObject(amber.meshes[0]).getCenter(new THREE.Vector3());
ok(amber.meshes.every(m => m.layers.test(camera.layers)) && Math.abs(c.x - 1) < 1e-6 && Math.abs(c.z + 2) < 1e-6, 'swap: amber shown where the fuel was ' + c.toArray());
play.collect();
inv = play.inventory();
ok(inv.fuelDuration === 180 && !inv.held, 'fuel collected (+30)');
ok(play.tapHit({ object: amber.meshes[0], distance: 2 }, 5, 5) && play.inventory().held === 'Amber', 'amber taken again');
play.tapHeld();
const d = new THREE.Box3().setFromObject(amber.meshes[0]).getCenter(new THREE.Vector3());
ok(Math.abs(d.z + 1) < 1e-6 && Math.abs(d.x) < 1e-6 && !play.inventory().held, 'dropped 1 m ahead ' + d.toArray());
play.tapHit({ object: amber.meshes[0], distance: 1 }, 5, 5); play.collect();
ok(play.inventory().amberAmount === 85, 'amber collected (+5)');
// fruit
const fruit = piece('Fruit', [0, 0.5, -1.5], { power: 2 });
play.tapHit({ object: fruit.meshes[0], distance: 1.5 }, 5, 5); play.tapHeld();
ok(play.inventory().health === 1 && !play.inventory().held, 'fruit eaten on tap (health capped at full)');
// ring: wear on first free finger, take a config ring off
const ring = piece('Ring', [0.5, 0, -1], { isThumbRing: 0 });
play.tapHit({ object: ring.meshes[0], distance: 1 }, 5, 5); play.collect();
inv = play.inventory();
ok(inv.fingers[1] === 'NoAbility' && !inv.held, 'ring worn on the left index (thumb taken)');
play.tapFinger(0, el('x'));
ok(play.inventory().held === 'Ring' && play.extras().length === 1 && play.inventory().fingers[0] === null, 'config ring taken off: a made ring held');
play.tapHeld();
ok(play.inventory().fingers[0] === 'Stout' && !play.inventory().held, 'held ring tapped: on the first free thumb');
const ring2 = piece('Ring', [0.6, 0, -1], { isThumbRing: 0 });
play.tapHit({ object: ring2.meshes[0], distance: 1 }, 5, 5); play.tapHeld();
ok(play.inventory().fingers[3] === 'NoAbility', 'held ring tapped: on the first free finger (left ring)');
// the dagger: collected on the tap; a firefly: one at a time
const dagger = piece('Dagger', [0, 0, -1.2]);
play.tapHit({ object: dagger.meshes[0], distance: 1.2 }, 5, 5);
ok(play.inventory().daggerCount === 2 && !play.inventory().held && dagger.meshes.every(m => !m.layers.test(camera.layers)), 'dagger collected at once');
const fly = piece('Firefly', [0.2, 0, -1.2]), fly2 = piece('Firefly', [-0.2, 0, -1.2]);
play.tapHit({ object: fly.meshes[0], distance: 1.2 }, 5, 5);
ok(play.inventory().fireflyCount === 1 && !play.inventory().held && /fireflyCount/.test(els.hudCounts.innerHTML), 'firefly to the hand crystal, shown');
const before = dots.length;
play.tapHit({ object: fly2.meshes[0], distance: 1.2 }, 5, 5);
ok(play.inventory().fireflyCount === 1 && dots.length === before + 1 && fly2.meshes.every(m => m.layers.test(camera.layers)), 'second firefly: red dot, left where it is');
// gems: dropped away from the station; at it, into the first open ring, then a red dot
const gem = piece('Gem', [0, 0, -1.5], { abilityId: 120, color: [0.2, 0.6, 1] });
play.tapHit({ object: gem.meshes[0], distance: 1.5 }, 5, 5); play.tapHeld();
ok(!play.inventory().held && gem.meshes.every(m => m.layers.test(camera.layers)), 'gem away from the station: dropped');
station = true;
play.tapHit({ object: gem.meshes[0], distance: 1 }, 5, 5); play.tapHeld();
inv = play.inventory();
ok(inv.fingers[1] === 'SeaSkip' && inv.fingers[2] === 'NoAbility' && !inv.held && gem.meshes.every(m => !m.layers.test(camera.layers)), 'gem at the station: into the first open ring (left index), gone');
const gem2 = piece('Gem', [0, 0, -1.6], { abilityId: 120 }), gem3 = piece('Gem', [0, 0, -1.7], { abilityId: 120 });
play.tapHit({ object: gem2.meshes[0], distance: 1 }, 5, 5); play.tapHeld();
play.tapHit({ object: gem3.meshes[0], distance: 1 }, 5, 5); play.tapHeld();
ok(play.inventory().fingers.filter(f => f === 'SeaSkip').length === 3 && play.inventory().held === null, 'second and third gems: the next open rings');
const gem4 = piece('Gem', [0, 0, -1.8], { abilityId: 120 }), dots0 = dots.length;
play.tapHit({ object: gem4.meshes[0], distance: 1 }, 5, 5); play.tapHeld();
ok(play.inventory().held === 'Gem' && dots.length > dots0, 'no open ring: red dot, gem still held');
station = false;
// reset restores
play.tapHit({ object: fuel.meshes[0], distance: 1 }, 5, 5);
play.reset();
amber.g.updateMatrixWorld(true);
const bc = new THREE.Box3().setFromObject(amber.meshes[0]).getCenter(new THREE.Vector3());
ok(Math.abs(bc.z + 2) < 1e-6 && Math.abs(bc.x) < 1e-6 && amber.meshes.every(m => m.layers.test(camera.layers)) && fuel.meshes.every(m => m.layers.test(camera.layers)), 'reset: items back where they were ' + bc.toArray());
inv = play.inventory();
ok(inv.amberAmount === 80 && inv.daggerCount === 1 && inv.fireflyCount === 0 && inv.fingers[0] === 'Stout' && inv.fingers[2] === 'NoAbility' && play.extras().length === 0 && !inv.held, 'reset: inventory, rings from the config, made rings gone');
ok(dagger.meshes.every(m => m.layers.test(camera.layers)) && gem.meshes.every(m => m.layers.test(camera.layers)), 'reset: the dagger and the set gem back');
// an assemblage: a tap kills only the harvester unit tapped, its meshes (app.js tapTarget), and an
// unguarded cage unit gives its own firefly, not another unit's
const isle = piece('Rock', [0, 0, -1]);
const harvester = isle.meshes.slice(0, 1), other = isle.meshes.slice(1);
play.kill(isle.g, { name: 'EjectorInk' }, { distance: 1 }, 5, 5, harvester, 'ink1'); // the unit's object (thing.go)
ok(harvester.every(m => !m.layers.test(camera.layers)) && other.every(m => m.layers.test(camera.layers)) && isle.rock.layers.test(camera.layers), 'assemblage: kill hides only the unit tapped');
const cageIsle = piece('Firefly', [0, 0, -1]);
play.reset();
ok(play.tapCage(cageIsle.g, { name: 'Cage', path: 'Isle/Cage' }, { distance: 1 }, 5, 5, cageIsle.meshes.slice(1)) && play.inventory().fireflyCount === 1 && cageIsle.meshes[0].layers.test(camera.layers) && !cageIsle.meshes[1].layers.test(camera.layers), 'assemblage: a cage unit gives only its own firefly');
ok(harvester.every(m => m.layers.test(camera.layers)), 'reset: the assemblage harvester back');
// a cage: guarded, empty or out of reach, the tap is any other (hops: false); else its firefly
play.reset();
const cage2 = piece('Firefly', [0, 0, -1]);
ok(play.tapCage(cage2.g, { name: 'Cage', path: 'C2', extra: 'guards 2' }, { distance: 1 }, 5, 5, null) === false && play.inventory().fireflyCount === 0, 'guarded cage: hopped to, firefly stays');
ok(play.tapCage(cage2.g, { name: 'Cage', path: 'C2' }, { distance: 4 }, 5, 5, null) === false && play.inventory().fireflyCount === 0, 'unguarded cage out of reach: hopped to');
ok(play.tapCage(cage2.g, { name: 'Cage', path: 'C2' }, { distance: 2 }, 5, 5, null) === true && play.inventory().fireflyCount === 1, 'unguarded cage within reach: firefly collected');
ok(play.tapCage(cage2.g, { name: 'Cage', path: 'C2' }, { distance: 2 }, 5, 5, null) === false, 'empty cage: hopped to');
// a payment marker: pays its value (a red dot when too poor, nothing when out of reach); taking an
// item tells the page (app.js takes amber made on a marker back off its payee)
play.reset();
const amber0 = play.inventory().amberAmount, dots1 = dots.length;
ok(play.pay(1000, { distance: 1 }, 5, 5) === true && dots.length > dots1 && play.inventory().amberAmount === amber0, 'too poor: red dot, nothing paid');
ok(play.pay(10, { distance: 4 }, 5, 5) === false, 'marker out of reach: hopped to');
ok(play.pay(10, { distance: 1 }, 5, 5) === 'paid' && play.inventory().amberAmount === amber0 - 10, 'paid: 10 amber less');
const madeAmber = piece('Amber', [0, 0, -1.2], { amberToAdd: 10, key: 'm1' });
play.tapHit({ object: madeAmber.meshes[0], distance: 1 }, 5, 5);
ok(takenGroups.includes(madeAmber.g), 'its amber taken: the page hears of it');
play.collect();
ok(play.inventory().amberAmount === amber0, 'collected: the amber back');
// daggers and fireflies in icons, no number; at most two daggers; mana stabbed empowers the dagger
play.reset();
const svgs = field => ((/data-field="FIELD">(.*?)<\/div>/.exec(els.hudCounts.innerHTML.replace('FIELD', field).replace(/data-field="(\w+)"/g, (m, f) => (f === field ? 'data-field="FIELD"' : m))) || [])[1] || '').split('<svg').length - 1;
const dagger2 = piece('Dagger', [0, 0, -1]);
play.tapHit({ object: dagger2.meshes[0], distance: 1 }, 5, 5);
ok(play.inventory().daggerCount === 2 && svgs('daggerCount') === 2 && !/<span>2<\/span>/.test(els.hudCounts.innerHTML), 'two daggers: two icons, no number');
const dagger3 = piece('Dagger', [0, 0, -1.1]), dots2 = dots.length;
play.tapHit({ object: dagger3.meshes[0], distance: 1 }, 5, 5);
ok(play.inventory().daggerCount === 2 && dots.length > dots2 && dagger3.meshes.every(m => m.layers.test(camera.layers)), 'a third dagger: a red dot, left where it is');
const fireMana = piece('Mana', [0, 0, -1.2], { class: 'ManaFire' });
play.tapHit({ object: fireMana.meshes[0], distance: 1 }, 5, 5);
ok(play.inventory().held === 'Mana' && !play.inventory().empowered, 'fire mana tapped: held, as any item');
ok(play.stabHeld() && play.inventory().empowered === 'fire' && !play.inventory().held && fireMana.meshes.every(m => !m.layers.test(camera.layers)) && /empowered fire/.test(els.hudCounts.innerHTML), 'held fire mana pressed: stabbed, the dagger fire-empowered (radiating), the mana gone');
// mounted mana: the page hides it and makes a real mana item, taken into Hold (holdMade)
const mounted = piece('Rock', [0, 0, -1.3]), madeWater = piece('Mana', [0, 0, -1.3], { class: 'ManaWater' });
play.hideGroup(mounted.g, mounted.meshes);
play.holdMade(madeWater.meshes[0]);
ok(play.inventory().held === 'Mana' && mounted.meshes.every(m => !m.layers.test(camera.layers)) && madeWater.meshes.every(m => !m.layers.test(camera.layers)), 'mana mounted on a harvester: hidden, a made mana item in Hold');
play.stabHeld();
ok(play.inventory().empowered === 'water' && !play.inventory().held, 'held water mana stabbed: water replaces fire');
ok(play.useFire() === false && play.inventory().empowered === 'water', 'water-empowered: no fire to use on red');
const fire2 = piece('Mana', [0, 0, -1.4], { class: 'ManaFire' });
play.holdMade(fire2.meshes[0]);
play.stabHeld();
ok(play.useFire() === true && !play.inventory().empowered && !/empowered/.test(els.hudCounts.innerHTML), 'fire used on red: the dagger back to normal');
ok(/class="count always" data-field="daggerCount"/.test(els.hudCounts.innerHTML), 'daggers carried show with the display off');
play.reset();
const noDagger = Play.create({ THREE, camera, scene, world, count: () => {} });
const fire3 = piece('Mana', [0, 0, -1.5], { class: 'ManaFire' });
noDagger.holdMade(fire3.meshes[0]);
ok(noDagger.stabHeld() === true && !noDagger.inventory().empowered && noDagger.inventory().held === 'Mana', 'no dagger: a red dot, the mana still held');
ok(svgs('fireflyCount') === 0, 'no firefly: no icon');
// an item taken off a harvester leaves its hierarchy: dropped, it lives on when the harvester is killed
play.reset();
const flamer = piece('Mana', [0, 0, -1], { class: 'ManaFire' });
play.tapHit({ object: flamer.meshes[0], distance: 1 }, 5, 5);
play.tapHeld(); // dropped ahead
play.kill(flamer.g, { name: 'Flamer' }, { distance: 1 }, 5, 5, null);
ok(flamer.meshes.every(m => m.layers.test(camera.layers) && m.parent !== flamer.g) && flamer.rock.layers.test(camera.layers) === false, 'mana taken off a flamer: the flamer killed, the dropped mana lives on');
play.reset();
ok(flamer.meshes.every(m => m.parent === flamer.g), 'reset: the mana back on its flamer');
// throwing: a straight item stops where it was thrown (in reach), or after 7 m with nothing tapped; a
// gravitic one lands where aimed (a floor at y = -2 here)
{
  const floor = (from, to) => (from.y > -2 && to.y <= -2 ? { point: from.clone().lerp(to, (from.y + 2) / (from.y - to.y)), normal: new THREE.Vector3(0, 1, 0) } : null);
  const thrower = Play.create({ THREE, camera, scene, world, count: () => {}, cast: floor, gravity: () => 3 }); // Canopy's
  const run = () => { for (let i = 0; i < 1200 && thrower.flying(); i++) thrower.frame(1 / 60); };
  const centerOf = mesh => new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  const a1 = piece('Amber', [0, 0, -1], { amberToAdd: 1, key: 't1' });
  thrower.tapHit({ object: a1.meshes[0], distance: 1 }, 5, 5);
  thrower.throwHeld(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -3), new THREE.Vector3(0, 0, -1));
  run();
  const c1 = centerOf(a1.meshes[0]);
  ok(!thrower.inventory().held && Math.abs(c1.z + 3) < 0.25 && Math.abs(c1.y) < 0.01 && a1.meshes[0].layers.test(camera.layers), 'thrown at a point 3 m off: it floats to a stop there ' + c1.toArray().map(v => v.toFixed(2)));
  const a2 = piece('Amber', [0, 0, -1], { amberToAdd: 1, key: 't2' });
  thrower.tapHit({ object: a2.meshes[0], distance: 1 }, 5, 5);
  thrower.throwHeld(new THREE.Vector3(0, 0, 0), null, new THREE.Vector3(0, 0, -1));
  run();
  const c2 = centerOf(a2.meshes[0]);
  ok(c2.z < -6.5 && c2.z > -7.1, 'thrown at nothing: it goes about 7 m and floats ' + c2.z.toFixed(2));
  const p1 = piece('Part', [0, 0, -1], { gravitic: 1, key: 't3' });
  thrower.tapHit({ object: p1.meshes[0], distance: 1 }, 5, 5);
  thrower.throwHeld(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -2, -2.5), new THREE.Vector3(0, -0.6, -0.8));
  run();
  const c3 = centerOf(p1.meshes[0]);
  ok(Math.abs(c3.y + 2) < 0.3 && Math.abs(c3.z + 2.5) < 0.4, 'a gravitic part aimed at the floor 2.5 m off lands there ' + c3.toArray().map(v => v.toFixed(2)));
}
// a tenant held: its look (most detailed mesh) for a vacancy's match, then used up
play.reset();
const tenant = piece('Tenant', [0, 0, -1], { key: 'tenant1' });
tenant.meshes.forEach((m, i) => { m.userData.part.mesh = { path: 'Assets/Meshes/EnemyPart18Lods/EnemyPart18_Lod' + i + '.asset', name: 'EnemyPart18_Lod' + i }; });
play.tapHit({ object: tenant.meshes[1], distance: 1 }, 5, 5);
ok(play.heldMeshId() === 'Assets/Meshes/EnemyPart18Lods/EnemyPart18_Lod0.asset|EnemyPart18_Lod0', 'a held tenant is known by its most detailed mesh');
play.useHeld();
ok(!play.inventory().held && tenant.meshes.every(m => !m.layers.test(camera.layers)), 'a tenant placed: gone from Hold and the world');
// An item's particle systems go with it (web/tickable.js prefab state): held, dropped (carried
// where it went), gone when collected or killed, all cleared when game mode starts over.
play.reset();
const lit = piece('Amber', [0, 0, -1], { amberToAdd: 1, key: 'lit1' });
const prefab = { objects: { lit1: { father: 'root' }, root: {} } };
lit.g.userData.prefab = prefab;
play.tapHit({ object: lit.meshes[0], distance: 1 }, 5, 5);
ok(!prefab.off.has('lit1') && prefab.carried.get('lit1').mesh !== lit.meshes[0], 'held: playing, carried with the hand');
play.tapHeld();
const moved = prefab.carried.get('lit1');
ok(!prefab.off.has('lit1') && moved && moved.mesh === lit.meshes[0], 'dropped: on, carried with the item');
play.tapHit({ object: lit.meshes[0], distance: 1 }, 5, 5);
play.collect();
ok(prefab.off.has('lit1'), 'collected: off');
play.reset();
ok(!prefab.off.size && !prefab.carried.size, 'starting over clears it');
play.hideGroup(lit.g, null);
ok(prefab.off.has('*'), 'a piece killed whole: all of it off');
play.reset();
play.hideGroup(lit.g, [lit.rock], 'root');
ok(prefab.off.has('root'), 'a given object off');
play.reset();
// Anything can be guarded (Ken, 2026-11-10): a guarded item isn't taken until its guards are killed;
// a tenant's look is guarded as the tenant (guardedAs), and its guards count down by that path.
{
  const looks = piece('Tenant', [0, 0, -1], { key: 'tenantLook' });
  looks.g.userData.piece = { name: 'EnemyPart22Lods', path: 'McTenant/TenantPart22/EnemyPart22Lods', extra: 'guards 2', guardedAs: 'McTenant/TenantPart22' };
  const guard = new THREE.Group(); world.add(guard);
  const guarded = Play.create({ THREE, camera, scene, world, count: () => {}, wardensLeft: () => 0, guardedPiece: path => (path === 'McTenant/TenantPart22' ? looks.g.userData.piece : null), objectOfPath: () => null });
  guarded.tapHit({ object: looks.meshes[0], distance: 1 }, 5, 5);
  ok(!guarded.inventory().held && looks.meshes[0].layers.test(camera.layers), 'guarded: not taken');
  guarded.kill(guard, { name: 'Daisy', guarding: 'McTenant/TenantPart22' }, { distance: 1 }, 5, 5, null);
  guarded.tapHit({ object: looks.meshes[0], distance: 1 }, 5, 5);
  ok(!guarded.inventory().held, 'one guard of two killed: still not taken');
  guarded.kill(guard, { name: 'Daisy (1)', guarding: 'McTenant/TenantPart22' }, { distance: 1 }, 5, 5, null);
  guarded.tapHit({ object: looks.meshes[0], distance: 1 }, 5, 5);
  ok(guarded.inventory().held === 'Tenant', 'both guards killed: taken');
  guarded.reset();
}
ok(play.symbols().DaggerCount === '1' && play.symbols().AmberAmount === '80' && play.symbols().FuelAmount === '150', 'inventory symbols');
console.log(counts);
