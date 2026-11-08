// Scripts (Ken, 2026-10-29): code attached to a piece, as a Unity MonoBehaviour is to a game
// object, run on the Ticker while the piece is in the scene. A script is a class derived from
// Tickable, in a file named for it that registers it:
//   Tickable.register("WaterScroller", class extends Tickable { start() {} tick(dt) {} stop() {} });
// They come two ways: a layout prefab's "- Script: <file> | settings" lines (layout/prefabs/), and
// the C# scripts of a Unity prefab that have a JS stand-in, layout/scripts/<ClassName>.js, which
// gets the script's saved fields. Each instance has:
//   THREE, camera, scene; group (the Three.js group of its piece, or of the prefab it sits in);
//   top (the scene piece's object); piece; params (the class's static params, then the script
//   line's settings, then the piece's); fields (a stand-in's saved C# fields, else {}); object
//   (a stand-in's game object key); environment() (unity.json's, as the scene has it); leafWind()
//   (the leaf wind's shader uniforms, app.js windPatch, for LeafGust and Wind); windLevels() (☰ View's
//   wind and gust levels and kind);
//   texture(description, srgb) (a material's texture, a promise); describe(guid) (a material's
//   description, tools/scene.js); textures() (whether ☰ View ▸ Textures is on); eye (the camera in this.space's
//   coordinates, once makeSpace has made one).
// A class with static singleton = true runs once: a second piece with it is hidden and its scripts
// stopped (the first loaded wins; a scene's included pieces load before its own).
(function (root) {
    const classes = new Map(), loading = new Map();
    const running = new Set(), singletons = new Map();
    let world = null; // { THREE, scene, camera, environment, leafWind, texture, material, describe, textures }, from app.js (Tickable.use)

    class Tickable {
        static params = {};
        static singleton = false;
        start() {}
        tick(dt) {}
        stop() {}
        // A group to draw in, in Unity coordinates: the piece's own (scaled with it), or world's.
        makeSpace(inWorld = false) {
            const space = new this.THREE.Group();
            space.scale.x = -1; // Three.js's X is Unity's mirrored (web/space.js)
            (inWorld ? this.scene : this.group).add(space);
            this.space = space;
            this.updateEye();
            return space;
        }
        updateEye() {
            if (!this.space) return;
            this.space.updateWorldMatrix(true, false);
            this.eye.copy(this.camera.position);
            this.space.worldToLocal(this.eye);
        }
        // A random point the camera sees, near to far meters off, in this.space's coordinates.
        inView(near, far) {
            const THREE = this.THREE, camera = this.camera;
            const through = new THREE.Vector3((Math.random() * 2 - 1) * 0.9, (Math.random() * 2 - 1) * 0.9, 0.5).unproject(camera);
            const at = through.sub(camera.position).normalize().multiplyScalar(near + Math.random() * (far - near)).add(camera.position);
            return this.space.worldToLocal(at);
        }
        // Stand-ins: the prefab this script sits in, placed at the world's origin as Unity places a
        // scene's root prefab, out of its piece (so it isn't picked up, snapped to or framed; the
        // piece itself stays where it is), until the script stops.
        toWorld() {
            const p = this.prefab;
            if (p.inWorld) return;
            p.inWorld = true;
            this.group.matrix.identity();
            this.scene.add(this.group);
        }
        // Stand-ins: a game object (by key or { ref }) and its saved details, or null.
        objectOf(ref) {
            const key = ref && ref.ref !== undefined ? ref.ref : ref;
            return (this.prefab.objects || {})[key] ? { key, ...this.prefab.objects[key] } : null;
        }
        // Stand-ins: the script instance of a component (by { ref }) in the same prefab, or null.
        componentOf(ref) {
            return (ref && this.prefab.components.get(ref.ref)) || null;
        }
        // Stand-ins: the meshes drawn for a game object (by key or { ref }) and everything under it.
        meshesUnder(ref) {
            const o = this.objectOf(ref), objects = this.prefab.objects || {};
            if (!o) return [];
            return this.group.children.filter(mesh => {
                for (let k = mesh.userData.part && mesh.userData.part.go; k; k = objects[k] && objects[k].father) if (k === o.key) return true;
                return false;
            });
        }
        // Stand-ins: draws a game object and everything under it in a Unity material (by guid; the
        // scene brings materials stand-ins' fields name), as RemapAllOwnedMaterials does: it sets
        // sharedMaterial, the first slot, and a mesh's other slots stay.
        useMaterial(ref, guid) {
            const m = guid && world.material(guid);
            if (!m) return;
            const first = now => (Array.isArray(now) ? [m, ...now.slice(1)] : m);
            for (const mesh of this.meshesUnder(ref)) {
                if (mesh.userData.untinted) mesh.userData.untinted = first(mesh.userData.untinted); // LOD tint is showing: put back to this
                else if ([mesh.material].flat()[0] !== m) mesh.material = first(mesh.material);
            }
        }
        // Stand-ins: moves a game object and everything under it by offset (Unity meters, from
        // where the prefab put it), as setting its transform's position would.
        offset(ref, by) {
            const o = this.objectOf(ref);
            if (o) (this.prefab.moves[o.key] = this.prefab.moves[o.key] || {}).offset = by;
        }
        // Stand-ins: turns a game object and everything under it about its own origin by degrees
        // (from where the prefab put it), about axis ([x, y, z], Unity's) in its own axes, or the
        // prefab's with world, as Transform.Rotate does.
        turn(ref, axis, degrees, world = false) {
            const o = this.objectOf(ref);
            if (!o) return;
            const THREE = this.THREE, a = new THREE.Vector3(...axis);
            if (!world) a.applyQuaternion(savedRotation(o));
            (this.prefab.moves[o.key] = this.prefab.moves[o.key] || {}).rot = new THREE.Quaternion().setFromAxisAngle(a.normalize(), degrees * Math.PI / 180);
        }
        // Stand-ins: a game object's rotation now, in the prefab's axes (Unity's), as a quaternion.
        rotationOf(ref) {
            const o = this.objectOf(ref);
            if (!o) return new this.THREE.Quaternion();
            const mv = this.prefab.moves[o.key];
            return turnsAbove(this.prefab, o.key).multiply(mv && mv.rot ? mv.rot : new this.THREE.Quaternion()).multiply(savedRotation(o));
        }
        // Stand-ins: points a game object (and what's under it) to rotation q, in the prefab's axes,
        // as setting transform.rotation does.
        orient(ref, q) {
            const o = this.objectOf(ref);
            if (!o) return;
            const rot = turnsAbove(this.prefab, o.key).invert().multiply(q).multiply(savedRotation(o).invert());
            (this.prefab.moves[o.key] = this.prefab.moves[o.key] || {}).rot = rot;
        }
        // Stand-ins: whether a LODGroup level ({ key, levels }, as a part's lod) is the one drawn now;
        // true while the page hasn't chosen one yet, or without a group.
        lodShowing(lod) {
            if (!lod) return true;
            const top = this.top;
            (top.userData.lodWatch = top.userData.lodWatch || new Set()).add(lod.key);
            const level = top.userData.lodChosen && top.userData.lodChosen[lod.key];
            return level === undefined || (level >= 0 && lod.levels.includes(level));
        }
        // Stand-ins: how far a game object's origin is from the camera now, in meters.
        distanceToCamera(ref) {
            const p = this.positionOf(ref);
            this.group.updateWorldMatrix(true, false);
            return this.group.localToWorld(new this.THREE.Vector3(-p.x, p.y, p.z)).distanceTo(this.camera.position); // Three.js's X is Unity's mirrored
        }
        // Stand-ins: where a game object's origin is now, in the prefab's axes (Unity's).
        positionOf(ref) {
            const o = this.objectOf(ref);
            if (!o) return new this.THREE.Vector3();
            return new this.THREE.Vector3(o.m[3], o.m[7], o.m[11]).applyMatrix4(movesDown(this.prefab, o.key, new this.THREE.Matrix4()));
        }
    }
    // An object's rotation as the prefab put it, and its ancestors' turns now (outermost first).
    const savedRotation = o => new world.THREE.Quaternion().setFromRotationMatrix(new world.THREE.Matrix4().extractRotation(new world.THREE.Matrix4().set(...o.m)));
    function turnsAbove(p, key) {
        const q = new world.THREE.Quaternion();
        const chain = [];
        for (let k = p.objects[key] && p.objects[key].father; k; k = p.objects[k] && p.objects[k].father) chain.unshift(k);
        for (const k of chain) if (p.moves[k] && p.moves[k].rot) q.multiply(p.moves[k].rot);
        return q;
    }

    // The scene's things scripts need; app.js calls it once.
    Tickable.use = things => { world = things; };
    Tickable.register = (name, cls) => { classes.set(name, cls); };

    function load(name, url) {
        if (!loading.has(url)) {
            loading.set(url, new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = url;
                script.onload = () => (classes.has(name) ? resolve(classes.get(name)) : reject(new Error(`${url} did not call Tickable.register("${name}", ...)`)));
                script.onerror = () => reject(new Error(`could not load ${url}`));
                document.head.appendChild(script);
            }));
        }
        return loading.get(url);
    }
    const attached = object => { for (let o = object; o; o = o.parent) if (o.isScene) return true; return false; };
    const topOf = group => { let o = group; while (o && !(o.userData && o.userData.piece) && o.parent) o = o.parent; return o; };
    // A piece's settings ("rate 2, speed 4"): numbers, or lists of them, by name; words stay words.
    function settingsOf(extra) {
        const out = {};
        for (const item of (extra || "").split(",").map(s => s.trim()).filter(Boolean)) {
            const [key, ...rest] = item.split(/\s+/);
            const values = rest.map(v => (Number.isFinite(+v) ? +v : v));
            out[key] = values.length === 1 ? values[0] : values.length ? values : true;
        }
        return out;
    }
    // A class's static params, its ancestors' first.
    function paramsOf(cls) {
        const chain = [];
        for (let c = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) if (Object.prototype.hasOwnProperty.call(c, "params")) chain.unshift(c.params);
        return Object.assign({}, ...chain);
    }

    // Starts the scripts of a library entry built into group (app.js buildObject): its layout
    // script lines (entry.scripts with url) and its Unity scripts that have stand-ins (with
    // fields and url); scripts on inactive objects don't run.
    function attach(entry, group, piece) {
        const scripts = (entry.scripts || []).filter(s => s.url && !s.off);
        if (!scripts.length) return;
        const prefab = { objects: entry.objects || null, moves: {}, components: new Map(), inWorld: false, group };
        group.userData.prefab = prefab;
        // Each script loads on its own: one that fails (its error shown) doesn't stop the rest.
        Promise.all(scripts.map(s => load(s.name, s.url).catch(error => { setTimeout(() => { throw error; }); return null; }))).then(found => {
            if (!attached(group)) return; // gone while its scripts loaded
            const top = topOf(group);
            found.forEach((cls, i) => {
                if (!cls) return;
                const s = scripts[i];
                const t = new cls();
                Object.assign(t, { THREE: world.THREE, camera: world.camera, scene: world.scene, environment: world.environment, leafWind: world.leafWind, windLevels: world.windLevels, texture: world.texture, describe: world.describe, textures: world.textures,
                    group, top, piece, prefab, name: s.name, object: s.go || null, fields: s.fields || {}, lod: s.lod || null, eye: new world.THREE.Vector3(),
                    params: { ...paramsOf(cls), ...settingsOf(s.settings), ...settingsOf(piece.extra) } });
                if (s.id) prefab.components.set(s.id, t);
                t.top.userData.tickables = [...(t.top.userData.tickables || []), t];
                if (cls.singleton) {
                    const other = singletons.get(cls);
                    if (other && running.has(other)) return duplicate(t.top, s.name);
                    singletons.set(cls, t);
                }
                running.add(t);
                try {
                    t.start();
                } catch (error) {
                    end(t); // this script only; the prefab's others still start
                    setTimeout(() => { throw error; });
                }
            });
        }).catch(error => setTimeout(() => { throw error; }));
    }
    // A second piece with a singleton: hidden, its scripts stopped.
    function duplicate(top, name) {
        if (top.userData.duplicate) return;
        top.userData.duplicate = name;
        top.visible = false;
        for (const t of top.userData.tickables || []) if (running.has(t)) end(t);
        console.warn(`${top.userData.pieceName || "a piece"}: another ${name} is already running (it is a singleton), so this one is hidden`);
    }
    function end(t) {
        running.delete(t);
        if (singletons.get(t.constructor) === t) singletons.delete(t.constructor);
        try {
            t.stop();
        } finally {
            if (t.space && t.space.parent) t.space.parent.remove(t.space);
            const p = t.prefab;
            if (p.inWorld && p.group.parent === t.scene) { t.scene.remove(p.group); p.inWorld = false; }
        }
    }
    // Moved game objects: each mesh of a prefab with stand-ins takes its object's offset and its
    // ancestors' (its part's matrix, moved).
    // Moved game objects: each mesh of a prefab with stand-ins takes its object's move and its
    // ancestors' (outermost first), each an offset after a turn about the object's own origin, in
    // Unity's axes; then Three.js's (X mirrored) on its part's matrix.
    let scratch = null;
    let IDENTITY = null;
    function moveOf(p, key, out) {
        const s = scratch, mv = p.moves[key], o = p.objects[key];
        out.identity();
        if (!mv || !o) return out;
        const m = o.m;
        if (mv.offset) out.makeTranslation(mv.offset[0], mv.offset[1], mv.offset[2]);
        if (mv.rot) {
            s.turn.makeTranslation(m[3], m[7], m[11])
                .multiply(s.rot.makeRotationFromQuaternion(mv.rot))
                .multiply(s.back.makeTranslation(-m[3], -m[7], -m[11]));
            out.multiply(s.turn);
        }
        return out;
    }
    // All the moves on an object, its ancestors' first, in Unity's axes.
    function movesDown(p, key, out) {
        const THREE = world.THREE;
        scratch = scratch || { axis: new THREE.Vector3(), turn: new THREE.Matrix4(), rot: new THREE.Matrix4(), back: new THREE.Matrix4(), one: new THREE.Matrix4(), all: new THREE.Matrix4() };
        const chain = [];
        for (let k = key; k; k = p.objects[k] && p.objects[k].father) if (p.moves[k]) chain.unshift(k);
        out.identity();
        const one = new THREE.Matrix4();
        for (const k of chain) out.multiply(moveOf(p, k, one));
        return out;
    }
    function place(p) {
        if (!p.objects || !Object.keys(p.moves).length) return;
        IDENTITY = IDENTITY || new world.THREE.Matrix4();
        const all = new world.THREE.Matrix4();
        for (const mesh of p.group.children) {
            const part = mesh.userData.part;
            if (!part || !part.go) continue;
            movesDown(p, part.go, all);
            if (!mesh.userData.placed) {
                if (all.equals(IDENTITY)) continue; // never moved: as the prefab put it
                mesh.userData.placed = mesh.matrix.clone();
            }
            mesh.matrix.copy(Space.mirrorX(all)).multiply(mesh.userData.placed); // into Three.js's axes
        }
    }
    Ticker.add(dt => {
        const prefabs = new Set();
        for (const t of [...running]) {
            if (!attached(t.top)) {
                end(t);
                continue;
            }
            try {
                t.updateEye();
                t.tick(dt);
            } catch (error) {
                end(t);
                setTimeout(() => { throw error; }); // reported like any page error
            }
            prefabs.add(t.prefab);
        }
        for (const p of prefabs) {
            try {
                place(p);
            } catch (error) {
                p.moves = {}; // this prefab's objects stay where they are; the rest carry on
                setTimeout(() => { throw error; });
            }
        }
    });

    Tickable.attach = attach;
    Tickable.settingsOf = settingsOf;
    root.Tickable = Tickable;
})(window);
