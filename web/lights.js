// Canopy's lights in the page (More Lights phase 4; Claude, 2026-11-08): what Canopy's
// CanopyLights.cs does in the game, so lights can be judged on the phone. Unity's point and spot
// Lights (each piece's `lights`, from tools/unity.js: color, intensity, range, culling mask, a
// spot's angles and direction), sorted Canopy's way (Ken, 2026-11-08: no harm in using Unity's
// point lights, sorted our own way; spots too): the 31 nearest the camera (by how far past its range each is) fill the
// shared arrays, slot 0 black; each mesh lit as Canopy/General is gets the four that light it most
// (each one's brightness at the nearest point of the mesh's bounds), only lights whose culling mask
// has the mesh's layer (the ForLighting layer's dedicated lights light only it), as canopyLights:
// four slots, each its light's index plus 0.99 times its weight. Unlike the game, no fading here:
// weights are 1. As in the game, a LOD group's levels are one object with one list (Ken, 2026-11-08:
// they occupy the same space), measured over all its levels. Spread out, as in the game (Ken, 2026-11-08: a few every frame): the lights are
// chosen four times a second, each keeping its slot while it stays; a cursor walks the lit meshes,
// PER_FRAME a frame; positions go up every frame. A light's color is made linear, then times its
// intensity, as the sun's.
// Loaded as a plain script in the browser (window.CanopyLights).
(function (root) {
    const MAX = 32; // CANOPY_LIGHTS in Canopy's CanopyLighting.cginc
    const SLOTS = 4;
    const LIGHTS_EVERY = 250; // ms between choosing the lights
    const PER_FRAME = 250; // meshes whose four are redone each frame

    function create(THREE) {
        const pos = Array.from({ length: MAX }, () => new THREE.Vector4());
        const color = Array.from({ length: MAX }, () => new THREE.Vector4());
        const spot = Array.from({ length: MAX }, () => new THREE.Vector4(0, 0, 0, -1));
        const forward = new THREE.Vector3();
        // shared by every material lit as General (web/app.js generalLight)
        const uniforms = {
            canopyLightPos: { value: pos }, // view space, w: 1 / range squared
            canopyLightColor: { value: color }, // linear color times intensity; a: 1 / (cos inner - cos outer)
            canopyLightSpot: { value: spot }, // a spot's forward (view space) and cos of its outer half angle; a point 0, 0, 0, -1
            canopyLightCount: { value: SLOTS }, // ☰ Light › Lights: 4, or 0 off
            canopyLightView: { value: 0 } // ☰ Light › Light crowding: color by how many lights reach
        };
        const slots = new Array(MAX).fill(null); // [index] -> a light (1..31), each keeping its slot while chosen
        const tracked = []; // objects lit as General, as they load: { group, meshes, lights }, a LOD group's levels one object
        const lodObjects = new Map(); // "<group id>|<LOD key>" -> its object
        let cursor = 0;
        let last = -1e9;
        const box = new THREE.Box3(), near = new THREE.Vector3(), sphere = new THREE.Sphere();
        const luminance = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

        // Every point Light of the shown pieces, in Three's world.
        function gather(groups) {
            const out = [];
            for (const g of groups) {
                const ls = g.userData.lights;
                if (!ls || !g.visible) continue;
                for (let k = 0; k < ls.length; k++) {
                    const l = ls[k];
                    const c = new THREE.Color().setRGB(l.color[0], l.color[1], l.color[2], THREE.SRGBColorSpace);
                    const cone = l.spot ? { outerHalf: l.spot[0] * Math.PI / 360, cosOuter: Math.cos(l.spot[0] * Math.PI / 360), scale: 1 / Math.max(Math.cos(l.spot[1] * Math.PI / 360) - Math.cos(l.spot[0] * Math.PI / 360), 1e-4) } : null;
                    out.push({ key: g.id + ":" + k, local: new THREE.Vector3(-l.at[0], l.at[1], l.at[2]), localDir: l.dir ? new THREE.Vector3(-l.dir[0], l.dir[1], l.dir[2]) : null, dir: new THREE.Vector3(), cone, group: g, at: new THREE.Vector3(), range: l.range, mask: l.mask, color: c, intensity: l.intensity, brightness: luminance(c) * l.intensity });
                }
            }
            for (const l of out) place(l);
            return out;
        }

        // A light's place and (a spot's) direction in Three's world.
        function place(l) {
            l.at.copy(l.local).applyMatrix4(l.group.matrixWorld);
            if (l.localDir) l.dir.copy(l.localDir).transformDirection(l.group.matrixWorld);
        }

        // How much of a spot's cone reaches a sphere: its falloff at the edge of the sphere nearest
        // its axis; full when the sphere holds the light (CanopyLights.cs Cone).
        function coneAt(l, center, radius) {
            near.copy(center).sub(l.at);
            const dist = near.length();
            if (dist <= radius) return 1;
            const toCenter = Math.acos(Math.min(1, Math.max(-1, near.dot(l.dir) / dist)));
            const nearest = Math.max(0, toCenter - Math.asin(Math.min(1, radius / dist)));
            if (nearest >= l.cone.outerHalf) return 0;
            return Math.min(1, Math.max(0, (Math.cos(nearest) - l.cone.cosOuter) * l.cone.scale));
        }

        // A mesh's layer, for the culling masks: its part's (tools/unity.js), else Default.
        const layerOf = mesh => (mesh.userData.part && mesh.userData.part.layer) || 0;

        // The 31 lights nearest the camera; one already in a slot keeps it.
        function chooseLights(camera, groups) {
            const eye = camera.position;
            const lights = gather(groups);
            lights.sort((a, b) => Math.max(0, a.at.distanceTo(eye) - a.range) - Math.max(0, b.at.distanceTo(eye) - b.range));
            const chosen = new Map(lights.slice(0, MAX - 1).map(l => [l.key, l]));
            for (let i = 1; i < MAX; i++) {
                const kept = slots[i] && chosen.get(slots[i].key);
                slots[i] = kept || null;
                if (kept) chosen.delete(kept.key);
            }
            for (const l of chosen.values()) {
                const free = slots.indexOf(null, 1);
                if (free < 0) break;
                slots[free] = l;
            }
        }

        // One mesh's four: the lights brightest at its sphere, among those whose culling mask has its
        // layer. Its sphere, as the game's: its bounds' center, the radius halfway between the sphere
        // inside them (the smallest half extent) and the one around them (half the diagonal).
        // Every level, shown or not, so a LOD level that switches in is lit (Ken, 2026-11-08: the altar
        // under the dagger went dark while the camera moved).
        const levelBox = new THREE.Box3();
        function listFor(object) {
            const best = []; // [index, score]
            {
                box.makeEmpty();
                for (const mesh of object.meshes) {
                    const geometry = mesh.geometry;
                    if (!geometry.boundingBox) geometry.computeBoundingBox();
                    box.union(levelBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
                }
                box.getCenter(sphere.center);
                box.getSize(near);
                sphere.radius = 0.25 * (Math.min(near.x, near.y, near.z) + near.length());
                const layerBit = 1 << layerOf(object.meshes[0]);
                for (let i = 1; i < MAX; i++) {
                    const l = slots[i];
                    if (!l || (l.mask & layerBit) === 0) continue;
                    const past = Math.max(0, sphere.center.distanceTo(l.at) - sphere.radius);
                    const x = (past * past) / (l.range * l.range);
                    if (x >= 1) continue;
                    const cone = l.cone ? coneAt(l, sphere.center, sphere.radius) : 1;
                    if (cone <= 0) continue;
                    best.push([i, cone * l.brightness * Math.min(1, Math.max(0, (1 - x) * 5)) / (1 + 25 * x)]);
                }
                if (best.length > 1) best.sort((a, b) => b[1] - a[1]);
            }
            const packed = k => (best[k] ? best[k][0] + 0.99 : 0);
            object.lights.set(packed(0), packed(1), packed(2), packed(3));
        }

        // A share of the meshes: PER_FRAME of them, those no longer in the scene dropped.
        function walk() {
            for (let n = Math.min(PER_FRAME, tracked.length); n > 0 && tracked.length; n--) {
                if (cursor >= tracked.length) cursor = 0;
                const object = tracked[cursor];
                if (!object.group.parent) { // its piece left the scene
                    if (object.key) lodObjects.delete(object.key);
                    tracked[cursor] = tracked[tracked.length - 1];
                    tracked.pop();
                    continue;
                }
                listFor(object);
                cursor++;
            }
        }

        // Each frame: the lights chosen every LIGHTS_EVERY ms, a share of the lists, the lights' places
        // (in view space) and colors.
        function update(now, camera, groups) {
            if (now - last >= LIGHTS_EVERY) {
                last = now;
                chooseLights(camera, groups);
            }
            walk();
            for (let i = 1; i < MAX; i++) {
                const l = slots[i];
                if (!l) {
                    color[i].set(0, 0, 0, 0);
                    continue;
                }
                place(l);
                near.copy(l.at).applyMatrix4(camera.matrixWorldInverse);
                pos[i].set(near.x, near.y, near.z, 1 / (l.range * l.range));
                color[i].set(l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity, l.cone ? l.cone.scale : 1);
                if (l.cone) {
                    forward.copy(l.dir).transformDirection(camera.matrixWorldInverse);
                    spot[i].set(forward.x, forward.y, forward.z, l.cone.cosOuter);
                } else spot[i].set(0, 0, 0, -1);
            }
        }

        // A mesh drawn with General's lighting: its own four, handed to each of its materials as it draws.
        // group: the piece it is drawn in; a LOD level (userData.lod) joins its group's other levels.
        function track(mesh, group) {
            if (mesh.userData.canopyLights) return;
            const lod = mesh.userData.lod;
            const key = lod ? group.id + "|" + lod.key : null;
            let object = key && lodObjects.get(key);
            if (object) object.meshes.push(mesh);
            else {
                object = { group, key, meshes: [mesh], lights: new THREE.Vector4() };
                if (key) lodObjects.set(key, object);
                tracked.push(object);
            }
            mesh.userData.canopyLights = object.lights; // shared by its levels
            mesh.onBeforeRender = (renderer, scene, camera, geometry, material) => {
                const u = material && material.userData.canopyLights;
                if (u && !u.value.equals(mesh.userData.canopyLights)) {
                    u.value.copy(mesh.userData.canopyLights);
                    material.uniformsNeedUpdate = true;
                }
            };
        }

        const count = () => slots.filter(Boolean).length;
        return { uniforms, update, track, count, MAX, SLOTS };
    }

    const CanopyLights = { create };
    if (typeof module === "object" && module.exports) {
        module.exports = CanopyLights;
    } else {
        root.CanopyLights = CanopyLights;
    }
})(typeof window !== "undefined" ? window : globalThis);
