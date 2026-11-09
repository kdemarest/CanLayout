// Game mode's items, inventory and display (Ken, 2026-11-08). In game mode a tap on an Item (any
// Canopy class deriving from Item, and fireflies: a part carries item, tools/unity.js) within
// TAKE_REACH m takes it into Hold, one item at a time: it leaves the world and is drawn in the corner
// (bottom right, at most 15% of the screen's shorter side). Tapping the held item drops it
// DROP_AHEAD m ahead of the camera, along its view; but a fruit is eaten, a ring goes on the first
// open finger, and a gem at the Gem Station (ctx.atGemStation: the temple's workbench) goes into
// the first open ring (a ring holding no gem); a red dot on it when there is none. Swiping left on
// it collects it into the inventory, as touching it with the other hand does in Canopy, and its
// count shows a moment. A dagger is collected as soon as it is tapped, and a firefly goes to the
// hand crystal (one at a time; a red dot when there is one already). Tapping another item while
// holding one swaps them. A ring is also worn by tapping a finger with it held, and taken off by
// tapping a worn finger with empty hands. Nothing persists: leaving game
// mode, or fast-forwarding, puts every item back where it was and starts the inventory over from
// the stage's FastForwardConfig (Canopy's FastForwardConfig.ApplyInitialSettings).
// ☰ Game display (default off, remembered in this browser) shows the counts top right and the ring
// fingers bottom left: amber always, health after the Tutorial, mana from the Tangle on (where the
// first mana can be collected) or once there is some, fuel once there are thrusters, thrusters,
// boosters, daggers and headlamps only while there are any.
// Loaded as a plain script in the browser (window.CanopyPlay).
(function (root) {
    const TAKE_REACH = 2.5; // m from the eye to the tapped point of an item
    const DROP_AHEAD = 1; // m ahead of the camera, along its view
    const BOX = 0.15; // the held item's corner, as a share of the screen's shorter side
    const HIDDEN = 1; // the layer a taken item's meshes go to: neither drawn nor hit by taps
    const BACKDROP = 0x2b3442; // behind the held item, so a dark one (the obsidian dagger) shows
    const FRUIT_POINTS = [1, 2, 4], FRUIT_TO_FULL = 15; // Fruit.powerToPoints, Rules.fruitPointsToFullHealth
    const DIGITS = ["Left thumb", "Left index", "Left middle", "Left ring", "Left pinky", "Right thumb", "Right index", "Right middle", "Right ring", "Right pinky"];
    const isThumb = d => d === 0 || d === 5;
    const svg = (body, color) => `<svg viewBox="0 0 24 24" aria-hidden="true" style="color:${color}">${body}</svg>`;
    // The display's icons, by inventory field.
    const ICONS = {
        health: svg('<path fill="currentColor" d="M12 21s-7.5-4.6-9.3-9.2C1.5 8.6 3.6 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.5 3.6 4.3 6.8C19.5 16.4 12 21 12 21z"/>', "#ff5a6a"),
        amberAmount: svg('<path fill="currentColor" d="M12 2l8 5v10l-8 5-8-5V7z"/><path fill="#fff6" d="M12 4.5l5.5 3.4L12 11 6.5 7.9z"/>', "#f2a43a"),
        mana: svg('<path fill="currentColor" d="M12 1l3 8 8 3-8 3-3 8-3-8-8-3 8-3z"/>', "#7fd4ff"),
        fuelDuration: svg('<path fill="currentColor" d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 3 1 4 2 4 0-3-1-6 1-9z"/>', "#ff8a3d"),
        thrusterCount: svg('<path fill="currentColor" d="M12 2c3 3 4 7 4 11l-2 3h-4l-2-3c0-4 1-8 4-11z"/><path fill="#ffb347" d="M10 17h4l-2 5z"/>', "#d6dbe4"),
        boosterCount: svg('<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M5 13l7-7 7 7M5 20l7-7 7 7"/>', "#a6f07a"),
        daggerCount: svg('<path fill="currentColor" d="M12 1l3 13h-6z"/><path fill="#c9a66b" d="M7 14h10v2H7zM11 16h2v5h-2z"/>', "#b8c4d8"),
        headlampCount: svg('<circle cx="12" cy="13" r="4.5" fill="currentColor"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3v3M4.5 6.5l2 2M19.5 6.5l-2 2M2 13h3M19 13h3"/>', "#ffe37a"),
        fireflyCount: svg('<path fill="currentColor" d="M11 12C7 4 2 5 3 9s5 4 8 3zM13 12c4-8 9-7 8-3s-5 4-8 3zM11 13c-4 1-7 4-5 6s4-1 5-6zM13 13c4 1 7 4 5 6s-4-1-5-6z"/><path fill="#fff" d="M11.3 8h1.4v9h-1.4z"/>', "#d9ff6a"),
        rings: svg('<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="3"/>', "#e8e6e1")
    };
    // Daggers and fireflies are counted in icons, one each, never a number (Ken, 2026-11-09): at most
    // MAX_DAGGERS daggers; fireflies, one a hand crystal (a second crystal, later in the game, carries
    // a second: not yet in Layout).
    const MAX_DAGGERS = 2, CRYSTALS = 1;
    const BY_ICON = new Set(["daggerCount", "fireflyCount"]);
    // A mana's element by its class (Ken, 2026-11-09: stabbing mana empowers the dagger)
    const MANA_ELEMENT = { ManaFire: "fire", ManaAir: "air", ManaWater: "water" };
    const STAB_PRESS = 1000; // ms: a press on held mana this long stabs it
    const COLLECTS = { Amber: "amberAmount", Mana: "mana", Fuel: "fuelDuration", Thruster: "thrusterCount", Booster: "boosterCount", Dagger: "daggerCount", Headlamp: "headlampCount" };
    const ZERO = { thrusterCount: 0, boosterCount: 0, daggerCount: 0, headlampCount: 0, amberAmount: 0, fuelDuration: 0, mana: 0, fireflyCount: 0 };
    const OPEN = "NoAbility"; // a ring holding no gem

    function create(ctx) {
        const { THREE, camera, scene, world, count } = ctx;
        const atGemStation = ctx.atGemStation || (() => false);
        const $ = id => document.getElementById(id);
        const box = $("heldBox"), toast = $("toast");
        const recs = new Map(); // "<piece group id>|<item key>" -> a taken item: { key, item, group, meshes, saved, fake, ring }
        const fakes = []; // rings made for worn rings of the fast-forward config, when taken off a finger
        let held = null, inventory = { ...ZERO }, health = 1, fingers = new Array(10).fill(null);
        let ff = null, stageName = null, active = false, display = false, fakeCount = 0;
        try {
            display = localStorage.getItem("layout.gameDisplay") === "1";
        } catch {
            display = false; // storage blocked: off
        }

        // ---------- the held item, drawn in its corner ----------
        const overlay = new THREE.Scene();
        overlay.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2), new THREE.DirectionalLight(0xffffff, 2));
        const holder = new THREE.Group();
        overlay.add(holder);
        const overlayCamera = new THREE.PerspectiveCamera(30, 1, 0.001, 100);
        const forward = new THREE.Vector3(), work = new THREE.Box3(), part = new THREE.Box3(), noLights = new THREE.Vector4();
        const clearColor = new THREE.Color(), backdrop = new THREE.Color(BACKDROP);
        let heldRadius = 0.1;
        function sizeBox() {
            const s = Math.round(BOX * Math.min(window.innerWidth, window.innerHeight));
            box.style.width = box.style.height = s + "px";
        }
        window.addEventListener("resize", sizeBox);
        sizeBox();
        // A taken item's place and size in the world: its meshes' bounds, every level.
        function bounds(rec) {
            work.makeEmpty();
            for (const mesh of rec.meshes) {
                if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                work.union(part.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
            }
            return work;
        }
        function showHeld(rec) {
            holder.clear();
            const b = bounds(rec), center = b.getCenter(new THREE.Vector3());
            // the farthest any of its meshes' bounding spheres reaches from the center, so it fits
            // the corner whichever way it turns
            heldRadius = 0.01;
            const sphere = new THREE.Sphere();
            for (const mesh of rec.meshes) {
                if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
                sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
                heldRadius = Math.max(heldRadius, sphere.center.distanceTo(center) + sphere.radius);
            }
            heldRadius = Math.min(heldRadius, b.getSize(new THREE.Vector3()).length() / 2);
            const toCenter = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const first = rec.meshes.filter(m => !m.userData.lod || m.userData.lod.levels.includes(0)); // its most detailed level
            for (const mesh of first.length ? first : rec.meshes) {
                const copy = new THREE.Mesh(mesh.geometry, mesh.userData.untinted || mesh.material);
                copy.matrixAutoUpdate = false;
                copy.matrix.multiplyMatrices(toCenter, mesh.matrixWorld);
                copy.frustumCulled = false;
                copy.renderOrder = mesh.renderOrder;
                copy.onBeforeRender = (renderer, s, c, g, material) => {
                    const u = material && material.userData && material.userData.canopyLights;
                    if (u) u.value.copy(noLights); // the world's point lights don't reach the corner
                };
                holder.add(copy);
            }
            box.classList.add("held");
        }
        function hideHeld() {
            holder.clear();
            box.classList.remove("held");
        }
        // Each frame: the held item turns slowly, in front of the eye (so the world's fog and sea
        // level treat it as near the player).
        function frame(dt) {
            if (flight) fly(dt);
            if (!held) return;
            holder.rotation.y += dt * 0.6;
            camera.getWorldDirection(forward);
            const distance = heldRadius / Math.sin(overlayCamera.fov * Math.PI / 360) * 1.02;
            overlayCamera.position.copy(camera.position);
            overlayCamera.quaternion.copy(camera.quaternion);
            overlayCamera.near = Math.max(0.0005, distance - heldRadius * 2);
            overlayCamera.far = distance + heldRadius * 2;
            holder.position.copy(camera.position).addScaledVector(forward, distance);
        }
        // After the world is drawn (into target, the linear frame, when there is one): the held
        // item over its corner, on a plain backdrop.
        function render(renderer, target) {
            if (!held || !active) return;
            const r = box.getBoundingClientRect(), canvas = renderer.domElement;
            if (!r.width) return;
            overlayCamera.aspect = r.width / r.height;
            overlayCamera.updateProjectionMatrix();
            overlayCamera.updateMatrixWorld();
            const autoClear = renderer.autoClear, clearAlpha = renderer.getClearAlpha();
            renderer.getClearColor(clearColor);
            renderer.setClearColor(backdrop, 1);
            renderer.autoClear = false;
            if (target) {
                const k = target.width / canvas.clientWidth;
                const x = r.left * k, y = (canvas.clientHeight - r.bottom) * k, w = r.width * k, h = r.height * k;
                target.viewport.set(x, y, w, h);
                target.scissor.set(x, y, w, h);
                target.scissorTest = true;
                renderer.setRenderTarget(target);
                renderer.clear(true, true, false);
                renderer.render(overlay, overlayCamera);
                target.viewport.set(0, 0, target.width, target.height);
                target.scissor.set(0, 0, target.width, target.height);
                target.scissorTest = false;
                renderer.setRenderTarget(target);
            } else {
                const y = canvas.clientHeight - r.bottom;
                renderer.setViewport(r.left, y, r.width, r.height);
                renderer.setScissor(r.left, y, r.width, r.height);
                renderer.setScissorTest(true);
                renderer.clear(true, true, false);
                renderer.render(overlay, overlayCamera);
                renderer.setScissorTest(false);
                renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
            }
            renderer.autoClear = autoClear;
            renderer.setClearColor(clearColor, clearAlpha);
        }

        // ---------- taken items ----------
        // The item a mesh belongs to: every mesh of its piece with the same item key (all its levels).
        function recFor(mesh) {
            if (mesh.userData.fakeRec) return mesh.userData.fakeRec;
            const item = mesh.userData.part.item;
            let group = mesh;
            while (group.parent && group.parent !== world) group = group.parent;
            const key = group.id + "|" + item.key;
            let rec = recs.get(key);
            if (rec) return rec;
            const meshes = [];
            group.traverse(o => {
                if (o.isMesh && o.userData.part && o.userData.part.item && o.userData.part.item.key === item.key) meshes.push(o);
            });
            rec = { key, item, group, meshes, saved: meshes.map(m => ({ mesh: m, matrix: m.matrix.clone(), mask: m.layers.mask })), ring: item.kind === "Ring" ? { ability: "NoAbility", thumb: Boolean(item.isThumbRing) } : null };
            recs.set(key, rec);
            return rec;
        }
        // A taken item's meshes: off the drawn layer while held, and no longer moved by their stand-in
        // scripts (web/tickable.js; the Tangle's dagger stops spinning) until game mode starts over.
        const hide = rec => rec.meshes.forEach(m => {
            m.layers.set(HIDDEN);
            m.userData.taken = true;
        });
        const show = rec => rec.saved.forEach(s => (s.mesh.layers.mask = s.mask));
        const centerOf = rec => bounds(rec).getCenter(new THREE.Vector3());
        // Moves an item, keeping its turn, so its center is at point (world).
        function placeAt(rec, point) {
            const delta = new THREE.Matrix4().makeTranslation(point.clone().sub(centerOf(rec)));
            const inverse = new THREE.Matrix4();
            for (const mesh of rec.meshes) {
                mesh.parent.updateMatrixWorld();
                inverse.copy(mesh.parent.matrixWorld).invert();
                mesh.matrix.multiplyMatrices(inverse, delta.clone().multiply(mesh.matrixWorld));
                mesh.updateMatrixWorld(true);
            }
        }
        function hold(rec) {
            hide(rec);
            held = rec;
            showHeld(rec);
            taken(rec);
        }
        function release() {
            held = null;
            hideHeld();
        }
        const ahead = () => camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(DROP_AHEAD).add(camera.position);
        // A tap on the world in game mode that hit an item's mesh: taken, or a red dot if out of reach.
        // Returns false when the hit isn't an item (the tap hops instead).
        function tapHit(hit, x, y) {
            const item = hit.object.userData.part && hit.object.userData.part.item;
            if (!item) return false;
            if (hit.distance > TAKE_REACH) {
                miss(x, y);
                count("game: take out of reach");
                return true;
            }
            const rec = recFor(hit.object);
            if (item.kind === "Dagger") { // collected at once (Ken, 2026-11-08: always)
                if (inventory.daggerCount >= MAX_DAGGERS) {
                    miss(x, y);
                    count("game: third dagger");
                    return notice(null, `You can carry ${MAX_DAGGERS} daggers`) || true;
                }
                hide(rec);
                inventory.daggerCount += 1;
                count("game: collect dagger");
                notice("daggerCount");
                return true;
            }
            if (item.kind === "Firefly" && ctx.inCage && ctx.inCage(hit.object)) return false; // a caged one is the cage's to give
            if (item.kind === "Firefly") { // to the hand crystal, one at a time
                if (inventory.fireflyCount >= CRYSTALS) {
                    miss(x, y);
                    count("game: second firefly");
                    return true;
                }
                hide(rec);
                inventory.fireflyCount += 1;
                count("game: take firefly");
                notice("fireflyCount");
                return true;
            }
            take(rec);
            return true;
        }
        // A taken item leaves its piece's hierarchy for the world (Ken, 2026-11-09: the fire mana on a
        // flamer is taken off it and lives on when the flamer is killed): its meshes move to a group of
        // their own, where they are in the world; they go home when game mode starts over.
        function detach(rec) {
            if (rec.home || rec.fake) return;
            const loose = new THREE.Group();
            loose.matrixAutoUpdate = false;
            world.add(loose);
            world.updateMatrixWorld(true);
            rec.home = rec.meshes.map(m => ({ mesh: m, parent: m.parent }));
            for (const m of rec.meshes) {
                loose.attach(m); // keeps its place in the world (its matrix, then decomposed)
                m.updateMatrix();
                m.userData.fakeRec = rec; // a tap on it later is still this item
            }
            loose.updateMatrixWorld(true);
            rec.origin = rec.group; // the piece it came from (the page knows it by that: amber made on a marker)
            rec.group = loose;
        }
        // Into Hold; a held one goes where this one was (a swap).
        function take(rec) {
            detach(rec);
            if (held) {
                const where = centerOf(rec);
                show(held);
                placeAt(held, where);
                count("game: swap");
            } else count("game: take");
            hold(rec);
        }
        // The held item tapped: a fruit is eaten, a ring put on, a gem at the Gem Station set in a
        // ring; anything else dropped ahead.
        function tapHeld() {
            if (!held) return;
            if (held.item.kind === "Fruit") return eat();
            if (held.item.kind === "Ring") return putOn();
            if (held.item.kind === "Gem" && atGemStation()) return setGem();
            const rec = held;
            release();
            show(rec);
            placeAt(rec, ahead());
            count("game: drop");
        }
        function eat() {
            const points = FRUIT_POINTS[Math.min(FRUIT_POINTS.length - 1, Math.max(0, held.item.power || 0))];
            health = Math.min(1, health + Math.max(1, points) / FRUIT_TO_FULL);
            release();
            count("game: eat");
            notice("health");
        }
        // Swiped left: collected into the inventory, as the other hand's touch collects it in Canopy.
        function collect() {
            if (!held) return;
            const kind = held.item.kind, field = COLLECTS[kind];
            if (kind === "Fruit") return eat();
            if (kind === "Ring") return putOn();
            if (!field) {
                count("game: collect refused");
                return notice(null, `A ${held.item.class || kind} isn't collected in Layout`);
            }
            const amount = kind === "Amber" ? held.item.amberToAdd ?? 1 : kind === "Fuel" ? held.item.fuelSecondsToAdd ?? 60 : 1;
            inventory[field] = (inventory[field] || 0) + amount;
            taken(held);
            release();
            count("game: collect");
            notice(field);
        }

        // ---------- harvesters and cages (Ken, 2026-11-09) ----------
        // A tap on a harvester kills it: the whole piece leaves the world; a guard's cage counts one
        // guard fewer (its stand-in, scripts/Cage.js, turns its sphere dead at none). A tap on a cage
        // with no guards gives its firefly, collected straight to the hand crystal (one at a time); a
        // guarded cage keeps it. All of it comes back when game mode starts over.
        const killed = []; // [{ saved: [{ mesh, mask }] }]
        const guardsLeft = new Map(); // a cage piece -> its guards now
        const guardsOf = piece => (guardsLeft.has(piece) ? guardsLeft.get(piece) : +((/(?:^|, )guards (\d+)/.exec(piece.extra || "") || [])[1] || 0));
        const cageOf = top => (top.userData.tickables || []).find(t => t.name === "Cage") || null;
        function hideGroup(top, meshes) {
            const list = meshes || [];
            if (!meshes) top.traverse(o => { if (o.isMesh) list.push(o); });
            const entry = { saved: list.map(m => ({ mesh: m, mask: m.layers.mask })) };
            killed.push(entry);
            for (const m of list) {
                m.layers.set(HIDDEN);
                m.userData.taken = true;
            }
            return entry;
        }

        // ---------- throwing (Ken, 2026-11-09) ----------
        // Canopy's toss (Hold.cs, Rules): let go, the held item flies at the hand's speed, at most
        // TOSS_CAP (tossSpeedCap, 7 m/s), slowed by drag (tossDragStandard 1: its speed falls e-fold a
        // second, so it goes at most TOSS_CAP / TOSS_DRAG, 7 m); only a gravitic one falls
        // (Interactable.isGravitic: Goop and PartBase, the harvester parts; tools/unity.js item.gravitic),
        // the rest float where they stop, as in Canopy. Layout throws at a double-tapped point
        // (web/app.js): a straight one at the speed that stops it there, if that's in reach; a falling
        // one aimed to come down there, or, nothing tapped, along the tap at full speed (a guess). It
        // stops where it meets anything (ctx.cast), and stays, an item like any dropped one. Gravity
        // is Canopy's (ProjectSettings/DynamicsManager.asset: 3 m/s2; ctx.gravity, which must be given).
        const TOSS_CAP = 7, TOSS_DRAG = 1, STEP = 1 / 60;
        const gravity = () => ctx.gravity();
        let flight = null;
        const stepFlight = (pos, velocity, falls, dt) => {
            velocity.multiplyScalar(Math.exp(-TOSS_DRAG * dt));
            if (falls) velocity.y -= gravity() * dt;
            pos.addScaledVector(velocity, dt);
        };
        // the launch, at full speed, whose path comes nearest target (Canopy's player just throws;
        // Layout aims for them)
        function aimFalling(from, target) {
            const flat = new THREE.Vector3(target.x - from.x, 0, target.z - from.z);
            if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
            flat.normalize();
            let best = null, nearest = Infinity;
            for (let degrees = -80; degrees <= 80; degrees += 1) {
                const a = degrees * Math.PI / 180;
                const v = flat.clone().multiplyScalar(Math.cos(a) * TOSS_CAP).setY(Math.sin(a) * TOSS_CAP);
                const pos = from.clone(), vel = v.clone();
                for (let t = 0; t < 4; t += STEP) {
                    stepFlight(pos, vel, true, STEP);
                    const d = pos.distanceTo(target);
                    if (d < nearest) { nearest = d; best = v; }
                    if (pos.y < target.y - 2 && vel.y < 0) break;
                }
            }
            return best;
        }
        // from: where it leaves the hand; target: the point tapped (null: none); dir: the tap's ray
        function throwHeld(from, target, dir) {
            if (!held) return false;
            const rec = held;
            release();
            show(rec);
            placeAt(rec, from);
            const radius = Math.min(0.5, bounds(rec).getSize(new THREE.Vector3()).length() / 2);
            const falls = Boolean(rec.item.gravitic);
            let velocity;
            if (falls) velocity = target ? aimFalling(from, target) : dir.clone().normalize().multiplyScalar(TOSS_CAP);
            else {
                const way = target ? target.clone().sub(from) : dir.clone();
                const reach = target ? Math.max(0, way.length() - radius) : Infinity;
                velocity = way.normalize().multiplyScalar(Math.min(TOSS_CAP, reach * TOSS_DRAG));
            }
            flight = { rec, pos: from.clone(), velocity, falls, radius, t: 0 };
            count("game: throw");
            return true;
        }
        // each frame: the thrown item on its way, stopping where it meets something (back off it by
        // its size), when it all but stops, or (falling) after 10 s
        function fly(dt) {
            const f = flight;
            for (let left = Math.min(dt, 0.1); left > 1e-6 && flight; left -= STEP) {
                const h = Math.min(STEP, left), was = f.pos.clone();
                stepFlight(f.pos, f.velocity, f.falls, h);
                f.t += h;
                const hit = ctx.cast && ctx.cast(was, f.pos, f.rec.meshes);
                if (hit) {
                    const back = f.pos.clone().sub(was).normalize();
                    f.pos.copy(hit.point).addScaledVector(hit.normal || back.negate(), f.radius);
                    flight = null;
                } else if ((!f.falls && f.velocity.length() < 0.05) || f.t > 10) flight = null;
            }
            placeAt(f.rec, f.pos);
            if (!flight) count("game: thrown item came to rest");
        }

        // ---------- the empowered dagger (Ken, 2026-11-09; Canopy doesn't do it yet) ----------
        // Stabbing mana empowers the dagger with its element (a new one replaces the last): fire, air or
        // water; its icon radiates red, white or blue. Fire lets one stab on red armor do a point of
        // damage, and is used up (app.js). Mana mounted on a harvester (the flamers' fire mana) is
        // stabbed by a tap within reach: true when it was (the page hides it), false with no dagger.
        function empower(element) {
            inventory.empowered = element;
            count("game: empower " + element);
            notice("daggerCount");
        }
        // An item the page made (the ManaFire for a flamer's mana, app.js), into Hold: by any of its meshes.
        function holdMade(mesh) {
            take(recFor(mesh));
        }
        // The held item's look, for a vacancy's match (Tenant.HasSameLod0Mesh): its most detailed mesh,
        // as "<asset path>|<mesh name>" (tools/scene.js meshId); null holding nothing.
        function heldMeshId() {
            if (!held) return null;
            const first = held.meshes.find(m => !m.userData.lod || m.userData.lod.levels.includes(0)) || held.meshes[0];
            const mesh = first && first.userData.part && first.userData.part.mesh;
            if (!mesh) throw new Error("the held item's mesh has no description (part.mesh)");
            return `${mesh.path || ""}|${mesh.name || ""}`;
        }
        // The held item used up (a tenant into its vacancy): gone from Hold and the world.
        function useHeld() {
            release();
            count("game: tenant placed");
        }
        // Held mana pressed a second: stabbed (Ken, 2026-11-09: you can hold mana, drop it, collect it,
        // and stab it): the dagger empowered, the mana gone; a red dot with no dagger.
        function stabHeld() {
            const element = held && MANA_ELEMENT[held.item.class];
            if (!element) return false;
            if (inventory.daggerCount < 1) {
                missHeld("No dagger to stab it with");
                return true;
            }
            release(); // used up: its meshes stay out of the world
            empower(element);
            return true;
        }
        // fire, used up on red armor: true when the dagger was fire-empowered
        function useFire() {
            if (inventory.empowered !== "fire") return false;
            inventory.empowered = null;
            notice("daggerCount");
            return true;
        }

        // ---------- payments (Ken, 2026-11-09) ----------
        // A tap on a payment marker (Payment.cs's emptyVisual, an amber's ghost) within reach pays its
        // value from the player's amber: "paid" (the page makes the amber there and counts it toward
        // the payee, app.js), true when there isn't enough (a red dot, as OnTooPoor), false when out of
        // reach (the tap hops). The page hears when an item is taken (ctx.onTaken: its amber taken back
        // off a marker).
        function pay(value, hit, x, y) {
            if (hit.distance > TAKE_REACH) return false;
            if ((inventory.amberAmount || 0) < value) {
                miss(x, y);
                count("game: too poor");
                notice(null, `Too poor: ${value} amber needed`);
                return true;
            }
            inventory.amberAmount -= value;
            count("game: pay");
            notice("amberAmount");
            return "paid";
        }
        const taken = rec => { if (rec && ctx.onTaken) ctx.onTaken(rec.origin || rec.group); };

        // meshes: the harvester's, when it is one unit of an assemblage (null: all of top's)
        function kill(top, piece, hit, x, y, meshes) {
            if (hit.distance > TAKE_REACH) {
                miss(x, y);
                count("game: kill out of reach");
                return true;
            }
            hideGroup(top, meshes || null);
            count("game: kill");
            const cage = piece.guarding && ctx.objectOfPath && ctx.objectOfPath(piece.guarding);
            if (cage) {
                const left = Math.max(0, guardsOf(cage.userData.piece) - 1);
                guardsLeft.set(cage.userData.piece, left);
                const stand = cageOf(cage);
                if (stand) stand.params.guards = left;
                notice(null, left ? `${piece.name} down: ${left} guard${left > 1 ? "s" : ""} left on its cage` : `${piece.name} down: its cage is unguarded`);
            } else notice(null, `${piece.name} down`);
            return true;
        }
        // A cage gives its firefly to a tap within reach once nothing guards it (to the hand crystal,
        // one at a time: a red dot on a second). Guarded, empty or farther, the tap is any other (Ken,
        // 2026-11-09: it hops to the cage): false.
        const fliesIn = (top, meshes) => {
            const isFly = o => o.isMesh && !o.userData.taken && o.userData.part && o.userData.part.item && o.userData.part.item.kind === "Firefly";
            const fly = [];
            if (meshes) fly.push(...meshes.filter(isFly));
            else top.traverse(o => { if (isFly(o)) fly.push(o); });
            return fly;
        };
        const cageGives = (top, piece, hit, meshes) => hit.distance <= TAKE_REACH && guardsOf(piece) === 0 && fliesIn(top, meshes).length > 0;
        function tapCage(top, piece, hit, x, y, meshes) {
            if (!cageGives(top, piece, hit, meshes)) return false;
            if (inventory.fireflyCount >= CRYSTALS) {
                miss(x, y);
                count("game: second firefly");
                return true;
            }
            hideGroup(top, fliesIn(top, meshes));
            inventory.fireflyCount = 1;
            count("game: firefly from cage");
            notice("fireflyCount");
            return true;
        }
        function restoreKills() {
            for (const k of killed) for (const sv of k.saved) {
                sv.mesh.layers.mask = sv.mask;
                delete sv.mesh.userData.taken;
            }
            killed.length = 0;
            for (const piece of guardsLeft.keys()) {
                const top = ctx.objectOfPath && ctx.objectOfPath(piece.path);
                const stand = top && cageOf(top);
                if (stand) stand.params.guards = +((/(?:^|, )guards (\d+)/.exec(piece.extra || "") || [])[1] || 0);
            }
            guardsLeft.clear();
        }

        // ---------- rings ----------
        // A red dot on the held item (in its corner), a moment: it can't go where it was sent.
        function missHeld(text) {
            const r = box.getBoundingClientRect();
            miss(r.left + r.width / 2, r.top + r.height / 2);
            if (text) notice(null, text);
        }
        // The held ring onto the first free finger (a thumb ring the first free thumb).
        function putOn() {
            const thumb = Boolean(held.ring && held.ring.thumb);
            const digit = fingers.findIndex((f, d) => !f && isThumb(d) === thumb);
            if (digit < 0) return missHeld(`No free ${thumb ? "thumb" : "finger"} for this ring`);
            return wear(digit);
        }
        // The held gem into the first open ring worn (Gem.PutIntoRingAndDie): the ring takes its
        // ability and color, and the gem is gone.
        function setGem() {
            const digit = fingers.findIndex(f => f && f.ability === OPEN);
            if (digit < 0) {
                count("game: no open ring");
                return missHeld("No open ring");
            }
            const gem = held.item, ability = (ff && ff.abilities && ff.abilities[gem.abilityId]) || String(gem.abilityId ?? "Gem");
            const ring = { ...fingers[digit], id: gem.abilityId, ability, ...(gem.color ? { color: gem.color } : {}) };
            if (ring.rec) ring.rec.ring = { ...ring.rec.ring, id: ring.id, ability, color: ring.color };
            fingers[digit] = ring;
            release(); // the gem stays out of the world
            count("game: set gem");
            notice("rings");
        }
        // A ring of the fast-forward config, taken off a finger: a plain ring of its gem's color, about
        // the size rings are in the world (larger than on a finger, IcRingPlacement.scaleWhenOn).
        function fakeRing(ring) {
            const color = ring.color ? new THREE.Color().setRGB(ring.color[0], ring.color[1], ring.color[2], THREE.SRGBColorSpace) : new THREE.Color(0xd9d9d9);
            const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.016, 12, 32), new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.35 }));
            mesh.matrixAutoUpdate = false;
            mesh.matrix.makeTranslation(ahead());
            scene.add(mesh);
            mesh.updateMatrixWorld(true);
            const item = { kind: "Ring", key: "fake" + ++fakeCount, ...(ring.thumb ? { isThumbRing: 1 } : {}) };
            mesh.userData.part = { item };
            const rec = { key: item.key, item, group: mesh, meshes: [mesh], saved: [{ mesh, matrix: mesh.matrix.clone(), mask: mesh.layers.mask }], fake: true, ring };
            mesh.userData.fakeRec = rec;
            fakes.push(mesh);
            return rec;
        }
        function wear(digit) {
            const rec = held, ring = rec.ring || { ability: "NoAbility" };
            if (Boolean(ring.thumb) !== isThumb(digit)) return notice(null, ring.thumb ? "A thumb ring goes on a thumb" : "A finger ring goes on a finger");
            const off = fingers[digit];
            fingers[digit] = { ...ring, rec };
            release();
            if (off) hold(off.rec || fakeRing(off));
            count("game: wear ring");
            notice("rings");
        }
        function tapFinger(digit, button) {
            if (held) {
                if (held.item.kind !== "Ring") {
                    const r = button.getBoundingClientRect();
                    miss(r.left + r.width / 2, r.top + r.height / 2);
                    return notice(null, "Only a ring goes on a finger");
                }
                return wear(digit);
            }
            const ring = fingers[digit];
            if (!ring) return;
            fingers[digit] = null;
            hold(ring.rec || fakeRing({ ...ring, thumb: isThumb(digit) }));
            count("game: take off ring");
            render_();
        }

        // ---------- the display ----------
        const stageId = () => (ff && stageName && stageName in ff.stages ? ff.stages[stageName] : 0); // its number: configs are by number
        const stageRank = name => Math.max(0, ff && name ? ff.order.indexOf(name) : 0); // its place in the order played
        const ringsWorn = () => fingers.filter(Boolean).length;
        function valueOf(field) {
            if (field === "health") return `${Math.round(health * 100)}%`;
            if (field === "rings") return String(ringsWorn());
            const v = inventory[field] || 0;
            if (field === "fuelDuration") return `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`;
            return String(Math.floor(v));
        }
        function shown(field) {
            if (field === "health") return stageRank(stageName) > 0; // Player.ApplyInitialSettings: after the Tutorial
            if (field === "amberAmount") return true;
            if (field === "mana") return stageRank(stageName) >= stageRank("Tangle") || inventory.mana > 0;
            if (field === "fuelDuration") return inventory.thrusterCount > 0;
            return (inventory[field] || 0) > 0;
        }
        // a field's icons: one per dagger or firefly (the empowered dagger's radiating), else the icon and its number
        function iconsOf(field) {
            if (!BY_ICON.has(field)) return `${ICONS[field]}<span>${valueOf(field)}</span>`;
            const n = Math.max(0, Math.floor(inventory[field] || 0));
            return Array.from({ length: n }, (_, i) => (field === "daggerCount" && i === 0 && inventory.empowered ? `<span class="empowered ${inventory.empowered}">${ICONS[field]}</span>` : ICONS[field])).join("");
        }
        // daggers and fireflies carried show whether or not the display is on (Ken, 2026-11-09)
        const countHtml = field => `<div class="count${BY_ICON.has(field) ? " always" : ""}" data-field="${field}">${iconsOf(field)}</div>`;
        const ringSvg = ring => (ring
            ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="#d9d9d9" stroke-width="3.2"/></svg>' // plain (Ken, 2026-11-09); its ability is the button's title
            : `<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="#9aa3b2" stroke-width="1.6"/></svg>`);
        function render_() {
            $("hudCounts").innerHTML = ["health", "amberAmount", "mana", "fuelDuration", "thrusterCount", "boosterCount", "daggerCount", "headlampCount", "fireflyCount"].filter(shown).map(countHtml).join("");
            const hand = (from) => `<div class="hand">${fingers.slice(from, from + 5).map((ring, i) => `<button data-digit="${from + i}" title="${DIGITS[from + i]}${ring ? `: ${ring.ability}` : ""}">${ringSvg(ring)}</button>`).join("")}</div>`;
            $("hudRings").innerHTML = hand(0) + hand(5);
            for (const b of $("hudRings").querySelectorAll("button")) b.onclick = () => tapFinger(+b.dataset.digit, b);
            document.body.classList.toggle("hud", display);
        }
        // A collected item's count, a moment at the top (and its display line pulses); text: a message.
        let toastTimer = 0;
        function notice(field, text) {
            render_();
            toast.innerHTML = field ? iconsOf(field) || `${ICONS[field]}<span>0</span>` : `<span>${text}</span>`;
            toast.classList.add("show");
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toast.classList.remove("show"), 1500);
            const line = field && $("hudCounts").querySelector(`[data-field="${field}"]`);
            if (line) line.classList.add("pulse");
        }
        // A tap out of reach (too far to take, or to hop to): a red dot there, a moment.
        function miss(x, y) {
            const dot = document.createElement("div");
            dot.className = "missDot";
            dot.style.left = x + "px";
            dot.style.top = y + "px";
            document.body.appendChild(dot);
            setTimeout(() => dot.remove(), 700);
        }

        // The held box: a tap drops (or eats), a swipe left collects.
        let press = null;
        box.addEventListener("pointerdown", e => {
            e.preventDefault();
            try {
                box.setPointerCapture(e.pointerId);
            } catch {
                // a synthetic pointer (lens/drive.js) can't be captured
            }
            press = { x: e.clientX, y: e.clientY };
            // pressed a second, held mana is stabbed (and the press does nothing more)
            const mine = press;
            setTimeout(() => {
                if (press === mine && stabHeld()) press = null;
            }, STAB_PRESS);
        });
        box.addEventListener("pointerup", e => {
            if (!press) return;
            const dx = e.clientX - press.x, dy = e.clientY - press.y;
            press = null;
            if (dx < -Math.max(30, box.clientWidth * 0.3) && Math.abs(dy) < Math.abs(dx)) collect();
            else if (Math.hypot(dx, dy) < 12) tapHeld();
        });
        box.addEventListener("pointercancel", () => (press = null));

        // ---------- starting over ----------
        // Every taken item back where it was, the fake rings gone, the inventory and fingers from the
        // stage's FastForwardConfig, full health.
        function reset() {
            flight = null;
            restoreKills();
            for (const rec of recs.values()) {
                for (const h of rec.home || []) {
                    h.parent.add(h.mesh);
                    delete h.mesh.userData.fakeRec;
                }
                if (rec.home) {
                    rec.group.removeFromParent();
                    rec.group = rec.origin;
                }
                for (const s of rec.saved) {
                    s.mesh.matrix.copy(s.matrix);
                    s.mesh.layers.mask = s.mask;
                    s.mesh.matrixWorldNeedsUpdate = true;
                    delete s.mesh.userData.taken;
                }
            }
            recs.clear();
            for (const mesh of fakes) {
                scene.remove(mesh);
                mesh.geometry.dispose();
                mesh.material.dispose();
            }
            fakes.length = 0;
            release();
            const config = ff && ff.configs[stageId()];
            inventory = { ...ZERO };
            for (const k of Object.keys(ZERO)) if (config && typeof config.inventory[k] === "number") inventory[k] = config.inventory[k];
            fingers = new Array(10).fill(null).map((f, d) => {
                const ring = config && config.rings[d];
                return ring ? { ...ring, thumb: isThumb(d) } : null;
            });
            health = 1;
            render_();
            if (ctx.onReset) ctx.onReset(); // the page's own game state (portals paid, amber made) starts over
        }
        // The fast-forward data (tools/conditions.js fastForward) and the stage the game starts in.
        function configure(data, stage) {
            ff = data || null;
            stageName = stage || null;
            reset();
        }
        function setActive(on) {
            active = on;
            reset();
        }
        function toggleDisplay() {
            display = !display;
            try {
                localStorage.setItem("layout.gameDisplay", display ? "1" : "0");
            } catch {
                // storage blocked: not remembered
            }
            render_();
            return display;
        }
        const isItem = mesh => Boolean(mesh && mesh.userData.part && mesh.userData.part.item);
        return { heldMeshId, useHeld, throwHeld, flying: () => Boolean(flight), kill, pay, holdMade, hideGroup, stabHeld, useFire, tapCage, cageGives, tapHit, tapHeld, collect, tapFinger, miss, frame, render, reset, configure, setActive, toggleDisplay, isItem, extras: () => fakes, displayOn: () => display, inventory: () => ({ ...inventory, health, held: held && held.item.kind, fingers: fingers.map(f => f && f.ability) }), TAKE_REACH };
    }

    const CanopyPlay = { create };
    if (typeof module === "object" && module.exports) {
        module.exports = CanopyPlay;
    } else {
        root.CanopyPlay = CanopyPlay;
    }
})(typeof window !== "undefined" ? window : globalThis);
