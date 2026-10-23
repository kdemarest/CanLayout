// layout composer. See ../README.md for how it is used.
// Pieces are kept as Unity values ({ name, position, rotation, scale, extra }); Space converts.
(function () {
    const $ = id => document.getElementById(id);
    const status = $("status");

    // ---------- state ----------
    const state = {
        scene: null,          // { name, kind: "composed" | "area", editable }
        pieces: [],           // Unity values
        objects: [],          // Three.js group per piece, same order
        area: null,           // the imported area a composed scene sits on ("- Area:" line), or null
        base: [],             // that area's pieces: drawn, snapped onto, never picked up or saved
        baseObjects: [],
        library: {},
        materials: {},        // Unity material guid -> description (colors, texture URLs)
        textures: true,
        undo: [],
        redo: [],
        dirty: false,
        carried: null,        // { index (or -1 when new), object, rel, factor, original }
        snap: false,
        labels: false,        // name every piece, not only the placeholders
        hiddenFolders: new Set(),
        orbitDistance: 12
    };

    // ---------- three.js ----------
    const canvas = $("view");
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (error) {
        throw new Error(`3D graphics (WebGL) could not start: ${error.message}. If the browser blocked it after a crash, close this tab and reopen it, or restart the browser.`, { cause: error });
    }
    canvas.addEventListener("webglcontextlost", e => {
        e.preventDefault();
        window.layoutError("3D graphics were lost (out of GPU memory?). Reload the page.");
    });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0.4, 1, 0.6);
    scene.add(sun);
    const world = new THREE.Group();
    scene.add(world);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
    camera.position.set(0, 5, 15);
    camera.lookAt(0, 0, 0);
    const highlight = new THREE.BoxHelper(undefined, 0x4fb3ff);
    highlight.visible = false;
    scene.add(highlight);

    const gray = new THREE.MeshStandardMaterial({ color: 0xb4b0a8, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    const faded = new THREE.MeshStandardMaterial({ color: 0xb4b0a8, roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.35 });
    const wire = new THREE.MeshBasicMaterial({ color: 0xff8c1a, wireframe: true });
    const unitCube = new THREE.BoxGeometry(1, 1, 1);

    function resize() {
        // The canvas size, not the window: on Android they differ while the address bar moves.
        const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    window.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(canvas);
    resize();

    // ---------- server ----------
    async function call(method, url, body) {
        const response = await fetch(url, method === "GET" ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || response.statusText);
        }
        return data;
    }
    function say(text) {
        status.textContent = text;
    }
    function fail(error) {
        window.layoutError(error && error.message ? error.message : String(error));
        console.error(error);
    }

    // ---------- meshes ----------
    const geometries = new Map();
    function parseObj(text) {
        const v = [], vt = [], vn = [], pos = [], nor = [], uv = [];
        for (const line of text.split("\n")) {
            const p = line.trim().split(/\s+/);
            if (p[0] === "v") v.push([+p[1], +p[2], +p[3]]);
            else if (p[0] === "vt") vt.push([+p[1], +p[2]]);
            else if (p[0] === "vn") vn.push([+p[1], +p[2], +p[3]]);
            else if (p[0] === "f") {
                const corner = token => {
                    const [a, b, c] = token.split("/").map(Number);
                    pos.push(...v[a - 1]);
                    uv.push(...(vt[b - 1] || [0, 0]));
                    nor.push(...(vn[c - 1] || [0, 1, 0]));
                };
                for (let i = 2; i < p.length - 1; i++) {
                    corner(p[1]);
                    corner(p[i]);
                    corner(p[i + 1]);
                }
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
        g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        g.computeBoundingSphere();
        return g;
    }
    function geometryFor(part) {
        if (part.mesh && part.mesh.kind === "builtin") {
            return Promise.resolve(builtin(part.mesh.name));
        }
        if (!part.obj) {
            return Promise.resolve(null);
        }
        if (!geometries.has(part.obj)) {
            geometries.set(part.obj, fetch(part.obj).then(r => (r.ok ? r.text() : null)).then(t => (t ? parseObj(t) : null)));
        }
        return geometries.get(part.obj);
    }
    const builtins = {};
    function builtin(name) {
        if (!(name in builtins)) {
            builtins[name] = name === "Cube" ? unitCube
                : name === "Cylinder" ? new THREE.CylinderGeometry(0.5, 0.5, 2, 16)
                    : name === "Sphere" ? new THREE.SphereGeometry(0.5, 16, 12)
                        : name === "Capsule" ? new THREE.CapsuleGeometry(0.5, 1, 4, 12)
                            : name === "Plane" ? new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2)
                                : name === "Quad" ? new THREE.PlaneGeometry(1, 1) : null;
        }
        return builtins[name];
    }
    function labelTexture(text, color) {
        const c = document.createElement("canvas");
        c.width = 512;
        c.height = 96;
        const g = c.getContext("2d");
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(0, 0, 512, 96);
        g.font = "bold 44px sans-serif";
        g.fillStyle = color;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(text, 256, 48, 496);
        return new THREE.CanvasTexture(c);
    }
    function label(text) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, "#ffb060"), depthTest: false }));
        s.scale.set(2, 0.375, 1);
        s.position.y = 1.2;
        return s;
    }
    // A 1 m box at the part's place (its import scale dropped), named.
    function placeholder(matrix, name) {
        const p = new THREE.Vector3(), q = new THREE.Quaternion();
        matrix.decompose(p, q, new THREE.Vector3());
        const box = new THREE.Mesh(unitCube, wire);
        box.matrixAutoUpdate = false;
        box.matrix.compose(p, q, new THREE.Vector3(1, 1, 1));
        box.add(label(name));
        return box;
    }
    // Placeholder shapes from docs "- Shape:" lines (tools/shapes.js): each rests on its origin,
    // then moves by "at" and turns by "turn", in the piece's Unity space.
    const shapeMaterials = new Map();
    function shapeMaterial(color) {
        if (!shapeMaterials.has(color)) shapeMaterials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true, side: THREE.DoubleSide }));
        return shapeMaterials.get(color);
    }
    // tint: a material that replaces every color, from an outer "use ... color".
    function shapeMesh(shape, tint) {
        // "use": another asset's shapes or a Unity prefab, as a piece placed at "at" and "turn".
        if (shape.kind === "use") {
            const piece = { name: shape.name, position: shape.at, rotation: shape.turn, scale: shape.scale || [1, 1, 1], extra: "" };
            return buildObject(piece, shape.color ? shapeMaterial(shape.color) : tint);
        }
        const [a, b, c] = shape.size;
        const tip = shape.tip || 0; // the top's size, as a fraction of the base
        let geometry;
        if (shape.kind === "box") geometry = new THREE.BoxGeometry(a, b, c).translate(0, b / 2, 0);
        else if (shape.kind === "cylinder") geometry = new THREE.CylinderGeometry(a, a, b, shape.sides || 24).translate(0, b / 2, 0);
        else if (shape.kind === "cone") geometry = new THREE.CylinderGeometry(a * tip, a, b, shape.sides || 24).translate(0, b / 2, 0);
        else if (shape.kind === "pyramid") {
            // A four-sided cylinder turned 45 degrees is a square; stretched to width by depth.
            geometry = new THREE.CylinderGeometry(tip, 1, b, 4).rotateY(Math.PI / 4).scale(a / Math.SQRT2, 1, c / Math.SQRT2).translate(0, b / 2, 0);
        }
        else if (shape.kind === "sphere") geometry = new THREE.SphereGeometry(a, 24, 16).translate(0, a, 0);
        else if (shape.kind === "hemisphere") {
            // The dome, closed underneath by a disc; "arc" keeps a wedge of it, closed at both cuts.
            const arc = (shape.arc || 360) * Math.PI / 180;
            const dome = new THREE.SphereGeometry(a, 24, 8, 0, arc, 0, Math.PI / 2);
            const disc = new THREE.CircleGeometry(a, 24, Math.PI - arc, arc).rotateX(Math.PI / 2);
            const pieces = [dome, disc];
            if (shape.arc && shape.arc < 360) {
                const cut = () => new THREE.CircleGeometry(a, 8, Math.PI / 2, Math.PI / 2);
                pieces.push(cut(), cut().rotateY(arc));
            }
            geometry = mergeGeometries(pieces);
        }
        else if (shape.kind === "dodecahedron") geometry = new THREE.DodecahedronGeometry(a / 2).translate(0, a / 2, 0);
        else if (shape.kind === "prism") {
            const triangle = new THREE.Shape([new THREE.Vector2(-a / 2, 0), new THREE.Vector2(a / 2, 0), new THREE.Vector2(0, b)]);
            geometry = new THREE.ExtrudeGeometry(triangle, { depth: c, bevelEnabled: false }).translate(0, 0, -c / 2);
        } else throw new Error(`unknown shape ${shape.kind}`);
        const mesh = new THREE.Mesh(geometry, tint || shapeMaterial(shape.color || "#c9a66b"));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(Space.pieceMatrix(THREE, { position: shape.at, rotation: shape.turn, scale: shape.scale || [1, 1, 1] }));
        return mesh;
    }
    // Joins non-indexed copies of geometries into one (enough for placeholder shapes).
    function mergeGeometries(list) {
        const flat = list.map(g => (g.index ? g.toNonIndexed() : g));
        const merged = new THREE.BufferGeometry();
        for (const name of ["position", "normal", "uv"]) {
            const arrays = flat.map(g => g.attributes[name].array);
            const out = new Float32Array(arrays.reduce((n, x) => n + x.length, 0));
            let at = 0;
            for (const x of arrays) {
                out.set(x, at);
                at += x.length;
            }
            merged.setAttribute(name, new THREE.BufferAttribute(out, flat[0].attributes[name].itemSize));
        }
        return merged;
    }
    function folderOf(entry) {
        if (!entry) return "(new or unknown)";
        if (!entry.source || !entry.source.includes("/")) return "(built-in)";
        return entry.source.replace(/^Assets\//, "").replace(/\/[^/]*$/, "");
    }
    // ---------- materials ----------
    // Textures are shrunk to at most 1024 px as they load; Unity's are often 4096 px, which a
    // phone can't hold many of.
    const MAX_TEXTURE = 1024;
    const textures = new Map();
    function texture(t, srgb) {
        if (!t || !t.url) return Promise.resolve(null);
        const key = `${t.url}|${t.scale}|${t.offset}|${srgb}`;
        if (!textures.has(key)) {
            textures.set(key, fetch(t.url).then(r => (r.ok ? r.blob() : null)).then(async blob => {
                if (!blob) return null;
                const full = await createImageBitmap(blob);
                const k = Math.min(1, MAX_TEXTURE / Math.max(full.width, full.height));
                const bitmap = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: "medium", imageOrientation: "flipY" });
                full.close();
                const tex = new THREE.Texture(bitmap);
                tex.flipY = false; // flipped while decoding
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(t.scale[0], t.scale[1]);
                tex.offset.set(t.offset[0], t.offset[1]);
                if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
                tex.anisotropy = 4;
                tex.needsUpdate = true;
                return tex;
            }).catch(() => null));
        }
        return textures.get(key);
    }
    const materials = new Map();
    // A Three.js material for a Unity material. Canopy/General is base * detail * tint *
    // brightness; its color is scaled back under 1 so hue survives Unity's dimmer lighting.
    function materialFor(guid, faint) {
        const d = guid && state.materials[guid];
        if (!state.textures || !d) return faint ? faded : gray;
        const key = `${guid}|${faint}`;
        if (materials.has(key)) return materials.get(key);
        let c = d.color.slice(0, 3).map(v => v * (d.brightness || 1));
        const top = Math.max(...c);
        if (top > 1) c = c.map(v => v / top);
        const opacity = faint ? 0.35 : d.transparent ? Math.min(1, d.color[3]) : 1;
        const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(...c), roughness: 0.85, metalness: 0, side: THREE.DoubleSide, transparent: opacity < 1, opacity });
        // Cutout materials (e.g. leaves) drop pixels whose texture alpha is under the cutoff.
        if (d.cutout) m.alphaTest = d.cutoff;
        texture(d.map, true).then(t => {
            if (t) {
                m.map = t;
                m.needsUpdate = true;
            }
        });
        texture(d.normal, false).then(t => {
            if (t) {
                m.normalMap = t;
                m.needsUpdate = true;
            }
        });
        if (d.detail) {
            texture(d.detail, true).then(t => {
                if (!t) return;
                // Multiply the detail texture in, tiled by its own scale, as the Unity shader does.
                m.defines = { ...(m.defines || {}), USE_UV: "" };
                m.onBeforeCompile = shader => {
                    shader.uniforms.detailMap = { value: t };
                    shader.uniforms.detailRepeat = { value: new THREE.Vector2(d.detail.scale[0], d.detail.scale[1]) };
                    shader.uniforms.detailOffset = { value: new THREE.Vector2(d.detail.offset[0], d.detail.offset[1]) };
                    shader.fragmentShader = "uniform sampler2D detailMap;\nuniform vec2 detailRepeat;\nuniform vec2 detailOffset;\n" + shader.fragmentShader.replace(
                        "#include <map_fragment>",
                        "#include <map_fragment>\n\tdiffuseColor.rgb *= texture2D(detailMap, vUv * detailRepeat + detailOffset).rgb;"
                    );
                };
                m.customProgramCacheKey = () => "detail";
                m.needsUpdate = true;
            });
        }
        materials.set(key, m);
        return m;
    }

    // A Three.js group for one piece; its parts load asynchronously. tint replaces its materials.
    function buildObject(piece, tint) {
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.matrix.copy(Space.pieceMatrix(THREE, piece));
        const entry = state.library[piece.name];
        group.userData.folder = folderOf(entry || (piece.source ? { source: piece.source } : null));
        group.visible = !state.hiddenFolders.has(group.userData.folder);
        const faint = /\binactive\b/.test(piece.extra || "");
        const parts = piece.parts || (entry ? entry.parts : []); // an imported instance may carry its own
        if (!piece.parts && entry && entry.shapes) {
            for (const shape of entry.shapes) group.add(shapeMesh(shape, tint));
            return group;
        }
        if (!parts.length) {
            group.add(placeholder(new THREE.Matrix4(), piece.name));
            return group;
        }
        for (const part of parts) {
            const local = Space.partMatrix(THREE, part.m);
            geometryFor(part).then(geometry => {
                if (geometry) {
                    const mesh = new THREE.Mesh(geometry, tint || materialFor(part.material, faint));
                    mesh.matrixAutoUpdate = false;
                    mesh.matrix.copy(local);
                    group.add(mesh);
                } else {
                    group.add(placeholder(local, part.mesh ? part.mesh.name : piece.name));
                }
            });
        }
        return group;
    }
    function rebuildBase() {
        for (const o of state.baseObjects) world.remove(o);
        state.baseObjects = state.base.map(p => {
            const o = buildObject(p);
            o.userData.pieceName = p.name;
            o.userData.piece = p;
            world.add(o);
            return o;
        });
    }
    const allObjects = () => [...state.baseObjects, ...state.objects];
    function rebuildWorld() {
        for (const o of state.objects) world.remove(o);
        state.objects = state.pieces.map(p => {
            const o = buildObject(p);
            o.userData.pieceName = p.name;
            world.add(o);
            return o;
        });
        refreshLabels();
        setTimeout(refreshLabels, 1500); // again once meshes have loaded and sizes are known
    }

    // ---------- labels ----------
    // With Labels on, every piece shows its name just above it, at a constant size on screen.
    // (Placeholder boxes always carry their own orange label.)
    const labels = new THREE.Group();
    scene.add(labels);
    const labelTextures = new Map();
    function placeLabel(sprite, object) {
        object.updateMatrixWorld(true);
        // Above the piece's own origin, high enough to clear it, but not chasing far-flung parts.
        const box = new THREE.Box3().setFromObject(object);
        const at = new THREE.Vector3().setFromMatrixPosition(object.matrix);
        const rise = box.isEmpty() ? 0.5 : Math.min(Math.max(box.max.y - at.y, 0.5), 8);
        sprite.position.set(at.x, at.y + rise + 0.2, at.z);
        sprite.visible = object.visible;
    }
    function refreshLabels() {
        for (const s of [...labels.children]) {
            labels.remove(s);
            s.material.dispose();
        }
        if (!state.labels) return;
        for (const o of allObjects()) {
            const name = o.userData.pieceName;
            const piece = o.userData.piece || state.pieces[state.objects.indexOf(o)];
            if (!name || (!state.library[name] && !(piece && piece.parts))) continue; // placeholders are labeled already
            if (!labelTextures.has(name)) labelTextures.set(name, labelTexture(name, "#cfe8ff"));
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTextures.get(name), depthTest: false, sizeAttenuation: false }));
            s.scale.set(0.16, 0.03, 1);
            s.center.set(0.5, 0);
            s.userData.object = o;
            placeLabel(s, o);
            labels.add(s);
        }
    }

    // ---------- scenes ----------
    async function refreshList(select) {
        const list = await call("GET", "/api/list");
        const sel = $("sceneSelect");
        sel.innerHTML = "";
        const group = (title, names, kind) => {
            const og = document.createElement("optgroup");
            og.label = title;
            for (const n of names) {
                const o = document.createElement("option");
                o.value = `${kind}:${n}`;
                o.textContent = n;
                og.appendChild(o);
            }
            sel.appendChild(og);
        };
        group("Composed scenes", list.composed, "composed");
        group("Imported areas (read-only)", list.areas, "area");
        $("unityScene").innerHTML = list.unityScenes.map(n => `<option>${n}</option>`).join("");
        if (select) sel.value = select;
        return list;
    }
    // keepCamera: stay put (a new scene on the area being viewed covers the same ground).
    async function loadScene(value, keepCamera = false) {
        if (state.dirty && !confirm("Discard unsaved changes?")) {
            $("sceneSelect").value = `${state.scene.kind}:${state.scene.name}`;
            return;
        }
        const [kind, ...rest] = value.split(":");
        const name = rest.join(":");
        say(`Loading ${name}… (first time fetches meshes)`);
        const data = await call("GET", `/api/scene?kind=${kind}&name=${encodeURIComponent(name)}`);
        state.scene = { name, kind, editable: data.editable };
        state.pieces = data.pieces;
        state.area = data.area || null;
        state.base = data.base || [];
        Object.assign(state.library, data.library);
        Object.assign(state.materials, data.materials || {});
        state.undo = [];
        state.redo = [];
        state.dirty = false;
        endCarry();
        rebuildBase();
        rebuildWorld();
        if (!keepCamera) frameAll();
        localStorage.setItem("layout.scene", value);
        updateUi();
        const on = state.area ? `, on ${state.area} (${state.base.length}, read-only)` : "";
        say(`${name}: ${data.pieces.length} pieces${on}${data.problems.length ? `; ${data.problems.length} meshes failed` : ""}${data.editable ? "" : " (read-only; Add starts a scene on it)"}`);
    }
    function frameAll() {
        const box = new THREE.Box3();
        for (const p of [...state.base, ...state.pieces]) box.expandByPoint(new THREE.Vector3(-p.position[0], p.position[1], p.position[2]));
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = Math.max(4, box.getSize(new THREE.Vector3()).length());
        state.orbitDistance = size * 0.8;
        camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 0.65).normalize().multiplyScalar(state.orbitDistance));
        camera.lookAt(center);
    }

    // ---------- editing ----------
    const snapshot = () => JSON.stringify(state.pieces);
    function commit(change) {
        state.undo.push(snapshot());
        state.redo = [];
        change();
        state.dirty = true;
        updateUi();
    }
    function restore(json) {
        state.pieces = JSON.parse(json);
        rebuildWorld();
        state.dirty = true;
        updateUi();
    }
    function sizeOf(object) {
        const box = new THREE.Box3().setFromObject(object);
        return box.isEmpty() ? 1 : Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    }
    // Carry: the piece keeps its pose relative to the camera, so moving or orbiting the camera
    // moves or turns the piece.
    function startCarry(index, object) {
        camera.updateMatrixWorld();
        object.updateMatrixWorld(true);
        state.carried = {
            index,
            object,
            rel: camera.matrixWorld.clone().invert().multiply(object.matrix),
            factor: 1,
            base: index >= 0 ? uniformScale(state.pieces[index].scale) : 1, // its size when picked up, x base size
            original: object.matrix.clone(),
            extra: index >= 0 ? state.pieces[index].extra || "" : "" // settings, e.g. a tablet's text id
        };
        showScale(state.carried.base);
        updateUi();
    }
    // The scale slider sets a piece's size as a multiple of its base size (scale 1), from x0.25
    // to x49 on a doubling (exponential) scale.
    const uniformScale = s => (s ? Math.cbrt(Math.abs(s[0] * s[1] * s[2])) || 1 : 1);
    function showScale(size) {
        $("scale").value = Math.log2(size);
        $("scaleValue").textContent = `×${size < 10 ? size.toFixed(2) : size.toFixed(1)}`;
    }
    // Tablets, signs and notes take a text id (from the game's English.txt).
    const takesText = c => Boolean(c && (state.library[c.object.userData.pieceName] || {}).takesText);
    const textIdOf = extra => ((/(?:^|, )textId ([^,]+)/.exec(extra || "") || [])[1] || "").trim();
    function setText(id) {
        const c = state.carried;
        const rest = (c.extra || "").split(", ").filter(s => s && !s.startsWith("textId "));
        c.extra = [`textId ${id}`, ...rest].join(", ");
        closePanels();
        say(`${c.object.userData.pieceName} shows ${id}. Drop to keep it.`);
    }
    function endCarry() {
        state.carried = null;
        highlight.visible = false;
        updateUi();
    }
    async function addPiece(name) {
        closePanels();
        if (!state.library[name]) {
            say(`Preparing ${name}…`);
            const data = await call("POST", "/api/prepare", { names: [name] });
            Object.assign(state.library, data.library);
            Object.assign(state.materials, data.materials || {});
        }
        const piece = { name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], extra: "" };
        const object = buildObject(piece);
        object.userData.pieceName = name;
        world.add(object);
        // Wait briefly for meshes so the size (and the cursor distance) is right.
        await new Promise(r => setTimeout(r, 300));
        const radius = sizeOf(object);
        const distance = Math.max(1.5, radius / (0.25 * Math.tan(camera.fov * Math.PI / 360)));
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const yaw = Math.atan2(forward.x, forward.z);
        object.matrix.compose(
            camera.position.clone().addScaledVector(forward, distance),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI),
            new THREE.Vector3(1, 1, 1)
        );
        startCarry(-1, object);
        say(`Carrying ${name}. Move, orbit to turn it, then Drop.${takesText(state.carried) ? " Add text picks its text." : ""}`);
    }
    function carriedMatrix() {
        const c = state.carried;
        camera.updateMatrixWorld();
        const m = camera.matrixWorld.clone().multiply(c.rel).multiply(new THREE.Matrix4().makeScale(c.factor, c.factor, c.factor));
        if (state.snap) {
            c.object.matrix.copy(m);
            c.object.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(c.object);
            if (!box.isEmpty()) {
                const center = box.getCenter(new THREE.Vector3());
                const ray = new THREE.Raycaster(new THREE.Vector3(center.x, box.max.y + 0.05, center.z), new THREE.Vector3(0, -1, 0));
                const others = [...state.baseObjects, ...state.objects.filter((o, i) => i !== c.index)].filter(o => o.visible);
                const hit = ray.intersectObjects(others, true).find(h => h.object.isMesh && h.object.material !== wire);
                if (hit) {
                    m.premultiply(new THREE.Matrix4().makeTranslation(0, hit.point.y - box.min.y, 0));
                }
            }
        }
        return m;
    }
    function drop() {
        const c = state.carried;
        if (!c) return;
        const placement = Space.placementOf(THREE, carriedMatrix());
        commit(() => {
            if (c.index < 0) {
                const piece = { name: c.object.userData.pieceName, ...placement, extra: c.extra };
                state.pieces.push(piece);
                state.objects.push(c.object);
            } else {
                Object.assign(state.pieces[c.index], placement, { extra: c.extra });
            }
            c.object.matrix.copy(Space.pieceMatrix(THREE, c.index < 0 ? state.pieces[state.pieces.length - 1] : state.pieces[c.index]));
        });
        endCarry();
        refreshLabels();
        say("Dropped.");
    }
    function cancel() {
        const c = state.carried;
        if (!c) return;
        if (c.index < 0) {
            world.remove(c.object);
        } else {
            c.object.matrix.copy(c.original);
        }
        endCarry();
        refreshLabels();
        say("Cancelled.");
    }
    function remove() {
        const c = state.carried;
        if (!c || c.index < 0) return;
        commit(() => {
            world.remove(c.object);
            state.pieces.splice(c.index, 1);
            state.objects.splice(c.index, 1);
        });
        endCarry();
        refreshLabels();
        say("Deleted.");
    }

    // ---------- camera ----------
    function pivot() {
        if (state.carried) {
            return new THREE.Box3().setFromObject(state.carried.object).getCenter(new THREE.Vector3());
        }
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        return camera.position.clone().addScaledVector(forward, state.orbitDistance);
    }
    // While carrying, orbiting only turns (about the vertical), so pieces stay upright.
    function orbit(dx, dy) {
        if (state.carried) dy = 0;
        const center = pivot();
        const offset = camera.position.clone().sub(center);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta -= dx * 0.008;
        spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - dy * 0.008));
        camera.position.copy(center).add(new THREE.Vector3().setFromSpherical(spherical));
        camera.lookAt(center);
    }
    // Grab-and-drag the view, like moving a map: swipe right to look left, down to look up (Ken's preference).
    function look(dx, dy) {
        const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
        e.y += dx * 0.005;
        e.x = Math.max(-1.45, Math.min(1.45, e.x + dy * 0.005));
        e.z = 0;
        camera.quaternion.setFromEuler(e);
    }
    function move(direction, amount) {
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const flat = new THREE.Vector3(forward.x, 0, forward.z).normalize();
        const right = new THREE.Vector3().crossVectors(flat, new THREE.Vector3(0, 1, 0));
        // W and S fly where the camera points; A and D sidestep level; Q and E sink and rise.
        const step = { forward, back: forward.clone().negate(), right, left: right.clone().negate(), up: new THREE.Vector3(0, 1, 0), down: new THREE.Vector3(0, -1, 0) }[direction];
        camera.position.addScaledVector(step, amount);
    }
    function speed() {
        const base = state.carried ? sizeOf(state.carried.object) * 1.5 : state.orbitDistance * 0.3;
        return Math.max(0.5, base * 0.5); // halved for now (Ken, 2026-10-21)
    }

    // Touch: one finger looks around (or, carrying, orbits to turn the piece); a pinch travels
    // forward and back like W and S, at their speed (spreading 200 px is a second of W); a tap selects.
    const pointers = new Map();
    let gesture = null;
    canvas.addEventListener("pointerdown", e => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
        gesture = null;
    });
    canvas.addEventListener("pointermove", e => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (pointers.size === 1) {
            if (state.carried) orbit(dx, dy);
            else look(dx, dy);
        } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const before = Math.hypot(a.x - b.x, a.y - b.y);
            p.x = e.clientX;
            p.y = e.clientY;
            const after = Math.hypot(a.x - b.x, a.y - b.y);
            move("forward", (after - before) / 200 * speed());
            gesture = "two";
            return;
        }
        p.x = e.clientX;
        p.y = e.clientY;
    });
    const release = e => {
        const p = pointers.get(e.pointerId);
        pointers.delete(e.pointerId);
        if (p && pointers.size === 0 && gesture !== "two" && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 8 && performance.now() - p.t0 < 350) {
            tap(e.clientX, e.clientY);
        }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", e => pointers.delete(e.pointerId));
    function tap(x, y) {
        if (state.carried || !state.scene || !state.scene.editable) return;
        const ray = new THREE.Raycaster();
        const r = canvas.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
        const hit = ray.intersectObjects(state.objects.filter(o => o.visible), true)[0];
        if (!hit) return;
        let o = hit.object;
        while (o.parent !== world) o = o.parent;
        const index = state.objects.indexOf(o);
        if (index >= 0) {
            o.userData.pieceName = state.pieces[index].name;
            startCarry(index, o);
            const text = textIdOf(state.pieces[index].extra);
            say(`Carrying ${state.pieces[index].name}${text ? ` (${text})` : ""}. Drop, Cancel, or Delete.`);
        }
    }

    // Movement pad and keys: held buttons move continuously. Only a finger that lands on a pad
    // button presses it; a finger already turning or pinching on the view never does, even if
    // it slides over the pad.
    const held = new Set();
    for (const b of document.querySelectorAll("[data-move]")) {
        const on = e => {
            e.preventDefault();
            if (pointers.has(e.pointerId)) return;
            if (pointers.size) fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `pad ${b.dataset.move} pressed by a new finger while ${pointers.size} finger(s) on the view (${gesture || "turning"})` }) }).catch(() => {});
            held.add(b.dataset.move);
        };
        const off = () => held.delete(b.dataset.move);
        b.addEventListener("pointerdown", on);
        b.addEventListener("pointerup", off);
        b.addEventListener("pointerleave", off);
        b.addEventListener("pointercancel", off);
    }
    // No long-press menu on the controls (the canvas handles its own touches).
    document.addEventListener("contextmenu", e => {
        if (e.target.closest && e.target.closest("button, #pad")) e.preventDefault();
    });
    const KEYS = { w: "forward", s: "back", a: "left", d: "right", e: "up", q: "down", ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right" };
    window.addEventListener("keydown", e => {
        if (KEYS[e.key] && document.activeElement.tagName !== "INPUT") held.add(KEYS[e.key]);
    });
    window.addEventListener("keyup", e => KEYS[e.key] && held.delete(KEYS[e.key]));

    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        // A and D sidestep at half speed (Ken, 2026-10-22).
        for (const direction of held) move(direction, speed() * dt * (direction === "left" || direction === "right" ? 0.5 : 1));
        if (state.carried) {
            state.carried.object.matrix.copy(carriedMatrix());
            for (const s of labels.children) if (s.userData.object === state.carried.object) placeLabel(s, s.userData.object);
            state.carried.object.updateMatrixWorld(true);
            highlight.setFromObject(state.carried.object);
            highlight.visible = true;
        }
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // ---------- panels and buttons ----------
    function updateUi() {
        const editable = state.scene && state.scene.editable;
        const carrying = Boolean(state.carried);
        // Add places a piece; while carrying a tablet it picks the tablet's text instead.
        $("addBtn").disabled = carrying ? !takesText(state.carried) : !(editable || (state.scene && state.scene.kind === "area"));
        $("addBtn").textContent = carrying && takesText(state.carried) ? "Add text" : "Add";
        // Drop, Cancel and Delete appear only while carrying (Delete only for a placed piece).
        $("dropBtn").hidden = !carrying;
        $("cancelBtn").hidden = !carrying;
        $("deleteBtn").hidden = !carrying || state.carried.index < 0;
        $("undoBtn").disabled = !state.undo.length || carrying;
        $("redoBtn").disabled = !state.redo.length || carrying;
        $("saveBtn").disabled = !editable || !state.dirty;
        $("saveBtn").textContent = state.dirty ? "Save ●" : "Save";
        $("menuBtn").textContent = state.dirty ? "☰ ●" : "☰";
        $("snapBtn").classList.toggle("on", state.snap);
        $("labelsBtn").classList.toggle("on", state.labels);
        $("scalebar").style.display = carrying ? "flex" : "none";
    }
    function closePanels() {
        for (const id of ["palette", "importPanel", "folders", "menu"]) $(id).style.display = "none";
    }
    // The ☰ menu holds New, Save, Import area, Folders, and the Snap and Labels toggles; choosing one closes it.
    $("menuBtn").onclick = e => {
        e.stopPropagation();
        const open = $("menu").style.display === "flex";
        closePanels();
        $("menu").style.display = open ? "none" : "flex";
    };
    for (const b of $("menu").querySelectorAll("button")) b.addEventListener("click", () => ($("menu").style.display = "none"));
    document.addEventListener("pointerdown", e => {
        if ($("menu").style.display === "flex" && !$("menu").contains(e.target) && e.target !== $("menuBtn")) $("menu").style.display = "none";
    });
    function toggle(id) {
        const show = $(id).style.display !== "flex";
        closePanels();
        $(id).style.display = show ? "flex" : "none";
    }

    let palette = null, texts = null;
    function renderPalette() {
        const filter = $("paletteFilter").value.trim().toLowerCase();
        const match = n => !filter || n.toLowerCase().includes(filter);
        const list = $("paletteList");
        list.innerHTML = "";
        if (state.carried) return renderTexts(filter, list);
        // mark(name): text shown after each name. Items are piece names, or { label, piece }.
        const section = (title, items, mark = () => "") => {
            const all = items.map(x => (typeof x === "string" ? { label: x, piece: x } : x)).filter(x => match(x.label));
            const head = document.createElement("div");
            head.className = "head";
            head.textContent = `${title} (${all.length})`;
            list.appendChild(head);
            for (const x of all.slice(0, 300)) {
                const row = document.createElement("div");
                row.textContent = x.label + mark(x.label);
                row.addEventListener("click", () => addPiece(x.piece).catch(fail));
                list.appendChild(row);
            }
        };
        // ◇: a placeholder shape (docs Shape lines); ▢: nothing yet, a labeled box.
        const shaped = new Set(palette.shaped);
        section("New assets (docs) ◇ shape, ▢ box", palette.newAssets, n => (shaped.has(n) ? " ◇" : " ▢"));
        // Reuses by docs name ("Tablet → RuinTablet"); placed as the prefab itself.
        section("Reused (docs)", (palette.reuses || []).map(r => ({ label: `${r.name} → ${r.prefab}`, piece: r.prefab })));
        section("Unity prefabs", palette.prefabs);
    }
    // Text ids by English.txt section, each with its first line; a typed id not there can be used too.
    function renderTexts(filter, list) {
        const current = textIdOf(state.carried.extra);
        const row = (label, id) => {
            const r = document.createElement("div");
            r.textContent = label;
            if (id === current) r.style.color = "var(--accent, #7fd4ff)";
            r.addEventListener("click", () => setText(id));
            list.appendChild(r);
        };
        const typed = $("paletteFilter").value.trim();
        if (typed && !/[,|]/.test(typed) && !texts.some(x => x.id === typed)) row(`Use new id "${typed}"`, typed);
        const shown = texts.filter(x => !filter || `${x.id} ${x.preview}`.toLowerCase().includes(filter));
        let section = null;
        for (const x of shown) {
            if (x.section !== section) {
                section = x.section;
                const head = document.createElement("div");
                head.className = "head";
                head.textContent = section || "Texts";
                list.appendChild(head);
            }
            row(x.preview ? `${x.id} — ${x.preview}` : x.id, x.id);
        }
    }
    $("addBtn").onclick = async () => {
        try {
            // On an imported area, Add first makes a composed scene on it; the area stays read-only.
            if (state.carried) {
                texts = texts || (await call("GET", "/api/texts")).texts;
                $("paletteFilter").placeholder = "Filter text ids";
            } else {
                if (state.scene.kind === "area" && !await newScene(state.scene.name)) return;
                palette = palette || await call("GET", "/api/palette");
                if (palette.shapeErrors.length) window.layoutError(`Shape lines: ${palette.shapeErrors.join("; ")}`);
                $("paletteFilter").placeholder = "Filter pieces";
            }
            $("paletteFilter").value = "";
            toggle("palette");
            renderPalette();
        } catch (error) {
            fail(error);
        }
    };
    $("paletteFilter").oninput = renderPalette;
    $("paletteClose").onclick = closePanels;
    $("dropBtn").onclick = drop;
    $("cancelBtn").onclick = cancel;
    $("deleteBtn").onclick = remove;
    $("labelsBtn").onclick = () => {
        state.labels = !state.labels;
        refreshLabels();
        updateUi();
    };
    $("snapBtn").onclick = () => {
        state.snap = !state.snap;
        updateUi();
    };
    $("undoBtn").onclick = () => {
        if (!state.undo.length) return;
        state.redo.push(snapshot());
        restore(state.undo.pop());
    };
    $("redoBtn").onclick = () => {
        if (!state.redo.length) return;
        state.undo.push(snapshot());
        restore(state.redo.pop());
    };
    $("scale").oninput = () => {
        const size = Math.pow(2, +$("scale").value);
        showScale(size);
        if (state.carried) state.carried.factor = size / state.carried.base;
    };
    $("saveBtn").onclick = async () => {
        try {
            await call("POST", "/api/save", { name: state.scene.name, pieces: state.pieces });
            state.dirty = false;
            updateUi();
            say(`Saved ${state.pieces.length} pieces to docs/scenes/${state.scene.name}.md`);
        } catch (error) {
            fail(error);
        }
    };
    // Makes a composed scene (on an area, if given) and opens it. Returns false if cancelled.
    async function newScene(area) {
        const on = area ? ` on ${area}` : "";
        const name = prompt(`New scene${on}, "<Type> <Name>" (e.g. Landmark Ring Forge):`);
        if (!name) return false;
        await call("POST", "/api/new", { name, area });
        await refreshList(`composed:${name}`);
        await loadScene(`composed:${name}`, Boolean(area));
        return true;
    }
    $("newBtn").onclick = () => newScene(state.scene && state.scene.kind === "area" ? state.scene.name : null).catch(fail);
    $("importBtn").onclick = () => toggle("importPanel");
    $("importClose").onclick = closePanels;
    $("extractBtn").onclick = async () => {
        try {
            say("Extracting…");
            const result = await call("POST", "/api/extract", {
                scene: $("unityScene").value,
                center: [$("cx").value, $("cy").value, $("cz").value],
                half: $("half").value,
                name: $("areaName").value
            });
            closePanels();
            await refreshList(`area:${result.name}`);
            await loadScene(`area:${result.name}`);
        } catch (error) {
            fail(error);
        }
    };
    $("foldersBtn").onclick = () => {
        const counts = new Map();
        for (const o of allObjects()) counts.set(o.userData.folder, (counts.get(o.userData.folder) || 0) + 1);
        const panel = $("folders");
        panel.innerHTML = "";
        for (const [folder, n] of [...counts].sort()) {
            const row = document.createElement("label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !state.hiddenFolders.has(folder);
            box.onchange = () => {
                if (box.checked) state.hiddenFolders.delete(folder);
                else state.hiddenFolders.add(folder);
                for (const o of allObjects()) if (o.userData.folder === folder) o.visible = box.checked;
                refreshLabels();
            };
            row.append(box, ` ${folder} (${n})`);
            panel.appendChild(row);
        }
        const close = document.createElement("button");
        close.textContent = "Close";
        close.onclick = closePanels;
        panel.appendChild(close);
        toggle("folders");
    };
    $("texturesBtn").onclick = () => {
        state.textures = !state.textures;
        $("texturesBtn").classList.toggle("on", state.textures);
        if (!state.carried) rebuildWorld();
    };
    $("fullBtn").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
    $("sceneSelect").onchange = e => loadScene(e.target.value).catch(fail);
    window.addEventListener("beforeunload", e => {
        if (state.dirty) e.preventDefault();
    });

    // ---------- live reload ----------
    // The server sends its run id; a new id means it restarted after an edit. Reload then,
    // unless there are unsaved changes, in which case offer it.
    let serverRun = null;
    const events = new EventSource("/events");
    events.onmessage = e => {
        if (serverRun === null) {
            serverRun = e.data;
        } else if (e.data !== serverRun) {
            if (!state.dirty) {
                location.reload();
            } else {
                $("reloadBtn").style.display = "inline-block";
                say("layout was updated. Save, then tap Reload.");
            }
        }
    };
    $("reloadBtn").onclick = () => {
        if (!state.dirty || confirm("Discard unsaved changes and reload?")) {
            state.dirty = false;
            location.reload();
        }
    };

    // ---------- start ----------
    (async () => {
        try {
            const list = await refreshList();
            const saved = localStorage.getItem("layout.scene");
            const first = saved && $("sceneSelect").querySelector(`option[value="${CSS.escape(saved)}"]`) ? saved
                : list.composed.length ? `composed:${list.composed[0]}` : list.areas.length ? `area:${list.areas[0]}` : null;
            if (first) {
                $("sceneSelect").value = first;
                await loadScene(first);
            } else {
                say("No scenes yet. Tap New, or Import area.");
            }
        } catch (error) {
            fail(error);
        }
        updateUi();
    })();
})();
