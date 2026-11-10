// layout composer. See ../README.md for how it is used.
// Pieces are kept as Unity values ({ name, position, rotation, scale, extra }); Space converts.
(function () {
    const $ = id => document.getElementById(id);
    const Lights = window.CanopyLights.create(THREE); // Canopy's point lights (More Lights phase 4)
    const status = $("status");

    // ---------- state ----------
    const state = {
        scene: null,          // { name, kind: "composed" | "area", editable }
        pieces: [],           // Unity values
        objects: [],          // Three.js group per piece, same order
        area: null,           // the imported area a composed scene sits on ("- Area:" line), or null
        also: [],             // other areas drawn alongside (☰ Areas, and a composed scene's later Area lines)
        withAreas: [],        // those unity.json says go with the scene (Hawthorn's outland, Black Isle)
        areaStages: {},       // each area's { from, auto }: when ☰ Fast forward loads it (server.js areaStage)
        areaLines: [],        // a composed scene's Area lines (the first is area)
        areaNames: [],        // every imported area, for ☰ Areas
        sceneSymbols: {},     // symbols of the Unity scenes of areas drawn alongside, by scene
        base: [],             // those areas' pieces: drawn, snapped onto, never picked up or saved
        baseObjects: [],
        library: {},
        materials: {},        // Unity material guid -> description (colors, texture URLs)
        textures: true,
        fog: true,            // Canopy's fog (unity.json environment), on every material
        environment: null,    // the scene's unity.json environment: sun, ambient, fog, the sky's material and settings
        undo: [],
        redo: [],
        dirty: false,
        carried: null,        // { index (or -1 when new), object, rel, factor, original }
        snap: false,
        labels: false,        // name every piece, not only the placeholders
        hiddenFolders: new Set(),
        orbitDistance: 12,
        // ☰ Light's lighting checks (Ken, 2026-11-06), never remembered, so the page always opens
        // lit as the game is: no ambient light at all, and every normal map 10 times as strong.
        noAmbient: false,
        normalsTimes2: false,
        fullSunHighlight: false
    };

    // ---------- three.js ----------
    const canvas = $("view");
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true }); // smoothed in linearFrame (below)
    } catch (error) {
        throw new Error(`3D graphics (WebGL) could not start: ${error.message}. If the browser blocked it after a crash, close this tab and reopen it, or restart the browser.`, { cause: error });
    }
    // Lost 3D graphics (Ken, 2026-11-09: tabbing away and back lost them; Android takes a hidden
    // page's GPU context back): wait for the browser to give it back, when three.js rebuilds its
    // buffers, textures (their data is kept: bitmaps are never closed, compressed mips stay) and
    // programs by itself. Not back within GL_WAIT ms of the page being seen again: reload; the
    // camera and toggles come back from this browser's storage.
    const GL_WAIT = 5000;
    let glLost = 0, glTimer = 0;
    const glReload = () => {
        if (glLost && document.visibilityState === "visible") location.reload();
    };
    const glWatch = () => {
        clearTimeout(glTimer);
        if (glLost && document.visibilityState === "visible") glTimer = setTimeout(glReload, GL_WAIT);
    };
    canvas.addEventListener("webglcontextlost", e => {
        e.preventDefault(); // so the browser may restore it
        glLost = performance.now();
        console.warn("layout: 3D graphics lost; waiting for them to come back");
        say("3D graphics were taken back while the page was away; restoring…");
        glWatch();
    });
    canvas.addEventListener("webglcontextrestored", () => {
        console.warn(`layout: 3D graphics back after ${Math.round(performance.now() - glLost)} ms`);
        glLost = 0;
        clearTimeout(glTimer);
        say("3D graphics restored.");
    });
    document.addEventListener("visibilitychange", glWatch);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        const log = gl.getShaderInfoLog(fragment) || gl.getShaderInfoLog(vertex) || gl.getProgramInfoLog(program);
        window.layoutError(`A surface shader didn't compile: ${String(log).trim().split("\n").slice(0, 3).join(" | ")}`);
    };
    // Canopy draws in linear color space: what blends (additive glows, the skybeams' strands, all
    // that is see-through) adds up in linear, and only the sum is encoded for the screen. Drawn
    // straight to the canvas, each layer was encoded before it was added, so the faint edges of a
    // glow came out darker and overlaps turned white sooner; the orange skybeams looked white (Ken,
    // 2026-11-03). So the scene is drawn into an sRGB buffer, smoothed (4 samples, as the canvas
    // was), whose blending is in linear, then copied to the screen. WebGL 1 can't: straight to the
    // canvas, unsmoothed.
    const linearFrame = renderer.capabilities.isWebGL2 ? new THREE.WebGLRenderTarget(1, 1, { samples: 4, colorSpace: THREE.SRGBColorSpace }) : null;
    const toScreen = new THREE.Scene(), toScreenCamera = new THREE.OrthographicCamera();
    if (linearFrame) {
        const copy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
            uniforms: { frame: { value: linearFrame.texture } },
            vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
            fragmentShader: "uniform sampler2D frame;\nvarying vec2 vUv;\nvoid main() {\n    gl_FragColor = texture2D(frame, vUv);\n    #include <colorspace_fragment>\n}",
            depthTest: false, depthWrite: false, blending: THREE.NoBlending
        }));
        copy.frustumCulled = false;
        toScreen.add(copy);
    }
    // Fog by distance from the camera, as Canopy's shaders have it, not by depth along the view.
    THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace("- mvPosition.z", "length( mvPosition.xyz )");
    const scene = new THREE.Scene();
    // The plain lights, for scenes without a Sun piece (layout/scripts/Sun.js turns them off).
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x404040, 0.9);
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0.4, 1, 0.6);
    hemisphere.userData.plainLight = sun.userData.plainLight = true;
    scene.add(hemisphere, sun);
    // The scene's unity.json environment: the sun's direction and color and Canopy's fog (it keeps
    // exp2(-(density * distance)^2) of a color, Three.js exp(-(d * distance)^2)). The sky and the
    // sea are pieces with scripts (the Sky and Sea prefabs, which World brings).
    function applyEnvironment() {
        const env = state.environment;
        if (!env) return;
        applyLight(env);
        const w = env.leafWind;
        if (w) {
            leafWindUniforms.leafWind.value.set(w.sway, w.flutter, w.frequency, w.fadeDistance);
            leafWindUniforms.leafGust.value.set(w.gustLength, w.gustSpeed, w.gustShape);
            leafWindUniforms.leafNear.value.set(w.near, w.nearDistance);
        }
        leafWindUniforms.leafWaveGusts.value = state.gustKind === "waves" ? 1 : 0;
    }
    // The sun, fog and Canopy's globals from the environment: on a load, and each frame while the
    // game's light is worked out live (web/environment.js, stepped in frame()).
    function applyLight(env) {
        const [x, y, z] = env.sunDirection;
        sun.position.set(-x, y, z).normalize(); // Unity's world is Three.js's with X mirrored
        sun.color.set(env.sunColor);
        if (!state.fog) scene.fog = null;
        else if (scene.fog) {
            scene.fog.color.set(env.fogColor);
            scene.fog.density = env.fogDensity * Math.sqrt(Math.LN2);
        } else scene.fog = new THREE.FogExp2(env.fogColor, env.fogDensity * Math.sqrt(Math.LN2));
        Surface.setEnvironment(env, state.fog);
        if (state.noAmbient) Surface.uniforms.canopyAmbient.value.setRGB(0, 0, 0);
        // ☰ Light › Full sun highlight: General's highlight as the committed shader had it, the sun's
        // color as the inspector shows it (never made linear), without its intensity.
        if (state.fullSunHighlight) Surface.uniforms.canopySunHighlight.value.set(env.sunColor).convertLinearToSRGB();
        hemisphere.intensity = state.noAmbient ? 0 : 0.9; // Three.js's own materials' ambient
    }
    // The game's EnvironmentManager (web/environment.js), from where the camera is, each frame;
    // unity.json's environment stands until its first step.
    function stepEnvironment(dt) {
        const env = state.environment;
        if (!env || !env.live) return;
        const sea = Surface.uniforms.canopySeaLevel.value;
        if (!Environment.step(env, [-camera.position.x, camera.position.y, camera.position.z], dt, sea > -1e8 ? sea : null)) return;
        applyLight(env);
        if (state.fogClip) applyClip();
    }
    const world = new THREE.Group();
    scene.add(world);
    // Wireframe: every visible triangle's edges drawn over the lit surfaces (a second pass of the
    // world alone, so the sky and sea stay plain).
    const wireScene = new THREE.Scene();
    wireScene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, wireframe: true, transparent: true, opacity: 0.55 });
    function drawWireframe() {
        wireScene.add(world);
        wireScene.fog = scene.fog;
        renderer.autoClear = false;
        renderer.render(wireScene, camera);
        renderer.autoClear = true;
        scene.add(world);
    }
    // Near and far planes: the game's, from unity.json (near, far) when a scene loads; the game's
    // 0.03 to 400 m also keeps enough depth precision that far crossings (trunks at the sea) don't flicker.
    const camera = new THREE.PerspectiveCamera(55, 1, 0.03, 400);
    // What scripts (web/tickable.js) work with.
    Tickable.use({ THREE, scene, camera, environment: () => state.environment, leafWind: () => leafWindUniforms, windLevels: () => ({ constantLevel: state.windLevel, gustLevel: state.gustLevel, cylinderGusts: state.gustKind === "cylinders" }), texture, material: guid => materialFor(guid, false), describe: guid => (state.materials || {})[guid] || null, textures: () => state.textures, gravity: () => {
        if (typeof state.gravity !== "number") throw new Error("no gravity: the scene reply carried none (server.js, tools/scene.js physicsGravity)");
        return state.gravity;
    }, gateHolds: (when, piece) => state.conditions === "saved" || Conditions.allHold(when, symbolsNow(piece)), hideMeshes: (top, meshes, key) => Play.hideGroup(top, meshes, key) });
    camera.position.set(0, 5, 15);
    camera.lookAt(0, 0, 0);

    // ---------- usage ----------
    // How often each control is used (Ken, 2026-11-08: records for future revisions of the menu):
    // every button tapped, by its menu and label ("Light › Fog", "☰ Game mode"), and game mode's
    // takes, drops, hops and misses ("game: take"), counted here and sent every 20 s (and as the page
    // is hidden) to the server's usage.json.
    const Usage = (() => {
        let pending = {}, any = false;
        const count = name => {
            pending[name] = (pending[name] || 0) + 1;
            any = true;
        };
        function flush() {
            if (!any) return;
            const counts = pending;
            pending = {};
            any = false;
            fetch("/api/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ counts }), keepalive: true }).catch(() => {});
        }
        setInterval(flush, 20000);
        document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
        document.addEventListener("click", e => {
            const b = e.target.closest && e.target.closest("button");
            if (!b || b.classList.contains("back") || b.closest("#hudRings")) return;
            const sub = b.closest(".submenu");
            const label = (b.getAttribute("aria-label") || b.textContent || "").split(":")[0].replace(/[▸☰⛶]/g, "").trim() || b.id;
            count((sub ? sub.dataset.title + " › " : b.closest("#menu") ? "☰ " : "") + label);
        }, true);
        return { count };
    })();
    // Game mode's items, inventory and display (web/play.js).
    const Play = window.CanopyPlay.create({ THREE, camera, scene, world, count: Usage.count, atGemStation: () => atGemStation(), objectOfPath: path => objectOfPath(path), inCage: mesh => Boolean(((tapTarget(mesh) || {}).thing || {}).cage), onReset: () => startPaying(), onChange: () => regate(), wardensLeft: top => wardensLeft(top), guardedPiece: path => guardedPiece(path), onTaken: group => takenBack(group), cast: (a, b, skip) => cast(a, b, skip), gravity: () => {
        if (typeof state.gravity !== "number") throw new Error("no gravity: the scene reply carried none");
        return state.gravity;
    } });
    // For driving the page from outside (lens/drive.js js '...'; Claude, 2026-11-08): its state and
    // the Three.js objects, and lookAt, which puts the camera at one point looking at another
    // (Three's world: x mirrored from Unity's).
    window.Layout = {
        state, camera, world, scene, Play, THREE,
        lookAt(from, to) {
            camera.position.set(from[0], from[1], from[2]);
            camera.lookAt(to[0], to[1], to[2]);
            camera.updateMatrixWorld();
            return camera.position.toArray();
        }
    };
    const highlight = new THREE.BoxHelper(undefined, 0x4fb3ff);
    highlight.material.fog = false;
    highlight.visible = false;
    scene.add(highlight);

    // Darkened below the sea, as Canopy's shaders darken everything under the waterline.
    const underSea = m => {
        m.onBeforeCompile = shader => Surface.underSea(shader);
        return m;
    };
    const gray = underSea(new THREE.MeshStandardMaterial({ color: 0xb4b0a8, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
    const faded = underSea(new THREE.MeshStandardMaterial({ color: 0xb4b0a8, roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
    const wire = new THREE.MeshBasicMaterial({ color: 0xff8c1a, wireframe: true, fog: false });
    const unitCube = new THREE.BoxGeometry(1, 1, 1);

    function resize() {
        // The canvas size, not the window: on Android they differ while the address bar moves.
        const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        if (linearFrame) {
            const size = renderer.getDrawingBufferSize(new THREE.Vector2());
            linearFrame.setSize(size.x, size.y);
        }
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
        let leaves = null; // a leaf mesh cut to an area: "# leaves <count> <faces each> <kept index ranges>"
        let submeshes = null; // several: "# submeshes <faces in each>", the faces in that order
        for (const line of text.split("\n")) {
            const p = line.trim().split(/\s+/);
            if (p[0] === "#" && p[1] === "leaves") leaves = { per: +p[3], list: p.slice(4).flatMap(r => { const [a, b] = r.split("-").map(Number); return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i); }) };
            if (p[0] === "#" && p[1] === "submeshes") submeshes = p.slice(2).map(Number);
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
        if (leaves) g.userData.leaves = leaves;
        if (submeshes) g.userData.submeshes = submeshes;
        return g;
    }
    // A mesh and a renderer's material slots paired as Unity pairs them: slot i draws submesh i, a
    // submesh with no slot isn't drawn, and a slot past the last submesh draws that one again. The
    // same vertices, with three.js's groups for the ranges; each group needs a material (Mesh.raycast).
    const slottedGeometries = new WeakMap();
    function slotted(geometry, count) {
        if (!slottedGeometries.has(geometry)) slottedGeometries.set(geometry, new Map());
        const made = slottedGeometries.get(geometry);
        if (made.has(count)) return made.get(count);
        const g = new THREE.BufferGeometry();
        made.set(count, g);
        for (const [name, attribute] of Object.entries(geometry.attributes)) g.setAttribute(name, attribute);
        g.boundingSphere = geometry.boundingSphere;
        const sizes = geometry.userData.submeshes || [geometry.attributes.position.count / 3];
        let at = 0, last = 0;
        sizes.forEach((size, i) => {
            if (i < count) g.addGroup(at * 3, size * 3, i);
            if (size) last = i;
            at += size;
        });
        const lastAt = sizes.slice(0, last).reduce((a, b) => a + b, 0);
        for (let i = sizes.length; i < count; i++) g.addGroup(lastAt * 3, sizes[last] * 3, i);
        return g;
    }
    // The guids of a part's slots, or null for a mesh drawn whole in the one material. Slot 0 is
    // part.material, which gems change as the game does.
    const slotsOf = (part, geometry) => (part.materials ? [part.material, ...part.materials.slice(1)] : geometry.userData.submeshes ? [part.material] : null);
    // What a ray hit is drawn in: on a mesh with slots, its triangle's (three.js's face.materialIndex).
    function hitMaterial(hit, piece) {
        const part = hit.object.userData.part || {}, several = Array.isArray(hit.object.material);
        const slot = several ? hit.face.materialIndex : null;
        return { slot, guid: (piece && piece.material) || (slot ? part.materials[slot] : part.material), drawn: several ? hit.object.material[slot] : hit.object.material };
    }
    // A leaf's thinning rank, 0..1: the same integer hash as Canopy's LeafSplit.LeafRank.
    const leafRank = i => {
        let h = Math.imul(i, 2654435761 | 0) >>> 0;
        h = (h ^ (h >>> 16)) >>> 0;
        h = Math.imul(h, 2246822519 | 0) >>> 0;
        h = (h ^ (h >>> 13)) >>> 0;
        return (h & 0xFFFFFF) / 16777216;
    };
    // A LeafSplit tree's leaf mesh with each leaf's rank and middle on its vertices, for the
    // thinning in the leaf material (thinPatch), and its stem, tip and face, for the wind
    // (windPatch). Leaves are runs of faces, in LeafSplit's order. The stem is the middle of the
    // leaf's corners at uv.y 0 and the tip of those at 1, as LeafSplit places its leaves.
    function leafGeometry(base, split) {
        const g = base.clone();
        const count = g.attributes.position.count, tris = count / 3;
        const per = base.userData.leaves ? base.userData.leaves.per : tris / split.leafCount;
        const list = base.userData.leaves ? base.userData.leaves.list : Array.from({ length: Math.round(tris / per) }, (_, i) => i);
        const p = g.attributes.position.array, uv = g.attributes.uv && g.attributes.uv.array;
        const rank = new Float32Array(count), centre = new Float32Array(count * 3);
        const stems = new Float32Array(count * 3), tips = new Float32Array(count * 3), faces = new Float32Array(count * 3);
        list.forEach((leaf, j) => {
            const first = j * per * 3, last = (j + 1) * per * 3;
            const c = [0, 0, 0];
            for (let k = first; k < last; k++) for (let a = 0; a < 3; a++) c[a] += p[k * 3 + a] / (last - first);
            const end = want => { // the middle of the corners at uv.y want (0 the stem, 1 the tip)
                const e = [0, 0, 0];
                let n = 0;
                for (let k = first; k < last; k++) {
                    if (Math.abs(uv[k * 2 + 1] - want) > 0.01) continue;
                    for (let a = 0; a < 3; a++) e[a] += p[k * 3 + a];
                    n++;
                }
                return n ? e.map(v => v / n) : c;
            };
            const stem = uv ? end(0) : c, tip = uv ? end(1) : c;
            const q = first * 3, u = [p[q + 3] - p[q], p[q + 4] - p[q + 1], p[q + 5] - p[q + 2]], w = [p[q + 6] - p[q], p[q + 7] - p[q + 1], p[q + 8] - p[q + 2]];
            const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            const len = Math.hypot(...n) || 1;
            for (let k = first; k < last; k++) {
                rank[k] = leafRank(leaf);
                centre.set(c, k * 3);
                stems.set(stem, k * 3);
                tips.set(tip, k * 3);
                faces.set(n.map(v => v / len), k * 3);
            }
        });
        g.setAttribute("leafRank", new THREE.BufferAttribute(rank, 1));
        g.setAttribute("leafCenter", new THREE.BufferAttribute(centre, 3));
        g.setAttribute("leafStem", new THREE.BufferAttribute(stems, 3));
        g.setAttribute("leafTip", new THREE.BufferAttribute(tips, 3));
        g.setAttribute("leafFace", new THREE.BufferAttribute(faces, 3));
        return g;
    }
    // Downloads, a few at a time, each tried up to three times (Claude, 2026-10-29: the whole Tangle
    // asked for 1806 meshes at once and the phone's browser failed some with "Failed to fetch"). A
    // response that is an error status isn't retried; resolves to the Response, or null.
    const fetchQueue = [];
    let fetching = 0;
    function queuedFetch(url) {
        return new Promise(resolve => {
            fetchQueue.push({ url, resolve, tries: 0 });
            pumpFetches();
        });
    }
    function pumpFetches() {
        while (fetching < 12 && fetchQueue.length) {
            const job = fetchQueue.shift();
            fetching++;
            fetch(job.url).then(r => {
                fetching--;
                job.resolve(r);
                pumpFetches();
            }, error => {
                fetching--;
                if (++job.tries < 3) setTimeout(() => { fetchQueue.push(job); pumpFetches(); }, 500 * job.tries);
                else {
                    job.resolve(null);
                    reportFailedFetch(job.url, error);
                }
                pumpFetches();
            });
        }
    }
    let failedFetches = 0;
    function reportFailedFetch(url, error) {
        if (failedFetches++ === 0) setTimeout(() => window.layoutError(`${failedFetches} download${failedFetches === 1 ? "" : "s"} failed after three tries (the first: ${url}: ${error.message})`), 3000);
    }
    function geometryFor(part) {
        if (part.mesh && part.mesh.kind === "builtin") {
            return Promise.resolve(builtin(part.mesh.name));
        }
        if (!part.obj) {
            return Promise.resolve(null);
        }
        if (!geometries.has(part.obj)) {
            geometries.set(part.obj, queuedFetch(part.obj).then(r => (r && r.ok ? r.text() : null)).then(t => (t ? parseObj(t) : null)));
        }
        if (part.leafSplit) {
            const key = part.obj + "|leaves";
            if (!geometries.has(key)) geometries.set(key, geometries.get(part.obj).then(g => (g ? leafGeometry(g, part.leafSplit) : null)));
            return geometries.get(key);
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
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, "#ffb060"), depthTest: false, fog: false }));
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
        if (!shapeMaterials.has(color)) shapeMaterials.set(color, underSea(new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true, side: THREE.DoubleSide })));
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
        else if (shape.kind === "octahedron" || shape.kind === "icosahedron") {
            // An octahedron has a point up, an icosahedron an edge; each rests on its lowest corners.
            geometry = shape.kind === "octahedron" ? new THREE.OctahedronGeometry(a / 2) : new THREE.IcosahedronGeometry(a / 2);
            geometry.computeBoundingBox();
            geometry.translate(0, -geometry.boundingBox.min.y, 0);
        }
        else if (shape.kind === "ico60") geometry = ico60Geometry(a);
        else if (shape.kind === "prism") {
            const triangle = new THREE.Shape([new THREE.Vector2(-a / 2, 0), new THREE.Vector2(a / 2, 0), new THREE.Vector2(0, b)]);
            geometry = new THREE.ExtrudeGeometry(triangle, { depth: c, bevelEnabled: false }).translate(0, 0, -c / 2);
        } else throw new Error(`unknown shape ${shape.kind}`);
        const placed = Space.pieceMatrix(THREE, { position: shape.at, rotation: shape.turn, scale: shape.scale || [1, 1, 1] });
        const named = !tint && shape.materialGuid && state.textures ? materialFor(shape.materialGuid, false) : null;
        // A named material may shade by object space: bake the placement in, so its vertices are
        // where make-shapes.js puts them in the placeholder model.
        if (named) geometry.applyMatrix4(placed);
        const mesh = new THREE.Mesh(geometry, tint || named || shapeMaterial(shape.color || "#c9a66b"));
        mesh.matrixAutoUpdate = false;
        if (!named) mesh.matrix.copy(placed);
        return mesh;
    }
    // A triakis icosahedron, size point to point, resting on its lowest corners, as
    // tools/shape-mesh.js makes it: a low three-sided pyramid on each face of an icosahedron,
    // its apex 0.855 as far out as the icosahedron's corners.
    function ico60Geometry(size) {
        const apexOut = (5 + 7 * Math.sqrt(5)) / 22 * Math.sqrt(3) / Math.hypot(1, (1 + Math.sqrt(5)) / 2);
        const p = new THREE.IcosahedronGeometry(1).attributes.position, corners = [];
        for (let i = 0; i < p.count; i += 3) {
            const f = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, i + k));
            const apex = f[0].clone().add(f[1]).add(f[2]).normalize().multiplyScalar(apexOut);
            for (let k = 0; k < 3; k++) corners.push(apex, f[k], f[(k + 1) % 3]);
        }
        for (let i = 0; i < corners.length; i += 3) {
            const [a, b, c] = corners.slice(i, i + 3);
            const n = b.clone().sub(a).cross(c.clone().sub(a));
            if (n.dot(a.clone().add(b).add(c)) < 0) [corners[i + 1], corners[i + 2]] = [c, b]; // outward
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(corners).scale(size / 2, size / 2, size / 2);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        return geometry.translate(0, -geometry.boundingBox.min.y, 0);
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
    // phone can't hold many of uncompressed. Where the GPU reads ASTC (astcTexture) they come at
    // the size the game draws them instead, at a quarter to a ninth of the memory.
    const MAX_TEXTURE = 1024;
    const textures = new Map();
    const textureMemory = { astc: 0, astcs: 0, png: 0, pngs: 0 }; // bytes on the GPU and how many, for layout.log
    const dressed = (tex, t, srgb) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(t.scale[0], t.scale[1]);
        tex.offset.set(t.offset[0], t.offset[1]);
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return tex;
    };
    // A texture's compressed copy (tools/texture-astc.js, which describes the file), with its
    // mipmaps; null without one or where the GPU can't read ASTC, for the PNG instead.
    async function astcTexture(t, srgb) {
        if (!t.astc || !renderer.extensions.has("WEBGL_compressed_texture_astc")) return null;
        const response = await queuedFetch(t.astc);
        if (!response || !response.ok) return null;
        const buffer = await response.arrayBuffer();
        const head = new DataView(buffer);
        if (head.getUint32(0, true) !== 0x3141544c) return null; // LTA1
        const count = head.getUint32(4, true), block = head.getUint32(8, true);
        const mipmaps = [];
        for (let i = 0, at = 16 + count * 12; i < count; i++) {
            const size = head.getUint32(24 + i * 12, true);
            mipmaps.push({ data: new Uint8Array(buffer, at, size), width: head.getUint32(16 + i * 12, true), height: head.getUint32(20 + i * 12, true) });
            at += size;
        }
        const format = block === 4 ? THREE.RGBA_ASTC_4x4_Format : THREE.RGBA_ASTC_6x6_Format;
        textureMemory.astc += buffer.byteLength;
        textureMemory.astcs++;
        return dressed(new THREE.CompressedTexture(mipmaps, mipmaps[0].width, mipmaps[0].height, format), t, srgb);
    }
    // srgb: whether its slot takes colors; a texture's own import setting decides when known
    // (t.srgb, tools/guid-index.js), as Unity decodes each by its own.
    function texture(t, slotSrgb) {
        if (!t || !t.url) return Promise.resolve(null);
        const srgb = typeof t.srgb === "boolean" ? t.srgb : slotSrgb;
        const key = `${t.url}|${t.astc}|${t.scale}|${t.offset}|${srgb}`;
        if (!textures.has(key)) {
            textures.set(key, astcTexture(t, srgb).catch(() => null).then(async compressed => {
                if (compressed) return compressed;
                const response = await queuedFetch(t.url);
                const blob = response && response.ok ? await response.blob() : null;
                if (!blob) return null;
                // Colors as the file has them, not multiplied by alpha (the browser's default): Unity
                // and Three.js keep them apart, and a texture whose alpha its shader ignores (the
                // flamers' Lava.tga, alpha mostly near 0) came out black (Claude, 2026-10-29).
                const full = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
                const k = Math.min(1, MAX_TEXTURE / Math.max(full.width, full.height));
                const bitmap = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: "medium", imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
                full.close();
                const tex = new THREE.Texture(bitmap);
                tex.flipY = false; // flipped while decoding
                textureMemory.png += bitmap.width * bitmap.height * 16 / 3; // RGBA, and a third more for its mipmaps
                textureMemory.pngs++;
                return dressed(tex, t, srgb);
            }).catch(() => null));
        }
        return textures.get(key);
    }
    const materials = new Map();
    // A Three.js material for a Unity material. Canopy/General is base * detail * tint *
    // brightness; its color is scaled back under 1 so hue survives Unity's dimmer lighting.
    // LeafSplit's thinning (Canopy's LeafSplit.cs; tools/scene.js sends its settings): a leaf whose
    // rank nears the share kept at its distance shrinks to nothing over the last `fade` of ranks
    // (5%), and every leaf shrinks over the last 10% of the distance limit, instead of blinking
    // out (Ken, 2026-10-26); with grow, the leaves left scale by 1/sqrt(keep). About its middle.
    const thinPatch = split => shader => {
        const t = split.thin;
        shader.uniforms.leafThin = { value: new THREE.Vector4(t.start, t.end, t.keep, t.grow ? 1 : 0) };
        shader.uniforms.leafMax = { value: split.maxDistance };
        shader.uniforms.leafFade = { value: t.fade ?? 0.05 };
        shader.vertexShader = "attribute vec3 leafCenter;\nattribute float leafRank;\nuniform vec4 leafThin;\nuniform float leafMax;\nuniform float leafFade;\n" + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\tfloat leafD = distance((modelMatrix * vec4(leafCenter, 1.0)).xyz, cameraPosition);
\t\tfloat keep = mix(1.0, leafThin.z, clamp((leafD - leafThin.x) / max(leafThin.y - leafThin.x, 0.001), 0.0, 1.0));
\t\tfloat size = leafThin.z < 1.0 ? clamp((keep - leafRank) / max(leafFade, 1e-4), 0.0, 1.0) : 1.0;
\t\tsize *= clamp((leafMax - leafD) / (0.1 * leafMax), 0.0, 1.0);
\t\tif (leafThin.w > 0.5 && leafThin.z < 1.0) size *= inversesqrt(keep);
\t\ttransformed = leafCenter + (transformed - leafCenter) * size;
\t}`);
    };
    // LeafSplit's leaves in the wind, as Canopy's iLeafCutWind shader moves them (see it for the
    // why): blown, each leaf turns about its stem, rigidly, its tip toward its own axis plus some of
    // downwind (leaning) and of its face's direction (fluttering), each leaf at its own rate and
    // phase; only a share of it near the eye, none far away. The wind is a steady one everywhere plus
    // gusts, added and never past strong; lean, wobble and flutter all follow their sum.
    // LeafGust (scripts/LeafGust.js) sets leafWindNow (the steady wind's direction x and z, its
    // strength, the gusts', in Unity's XZ) and its cylinders (leafGusts: centre, radius, life;
    // leafGustDirs: heading, soft edge), tested by squared distance; ☰ World's gusts as waves turns on
    // the wave gusts instead, travelling downwind and lulling to stillness between them. Its settings
    // are unity.json's environment leafWind (applyEnvironment); the levels ☰ World's (windLevels).
    const leafWindUniforms = {
        leafWindNow: { value: new THREE.Vector4(1, 0, 0, 0) },  // LeafGust's: the steady wind's direction x, z (Unity), its strength, the gusts'
        leafWind: { value: new THREE.Vector4(0, 0, 1, 1000) }, // sway, flutter, frequency, fadeDistance
        leafGust: { value: new THREE.Vector3(12, 4, 2) },       // gustLength, gustSpeed, gustShape (the wave gusts)
        leafNear: { value: new THREE.Vector2(1, 8) },           // near, nearDistance
        leafWaveGusts: { value: 0 },
        leafGusts: { value: [0, 1, 2].map(() => new THREE.Vector4()) },   // LeafGust's: centre x, z, radius, life (Unity)
        leafGustDirs: { value: [0, 1, 2].map(() => new THREE.Vector4()) } // heading x, z, soft edge (Unity)
    };
    const windPatch = shader => {
        Object.assign(shader.uniforms, leafWindUniforms, { canopyTime: Surface.uniforms.canopyTime });
        shader.vertexShader = "attribute vec3 leafStem;\nattribute vec3 leafTip;\nattribute vec3 leafFace;\nuniform vec4 leafWindNow;\nuniform vec4 leafWind;\nuniform vec3 leafGust;\nuniform vec2 leafNear;\nuniform float leafWaveGusts;\nuniform vec4 leafGusts[3];\nuniform vec4 leafGustDirs[3];\nuniform float canopyTime;\n" + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\tvec3 stem = (modelMatrix * vec4(leafStem, 1.0)).xyz;
\t\tvec3 axis = normalize((modelMatrix * vec4(leafTip, 1.0)).xyz - stem);
\t\tvec3 face = normalize(mat3(modelMatrix) * leafFace);
\t\tfloat h = fract(sin(dot(stem, vec3(127.1, 311.7, 74.7))) * 43758.5453);
\t\tfloat t = canopyTime;
\t\tfloat d = distance(cameraPosition, stem);
\t\tvec2 stemU = vec2(-stem.x, stem.z); // in Unity's XZ, as LeafGust's wind is
\t\tvec2 calm = leafWindNow.xy;
\t\tfloat steady = leafWindNow.z, gusts = leafWindNow.w;
\t\tfloat inGust = leafWaveGusts * pow(clamp(0.5 + 0.5 * sin(6.2832 * (dot(stemU, calm) - leafGust.y * t) / max(leafGust.x, 0.01)), 0.0, 1.0), leafGust.z);
\t\tvec2 down = (steady + gusts * inGust) * calm;
\t\tfor (int i = 0; i < 3; i++) {
\t\t\tvec4 g = leafGusts[i];
\t\t\tvec2 off = stemU - g.xy;
\t\t\tfloat inner = max(g.z - leafGustDirs[i].z, 0.0);
\t\t\tfloat e = clamp((dot(off, off) - inner * inner) / max(g.z * g.z - inner * inner, 1e-4), 0.0, 1.0);
\t\t\tfloat s = g.w * (1.0 - e * e * (3.0 - 2.0 * e));
\t\t\tinGust = max(inGust, s);
\t\t\tdown += gusts * s * leafGustDirs[i].xy;
\t\t}
\t\tfloat gust = min(gusts * inGust, 1.7 - steady); // added to the steady wind, never past strong (LeafGust's 1.7)
\t\tif (steady + gust > 0.0) {
\t\tvec3 windDir = dot(down, down) > 1e-8 ? normalize(vec3(-down.x, 0.0, down.y)) : vec3(-calm.x, 0.0, calm.y);
\t\tfloat wind = steady + gust;
\t\tfloat lean = leafWind.x * wind * (1.0 + 0.3 * sin(3.1416 * leafWind.z * t + 6.2832 * h));
\t\tfloat flap = leafWind.y * wind * sin(6.2832 * (leafWind.z * (0.8 + 0.4 * h) * t + h));
\t\tfloat share = mix(leafNear.x, 1.0, clamp(d / max(leafNear.y, 0.01), 0.0, 1.0)) * clamp(2.0 * (1.0 - d / max(leafWind.w, 0.01)), 0.0, 1.0);
\t\tvec3 blown = normalize(axis + share * (windDir * lean + face * flap));
\t\tvec3 k = cross(axis, blown);
\t\tfloat c = dot(axis, blown);
\t\tvec3 v = (modelMatrix * vec4(transformed, 1.0)).xyz - stem;
\t\tvec3 move = (c - 1.0) * v + cross(k, v) + k * (dot(k, v) / max(1.0 + c, 1e-4));
\t\ttransformed += inverse(mat3(modelMatrix)) * move;
\t\t}
\t}`);
    };
    // Branch strips (tools/tree-build.js): each vertex is a ring's centre, its normal the branch's
    // direction times its radius, uv.x its side (-1, 1), uv.y the bark's v. The vertex shader
    // moves it sideways, across the branch and the view, by the radius, so the strip faces the
    // camera as wide as the branch; the fragment shader shades it as a round cylinder (the normal
    // turns with the side) and wraps the bark around the half that faces the viewer.
    const stripPatch = shader => {
        shader.vertexShader = "varying float vStripSide;\nvarying vec3 vStripAcross;\nvarying vec3 vStripFacing;\n" + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\tfloat stripR = length(normal);
\t\tvec3 stripAxis = normal / max(stripR, 1e-6);
\t\tvec3 toCamera = normalize((inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz - position);
\t\tvec3 across = normalize(cross(stripAxis, toCamera));
\t\ttransformed = position + across * stripR * uv.x;
\t\tvStripSide = uv.x;
\t\tvStripAcross = normalize((modelViewMatrix * vec4(across, 0.0)).xyz);
\t\tvStripFacing = normalize((modelViewMatrix * vec4(normalize(toCamera - stripAxis * dot(toCamera, stripAxis)), 0.0)).xyz);
\t}`);
        shader.fragmentShader = "varying float vStripSide;\nvarying vec3 vStripAcross;\nvarying vec3 vStripFacing;\n" + shader.fragmentShader
            .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
\t{
\t\tfloat k = clamp(vStripSide, -1.0, 1.0);
\t\tnormal = normalize(normalize(vStripAcross) * k + normalize(vStripFacing) * sqrt(max(0.0, 1.0 - k * k)));
\t}`)
            .replace("#include <map_fragment>", `#ifdef USE_MAP
\tvec4 sampledDiffuseColor = texture2D(map, vec2(acos(clamp(vStripSide, -1.0, 1.0)) * 0.15915494, vMapUv.y));
\tdiffuseColor *= sampledDiffuseColor;
#endif`);
    };
    // Canopy/General's own lighting (Canopy's General.shader) in place of Three.js's: ambient
    // times the color, plus the sun (its color times its intensity) times N·L times the color,
    // plus its Blinn highlight, between the 8th and 64th power by gloss, _HighlightStrength (0.2
    // by default: a fifth) of the sun times gloss. The sun (canopySunLight, already times its intensity) and ambient are
    // web/surface.js's (Canopy's globals). gloss: the material's
    // _Glossiness, live. GlowLit and TransparentLit light as General does; GeneralCutout's
    // highlight is its own, the 8th power times gloss times the sun, when its _SpecularHighlights
    // (cutoutHighlights, 0 or 1; null for General's) is on. A glowing pixel has none (glowLitPatch).
    // Then up to four point or spot lights (More Lights phase 4, web/lights.js), each lit as the sun is,
    // by its color, falloff (Unity's shape: 1 / (1 + 25 x), x the distance over the range squared, 0 at
    // the range), a spot's cone and its weight, as CanopyLighting.cginc's CanopyLights; lights: the material's own four
    // (canopyLights, set per mesh as it draws). WebGL 1 can't index the arrays, so it draws none.
    const generalLight = (gloss, cutoutHighlights = null, strength = { value: 0.2 }, lights = { value: new THREE.Vector4() }) => shader => {
        for (const name of ["canopySunDirection", "canopySunLight", "canopySunHighlight", "canopyAmbient"]) shader.uniforms[name] = Surface.uniforms[name];
        Object.assign(shader.uniforms, Lights.uniforms);
        shader.uniforms.canopyLights = lights;
        shader.uniforms.canopyGloss = gloss;
        shader.uniforms.canopyHighlightStrength = strength;
        const highlight = cutoutHighlights === null ? "(canopyGloss == 0.0 ? 0.0 : mix(n8, n64, canopyGloss)) * canopyHighlightStrength * canopyGloss" : `n8 * canopyGloss * ${cutoutHighlights ? "1.0" : "0.0"}`;
        const lightHighlight = highlight.replace(/\bn8\b/g, "m8").replace(/\bn64\b/g, "m64");
        shader.fragmentShader = `uniform vec3 canopySunDirection;\nuniform vec3 canopySunLight;\nuniform vec3 canopySunHighlight;\nuniform vec3 canopyAmbient;\nuniform float canopyGloss;\nuniform float canopyHighlightStrength;\nuniform vec4 canopyLightPos[${Lights.MAX}];\nuniform vec4 canopyLightColor[${Lights.MAX}];\nuniform vec4 canopyLightSpot[${Lights.MAX}];\nuniform float canopyLightCount;\nuniform float canopyLightView;\nuniform vec4 canopyLights;\nfloat canopyGlowOff = 1.0;\n` + shader.fragmentShader
            .replace("#include <lights_fragment_begin>", `{
\t\tvec3 L = normalize((viewMatrix * vec4(canopySunDirection * vec3(-1.0, 1.0, 1.0), 0.0)).xyz); // Unity's world is Three.js's with X mirrored
\t\tvec3 H = normalize(L + normalize(vViewPosition));
\t\tfloat n2 = max(dot(normal, H), 0.0);
\t\tn2 *= n2;
\t\tfloat n8 = n2 * n2 * n2 * n2;
\t\tfloat n64 = n8 * n8 * n8 * n8 * n8 * n8 * n8 * n8;
\t\treflectedLight.indirectDiffuse = canopyAmbient * diffuseColor.rgb;
\t\treflectedLight.directDiffuse = max(dot(normal, L), 0.0) * canopySunLight * diffuseColor.rgb;
\t\treflectedLight.directSpecular = ${highlight} * canopySunHighlight * canopyGlowOff;
#if __VERSION__ >= 300
\t\tvec3 V = normalize(vViewPosition);
\t\tfloat reached = 0.0;
\t\tfor (int k = 0; k < 4; k++) {
\t\t\tfloat slot = canopyLights[k];
\t\t\treached += step(0.5, slot);
\t\t\tif (float(k) >= canopyLightCount) continue;
\t\t\tint index = int(slot);
\t\t\tfloat weight = clamp(fract(slot) / 0.99, 0.0, 1.0);
\t\t\tvec4 p = canopyLightPos[index];
\t\t\tvec3 toLight = p.xyz + vViewPosition; // the point is -vViewPosition
\t\t\tfloat d2 = max(dot(toLight, toLight), 1e-6);
\t\t\tvec3 Lk = toLight * inversesqrt(d2);
\t\t\tfloat x = d2 * p.w;
\t\t\tvec4 spot = canopyLightSpot[index];\n\t\t\tfloat cone = clamp((dot(-Lk, spot.xyz) - spot.w) * canopyLightColor[index].a, 0.0, 1.0);\n\t\t\tvec3 light = canopyLightColor[index].rgb * (clamp((1.0 - x) * 5.0, 0.0, 1.0) / (1.0 + 25.0 * x) * cone * weight);
\t\t\tfloat m2 = max(dot(normal, normalize(Lk + V)), 0.0);
\t\t\tm2 *= m2;
\t\t\tfloat m8 = m2 * m2 * m2 * m2;
\t\t\tfloat m64 = m8 * m8 * m8 * m8 * m8 * m8 * m8 * m8;
\t\t\treflectedLight.directDiffuse += max(dot(normal, Lk), 0.0) * light * diffuseColor.rgb;
\t\t\treflectedLight.directSpecular += ${lightHighlight} * light * canopyGlowOff;
\t\t}
\t\tif (canopyLightView > 0.5) { // ☰ Light › Light crowding: none gray, then blue, green, yellow, red
\t\t\tvec3 heat = reached < 0.5 ? vec3(0.08) : reached < 1.5 ? vec3(0.0, 0.2, 1.0) : reached < 2.5 ? vec3(0.0, 0.8, 0.1) : reached < 3.5 ? vec3(1.0, 0.85, 0.0) : vec3(1.0, 0.05, 0.0);
\t\t\treflectedLight.indirectDiffuse = heat * (0.4 + 0.6 * max(dot(normal, L), 0.0));
\t\t\treflectedLight.directDiffuse = vec3(0.0);
\t\t\treflectedLight.directSpecular = vec3(0.0);
\t\t}
#endif
\t}`)
            .replace("#include <lights_fragment_maps>", "")
            .replace("#include <lights_fragment_end>", "");
    };
    // Canopy/GlowLit's glows (More Lights phase 3), over generalLight: where the glow texture, at
    // its own tiling, is brighter than _GlowThreshold (its average; _GlowMode 1: its brightest
    // channel), its color squared times _GlowTint, _GlowBrightness and 1 / _GlowFogLevel glows and
    // the highlight goes (_GlowMode 1: the lit color too); plus the constant glow, _EmissionColor
    // times _EmissionMap (white without one) at _MainTex's tiling. Colors made linear, as Unity
    // does; the game's glow fade (_DetailGlowFadeLevel) is taken as 1, none.
    function glowLitPatch(d) {
        const v = (name, dflt) => (d.values && d.values[name]) || dflt;
        const srgb = c => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
        const st = t => new THREE.Vector4(...(t ? [...t.scale, ...t.offset] : [1, 1, 0, 0]));
        const u = {
            glowMap: { value: null }, glowST: { value: st(d.glow) }, glowOn: { value: 0 }, glowTint: { value: srgb(v("_GlowTint", [0.5, 0.5, 0.5])) },
            glowThreshold: { value: v("_GlowThreshold", [0.5])[0] }, glowBrightness: { value: v("_GlowBrightness", [100])[0] },
            glowFogLevel: { value: v("_GlowFogLevel", [1])[0] }, glowMode: { value: v("_GlowMode", [0])[0] },
            emissionColor: { value: srgb(v("_EmissionColor", [0, 0, 0])) }, emissionMap: { value: null }, emissionMapOn: { value: 0 }, mainST: { value: st(d.map) }
        };
        texture(d.glow, true).then(t => {
            if (t) {
                u.glowMap.value = t;
                u.glowOn.value = 1;
            }
        });
        texture(d.emission, true).then(t => {
            if (t) {
                u.emissionMap.value = t;
                u.emissionMapOn.value = 1;
            }
        });
        return shader => {
            Object.assign(shader.uniforms, u);
            shader.fragmentShader = "uniform sampler2D glowMap;\nuniform vec4 glowST;\nuniform vec3 glowTint;\nuniform float glowOn, glowThreshold, glowBrightness, glowFogLevel, glowMode;\nuniform vec3 emissionColor;\nuniform sampler2D emissionMap;\nuniform float emissionMapOn;\nuniform vec4 mainST;\n" + shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
\t{
\t\tvec3 glow = texture2D(glowMap, vUv * glowST.xy + glowST.zw).rgb;
\t\tfloat level = mix((glow.r + glow.g + glow.b) / 3.0, max(glow.r, max(glow.g, glow.b)), glowMode);
\t\tif (glowOn > 0.5 && level > glowThreshold) {
\t\t\ttotalEmissiveRadiance += glow * glow * glowTint * glowBrightness / glowFogLevel;
\t\t\tdiffuseColor.rgb *= 1.0 - glowMode;
\t\t\tcanopyGlowOff = 0.0;
\t\t}
\t\tif (any(greaterThan(emissionColor, vec3(0.0)))) totalEmissiveRadiance += emissionColor * (emissionMapOn > 0.5 ? texture2D(emissionMap, vUv * mainST.xy + mainST.zw).rgb : vec3(1.0));
\t}`);
        };
    }
    // Flat colors for diagnostic parts (tree-build.js candidates: caps cyan, strips inside tubes red).
    function debugMaterial(color, strip) {
        const key = `debug|${color}|${Boolean(strip)}`;
        if (!materials.has(key)) {
            const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
            if (strip) {
                m.onBeforeCompile = shader => stripPatch(shader);
                m.customProgramCacheKey = () => "strip";
            }
            materials.set(key, m);
        }
        return materials.get(key);
    }
    // An inspection model's look: lit in its color, both sides, see-through below opacity 1.
    function inspectMaterial(look) {
        const key = `inspect|${look.color}|${look.opacity}|${look.side}`;
        if (!materials.has(key)) {
            const see = look.opacity < 1;
            const side = look.side === "front" ? THREE.FrontSide : look.side === "back" ? THREE.BackSide : THREE.DoubleSide;
            materials.set(key, new THREE.MeshStandardMaterial({ color: look.color, roughness: 0.7, metalness: 0, side, transparent: see, opacity: look.opacity, depthWrite: !see }));
        }
        return materials.get(key);
    }
    function materialFor(guid, faint, split, strip) {
        // ☰ Surfaces › Unity's shaders: a material More Lights moved onto a Canopy shader drawn as its
        // copy on Unity's (tools/convert-materials.js; the server sends it as unity).
        const own = guid && state.materials[guid];
        const asUnity = Boolean(state.unityShaders && own && own.unity);
        const d = asUnity ? own.unity : own;
        if (!state.textures || !d) {
            if (!strip) return faint ? faded : gray;
            // a plain gray strip still has to widen
            if (!materials.has("strip|gray")) {
                const m = gray.clone();
                m.onBeforeCompile = shader => { Surface.underSea(shader); stripPatch(shader); };
                m.customProgramCacheKey = () => "sea+strip";
                materials.set("strip|gray", m);
            }
            return materials.get("strip|gray");
        }
        const key = `${guid}|${faint}${split ? "|" + JSON.stringify([split.thin, split.maxDistance]) : ""}${strip ? "|strip" : ""}${asUnity ? "|unity" : ""}`;
        if (materials.has(key)) return materials.get(key);
        // Faces as the Unity shader culls them (tools/scene.js cullOf); strips and LeafSplit's
        // leaves draw both sides, as the game does (front and back instances).
        const side = strip || split || d.cull === 'Off' ? THREE.DoubleSide : d.cull === 'Front' ? THREE.BackSide : THREE.FrontSide;
        // Some of Canopy's own shaders, drawn by name (web/surface.js byShader: the sea's surfaces,
        // Water, Force Field, CloudTextured, Goop, DiffuseGlow, RimLit), with their textures.
        const ported = !faint && d.shaderName && Surface.byShader(d, { side });
        if (ported) {
            ported.userData.drawnBy = d.shaderName; // the probe says which of layout's ports drew it
            if (ported.uniforms.seaNormal) texture(d.normal1 || d.normal, false).then(t => { if (t) ported.uniforms.seaNormal.value = t; });
            if (ported.uniforms.fieldMap) texture(d.map, true).then(t => { if (t) ported.uniforms.fieldMap.value = t; });
            if (ported.uniforms.noiseMap) texture(d.noise, true).then(t => { if (t) ported.uniforms.noiseMap.value = t; });
            if (ported.uniforms.normalMap) texture(d.normal, false).then(t => { if (t) ported.uniforms.normalMap.value = t; });
            materials.set(key, ported);
            return ported;
        }
        // A surface shader's material (web/surface.js); faint ones stay plain.
        if (d.surface && !faint) {
            materials.set(key, Surface.material(d, { side }));
            return materials.get(key);
        }
        // untinted: its shader never reads the color (tools/scene.js prepareMaterials). A see-through
        // one still takes its alpha as opacity, a stand-in for blending layout doesn't draw.
        // Made linear, as Unity hands a material's colors to its shaders in a Linear project (the
        // .mat keeps them in sRGB, as the inspector shows them); Three.js lights in linear too.
        const base = d.untinted ? [1, 1, 1] : new THREE.Color().setRGB(d.color[0], d.color[1], d.color[2], THREE.SRGBColorSpace).toArray();
        // Canopy/General and the shaders lit as it is (generalLight: GeneralCutout with its own
        // highlight, GlowLit with its glows, TransparentLit blended by its alpha; glass's
        // premultiplied highlight isn't drawn) take their color as bright as the game's, over 1 if
        // so; the rest, under Three.js's own lighting, are scaled down to fit under 1.
        const general = ["Canopy/General", "Canopy/GeneralCutout", "Canopy/GlowLit", "Canopy/TransparentLit"].includes(d.shaderName);
        const lit = brightness => {
            const c = base.map(v => v * brightness);
            const top = Math.max(...c);
            return top > 1 && !general ? c.map(v => v / top) : c;
        };
        const c = lit(d.brightness || 1);
        const opacity = faint ? 0.35 : d.transparent ? Math.min(1, d.color[3]) : 1;
        // Canopy/General's _Glossiness (a Blinn highlight, 8th to 64th power) as a stand-in roughness:
        // the Hut's silk shines a little (Ken, 2026-11-04).
        const gloss = d.general && d.values && d.values._Glossiness ? d.values._Glossiness[0] : 0;
        // Unity's Standard by its own smoothness and metallic: Three.js's roughness is Unity's
        // perceptual roughness, 1 - smoothness, and both are GGX, so Unity's shaders compare fairly
        // with Canopy's (More Lights phase 3, ☰ Surfaces › Unity's shaders).
        const standard = d.shader && d.shader.guid === "0000000000000000f000000000000000" && (d.shader.fileID === "46" || d.shader.fileID === "45");
        const value = (name, dflt) => (d.values && d.values[name] ? d.values[name][0] : dflt);
        const roughness = standard ? Math.min(1, Math.max(0, 1 - value("_Glossiness", 0.5))) : 0.85 - 0.5 * gloss;
        const metalness = standard && d.shader.fileID === "46" ? Math.min(1, Math.max(0, value("_Metallic", 0))) : 0;
        const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(...c), roughness, metalness, side, transparent: opacity < 1, opacity });
        // Canopy/General's _NormalStrength scales the normal map's tilt (Ken, 2026-11-04).
        const tilt = d.general && d.values && d.values._NormalStrength ? d.values._NormalStrength[0] : 1;
        m.userData.tilt = tilt; // _NormalStrength, live in Tweak; ☰ Surfaces › Normal maps × 2 scales it
        m.normalScale.setScalar(tilt * (state.normalsTimes2 ? 2 : 1));
        // Tweak's live vars set these as a drag goes (tweakLive): the detail texture's tiling, how
        // far toward white it is eased (its strength against the baked one) and the color's gain.
        m.userData.guid = guid;
        m.userData.lit = lit; // its color at a brightness (Canopy/General's _Brightness), linear
        m.userData.gloss = { value: gloss }; // generalLight's, live
        m.userData.highlight = { value: value("_HighlightStrength", 0.2) }; // and its _HighlightStrength
        if (general) m.userData.canopyLights = { value: new THREE.Vector4() }; // the drawing mesh's four lights (web/lights.js)
        m.userData.detail = { repeat: new THREE.Vector2(1, 1), ratio: { value: 1 }, gain: { value: 1 } };
        // Shader patches, applied in order: darkening under the sea, Canopy/General's lighting, LeafSplit's thinning and wind, the detail texture.
        const patches = [["sea", Surface.underSea]];
        // GeneralCutout's highlight switch is in the program's code, so in its cache key too
        const cutoutHighlights = d.shaderName === "Canopy/GeneralCutout" ? value("_SpecularHighlights", 1) > 0.5 : null;
        if (general) patches.push([cutoutHighlights === null ? "general" : "general-cutout" + Number(cutoutHighlights), generalLight(m.userData.gloss, cutoutHighlights, m.userData.highlight, m.userData.canopyLights)]);
        if (d.shaderName === "Canopy/GlowLit" && !faint) {
            m.defines = { ...(m.defines || {}), USE_UV: "" };
            patches.push(["glow", glowLitPatch(d)]);
        }
        if (split) patches.push(["thin", thinPatch(split)], ["wind", windPatch]);
        if (strip) patches.push(["strip", stripPatch]);
        const usePatches = () => {
            m.onBeforeCompile = shader => patches.forEach(([, p]) => p(shader));
            m.customProgramCacheKey = () => patches.map(([name]) => name).join("+");
        };
        usePatches();
        // Cutout materials (e.g. leaves) drop pixels whose texture alpha is under the cutoff.
        if (d.cutout) m.alphaTest = d.cutoff;
        texture(d.map, true).then(t => {
            if (t) {
                m.map = t;
                m.needsUpdate = true;
            }
        });
        texture(d.normal, false).then(t => {
            if (t && !strip) { // strips have no tangents: their normal comes from the shader
                m.userData.normalMap = t; // kept for ☰ Surfaces › Normal maps
                if (state.normalMaps) {
                    m.normalMap = t;
                    m.needsUpdate = true;
                }
            }
        });
        if (d.detail) {
            texture(d.detail, true).then(t => {
                if (!t) return;
                // Multiply the detail texture in, tiled by its own scale, as the Unity shader does.
                m.defines = { ...(m.defines || {}), USE_UV: "" };
                const live = m.userData.detail;
                if (!live.tiled) live.repeat.set(d.detail.scale[0], d.detail.scale[1]);
                patches.push(["detail", shader => {
                    shader.uniforms.detailMap = { value: t };
                    shader.uniforms.detailRepeat = { value: live.repeat };
                    shader.uniforms.detailOffset = { value: new THREE.Vector2(d.detail.offset[0], d.detail.offset[1]) };
                    shader.uniforms.detailRatio = live.ratio;
                    shader.uniforms.detailGain = live.gain;
                    shader.fragmentShader = "uniform sampler2D detailMap;\nuniform vec2 detailRepeat;\nuniform vec2 detailOffset;\nuniform float detailRatio;\nuniform float detailGain;\n" + shader.fragmentShader.replace(
                        "#include <map_fragment>",
                        "#include <map_fragment>\n\tdiffuseColor.rgb *= (1.0 + detailRatio * (texture2D(detailMap, vUv * detailRepeat + detailOffset).rgb - 1.0)) * detailGain;"
                    );
                }]);
                usePatches();
                m.needsUpdate = true;
            });
        }
        materials.set(key, m);
        return m;
    }

    // The box, in its piece's space, of every mesh of one LOD group (in one candidate set), which
    // a grid group's frustum test uses (see lodLevel). A strip's points are branch centres, its
    // radius the normal's length: grown by the largest.
    function growLodBox(group, part, geometry, local) {
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox.clone();
        if (part.strip) {
            const n = geometry.attributes.normal;
            let r = 0;
            for (let i = 0; n && i < n.count; i++) r = Math.max(r, Math.hypot(n.getX(i), n.getY(i), n.getZ(i)));
            box.expandByScalar(r);
        }
        box.applyMatrix4(local);
        const boxes = group.userData.lodBoxes || (group.userData.lodBoxes = {});
        const key = part.lod.key + ":" + (part.set || "");
        if (boxes[key]) boxes[key].union(box);
        else boxes[key] = box;
    }
    // ---------- conditions ----------
    // ☰ World › Conditions (Ken, 2026-10-29; web/conditions.js): which objects are on, and where, as the
    // game has them with its conditions met (met), as a new game starts the scene's stage (start), or
    // as the scene was saved (saved). An imported piece or part carries its gate (never, or when:
    // terms over the scene's symbols, which the server sends) and moved (where its triggers put it).
    // An object off in the mode is hidden; with ☰ World › Inactive it is drawn faint instead, scripts off.
    // A piece from an area drawn alongside (☰ Areas) carries its own Unity scene, and is tested
    // against that scene's symbols (its stage), not the scene being viewed.
    // In game mode the inventory's symbols join them (Play.symbols: DaggerCount and the like).
    const symbolsNow = piece => {
        const own = (((piece && piece.unityScene && (state.sceneSymbols || {})[piece.unityScene]) || state.symbols || {})[state.conditions] || {});
        return state.game ? { ...own, ...Play.symbols() } : own;
    };
    // Inventory gates (Ken, 2026-11-10): a piece gated on the inventory follows it in game mode, as
    // Canopy's EffectBoolTrigger does: the Tangle's dagger beacon (DaggerCount<1) goes out when the
    // dagger is collected, and comes back when game mode starts over. Built on, it is switched off and
    // on (shown, and its scripts, web/tickable.js top.userData.gateOff); built off, it is rebuilt
    // when its gate holds. A part's or particle system's gate is tested where it is drawn: parts
    // when the piece is built, particle systems each frame (web/tickable.js).
    const INVENTORY_SYMBOL = /\b(?:Thruster|Booster|Dagger|Headlamp)Count\b|\b(?:Amber|Fuel|Mana)Amount\b/;
    const inventoryGated = piece => Boolean(piece && piece.when && INVENTORY_SYMBOL.test(JSON.stringify(piece.when)));
    function regate() {
        for (const list of [state.baseObjects, state.objects]) {
            list.forEach((o, i) => {
                const piece = o.userData.piece;
                if (!inventoryGated(piece)) return;
                const on = pieceOn(piece);
                if (o.userData.builtOn) {
                    o.userData.gateOff = !on;
                    o.userData.off = !on && !state.inactive;
                    o.visible = shown(o);
                } else if (on) {
                    const fresh = buildObject(piece);
                    fresh.userData.pieceName = o.userData.pieceName;
                    fresh.userData.piece = piece;
                    world.remove(o);
                    world.add(fresh);
                    list[i] = fresh;
                }
            });
        }
    }
    const gateOf = (x, piece) => (x.never ? false : x.when ? Conditions.allHold(x.when, symbolsNow(piece)) : null);
    // ☰ Fast forward (Ken, 2026-11-08): a stage chosen there starts the game at it, as Canopy does
    // when Settings' starting stage is past the Tutorial (GameInit.RunFromSettings): the conditions
    // as that stage starts (the FastForwardSymbols of every stage before it), a ring locus of an
    // earlier stage gone (RingLocus.OnStage, unless keepDuringFastForward), a gem only on the loci
    // of that stage (GemLocus.OnStage), and game mode's inventory and rings from its
    // FastForwardConfig (web/play.js). The stage's conditions are World › Conditions' start mode,
    // which it switches to; with no stage chosen, start is the scene's own stage.
    // A stage's place in the order stages are played (Canopy's Stage.ValidStages; its number says
    // nothing of order: Hawthorn is 10, between Tangle 2 and Oak 3), null if none.
    const stageRank = name => {
        const i = state.fastForward && name ? state.fastForward.order.indexOf(name) : -1;
        return i < 0 ? null : i;
    };
    const stageFor = piece => state.ffStage || (((piece && piece.unityScene && (state.sceneSymbols || {})[piece.unityScene]) || state.symbols || {}).stage) || null;
    function startAt(ff, name, extra) {
        const at = ff.order.indexOf(name), out = {};
        const rankOf = id => ff.order.findIndex(n => ff.stages[n] === Number(id));
        for (const k of Object.keys(ff.symbols).sort((a, b) => rankOf(a) - rankOf(b))) if (rankOf(k) < at) Object.assign(out, ff.symbols[k]);
        return Object.assign(out, { StageName: name }, extra);
    }
    function applyFastForward() {
        const ff = state.fastForward;
        for (const set of [state.symbols, ...Object.values(state.sceneSymbols || {})]) {
            if (!set) continue;
            if (!set.startSaved) set.startSaved = set.start;
            set.start = state.ffStage && ff ? startAt(ff, state.ffStage, set.extra || {}) : set.startSaved;
        }
        Play.configure(ff, stageFor(null));
    }
    // A gem or ring locus's piece (part null) or gem (part) off as the stage starts (start mode only).
    function lociOff(piece, part) {
        const l = piece && piece.locus;
        if (!l || state.conditions !== "start") return false;
        const now = stageRank(stageFor(piece)), appear = stageRank(l.appear);
        if (now === null || appear === null) return false;
        if (l.kind === "RingLocus") return !part && !l.keep && now > appear;
        return Boolean(part && part.item && part.item.kind === "Gem") && appear !== now;
    }
    // Fast-forwarded, a piece of a place played after that stage isn't there yet (Ken, 2026-11-09:
    // to Beech, no Tangle; piece.from, the server's Conditions.placeStage; the Stronghold has none).
    function laterPlace(piece) {
        if (!state.ffStage || !piece || !piece.from) return false;
        const at = stageRank(state.ffStage), from = stageRank(piece.from);
        return at !== null && from !== null && from > at;
    }
    function pieceOn(piece) {
        if (laterPlace(piece) || lociOff(piece, null)) return false;
        // editing an assemblage in place: its placements in the scene beneath would draw it twice
        if (piece.placement && state.assemblagePrefab && piece.name === state.assemblagePrefab) return false;
        const saved = !/\binactive\b/.test(piece.extra || "");
        if (state.conditions === "saved") return saved;
        const gate = gateOf(piece, piece);
        return gate === null ? saved : gate;
    }
    function partOn(part, piece) {
        if (lociOff(piece, part)) return false;
        if (state.conditions === "saved") return !part.offSaved;
        const gate = gateOf(part, piece);
        return gate === null ? true : gate;
    }
    // The piece, placed where the mode has it.
    function placed(piece) {
        const mv = piece.moved;
        if (!mv || state.conditions === "saved" || !Conditions.allHold(mv.when, symbolsNow(piece))) return piece;
        return { ...piece, position: mv.position, rotation: mv.rotation, scale: mv.scale };
    }
    // A gate as text, for the probe: "when SkyIsle (holds)".
    function gateText(x, piece) {
        if (x.never) return "never on in the game";
        if (!x.when) return null;
        return `when ${x.when.map(Conditions.describe).join(" and ")} (${Conditions.allHold(x.when, symbolsNow(piece)) ? "holds" : "doesn't hold"} in ${state.conditions})`;
    }

    // A Three.js group for one piece; its parts load asynchronously. tint replaces its materials.
    function buildObject(piece, tint) {
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.matrix.copy(Space.pieceMatrix(THREE, placed(piece)));
        const entry = state.library[piece.name];
        group.userData.folder = folderOf(entry || (piece.source ? { source: piece.source } : null));
        const on = pieceOn(piece);
        group.userData.builtOn = on; // with its scripts and lights (regate)
        group.userData.off = !on && !state.inactive; // hidden (shown() checks it)
        group.visible = shown(group);
        const faint = !on;
        const parts = piece.parts || (entry ? entry.parts : []); // an imported instance may carry its own
        // LOD groups (see updateLods): meshes that are one level of a group start hidden.
        const lodGroups = piece.lodGroups || (entry && entry.lodGroups) || null;
        if (lodGroups && Object.keys(lodGroups).length) group.userData.lodGroups = lodGroups;
        // Its scripts (web/tickable.js): a layout prefab's, and a Unity prefab's C# ones with stand-ins
        // (an imported piece carries its own).
        const scripted = piece.parts ? piece : entry;
        if (scripted && scripted.scripts && on) Tickable.attach(scripted, group, piece);
        // its point Lights (More Lights phase 4, web/lights.js)
        const lights = piece.lights || (!piece.parts && entry && entry.lights);
        if (lights && on) group.userData.lights = lights;
        if (!piece.parts && entry && entry.shapes) {
            // Prefabs its "use" shapes nest, with LOD groups or sets: updateLods reaches them
            // through this piece (Ken, 2026-11-02: Cocoon Basket's basket and cocoons never showed).
            const lodChildren = [];
            for (const shape of entry.shapes) {
                const child = shapeMesh(shape, tint);
                group.add(child);
                if (child.userData.lodGroups || child.userData.sets) lodChildren.push(child);
                lodChildren.push(...(child.userData.lodChildren || []));
            }
            if (lodChildren.length) group.userData.lodChildren = lodChildren;
            return group;
        }
        if (!parts.length) {
            // a piece that is only a light: a small ball of its color, unlit, not a placeholder box;
            // one whose particle systems draw it (OutpostSkyBeamPfx's beam): those, no box or label
            // (Ken, 2026-11-09)
            const drawn = scripted && (scripted.scripts || []).some(sc => sc.name === "ParticleSystem" && sc.fields && !sc.off);
            if (piece.lights) for (const l of piece.lights) group.add(lightMarker(l));
            else if (!drawn) group.add(placeholder(new THREE.Matrix4(), piece.name));
            return group;
        }
        for (const part of parts) {
            const partFaint = faint || !partOn(part, piece);
            if (partFaint && !faint && !state.inactive) continue; // off in this mode
            const local = Space.partMatrix(THREE, part.m);
            const material = piece.material || part.material; // "material <Name>" in the piece's settings wins
            geometryFor(part).then(geometry => {
                if (geometry) {
                    const slots = tint || piece.material || part.inspect || part.debug ? null : slotsOf(part, geometry);
                    const mesh = slots ? new THREE.Mesh(slotted(geometry, slots.length), slots.map(guid => materialFor(guid, partFaint, part.leafSplit, part.strip)))
                        : new THREE.Mesh(geometry, tint || (part.inspect ? (material && state.textures ? materialFor(material, partFaint) : inspectMaterial(part.inspect)) : part.debug ? debugMaterial(part.debug, part.strip) : materialFor(material, partFaint, part.leafSplit, part.strip)));
                    if (part.debug || part.inspect) mesh.userData.debug = true;
                    // Unity draws by render queue, then distance; three.js by renderOrder, then depth.
                    // Queues past 2500 keep their order around the particles' 3000, which is
                    // renderOrder 0, as are the wind's ribbons and the markers (Ken, 2026-10-30: the
                    // sea, at 2950, drew over particles when its origin, under the camera, sorted
                    // nearer). Opaque meshes keep 0. The sky goes before all of them (renderOrder
                    // -1000: it tests no depth, so it covers anything drawn first; Ken, 2026-10-31:
                    // LeafOakMat, at 2902, is -98, and was covered when the sky was -2).
                    const queue = Math.max(...(slots || [material]).map(guid => (guid && state.materials[guid] && state.materials[guid].queue) || 0));
                    if (queue > 2500) mesh.renderOrder = queue - 3000;
                    if (part.mesh && part.mesh.name) mesh.userData.model = part.mesh.name; // Tweak swaps meshes by model
                    mesh.userData.part = part; // what Probe reports
                    if (part.strip) {
                        mesh.frustumCulled = false; // its points are branch centres; the shader widens it
                        mesh.userData.strip = true;
                    }
                    mesh.matrixAutoUpdate = false;
                    mesh.matrix.copy(local);
                    if (part.lod && group.userData.lodGroups) {
                        mesh.userData.lod = part.lod;
                        mesh.visible = false;
                        growLodBox(group, part, geometry, local);
                    }
                    if (part.set) {
                        mesh.userData.set = part.set;
                        mesh.visible = false;
                        group.userData.sets = true;
                    }
                    if ([mesh.material].flat().some(mm => mm && mm.userData && mm.userData.canopyLights)) Lights.track(mesh, group); // its lights (web/lights.js); after its LOD is set
                    group.add(mesh);
                } else {
                    const box = placeholder(local, part.mesh ? part.mesh.name : piece.name);
                    if (part.lod && group.userData.lodGroups) box.userData.lod = part.lod;
                    if (part.set) box.userData.set = part.set;
                    group.add(box);
                }
            });
        }
        return group;
    }
    // A light-only piece's mark: a 10 cm ball in its light's color.
    function lightMarker(l) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(l.color[0], l.color[1], l.color[2], THREE.SRGBColorSpace) }));
        ball.position.set(-l.at[0], l.at[1], l.at[2]);
        ball.userData.debug = true;
        return ball;
    }
    function rebuildBase() {
        state.pickedObject = null;
        highlight.visible = false;
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
        state.pickedObject = null;
        highlight.visible = false;
        for (const o of state.objects) world.remove(o);
        state.objects = state.pieces.map(p => {
            const o = buildObject(p);
            o.userData.pieceName = p.name;
            o.userData.piece = p;
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
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTextures.get(name), depthTest: false, sizeAttenuation: false, fog: false }));
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
        state.areaNames = list.areas;
        state.areaStages = list.areaStages || {};
        if (!Array.isArray(list.stageOrder)) throw new Error("the scene list has no stageOrder (server.js /api/list)");
        state.stageOrder = list.stageOrder;
        // Fast forward is a choice here (Ken, 2026-11-09: the chooser says FF: Beech, and a reload
        // opens that): the game's areas as that stage starts (loadScene)
        const ffGroup = document.createElement("optgroup");
        ffGroup.label = "Fast forward";
        for (const stage of list.stageOrder) {
            const o = document.createElement("option");
            o.value = `ff:${stage}`;
            o.textContent = `FF: ${stage}`;
            ffGroup.appendChild(o);
        }
        sel.appendChild(ffGroup);
        $("unityScene").innerHTML = list.unityScenes.map(n => `<option>${n}</option>`).join("");
        if (select) sel.value = select;
        return list;
    }
    // Textures, ☰ Snap, ☰ Labels, ☰ Fog, ☰ LOD tint, ☰ Tick and the rest are remembered per scene, in this
    // browser; a scene not seen before starts with these.
    const GUST_KINDS = ["cylinders", "waves"];
    const TOGGLES = { textures: true, normalMaps: true, lights: true, lightView: false, unityShaders: false, snap: false, labels: false, fog: true, lodTint: false, candidates: false, fogClip: false, culling: false, refCube: false, showOrigin: false, wireframe: false, ticking: true, inactive: false, conditions: "met", ffStage: "", windLevel: 1, gustLevel: 2, gustKind: "cylinders" };
    // the chooser's value for the scene open: ff:<stage> for a fast-forward, else kind:name
    const sceneValue = () => (state.scene.ff ? `ff:${state.scene.ff}` : `${state.scene.kind}:${state.scene.name}`);
    const togglesKey = () => `layout.toggles.${sceneValue()}`;
    function loadToggles() {
        let saved;
        try {
            saved = JSON.parse(localStorage.getItem(togglesKey())) || {};
        } catch {
            saved = {}; // unreadable or blocked storage: start fresh
        }
        for (const [name, start] of Object.entries(TOGGLES)) state[name] = typeof saved[name] === typeof start ? saved[name] : start;
        if (!Conditions.MODES.includes(state.conditions)) state.conditions = TOGGLES.conditions;
        for (const name of ["windLevel", "gustLevel"]) if (!(state[name] >= 0 && state[name] <= 3)) state[name] = TOGGLES[name];
        if (!GUST_KINDS.includes(state.gustKind)) state.gustKind = TOGGLES.gustKind;
    }
    function saveToggles() {
        if (!state.scene) return;
        try {
            localStorage.setItem(togglesKey(), JSON.stringify(Object.fromEntries(Object.keys(TOGGLES).map(name => [name, state[name]]))));
        } catch {
            // private window or storage blocked: the toggles just aren't remembered
        }
    }
    // The camera's place and direction, remembered per scene in this browser (saved about once a
    // second while it changes), so a scene opens where it was left.
    const cameraKey = () => `layout.camera.${sceneValue()}`;
    let cameraSaved = "", cameraSavedAt = 0;
    function saveCamera(now) {
        if (!state.scene || now - cameraSavedAt < 1000) return;
        cameraSavedAt = now;
        const value = JSON.stringify([...camera.position.toArray().map(v => +v.toFixed(3)), ...camera.quaternion.toArray().map(v => +v.toFixed(5))]);
        if (value === cameraSaved) return;
        cameraSaved = value;
        try {
            localStorage.setItem(cameraKey(), value);
        } catch {
            // storage blocked: the camera just isn't remembered
        }
    }
    function restoreCamera() {
        try {
            const v = JSON.parse(localStorage.getItem(cameraKey()));
            if (!Array.isArray(v) || v.length !== 7) return false;
            camera.position.fromArray(v, 0);
            camera.quaternion.fromArray(v, 3);
            cameraSaved = JSON.stringify(v);
            nearScene();
            return true;
        } catch {
            return false;
        }
    }
    // keepCamera: stay put (a new scene on the area being viewed covers the same ground).
    async function loadScene(value, keepCamera = false) {
        if (state.dirty && !confirm("Discard unsaved changes?")) {
            $("sceneSelect").value = sceneValue();
            return;
        }
        let [kind, ...rest] = value.split(":");
        let name = rest.join(":"), ff = null, alsoList = null;
        // ff:<stage>: the stage's own area (else the first the game shows then), the rest of what the
        // game shows at that stage alongside, conditions as it starts
        if (kind === "ff") {
            ff = name;
            const needed = ffAreasFor(ff);
            if (!needed.length) throw new Error(`Fast forward to ${ff}: no imported area is shown at that stage`);
            kind = "area";
            name = needed.includes(ff) ? ff : needed[0];
            alsoList = needed.filter(a => a !== name);
        }
        const started = performance.now(), before = { meshes: geometries.size, textures: textures.size };
        // the seconds counting up until the load says it's done (Ken, 2026-11-04: to see its timing)
        const title = ff ? `FF: ${ff}` : name;
        const loading = () => `Loading ${title}… ${Math.round((performance.now() - started) / 1000)} s`;
        say(loading());
        const ticking = setInterval(() => (status.textContent.startsWith(`Loading ${title}…`) ? say(loading()) : clearInterval(ticking)), 1000);
        const also = (alsoList || loadAlso(`${kind}:${name}`)).map(a => `&also=${encodeURIComponent(a)}`).join("");
        let data;
        try {
            data = await call("GET", `/api/scene?kind=${kind}&name=${encodeURIComponent(name)}${also}`);
        } catch (error) {
            clearInterval(ticking);
            say(`Loading ${name} failed after ${Math.round((performance.now() - started) / 1000)} s.`);
            throw error;
        }
        const fetched = performance.now();
        state.scene = { name, kind, editable: data.editable, ...(ff ? { ff } : {}) };
        state.unityScene = data.unityScene || null; // the Canopy scene an area is cut from
        state.assemblagePrefab = data.assemblagePrefab || null; // this working scene's prefab, if an assemblage
        if (!state.tweak) clearSelection(); // its pieces went with the old scene
        loadHidden();
        loadToggles();
        // fast-forwarded only as an FF: <stage> scene; any other opens as itself
        state.ffStage = ff || "";
        if (ff) state.conditions = "start";
        state.pieces = data.pieces;
        state.origin = data.origin || null; // an assemblage's root, "- Origin: x y z" (Unity axes)
        state.switch = data.switch || null; // "- Switch: ...": sets of inspect layers, one shown at a time
        if (state.switch && switchAt() < 0) showSwitch(0); // none of its sets shown alone yet: the first
        else updateSwitch();
        state.area = data.area || null;
        state.also = data.also || [];
        state.withAreas = data.withAreas || [];
        state.areaLines = data.areaLines || [];
        state.base = data.base || [];
        Object.assign(state.library, data.library);
        Object.assign(state.materials, data.materials || {});
        state.environment = data.environment || null;
        Environment.load(state.environment && state.environment.live); // eased from scratch: the first step snaps
        state.symbols = data.symbols || { met: {}, start: {} };
        state.sceneSymbols = data.sceneSymbols || {};
        state.fastForward = data.fastForward || null;
        state.immune = new Set(data.immune || []);
        if (typeof data.gravity !== "number") throw new Error("the scene reply has no gravity (server.js, tools/scene.js physicsGravity)");
        state.gravity = data.gravity; // Canopy's physics gravity (thrown items, particles) // the materials the dagger can't hurt (tools/scene.js daggerImmune)
        if (state.ffStage && !(state.fastForward && state.ffStage in state.fastForward.stages)) throw new Error(`Fast forward to ${state.ffStage}: no such stage in the scan (tools/conditions.js fastForward)`);
        applyFastForward();
        state.lodView = data.lod || { fov: 90, bias: 1 };
        state.clip = data.clip || { near: 0.03, far: 400 };
        state.cullSettings = data.culling || { perFrame: 0.05, margin: 6 };
        state.candidateCount = data.candidates || 0;
        applyClip();
        applyEnvironment();
        state.undo = [];
        state.redo = [];
        state.dirty = false;
        endCarry();
        rebuildBase();
        rebuildWorld();
        sceneExtent();
        if (!keepCamera && !restoreCamera()) frameAll();
        else if (!keepCamera) {
            const scene = state.scene;
            Promise.allSettled(geometries.values()).then(() => { if (state.scene === scene) nearScene(); });
        }
        localStorage.setItem("layout.scene", value);
        updateUi();
        const on = (state.area ? `, on ${state.area}` : "") + (state.also.length ? `, with ${state.also.join(", ")}` : "") + (state.area || state.also.length ? ` (${state.base.length}, read-only)` : "");
        clearInterval(ticking);
        say(`${title}: ${data.pieces.length} pieces, loaded in ${((performance.now() - started) / 1000).toFixed(1)} s${on}${data.problems.length ? `; ${data.problems.length} meshes failed` : ""}${data.editable ? "" : " (read-only; Add starts a scene on it)"}`);
        logLoad(name, started, fetched, before).catch(() => {});
        findTweaks().catch(fail);
        showRefCube();
        showOrigin();
    }
    // Tells layout.log how long the page took: the scene's JSON, then its meshes and textures,
    // which load after the scene appears (textures once their mesh is in).
    async function logLoad(name, started, fetched, before) {
        await Promise.all(geometries.values());
        await Promise.all(textures.values());
        const s = ms => `${(ms / 1000).toFixed(1)} s`;
        const mb = bytes => `${Math.round(bytes / 1048576)} MB`;
        const done = performance.now();
        const text = `${s(done - started)}: scene JSON ${s(fetched - started)}, meshes and textures ${s(done - fetched)}; downloaded ${geometries.size - before.meshes} meshes, ${textures.size - before.textures} textures; on the GPU ${textureMemory.astcs} compressed ${mb(textureMemory.astc)}, ${textureMemory.pngs} PNG ${mb(textureMemory.png)}; ASTC ${renderer.extensions.has("WEBGL_compressed_texture_astc") ? "yes" : "no"}`;
        await call("POST", "/api/loaded", { name, text });
    }
    // Shown: not in a folder ☰ Folders hides, and not culled (☰ Culling).
    function shown(o) {
        if (o.userData.duplicate) return false; // a second of a singleton (web/tickable.js)
        if (o.userData.off) return false; // off in ☰ World › Conditions' mode
        return !state.hiddenFolders.has(o.userData.folder) && !(state.culling && o.userData.culled);
    }
    // Where the fog hides farClip.threshold of the light (FarClipManager's distance; see applyClip).
    function fogDistance() {
        const clip = state.clip || {}, f = clip.fog || { threshold: 0.95, min: 10, max: 400 }, env = state.environment;
        if (!state.fog || !env || env.fogDensity <= 0.001) return f.max;
        return Math.min(f.max, Math.max(f.min, Math.sqrt(Math.log2(1 / Math.max(1e-6, 1 - f.threshold))) / env.fogDensity));
    }
    // ☰ Culling, a stand-in for Unity's CullingGroup: each frame a share of the pieces (perFrame,
    // in turn) is checked against its cull distance (tools/config.js cullDistance: unity.json's
    // culling rules, else the fog's distance): hidden once its nearest point is past that plus
    // margin, shown again once back inside it, so a head's small moves don't flicker it.
    let cullCursor = 0;
    const cullBox = new THREE.Box3(), cullSphere = new THREE.Sphere();
    function updateCulling() {
        if (!state.culling) return;
        const objects = allObjects();
        if (!objects.length) return;
        const settings = state.cullSettings || { perFrame: 0.05, margin: 6 };
        const fog = fogDistance();
        for (let n = Math.max(1, Math.ceil(objects.length * settings.perFrame)); n > 0; n--) {
            const o = objects[cullCursor++ % objects.length];
            if (state.carried && o === state.carried.object) continue;
            cullBox.setFromObject(o);
            if (cullBox.isEmpty()) continue;
            cullBox.getBoundingSphere(cullSphere);
            const d = camera.position.distanceTo(cullSphere.center) - cullSphere.radius;
            const piece = o.userData.piece || {};
            const limit = typeof piece.cull === "number" ? piece.cull : fog;
            if (!o.userData.culled && d > limit + settings.margin) o.userData.culled = true;
            else if (o.userData.culled && d < limit) o.userData.culled = false;
            o.visible = shown(o);
        }
    }
    // The camera's clip planes: unity.json's near and far, or with ☰ Fog far clip, FarClipManager's
    // far clip: where Canopy's fog, exp2(-(density distance)^2), hides farClip.threshold of the
    // light (0.95: 148 m at density 0.014), within farClip.min and .max; with ☰ Fog off, max.
    // (In clouds the game clips at 40 m; not here.) The sky's radius follows the far clip.
    function applyClip() {
        const clip = state.clip || { near: 0.03, far: 400 };
        let far = clip.far;
        const env = state.environment;
        if (state.fogClip && clip.fog) {
            const f = clip.fog;
            far = state.fog && env && env.fogDensity > 0.001
                ? Math.min(f.max, Math.max(f.min, Math.sqrt(Math.log2(1 / Math.max(1e-6, 1 - f.threshold))) / env.fogDensity))
                : f.max;
        }
        camera.near = lodCamera.near = clip.near;
        camera.far = lodCamera.far = far;
        camera.updateProjectionMatrix(); // the Sky follows the far clip (layout/scripts/Skybox.js)
        return far;
    }
    // The scene's middle and size; its size sets how far the camera frames it from and how fast
    // the camera moves, so it is worked out on every load, the camera restored or not.
    // The scene's own pieces, not the areas drawn alongside it (Ken, 2026-11-07: Hawthorn with four
    // other areas framed them all, 1.4 km off, and that camera was then remembered); a scene with
    // none of its own, its base.
    function sceneExtent() {
        const box = new THREE.Box3();
        for (const p of state.pieces.length ? state.pieces : state.base) box.expandByPoint(new THREE.Vector3(-p.position[0], p.position[1], p.position[2]));
        if (box.isEmpty()) return null;
        const size = Math.max(4, box.getSize(new THREE.Vector3()).length());
        state.orbitDistance = size * 0.8;
        return box.getCenter(new THREE.Vector3());
    }
    // A remembered camera kept near enough to see the scene (Ken: after a restart it was too far off
    // to see at all; under the sea is fine): within what the scene draws, once its meshes are in,
    // widened by half its size or 100 m.
    function nearScene() {
        const box = new THREE.Box3();
        for (const o of allObjects()) box.expandByObject(o);
        if (box.isEmpty()) return;
        const margin = Math.max(100, box.getSize(new THREE.Vector3()).length() / 2), was = camera.position.clone();
        camera.position.clamp(box.min.clone().subScalar(margin), box.max.clone().addScalar(margin));
        if (!camera.position.equals(was)) say(`Brought back near ${state.scene.name}: the camera was ${Math.round(was.distanceTo(camera.position))} m away.`);
    }
    function frameAll() {
        const center = sceneExtent();
        if (!center) return;
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
    // Carry: the piece keeps its pose relative to the camera, so moving the camera moves it;
    // orbiting and spinning (the spin buttons) take that pose again (holdingCarried).
    function startCarry(index, object) {
        camera.updateMatrixWorld();
        object.updateMatrixWorld(true);
        state.carried = {
            index,
            object,
            rel: camera.matrixWorld.clone().invert().multiply(object.matrix),
            factor: 1,
            base: index >= 0 ? uniformScale(state.pieces[index].scale) : index === PLACED ? uniformScale(object.userData.piece.scale) : 1, // its size when picked up, x base size
            original: object.matrix.clone(),
            camera: { position: camera.position.clone(), quaternion: camera.quaternion.clone() }, // where Cancel returns to
            extra: index >= 0 ? state.pieces[index].extra || "" : "" // settings, e.g. a tablet's text id
        };
        showScale(state.carried.base);
        showSelection();
        updateUi();
        if (state.tweak) renderTweaks(); // only its vars
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
        showSelection();
        updateUi();
        if (state.tweak) renderTweaks(); // every var again
        if (state.reloadAfterCarry) {
            state.reloadAfterCarry = false;
            canopyReload();
        }
    }
    // placing: an assemblage added to the Canopy scene of the area open (dropping writes it there)
    async function addPiece(name, placing = false) {
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
        // an assemblage starts where it was authored (its Origin) if that is in sight: a one-of-a-kind
        // made in place drops right back where it was designed
        const authored = placing && palette && (palette.scenes || []).find(x => x.prefab === name);
        if (authored && authored.origin) {
            const at = Space.pieceMatrix(THREE, { position: authored.origin, rotation: [0, 0, 0], scale: [1, 1, 1] });
            if (new THREE.Vector3().setFromMatrixPosition(at).distanceTo(camera.position) < 300) object.matrix.copy(at);
        }
        startCarry(-1, object);
        if (placing) state.carried.placement = { scene: state.unityScene, prefab: name };
        say(`Carrying ${name}. Move to carry it, drag to circle it, the buttons above Q and E to spin it, then Drop.${takesText(state.carried) ? " Add text picks its text." : ""}`);
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
                const others = [...state.baseObjects, ...state.objects].filter(o => o.visible && o !== c.object);
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
        if (c.index === REF_CUBE) {
            refCube.matrix.copy(carriedMatrix());
            saveRefCube();
            endCarry();
            return say("Reference cube placed (kept in this browser, not in the scene).");
        }
        const placement = Space.placementOf(THREE, carriedMatrix());
        if (c.placement) return dropPlacement(c, placement);
        commit(() => {
            if (c.index < 0) {
                const piece = { name: c.object.userData.pieceName, ...placement, extra: c.extra };
                state.pieces.push(piece);
                state.objects.push(c.object);
            } else {
                Object.assign(state.pieces[c.index], placement, { extra: c.extra });
                carryLinkedChildren(c);
            }
            c.object.matrix.copy(Space.pieceMatrix(THREE, c.index < 0 ? state.pieces[state.pieces.length - 1] : state.pieces[c.index]));
        });
        if (c.index < 0) findTweaks().catch(fail); // a modl piece brings its tweaks
        endCarry();
        refreshLabels();
        say("Dropped.");
    }
    // A linked assemblage's piece (tools/linked.js: "link <id>", "in <its parent's id>") moved: the
    // pieces under it (in, at any depth) move with it, as children do in Unity (Ken, 2026-11-09:
    // Black Isle's shamans and the thrusters on them).
    const linkIdOf = extra => (/(?:^|, )link (-?\d+)/.exec(extra || "") || [])[1] || null;
    const linkParentOf = extra => (/(?:^|, )in (-?\d+)/.exec(extra || "") || [])[1] || null;
    function carryLinkedChildren(c) {
        const root = linkIdOf(state.pieces[c.index].extra);
        if (!root) return;
        const moving = new Set([root]);
        for (let grew = true; grew;) {
            grew = false;
            for (const p of state.pieces) {
                const id = linkIdOf(p.extra);
                if (id && !moving.has(id) && moving.has(linkParentOf(p.extra))) {
                    moving.add(id);
                    grew = true;
                }
            }
        }
        const delta = Space.pieceMatrix(THREE, state.pieces[c.index]).multiply(c.original.clone().invert());
        state.pieces.forEach((p, i) => {
            if (i === c.index || !moving.has(linkIdOf(p.extra))) return;
            const m = delta.clone().multiply(Space.pieceMatrix(THREE, p));
            Object.assign(p, Space.placementOf(THREE, m));
            state.objects[i].matrix.copy(Space.pieceMatrix(THREE, p));
        });
    }
    // An assemblage's placement written into its Canopy scene, then shown as the scene's (read-only
    // beneath, carried again from there).
    async function dropPlacement(c, placement) {
        const p = c.placement;
        say(`Writing ${p.prefab} into ${p.scene}…`);
        let result;
        try {
            result = await call("POST", "/api/placement", { op: p.instance ? "move" : "add", scene: p.scene, prefab: p.prefab, instance: p.instance, placement });
        } catch (error) {
            cancel();
            return fail(error);
        }
        const piece = c.index === PLACED ? Object.assign(c.object.userData.piece, result.piece) : { ...result.piece, ...(p.scene !== state.unityScene ? { unityScene: p.scene } : {}) };
        if (c.index !== PLACED) {
            c.object.userData.piece = piece;
            c.object.userData.pieceName = piece.name;
            state.base.push(piece);
            state.baseObjects.push(c.object);
        }
        c.object.matrix.copy(Space.pieceMatrix(THREE, placed(piece)));
        c.object.updateMatrixWorld(true);
        endCarry();
        refreshLabels();
        say(`${piece.name} ${p.instance ? "moved" : "placed"} in ${p.scene} (logged in Canopy Changes).`);
    }
    function cancel() {
        const c = state.carried;
        if (!c) return;
        if (c.index === REF_CUBE) {
            c.object.matrix.copy(c.original);
        } else if (c.index < 0) {
            world.remove(c.object);
        } else {
            c.object.matrix.copy(c.original);
        }
        // back where the carry began: carrying moves the camera (to move the piece, or circle it)
        camera.position.copy(c.camera.position);
        camera.quaternion.copy(c.camera.quaternion);
        endCarry();
        refreshLabels();
        say("Cancelled.");
    }
    function remove() {
        const c = state.carried;
        if (c && c.index === PLACED) return removePlacement(c);
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

    async function removePlacement(c) {
        const p = c.placement;
        if (!confirm(`Delete this ${p.prefab} from ${p.scene}?`)) return;
        try {
            await call("POST", "/api/placement", { op: "delete", scene: p.scene, instance: p.instance });
        } catch (error) {
            return fail(error);
        }
        world.remove(c.object);
        const i = state.baseObjects.indexOf(c.object);
        if (i >= 0) {
            state.baseObjects.splice(i, 1);
            state.base.splice(state.base.indexOf(c.object.userData.piece), 1);
        }
        endCarry();
        refreshLabels();
        say(`${p.prefab} deleted from ${p.scene} (logged in Canopy Changes).`);
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
    // Changes the camera (or the carried piece's pose, given its world pose) while the carried
    // piece keeps its place in the world: its pose relative to the camera is taken again after.
    function holdingCarried(change) {
        const c = state.carried;
        camera.updateMatrixWorld();
        const pose = camera.matrixWorld.clone().multiply(c.rel);
        const changed = change(pose) || pose;
        camera.updateMatrixWorld();
        c.rel = camera.matrixWorld.clone().invert().multiply(changed);
    }
    // Carrying, a drag orbits the camera around the piece (about the vertical, level), which
    // stays put; the spin buttons spin it instead (spin). A drag the width of the screen goes a quarter
    // turn, whatever the screen (0.008 a pixel spun a phone's swipe half way round: too fast,
    // Ken 2026-10-25).
    function orbit(dx, dy) {
        if (state.carried) dy = 0;
        const perPixel = Math.PI / 2 / (canvas.clientWidth || window.innerWidth);
        const turn = () => {
            const center = pivot();
            const offset = camera.position.clone().sub(center);
            const spherical = new THREE.Spherical().setFromVector3(offset);
            spherical.theta -= dx * perPixel;
            spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - dy * perPixel));
            camera.position.copy(center).add(new THREE.Vector3().setFromSpherical(spherical));
            camera.lookAt(center);
        };
        if (state.carried) holdingCarried(turn);
        else turn();
    }
    // Turns the carried piece about the vertical through its middle, angle radians (positive is
    // counterclockwise seen from above).
    function spin(angle) {
        const center = pivot();
        holdingCarried(pose => new THREE.Matrix4().makeTranslation(center.x, center.y, center.z)
            .multiply(new THREE.Matrix4().makeRotationY(angle))
            .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))
            .multiply(pose));
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
    // The move keys' base speed: the same in every scene (Ken, 2026-11-03; it was a share of the
    // scene's size, so the same ground went at different speeds in different areas): what
    // Hawthorn gave; the keys go from a sixtieth of it to six times it (frame()'s
    // RAMP). Carrying, it follows the piece's size, for placing small things.
    const MOVE_SPEED = 44;
    function speed() {
        return state.carried ? Math.max(0.5, sizeOf(state.carried.object) * 0.75) : MOVE_SPEED;
    }

    // Touch: one finger looks around (or, carrying, circles the piece); a pinch travels
    // forward and back like W and S, at their speed (spreading 200 px is a second of W); a tap selects.
    const pointers = new Map();
    let gesture = null;
    let pinchStart = null; // when the pinch last moved (its speed sets how far it goes)
    // (a synthetic pointer, lens/drive.js's taps, can't be captured: it goes on uncaptured)
    const capture = (element, id) => {
        try {
            element.setPointerCapture(id);
        } catch {
            // not a live pointer
        }
    };
    canvas.addEventListener("pointerdown", e => {
        capture(canvas, e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
        pinchStart = null;
        gesture = null;
    });
    canvas.addEventListener("pointermove", e => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (pointers.size === 1) {
            if (tweakDragging(e.clientX - p.x0)) {
                p.x = e.clientX;
                p.y = e.clientY;
                return;
            }
            if (state.carried) orbit(dx, dy);
            else look(dx, dy);
        } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const before = Math.hypot(a.x - b.x, a.y - b.y);
            p.x = e.clientX;
            p.y = e.clientY;
            const after = Math.hypot(a.x - b.x, a.y - b.y);
            // The faster the fingers move, the farther each pixel goes (Ken, 2026-10-28): slow
            // pinches stay fine, a quick one travels: 0.2 + (speed / 400 px/s)^1.5, at most 12, all
            // four times over (Ken, 2026-10-28; the start a fifth of what it was, Ken, 2026-11-04).
            const now = performance.now();
            const dt = Math.max(8, now - (pinchStart === null ? now - 16 : pinchStart)) / 1000;
            pinchStart = now;
            const gain = Math.min(12, 0.2 + Math.pow(Math.abs(after - before) / dt / 400, 1.5));
            move("forward", 4 * (after - before) / 200 * speed() * gain);
            gesture = "two";
            return;
        }
        p.x = e.clientX;
        p.y = e.clientY;
    });
    const release = e => {
        const p = pointers.get(e.pointerId);
        pointers.delete(e.pointerId);
        pinchStart = null;
        if (pointers.size === 0) tweakReleased();
        if (p && pointers.size === 0 && gesture !== "two" && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 8 && performance.now() - p.t0 < 350) {
            tap(e.clientX, e.clientY);
        }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", e => {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) tweakReleased();
    });
    function tap(x, y) {
        if (state.game) return gameTapOrThrow(x, y);
        if (state.carried || state.tweak || !state.scene) return;
        const ray = new THREE.Raycaster();
        const r = canvas.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
        if (refCube.visible && ray.intersectObject(refCube, true).length) {
            startCarry(REF_CUBE, refCube);
            return say("Carrying the reference cube. Drop or Cancel.");
        }
        pickMaterial(ray);
        if (!state.scene.editable) {
            // in an imported area, an assemblage placed in the scene can be carried (its other pieces can't)
            const near = ray.intersectObjects(state.baseObjects.filter(o => o.visible), true).find(h => h.object.isMesh && visibleUp(h.object));
            let top = near && near.object;
            while (top && top.parent !== world) top = top.parent;
            const placed = top && top.userData.piece && top.userData.piece.placement;
            if (!placed) return;
            const piece = top.userData.piece;
            startCarry(PLACED, top);
            state.carried.placement = { scene: piece.unityScene || state.unityScene, prefab: piece.name, instance: placed.instance };
            say(`Carrying ${piece.name}, placed in ${state.carried.placement.scene}. Drop to move it there, Cancel, or Delete.`);
            return;
        }
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

    // ---------- game mode ----------
    // ☰ Game mode (Ken, 2026-11-02): only ☰ and ⛶ on screen, and the reticle; dragging looks around
    // and a pinch travels, as ever. A tap casts a ray; the first thing drawn it meets (leaves are
    // passed through, Ken, 2026-11-03):
    //   an Item (web/play.js) within 2.5 m is taken into Hold (Ken, 2026-11-08);
    //   anything else is hopped to if it is within HOP_REACH m, level or upward, or below level
    //   within HOP_REACH m across (in x and z, however far down: Ken, 2026-11-02): the camera (the
    //   player) hops there along an arc, landing a meter off the tapped polygon along its normal
    //   (turned toward the side tapped), still looking the same way; a hop goes through leaves.
    // Out of reach (or nothing there), a red dot shows a moment where the tap was. The reticle gets
    // a ring while what it points at could be taken or hopped to.
    const HOP_REACH = 20, HOP_STANDOFF = 1;
    const isLeaf = part => Boolean(part && (part.leafSplit || /\/ForestTreeLeaves/.test((part.mesh && part.mesh.path) || "")));
    function setGame(on) {
        portalLinks.clear();
        if (on) {
            if (state.carried) cancel();
            if (state.tweak) endTweak();
            clearSelection();
            held.clear();
            closePanels();
        }
        state.game = on;
        state.hop = null;
        lastStable = on ? camera.position.clone() : null; // where game mode starts is stable
        Play.setActive(on); // whatever was taken goes back where it was
        document.body.classList.toggle("game", on);
        $("gameBtn").textContent = on ? "Edit mode" : "Game mode";
        $("reticle").classList.remove("aim");
        say(on ? "Game mode: drag to look, tap to hop there or take an item." : "Edit mode.");
    }
    $("gameBtn").onclick = () => setGame(!state.game);
    // ☰ Game display (game mode only; default off): the counts and the ring fingers.
    $("hudBtn").onclick = () => {
        Play.toggleDisplay();
        updateUi();
    };
    // The first thing drawn along a ray: a mesh with a face, it and everything above it visible
    // (hidden LOD levels, culled and switched-off pieces aren't), not a leaf; taken items aren't hit
    // (they are on another layer), the rings game mode made are.
    const seen = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const gameRay = new THREE.Raycaster();
    // The sea (Ken, 2026-11-09): taps pass through its surface (it isn't in the world a tap meets) to
    // whatever is below it, which is the target; only when nothing is, the tap is taken as at the hop's
    // full reach along it, under the surface (hit.sea: the sea is no surface to land on; the player
    // tries to go in). One whose surface is out of reach: a red dot. A hop that brings the head (the camera) within SEA_TOUCH of it,
    // from above, is Canopy's head in the sea (Sea.Update, Player.OnSeaSurfaceDeath): back to the last
    // stable place, where a hop or a portal last left the head more than STABLE_ABOVE_SEA above it
    // (Rules' stablePositionHeadAboveSeaDist; or where game mode started). SeaSkip, WaterBounce and
    // Antacid, which spare the player in Canopy, aren't played. A biome below the sea (Coral, Maple:
    // their air zones) is never "in the sea": only a hop from above the surface down to it counts.
    const SEA_TOUCH = 0.2, STABLE_ABOVE_SEA = 0.2;
    const seaLevel = () => { const y = Surface.uniforms.canopySeaLevel.value; return y > -1e8 ? y : null; };
    let lastStable = null;
    function seaHit(ray) {
        const y = seaLevel();
        if (y === null || Math.abs(ray.direction.y) < 1e-6) return null;
        const t = (y - ray.origin.y) / ray.direction.y;
        if (t <= 0) return null;
        // at full reach: HOP_REACH across (hopReaches), or along the ray when it points nearly straight down
        const flat = Math.hypot(ray.direction.x, ray.direction.z);
        const reach = Math.max(t, flat > 1e-3 ? HOP_REACH / flat : HOP_REACH);
        const surfaceAcross = t * flat;
        const d = surfaceAcross > HOP_REACH ? t : reach; // the surface out of reach: there (a red dot)
        return { sea: true, distance: d, point: ray.at(d, new THREE.Vector3()), face: { normal: new THREE.Vector3(0, ray.origin.y > y ? 1 : -1, 0) }, object: null };
    }
    function noteStable() {
        const y = seaLevel();
        if (y === null || camera.position.y > y + STABLE_ABOVE_SEA) lastStable = camera.position.clone();
    }
    function gameHit(ndc) {
        gameRay.setFromCamera(ndc, camera);
        gameRay.far = Infinity;
        return gameRay.intersectObjects([world, ...Play.extras()], true).find(h => h.face && h.object.isMesh && seen(h.object) && !isLeaf(h.object.userData.part)) || seaHit(gameRay.ray);
    }
    const across = p => Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
    // Within a hop: level or upward within HOP_REACH m, below level within HOP_REACH m across.
    const hopReaches = hit => (gameRay.ray.direction.y < 0 ? across(hit.point) <= HOP_REACH : hit.distance <= HOP_REACH);
    const ndcOf = (x, y) => {
        const r = canvas.getBoundingClientRect();
        return new THREE.Vector2((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    };
    // At the Gem Station (Ken, 2026-11-08: where a held gem tapped goes into the first open ring):
    // within STATION_REACH m of any piece of the temple's GemWorkbench.
    const GEM_STATION = /\/GemWorkbench\//, STATION_REACH = 3, stationBox = new THREE.Box3();
    function atGemStation() {
        for (const o of allObjects()) {
            const piece = o.userData.piece;
            if (!piece || !GEM_STATION.test(piece.path || "") || !seen(o)) continue;
            stationBox.setFromObject(o);
            if (!stationBox.isEmpty() && stationBox.distanceToPoint(camera.position) <= STATION_REACH) return true;
        }
        return false;
    }
    // The piece group a mesh belongs to (the world's child), and the drawn piece at a Unity path.
    const topObject = o => { while (o && o.parent && o.parent !== world) o = o.parent; return o && o.parent === world ? o : null; };
    // What a tap in game mode is on (Ken, 2026-11-09: a tap should always figure out what you
    // tapped): the innermost of its piece's things (a portal, harvester or cage: tools/scene.js
    // gameThings, the piece's own or, for a piece drawn from its prefab such as an assemblage, its
    // library entry's) holding the part hit. { top, piece, thing, meshes }: piece is the drawn piece
    // for a thing that is all of it (its guards, its path), else one of its own ({ name, path,
    // guarding }); meshes, the thing's (null: all of top's); thing null: ground (or an item).
    const thingsOf = piece => piece.things || (state.library[piece.name] || {}).things || [];
    const within = (things, i, outer) => { for (let k = i, n = 0; k !== undefined && k !== null && n < 64; k = things[k].in, n++) if (k === outer) return true; return false; };
    function unityMatrix(piece) {
        return new THREE.Matrix4().compose(new THREE.Vector3(...piece.position), Space.unityEulerToQuaternion(THREE, piece.rotation), new THREE.Vector3(...piece.scale));
    }
    // a portal thing with its landing in the world
    const worldPortal = (piece, portal) => ({ ...portal, landing: new THREE.Vector3(...portal.landing).applyMatrix4(unityMatrix(piece)).toArray() });
    function tapTarget(object) {
        const top = topObject(object), piece = top && top.userData.piece;
        if (!piece) return null;
        const things = thingsOf(piece), i = object.userData.part ? object.userData.part.thing : undefined;
        const t = i === undefined ? null : things[i];
        if (!t) return { top, piece, thing: null, meshes: null };
        const own = (piece.path || piece.name || "").split("/").pop(); // a whole piece's portal goes by the piece's name
        const thing = t.portal ? { ...t, portal: worldPortal(piece, t.portal.atRoot ? { ...t.portal, name: own } : t.portal) } : t;
        if (t.root) return { top, piece, thing, meshes: null, index: i };
        const meshes = [];
        top.traverse(o => { if (o.isMesh && o.userData.part && within(things, o.userData.part.thing, i)) meshes.push(o); });
        // a cage's own guard counts down that cage (the drawn piece, when the cage is all of it)
        const cage = t.guard && things[t.in] && things[t.in].root ? piece.path : null;
        return { top, piece: { name: t.name, path: `${piece.path}/${t.name}`, ...(cage ? { guarding: cage } : {}) }, thing, meshes, index: i };
    }
    // The piece guarded as path (its own path, or a tenant look's guardedAs), or null.
    function guardedPiece(path) {
        const o = allObjects().find(x => x.userData.piece && (x.userData.piece.path === path || x.userData.piece.guardedAs === path));
        return o ? o.userData.piece : null;
    }
    // A cage's own guards (its wardens: things marked guard) still in the world, any mesh of theirs not
    // taken (Ken, 2026-11-10: no firefly while any warden exists on that cage, they all guard it).
    function wardensLeft(top) {
        const things = thingsOf(top.userData.piece);
        let left = 0;
        things.forEach((t, i) => {
            if (!t.guard) return;
            let alive = false;
            top.traverse(o => { if (!alive && o.isMesh && !o.userData.taken && o.userData.part && within(things, o.userData.part.thing, i)) alive = true; });
            if (alive) left++;
        });
        return left;
    }
    // ---------- portals paid, and payees (Ken, 2026-11-09) ----------
    // In game mode portals start unpaid, as in Canopy: no bubble (Portal.TestLit: lit only when paid
    // and leading somewhere) and the spinners a purchase starts standing still; paid only as a scene
    // saves them (Portal.isPaid), as fast forward pays them (an Outpost and its Temple portal once
    // both their stages are done: FastForwardConfig.LinkTemplePortals), as one is arrived at through
    // a portal that links back (the Temple's cairn: SetLeadsTo), or bought. A payee (Payee.cs) shows
    // as many markers as its price takes (ShowPaymentsAtCurrentPrice); amber paid on them (web/play.js
    // pay, the amber made where the marker was) counts toward the price; reaching it, a second later
    // (finalPaymentDelay) the amber is used up and the portal paid (and the one it leads to,
    // Portal.SetPaid), which hides its payee's markers (SetPaymentsUnavailable); a payee of no portal
    // goes to its next price. Taking amber back off a marker takes it off the price. Edit mode shows
    // everything, as ever. (Canopy's sounds and the final payment's particle burst aren't played.)
    const paying = { portals: [], payees: [], made: new Map(), touched: new Set() };
    const madeObjects = [];
    let madeCount = 0;
    function thingMeshes(top, things, i) {
        const out = [];
        top.traverse(o => { if (o.isMesh && o.userData.part && within(things, o.userData.part.thing, i)) out.push(o); });
        return out;
    }
    // drawn or not, as game mode has it (layer 1: neither drawn nor hit, web/play.js HIDDEN)
    function showMeshes(meshes, on) {
        for (const m of meshes) {
            if (m.userData.shownMask === undefined) m.userData.shownMask = m.layers.mask;
            paying.touched.add(m);
            if (on) {
                m.layers.mask = m.userData.shownMask;
                delete m.userData.taken;
            } else {
                m.layers.set(1);
                m.userData.taken = true;
            }
        }
    }
    const portalName = (piece, t) => (t.portal.atRoot ? (piece.path || piece.name || "").split("/").pop() : t.portal.name);
    // where a portal leads now (by name): where game mode linked it, the fast-forward stage's link,
    // else as saved ("": nowhere)
    function leadsTo(portal, name) {
        const ff = state.fastForward, config = ff && state.ffStage && ff.configs[ff.stages[state.ffStage]];
        const saved = portal.target !== name ? portal.target : "";
        return portalLinks.get(name) || (config && config.portalLinks && config.portalLinks[name]) || saved;
    }
    const priceOf = payee => (payee.index >= 0 && payee.index < payee.prices.length ? payee.prices[payee.index] : 0);
    function startPaying() {
        for (const o of madeObjects) world.remove(o);
        madeObjects.length = 0;
        paying.made.clear();
        for (const p of paying.payees) clearTimeout(p.timer);
        showMeshes([...paying.touched], true);
        paying.touched.clear();
        for (const o of allObjects()) if (o.userData.stillSpinners) delete o.userData.stillSpinners;
        paying.portals = [];
        paying.payees = [];
        damage.clear();
        startVacancies();
        payingObjects = allObjects();
        if (!state.game) return;
        for (const o of allObjects()) {
            const piece = o.userData.piece, things = piece ? thingsOf(piece) : [];
            if (!things.length) continue;
            const payees = (piece.payees || (state.library[piece.name] || {}).payees || []).map(p => ({ top: o, prices: p.prices, index: p.index, markers: [], timer: null }));
            things.forEach((t, i) => {
                const payee = t.payment && payees[t.payment.payee];
                if (payee) payee.markers.push({ i, things, value: t.payment.value, placed: null });
                if (t.portal) paying.portals.push({ top: o, piece, t, i, things, name: portalName(piece, t), paid: Boolean(t.portal.paid), payee: payees[t.portal.payee] || null });
            });
            paying.payees.push(...payees);
        }
        // fast-forwarded: the pairs that lead to each other, both from stages done (LinkTemplePortals)
        const at = stageRank(state.ffStage);
        if (at !== null) {
            const done = p => p.piece.from && stageRank(p.piece.from) !== null && stageRank(p.piece.from) < at;
            for (const p of paying.portals) {
                const q = portalByName(p.t.portal.target);
                if (q && q !== p && q.t.portal.target === p.name && done(p) && done(q)) p.paid = q.paid = true;
            }
        }
        for (const p of paying.portals) if (p.paid && p.payee) p.payee.index = -1;
        refreshPaying();
    }
    // Meshes load after their pieces are built, and Fast forward loads areas: twice a second in game
    // mode the drawn world is checked (new pieces: game mode's state starts over; new meshes: hidden
    // or shown as their portal or payee has them).
    let payingAt = 0, payingObjects = null;
    function payingTick(now) {
        if (now - payingAt < 500) return;
        payingAt = now;
        const objects = allObjects();
        if (payingObjects && (objects.length !== payingObjects.length || objects.some((o, k) => o !== payingObjects[k]))) Play.reset();
        else {
            refreshPaying();
            refreshVacancies();
        }
        payingObjects = objects;
    }
    const portalByName = name => (name ? paying.portals.find(p => p.name === name) || null : null);
    function refreshPaying() {
        const still = new Map(); // top -> its unpaid portals' spinners
        for (const p of paying.portals) {
            showMeshes(thingMeshes(p.top, p.things, p.i), p.paid && Boolean(leadsTo(p.t.portal, p.name)));
            if (!p.paid) for (const go of p.t.spinners || []) (still.get(p.top) || still.set(p.top, new Set()).get(p.top)).add(go);
        }
        for (const p of paying.portals) p.top.userData.stillSpinners = still.get(p.top) || null; // scripts/Spinner.js
        for (const payee of paying.payees) {
            let left = priceOf(payee);
            for (const m of payee.markers) {
                const shown = left >= m.value;
                if (shown) left -= m.value;
                showMeshes(thingMeshes(payee.top, m.things, m.i), shown && !m.placed);
            }
        }
    }
    // Portal.SetPaid: paid, its payee's markers gone, and the portal it leads to paid too
    function setPaid(p) {
        if (!p || p.paid) return;
        p.paid = true;
        if (p.payee) p.payee.index = -1;
        setPaid(portalByName(leadsTo(p.t.portal, p.name)));
    }
    function payeeTotal(payee) {
        return payee.markers.reduce((sum, m) => sum + (m.placed ? m.value : 0), 0);
    }
    function checkPayee(payee) {
        clearTimeout(payee.timer);
        const price = priceOf(payee);
        if (price > 0 && payeeTotal(payee) >= price) payee.timer = setTimeout(() => completePayee(payee), 1000);
    }
    // Payee.OnPaymentComplete: the amber used up; its portal paid, else its next price
    function completePayee(payee) {
        payee.timer = null;
        for (const m of payee.markers) {
            if (!m.placed) continue;
            world.remove(m.placed);
            paying.made.delete(m.placed);
            m.placed = null;
        }
        const portal = paying.portals.find(p => p.payee === payee);
        if (portal) setPaid(portal);
        else payee.index = payee.index >= 0 ? payee.index + 1 : payee.index;
        Usage.count("game: purchase");
        say(portal ? `${portal.name} bought.` : "Bought.");
        refreshPaying();
    }
    // A marker tapped: paid (web/play.js pay), its amber made where it was (its prefabToMake, Amber10;
    // centered on the marker, no gravity), counted toward its payee.
    async function payAt(top, i, thing, hit, x, y) {
        const paid = Play.pay(thing.payment.value, hit, x, y);
        if (paid !== "paid") return paid;
        const payee = paying.payees.find(p => p.top === top && p.markers.some(m => m.i === i));
        const marker = payee && payee.markers.find(m => m.i === i);
        const meshes = thingMeshes(top, thingsOf(top.userData.piece), i);
        const box = new THREE.Box3();
        for (const m of meshes) box.expandByObject(m);
        showMeshes(meshes, false);
        const name = thing.payment.make;
        if (!state.library[name]) {
            const data = await call("POST", "/api/prepare", { names: [name] });
            Object.assign(state.library, data.library);
            Object.assign(state.materials, data.materials || {});
        }
        const center = box.isEmpty() ? camera.position.clone() : box.getCenter(new THREE.Vector3());
        const at = Space.placementOf(THREE, new THREE.Matrix4().makeTranslation(center.x, center.y, center.z));
        const piece = { name, path: `made/${name}/${++madeCount}`, position: at.position, rotation: [0, 0, 0], scale: [1, 1, 1], extra: "" };
        const object = buildObject(piece);
        object.userData.pieceName = name;
        object.userData.piece = piece;
        world.add(object);
        madeObjects.push(object);
        if (marker) {
            marker.placed = object;
            paying.made.set(object, { payee, marker });
            checkPayee(payee);
        }
        return true;
    }
    // an item taken (web/play.js): amber made on a marker, taken back off it
    function takenBack(group) {
        const made = paying.made.get(group);
        if (!made) return;
        paying.made.delete(group);
        made.marker.placed = null;
        checkPayee(made.payee);
        refreshPaying();
    }
    // Mana mounted on a harvester (Ken, 2026-11-09: the flamer is sure to be killed, and the mana must
    // go on existing): taken, the mounted mana is hidden and a real mana item (ManaFire, ManaAir or
    // ManaWater, by element) made where it was goes into Hold, a thing of its own; gone when game
    // mode starts over. In Canopy the flamers should carry a real ManaFire (docs: Flamer).
    const MANA_ITEM = { fire: "ManaFire", air: "ManaAir", water: "ManaWater" };
    async function takeMounted(top, meshes, element) {
        const box = new THREE.Box3();
        for (const m of meshes) box.expandByObject(m);
        Play.hideGroup(top, meshes);
        const name = MANA_ITEM[element];
        if (!state.library[name]) {
            const data = await call("POST", "/api/prepare", { names: [name] });
            Object.assign(state.library, data.library);
            Object.assign(state.materials, data.materials || {});
        }
        const center = box.getCenter(new THREE.Vector3());
        const at = Space.placementOf(THREE, new THREE.Matrix4().makeTranslation(center.x, center.y, center.z));
        const piece = { name, path: `made/${name}/${++madeCount}`, position: at.position, rotation: [0, 0, 0], scale: [1, 1, 1], extra: "" };
        const object = buildObject(piece);
        object.userData.pieceName = name;
        object.userData.piece = piece;
        world.add(object);
        madeObjects.push(object);
        // its meshes load a moment later: then it is taken
        for (let waited = 0; waited < 5000; waited += 50) {
            if (!object.parent) return; // game mode started over meanwhile
            let found = null;
            object.traverse(o => { if (!found && o.isMesh && o.userData.part && o.userData.part.item) found = o; });
            if (found) return Play.holdMade(found);
            await new Promise(r => setTimeout(r, 50));
        }
        say(`${name} didn't load.`);
    }
    // A fire-empowered stab on red armor: a point of damage (Ken, 2026-11-09); dead at its health
    // (HcHealth.healthMax, 1 unless more). Damage is forgotten when game mode starts over.
    const damage = new Map(); // harvester path -> damage taken
    function burn(top, piece, thing, hit, x, y, meshes) {
        const taken = (damage.get(piece.path) || 0) + 1, health = thing.health || 1;
        damage.set(piece.path, taken);
        Usage.count("game: fire on red");
        if (taken >= health) return Play.kill(top, piece, hit, x, y, meshes, meshes ? thing.go : null);
        say(`Burned: ${health - taken} of ${health} health left.`);
    }
    // ---------- vacancies (Ken, 2026-11-09; Canopy's Vacancy.cs and Tenant.cs) ----------
    // In game mode a vacancy's piece (the first LOD group under its parent, tools/scene.js) is drawn
    // in its translucent shadowMaterial, as Canopy draws the copy it makes; tapped within reach while
    // holding a tenant with the same most-detailed mesh (HasSameLod0Mesh), the piece is drawn again,
    // the vacancy gone, and the tenant used up. Holding anything else: a red dot. Edit mode, and
    // game mode starting over, draw them as they are.
    const vacancies = { list: [] }; // { top, i, vac, filled, shadowed: Map(mesh -> its material) }
    function vacancyMeshes(top, i) {
        const out = [];
        top.traverse(o => { if (o.isMesh && o.userData.part && o.userData.part.vacancy === i) out.push(o); });
        return out;
    }
    function unshadow(v) {
        for (const [m, material] of v.shadowed) m.material = material;
        v.shadowed.clear();
    }
    function startVacancies() {
        for (const v of vacancies.list) unshadow(v);
        vacancies.list = [];
        if (!state.game) return;
        for (const o of allObjects()) {
            const piece = o.userData.piece;
            (piece && piece.vacancies || []).forEach((vac, i) => vacancies.list.push({ top: o, i, vac, filled: false, shadowed: new Map() }));
        }
        refreshVacancies();
    }
    // (twice a second, with the payees: meshes load late)
    function refreshVacancies() {
        for (const v of vacancies.list) {
            if (v.filled) continue;
            const shadow = materialFor(v.vac.shadow, false);
            if (!shadow) throw new Error(`no material ${v.vac.shadow} for a vacancy (the scene reply should carry it: part.shadow)`);
            for (const m of vacancyMeshes(v.top, v.i)) if (!v.shadowed.has(m)) {
                v.shadowed.set(m, m.material);
                m.material = shadow;
            }
        }
    }
    // a tap on a vacancy within reach: true when it took the tap
    function tapVacancy(object, hit, x, y) {
        const part = object.userData.part, top = topObject(object);
        const v = part && part.vacancy !== undefined && vacancies.list.find(q => q.top === top && q.i === part.vacancy && !q.filled);
        if (!v || hit.distance > Play.TAKE_REACH || !Play.inventory().held) return false;
        if (Play.heldMeshId() !== v.vac.mesh) {
            Play.miss(x, y);
            say("That doesn't fit there.");
            return true;
        }
        unshadow(v);
        v.filled = true;
        Play.useHeld();
        Usage.count("game: vacancy filled");
        say("It fits.");
        return true;
    }
    // Every portal drawn: { portal (its landing in the world), from (its place's stage) }.
    function portalPieces() {
        const out = [];
        for (const o of allObjects()) {
            const piece = o.userData.piece;
            if (!piece) continue;
            for (const t of thingsOf(piece)) if (t.portal) out.push({ portal: worldPortal(piece, t.portal.atRoot ? { ...t.portal, name: (piece.path || piece.name || "").split("/").pop() } : t.portal), from: piece.from });
        }
        return out;
    }
    function objectOfPath(path) {
        for (const o of allObjects()) if (o.userData.piece && o.userData.piece.path === path) return o;
        return null;
    }
    // Through a portal or cairn (Portal.TeleportInteractableAndConnect): to the landing of the portal
    // it leads to (its CrossSceneReference, or the fast-forward stage's portalLinks), standing there.
    const EYE = 1.6;
    const portalLinks = new Map(); // portal name -> where game mode has linked it; cleared as game mode starts over
    function teleport(piece, hit, x, y) {
        if (hit.distance > Play.TAKE_REACH) {
            Play.miss(x, y);
            Usage.count("game: portal out of reach");
            return;
        }
        // where it leads now: where game mode linked it (one that links itself to incomers), the
        // fast-forward stage's link, else as saved (a portal leading to itself leads nowhere yet)
        const target = leadsTo(piece.portal, piece.portal.name);
        const to = target && portalPieces().find(p => p.portal.name === target);
        if (!to) {
            Play.miss(x, y);
            return say(target ? `${piece.portal.name} leads to ${target}, which isn't loaded.` : `${piece.portal.name} isn't linked anywhere.`);
        }
        // Fast-forwarded, an Outpost and its Temple portal (each leads to the other) are lit once both
        // their places' stages are done (Ken, 2026-11-09; Canopy's FastForwardConfig.LinkTemplePortals).
        const at0 = stageRank(state.ffStage);
        const late = at0 !== null && to.portal.name !== piece.portal.name && to.portal.target === piece.portal.name && [piece, to].find(p => p.from && stageRank(p.from) !== null && stageRank(p.from) >= at0);
        if (late) {
            Play.miss(x, y);
            return say(`${piece.portal.name} isn't lit yet: fast-forwarded to ${state.ffStage}, ${late.from} isn't done.`);
        }
        const at = new THREE.Vector3().setFromMatrixPosition(Space.pieceMatrix(THREE, { position: to.portal.landing, rotation: [0, 0, 0], scale: [1, 1, 1] }));
        camera.position.copy(at).add(new THREE.Vector3(0, EYE, 0));
        noteStable();
        if (to.portal.linkBack) { // Portal.SetLeadsTo: linked back, and paid (lit)
            portalLinks.set(to.portal.name, piece.portal.name);
            setPaid(portalByName(to.portal.name));
            refreshPaying();
        }
        camera.updateMatrixWorld();
        Usage.count("game: teleport");
        say(`Through ${piece.portal.name} to ${target}.`);
    }
    // A double tap in game mode, holding something, throws it there (Ken, 2026-11-09; web/play.js
    // throwHeld): at what the tap meets, else along the tap from the camera. So, holding something, a
    // single tap waits DOUBLE_TAP ms to be sure it isn't the first of two.
    const DOUBLE_TAP = 300, DOUBLE_SLOP = 40;
    let pendingTap = null;
    function gameTapOrThrow(x, y) {
        if (!Play.inventory().held) {
            pendingTap = null;
            return gameTap(x, y);
        }
        if (pendingTap && Math.hypot(x - pendingTap.x, y - pendingTap.y) < DOUBLE_SLOP) {
            clearTimeout(pendingTap.timer);
            pendingTap = null;
            return throwAt(x, y);
        }
        if (pendingTap) { // a different place: the first was a tap of its own
            clearTimeout(pendingTap.timer);
            gameTap(pendingTap.x, pendingTap.y);
        }
        const p = { x, y };
        p.timer = setTimeout(() => {
            if (pendingTap !== p) return;
            pendingTap = null;
            gameTap(x, y);
        }, DOUBLE_TAP);
        pendingTap = p;
    }
    function throwAt(x, y) {
        const hit = gameHit(ndcOf(x, y));
        const dir = gameRay.ray.direction.clone();
        const target = hit && !hit.sea ? hit.point.clone() : null;
        const from = camera.position.clone().addScaledVector(dir, 0.4); // just off the camera
        if (Play.throwHeld(from, target, dir)) say(target ? "Thrown at what you tapped." : "Thrown.");
    }
    // What a thrown item meets between two points (web/play.js fly): { point, normal (toward from) }.
    const castRay = new THREE.Raycaster();
    function cast(from, to, exclude) {
        const d = to.clone().sub(from), len = d.length();
        if (len < 1e-6) return null;
        castRay.set(from, d.divideScalar(len));
        castRay.far = len;
        castRay.camera = camera; // a sprite (a placeholder's label) needs it to be raycast; without it three.js throws and the loop stops
        const skip = new Set(exclude);
        const h = castRay.intersectObjects([world], true).find(x => x.face && x.object.isMesh && !skip.has(x.object) && seen(x.object) && !isLeaf(x.object.userData.part));
        if (!h) return null;
        const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        if (normal.dot(d) > 0) normal.negate();
        return { point: h.point, normal };
    }
    function gameTap(x, y) {
        if (state.hop) return;
        const hit = gameHit(ndcOf(x, y));
        const { top, piece, thing, meshes, index } = (hit && !hit.sea && tapTarget(hit.object)) || {};
        if (hit && !hit.sea && tapVacancy(hit.object, hit, x, y)) return; // a vacancy, holding something
        // a payment marker within reach: paid (or a red dot, too poor), its amber made there
        if (thing && thing.payment && hit.distance <= Play.TAKE_REACH) {
            payAt(top, index, thing, hit, x, y).catch(error => say(`Couldn't pay: ${error.message}`));
            return;
        }
        if (thing && thing.cage && Play.tapCage(top, piece, hit, x, y, meshes)) return; // a cage: its firefly, unguarded and within reach; else hopped to
        if (hit && !hit.sea && Play.tapHit(hit, x, y)) return; // an item: taken, or out of reach
        // a portal's bubble: through it within reach; farther, hopped to like any ground (Ken, 2026-11-09)
        if (thing && thing.portal && hit.distance <= Play.TAKE_REACH) return teleport({ portal: thing.portal, from: piece.from }, hit, x, y);
        // a harvester: killed within reach; farther, hopped to like any ground (Ken, 2026-11-09); a
        // part drawn in a material the dagger can't hurt (GearDagger.immuneMaterials: the red
        // EnemyInvulnerable and the like; Canopy checks the part struck) isn't, a red dot
        if (thing && thing.harvester && hit.distance <= Play.TAKE_REACH) {
            const part = hit.object.userData.part || {};
            // mana mounted on it (the flamers' fire mana, real fire mana): a real mana item, taken
            if (part.mana) {
                const mana = [];
                top.traverse(o => { if (o.isMesh && !o.userData.taken && o.userData.part && o.userData.part.mana === part.mana && within(thingsOf(top.userData.piece), o.userData.part.thing, index)) mana.push(o); });
                if (mana.length) return void takeMounted(top, mana, part.mana).catch(error => say(`Couldn't take the mana: ${error.message}`));
            }
            if (part.immune || (state.immune || new Set()).has(hitMaterial(hit, top.userData.piece).guid)) {
                // red armor: a fire-empowered stab does a point of damage, and the fire is used up
                if (Play.useFire()) return void burn(top, piece, thing, hit, x, y, meshes);
                Play.miss(x, y);
                Usage.count("game: immune part");
                return say("Immune: the dagger can't hurt that part.");
            }
            return void Play.kill(top, piece, hit, x, y, meshes, meshes ? thing.go : null); // a unit: its own object switched off (its particle systems, a guard's beam)
        }
        if (!hit || !hopReaches(hit)) {
            Play.miss(x, y);
            Usage.count("game: hop out of reach");
            return;
        }
        Usage.count("game: hop");
        const normal = hit.sea ? hit.face.normal.clone() : hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.dot(gameRay.ray.direction) > 0) normal.negate(); // the side it was tapped from
        // into the sea: to full reach under it (the head goes in on the way); else standing off what was tapped
        const to = hit.point.clone().addScaledVector(normal, hit.sea ? 0 : HOP_STANDOFF);
        const from = camera.position.clone();
        const distance = from.distanceTo(to);
        const sea = seaLevel();
        state.hop = { from, to, t: 0, seconds: 0.3 + distance / 15, lift: Math.min(3, 0.3 * distance), aboveSea: sea !== null && from.y > sea + SEA_TOUCH };
    }
    // The reticle's ring: what the screen's center points at, looked at again (at most 6 times a
    // second) only once the camera has moved or turned.
    const aimCenter = new THREE.Vector2(0, 0), aimLast = new THREE.Matrix4();
    let aimAt = 0;
    function aim(now) {
        if (now - aimAt < 160 || aimLast.equals(camera.matrixWorld)) return;
        aimAt = now;
        aimLast.copy(camera.matrixWorld);
        const hit = gameHit(aimCenter);
        const { top, piece, thing, meshes } = (hit && !hit.sea && tapTarget(hit.object)) || {};
        // something to tap (an item, a portal, a harvester, a cage giving its firefly) within reach, else somewhere to hop
        const touchable = Boolean(hit) && ((!hit.sea && Play.isItem(hit.object) && !(thing && thing.cage)) || Boolean(thing && ((thing.cage && Play.cageGives(top, piece, hit, meshes)) || ((thing.portal || thing.harvester || thing.payment) && hit.distance <= Play.TAKE_REACH))));
        const can = Boolean(hit) && (touchable ? hit.distance <= Play.TAKE_REACH : hopReaches(hit));
        $("reticle").classList.toggle("aim", can);
    }
    function stepHop(dt) {
        const h = state.hop;
        h.t = Math.min(1, h.t + dt / h.seconds);
        const s = h.t * h.t * (3 - 2 * h.t); // eases off and in
        camera.position.lerpVectors(h.from, h.to, s);
        camera.position.y += h.lift * 4 * s * (1 - s); // the arc
        const sea = seaLevel();
        if (h.aboveSea && sea !== null && camera.position.y <= sea + SEA_TOUCH) return seaTouched();
        if (h.t >= 1) {
            state.hop = null;
            noteStable();
        }
    }
    // the head in the sea (Player.OnSeaSurfaceDeath): back to the last stable place
    function seaTouched() {
        state.hop = null;
        if (lastStable) camera.position.copy(lastStable);
        camera.updateMatrixWorld();
        Usage.count("game: head in the sea");
        say("Head in the sea: back where you last stood.");
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

    // ---------- LODs ----------
    // Each frame every LOD group picks a level the way the game does, as seen by a camera with the
    // headset's field of view (unity.json lodFov; Layout's own view is narrower), from where
    // Layout's camera is:
    // - Unity's LODGroup: the group's size over its distance, as a share of the view's height
    //   (size / (2 distance tan(fov / 2)), times lodBias); the first level whose screen height that
    //   reaches, else none.
    // - kind 'grid' (Canopy's GridRender.TestLoDs, for trees it draws itself): a cube of the group's
    //   size at its center, if in view; the screen height between its bottom and top centers, in
    //   percent (or, with byDistance, the cube's size over its distance, as for LODGroups); the first
    //   cutoff that reaches, else none.
    // ☰ LOD tint colors each level; the legend counts the triangles drawn.
    const lodCamera = new THREE.PerspectiveCamera(90, 1, 0.03, 400);
    const LOD_COLORS = ["#3cc84a", "#e8d23a", "#f08a24", "#e03a3a", "#c23ad6", "#3a6ee0", "#3ad6d0"];
    const lodTints = LOD_COLORS.map(c => new THREE.MeshLambertMaterial({ color: c }));
    // Strips keep their shader under the tint (else they draw zero wide: their points are centres).
    const stripTints = LOD_COLORS.map(c => {
        const m = new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide });
        m.onBeforeCompile = shader => stripPatch(shader);
        m.customProgramCacheKey = () => "strip";
        return m;
    });
    const lodFrustum = new THREE.Frustum(), lodProj = new THREE.Matrix4(), lodBox = new THREE.Box3();
    const lodC = new THREE.Vector3(), lodA = new THREE.Vector3(), lodB = new THREE.Vector3(), lodS = new THREE.Vector3();
    function lodLevel(g, world, scale, tanHalf, bias, box) {
        if (!g) return 0;
        lodC.set(-g.center[0], g.center[1], g.center[2]).applyMatrix4(world); // Unity to Three.js: x mirrored
        const size = g.size * scale;
        if (g.kind === "grid") {
            // In view if its meshes' box is (Canopy's fixed GridRender): its objectSize cube, which
            // GridRender used to test, misses geometry the cutting left outside it.
            if (box) lodBox.copy(box).applyMatrix4(world);
            else lodBox.setFromCenterAndSize(lodC, lodS.setScalar(size));
            if (!lodFrustum.intersectsBox(lodBox)) return -1;
            // By distance (Canopy's fixed GridRender): the cube's size as a share of the view's
            // height at its distance, whichever way the camera looks. Else the old way: the screen
            // height between its bottom and top centers, which shrinks looking down.
            let percent;
            if (g.byDistance) percent = size / (2 * Math.max(camera.position.distanceTo(lodC), 1e-6) * tanHalf) * 100;
            else {
                const a = lodA.set(lodC.x, lodC.y - size / 2, lodC.z).project(lodCamera);
                const b = lodB.set(lodC.x, lodC.y + size / 2, lodC.z).project(lodCamera);
                percent = Math.abs(b.y - a.y) / 2 * 100;
            }
            // ☰ Candidate trees: a candidate's own cutoffs, if it has them
            const cutoffs = state.candidates && g.candidateCutoffs ? g.candidateCutoffs : g.cutoffs;
            for (let i = 0; i < cutoffs.length; i++) if (percent >= cutoffs[i]) return i;
            return -1;
        }
        const height = size / (2 * Math.max(camera.position.distanceTo(lodC), 1e-6) * tanHalf) * bias;
        for (let i = 0; i < g.heights.length; i++) if (height >= g.heights[i]) return i;
        return -1;
    }
    function updateLods() {
        const view = state.lodView || { fov: 90, bias: 1 };
        lodCamera.fov = view.fov;
        lodCamera.aspect = camera.aspect;
        lodCamera.position.copy(camera.position);
        lodCamera.quaternion.copy(camera.quaternion);
        lodCamera.updateProjectionMatrix();
        lodCamera.updateMatrixWorld();
        lodFrustum.setFromProjectionMatrix(lodProj.multiplyMatrices(lodCamera.projectionMatrix, lodCamera.matrixWorldInverse));
        const tanHalf = Math.tan(view.fov * Math.PI / 360);
        const tops = state.carried ? [...allObjects(), state.carried.object] : allObjects();
        // each piece, then the prefabs nested in it (buildObject lodChildren), parents first
        const objects = tops.flatMap(o => (o.userData.lodChildren && o.visible ? [o, ...o.userData.lodChildren] : [o]));
        for (const o of objects) {
            const groups = o.userData.lodGroups || {};
            if (!(o.userData.lodGroups || o.userData.sets) || !o.visible) continue;
            o.updateMatrixWorld();
            const scale = o.matrixWorld.getMaxScaleOnAxis();
            const chosen = {}, boxes = o.userData.lodBoxes || {}, active = state.candidates ? "candidate" : "shipped";
            for (const mesh of o.children) {
                const lod = mesh.userData.lod, set = mesh.userData.set;
                if (!lod && !set) continue;
                // ☰ Candidate trees: meshes in a set (shipped, candidate) show only with theirs.
                const inSet = !set || set === (state.candidates ? "candidate" : "shipped");
                if (!lod) {
                    mesh.visible = inSet;
                    continue;
                }
                if (!(lod.key in chosen)) chosen[lod.key] = lodLevel(groups[lod.key], o.matrixWorld, scale, tanHalf, view.bias, boxes[lod.key + ":" + active] || boxes[lod.key + ":"]);
                const level = chosen[lod.key];
                mesh.visible = inSet && level >= 0 && lod.levels.includes(level);
                if (!mesh.isMesh) continue;
                if (mesh.userData.debug) continue; // diagnostic colors stay
                if (state.lodTint && mesh.visible) {
                    if (!mesh.userData.untinted) mesh.userData.untinted = mesh.material;
                    mesh.material = (mesh.userData.strip ? stripTints : lodTints)[Math.min(level, lodTints.length - 1)];
                } else if (mesh.userData.untinted) {
                    mesh.material = mesh.userData.untinted;
                    delete mesh.userData.untinted;
                }
            }
            // Groups scripts watch (a particle system drawn only at its level): their levels too,
            // kept for them (web/tickable.js lodLevelOf).
            for (const key of o.userData.lodWatch || []) if (!(key in chosen)) chosen[key] = lodLevel(groups[key], o.matrixWorld, scale, tanHalf, view.bias, boxes[key + ":" + active] || boxes[key + ":"]);
            o.userData.lodChosen = chosen;
        }
    }
    $("lodLegend").innerHTML = LOD_COLORS.map((c, i) => `<span style="color:${c}">L${i}</span>`).join(" ") + ' <span id="lodTris"></span>';
    let lodShown = 0;

    const heldFor = new Map(); // seconds each move key has been held
    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        // A and D sidestep at half speed (Ken, 2026-10-22); carrying, at Q and E's (Ken, 2026-11-04:
        // traverse, nice and slow), and the spin buttons above Q and E turn the piece a quarter
        // turn a second, as A and D did (Ken, 2026-10-25).
        // Over 2 s of holding, every move key (W S A D Q E) speeds up from a sixtieth of the speed to
        // six times it, A and D at half that as sidesteps (Ken, 2026-10-28; the start a third of what
        // it was, the top the same, Ken, 2026-11-03; then both 30% of that, Ken, 2026-11-03; then the
        // start half that, Ken, 2026-11-04).
        const RAMP = [1 / 60, 6], RAMP_SECONDS = 2;
        for (const d of [...heldFor.keys()]) if (!held.has(d)) heldFor.delete(d);
        for (const direction of held) {
            heldFor.set(direction, (heldFor.get(direction) || 0) + dt);
            const sideways = direction === "left" || direction === "right";
            const ramp = RAMP[0] + (RAMP[1] - RAMP[0]) * Math.min(1, heldFor.get(direction) / RAMP_SECONDS);
            if (direction === "spinLeft" || direction === "spinRight") {
                if (state.carried) spin((direction === "spinLeft" ? -1 : 1) * Math.PI / 2 * dt); // left clockwise from above, as A was (Ken, 2026-10-25)
            } else move(direction, speed() * dt * (sideways && !state.carried ? 0.5 : 1) * ramp);
        }
        if (state.hop) stepHop(dt);
        if (state.game) {
            Play.frame(dt);
            aim(now);
            payingTick(now);
        }
        stepEnvironment(dt);
        if (state.carried) {
            state.carried.object.matrix.copy(carriedMatrix());
            for (const s of labels.children) if (s.userData.object === state.carried.object) placeLabel(s, s.userData.object);
            state.carried.object.updateMatrixWorld(true);
            highlight.setFromObject(state.carried.object);
            highlight.visible = true;
        }
        Ticker.tick(state.ticking ? dt : 0); // scripts: the sea, the sky, effects (☰ Tick off freezes them)
        Surface.uniforms.canopyTime.value = Ticker.time;
        // Canopy darkens what is under the sea only while the eye is above it (no sea: never).
        Surface.uniforms.canopyHeadUnder.value = camera.position.y < Surface.uniforms.canopySeaLevel.value ? 1 : 0;
        updateCulling();
        updateLods();
        Lights.update(now, camera, allObjects());
        saveCamera(now);
        renderer.setRenderTarget(linearFrame);
        renderer.render(scene, camera);
        const triangles = renderer.info.render.triangles; // the scene's (each render starts the count over)
        if (state.wireframe) drawWireframe();
        if (state.game) Play.render(renderer, linearFrame); // the held item, in its corner
        if (linearFrame) {
            renderer.setRenderTarget(null);
            renderer.render(toScreen, toScreenCamera);
        }
        if (state.lodTint && now - lodShown > 500) {
            lodShown = now;
            const culled = state.culling ? allObjects().filter(o => o.userData.culled).length : 0;
            $("lodTris").textContent = `${triangles.toLocaleString()} triangles${state.culling ? `, ${culled} pieces culled` : ""}`;
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // ---------- reference cube ----------
    // ☰ Reference cube: a 1 m cube to judge sizes by. Tap it to carry it (Drop, Cancel); where it
    // is, per scene, stays in this browser and never goes into the scene.
    const REF_CUBE = -2; // its carried "index"
    // An assemblage placed in a Canopy scene, carried from an imported area (its piece in state.base;
    // tools/placements.js writes the scene; Ken, 2026-11-09: a biome refers to each instance it wants).
    const PLACED = -3;
    const refCube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 }));
    refCube.add(new THREE.LineSegments(new THREE.EdgesGeometry(refCube.geometry), new THREE.LineBasicMaterial({ color: 0x1a0d00 })));
    refCube.matrixAutoUpdate = false;
    refCube.visible = false;
    refCube.userData.pieceName = "Reference cube";
    world.add(refCube);
    const refCubeKey = () => state.scene && `layout.refCube.${state.scene.kind}:${state.scene.name}`;
    function saveRefCube() {
        try { localStorage.setItem(refCubeKey(), JSON.stringify(refCube.matrix.elements)); } catch { /* private mode */ }
    }
    function showRefCube() {
        refCube.visible = Boolean(state.refCube && state.scene);
        if (!refCube.visible) return;
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(refCubeKey())); } catch { /* none */ }
        if (Array.isArray(saved) && saved.length === 16) return refCube.matrix.fromArray(saved);
        // first time in this scene: where the reticle points, else 4 m ahead
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(0, 0), camera);
        const hit = ray.intersectObjects([...state.baseObjects, ...state.objects].filter(o => o.visible), true)[0];
        const at = hit ? hit.point.clone().add(new THREE.Vector3(0, 0.5, 0)) : camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 4);
        refCube.matrix.makeTranslation(at.x, at.y, at.z);
        saveRefCube();
    }

    // Folders switched off (☰ Folders, ☰ Inspect layers), kept per scene in this browser between
    // runs (Ken, 2026-10-28).
    const hiddenKey = () => state.scene && `layout.hiddenFolders.${state.scene.kind}:${state.scene.name}`;
    function loadHidden() {
        let saved = [];
        try { saved = JSON.parse(localStorage.getItem(hiddenKey())) || []; } catch { /* none */ }
        state.hiddenFolders = new Set(Array.isArray(saved) ? saved : []);
    }
    function saveHidden() {
        try { localStorage.setItem(hiddenKey(), JSON.stringify([...state.hiddenFolders])); } catch { /* private mode */ }
    }

    // ---------- switch ----------
    // A scene's "- Switch: Before = A B | After = C": a top-bar button showing the set of inspect
    // layers now shown; a tap shows the next set alone (the same switch as ☰ Inspect layers).
    function switchAt() {
        const sw = state.switch;
        if (!sw) return -1;
        const i = sw.findIndex(s => s.layers.every(l => !state.hiddenFolders.has(`Inspect/${l}`)) && sw.every(o => o === s || o.layers.every(l => s.layers.includes(l) || state.hiddenFolders.has(`Inspect/${l}`))));
        return i;
    }
    function showSwitch(i) {
        const sw = state.switch;
        for (const s of sw) for (const l of s.layers) state.hiddenFolders.add(`Inspect/${l}`);
        for (const l of sw[i].layers) state.hiddenFolders.delete(`Inspect/${l}`);
        saveHidden();
        for (const o of allObjects()) if (o.userData.folder && o.userData.folder.startsWith("Inspect/")) o.visible = shown(o);
        updateSwitch();
    }
    function updateSwitch() {
        const btn = $("switchBtn");
        btn.hidden = !state.switch;
        if (state.switch) btn.textContent = state.switch[Math.max(0, switchAt())].label;
    }
    $("switchBtn").onclick = () => showSwitch((switchAt() + 1) % state.switch.length);

    // ---------- probe ----------
    // The reticle button: a ray from the camera through the screen's center; the first piece it
    // hits (visible meshes only) is marked and reported: on the page, and to the server, which
    // keeps it in cache/probes.jsonl (for Claude: "what about this?"). Points are Unity's. For a
    // mesh-clean layer the server adds the branch and ring and the changes near it (tools/mesh-why.js).
    const probeMark = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe14d, depthTest: false }));
    probeMark.renderOrder = 11;
    probeMark.visible = false;
    world.add(probeMark);
    const unityOf = v => [-v.x, v.y, v.z].map(x => +x.toFixed(3));
    const visibleUp = o => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
    // Holding the probe button 1.2 s goes back to where the current probe (the last one taken, from
    // any page) was taken, facing the way it faced, and shows its mark.
    let probeHold = null, probeHeld = false;
    $("probeBtn").addEventListener("pointerdown", () => {
        probeHeld = false;
        clearTimeout(probeHold);
        probeHold = setTimeout(() => { probeHeld = true; backToProbe().catch(fail); }, 1200);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) $("probeBtn").addEventListener(type, () => clearTimeout(probeHold));
    $("probeBtn").addEventListener("contextmenu", e => e.preventDefault()); // a long press is ours, not the browser's menu
    async function backToProbe() {
        const probe = await call("GET", "/api/probe");
        if (!probe.camera) return say("No probe taken yet.");
        const [x, y, z] = probe.camera.position, [dx, dy, dz] = probe.camera.direction;
        camera.position.set(-x, y, z);
        camera.lookAt(camera.position.clone().add(new THREE.Vector3(-dx, dy, dz)));
        const h = probe.hit;
        if (h) {
            probeMark.position.set(-h.point[0], h.point[1], h.point[2]);
            probeMark.scale.setScalar(Math.max(0.03, h.distance * 0.006));
        }
        probeMark.visible = Boolean(h);
        const scene = state.scene ? `${state.scene.kind}:${state.scene.name}` : null;
        say(`Back where the probe was taken${probe.scene && probe.scene !== scene ? ` (in ${probe.scene.split(":").slice(1).join(":")})` : ""}${h ? `: ${h.piece}` : ""}.`);
    }
    // The hit triangle's corners and the 6 vertices of the hit mesh nearest the hit point (positions
    // in the piece's own frame, Unity axes, as "local"; d: metres from the hit point), copies at
    // the same place (UV seams) counted once (Ken, 2026-10-28: so a probe says which vertices).
    function probeVertices(hit, top) {
        const pos = hit.object.geometry && hit.object.geometry.attributes.position;
        if (!pos) return {};
        const toLocal = top.matrixWorld.clone().invert().multiply(hit.object.matrixWorld), v = new THREE.Vector3();
        const at = i => {
            v.fromBufferAttribute(pos, i);
            const local = unityOf(v.clone().applyMatrix4(toLocal));
            return { local, d: +v.applyMatrix4(hit.object.matrixWorld).distanceTo(hit.point).toFixed(3) };
        };
        const corners = hit.face ? [hit.face.a, hit.face.b, hit.face.c].map(at) : null;
        const best = new Map();
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
            const d = v.distanceTo(hit.point);
            if (best.size >= 6 && d >= Math.max(...[...best.values()].map(b => b.d))) continue;
            const one = at(i), key = one.local.join(",");
            if (!best.has(key) || best.get(key).d > one.d) best.set(key, one);
            if (best.size > 6) best.delete([...best.entries()].sort((x, y) => y[1].d - x[1].d)[0][0]);
        }
        return { corners, nearest: [...best.values()].sort((x, y) => x.d - y.d) };
    }
    $("probeBtn").onclick = () => {
        if (probeHeld) return void (probeHeld = false); // that press was a hold
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(0, 0), camera);
        const objects = [...state.baseObjects, ...state.objects].filter(o => o.visible);
        const hit = ray.intersectObjects(objects, true).find(h => h.object.isMesh && h.object !== probeMark && visibleUp(h.object));
        const forward = camera.getWorldDirection(new THREE.Vector3());
        const report = { scene: state.scene ? `${state.scene.kind}:${state.scene.name}` : null, camera: { position: unityOf(camera.position), direction: unityOf(forward) }, hit: null };
        if (hit) {
            let top = hit.object;
            while (top.parent && top.parent !== world) top = top.parent;
            const index = state.objects.indexOf(top), baseIndex = state.baseObjects.indexOf(top);
            const piece = index >= 0 ? state.pieces[index] : baseIndex >= 0 ? state.base[baseIndex] : null;
            const part = hit.object.userData.part || {};
            const local = hit.point.clone().applyMatrix4(top.matrixWorld.clone().invert());
            const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
            const shown = hitMaterial(hit, piece), material = shown.guid && state.materials[shown.guid];
            const scripts = piece ? scriptsIn(piece.name) : [];
            report.hit = {
                piece: piece ? piece.name : top.userData.pieceName || null,
                pieceIndex: index >= 0 ? index : null, base: baseIndex >= 0,
                placed: piece ? { position: piece.position, rotation: piece.rotation, scale: piece.scale } : null,
                folder: top.userData.folder || null,
                model: (part.mesh && (part.mesh.path || part.mesh.name)) || hit.object.userData.model || null,
                object: part.object || null, material: material ? material.name : part.inspect ? `inspect ${part.inspect.color}` : null,
                ...(shown.slot !== null ? { submesh: shown.slot } : {}),
                drawnBy: (shown.drawn && shown.drawn.userData && shown.drawn.userData.drawnBy) || (shown.drawn && shown.drawn.type) || null,
                lod: hit.object.userData.lod ? hit.object.userData.lod.levels : null,
                ...(scripts.length ? { scripts } : {}),
                ...(piece && (piece.when || piece.never) ? { gate: gateText(piece, piece) } : {}),
                ...(part.when || part.never ? { partGate: gateText(part, piece) } : {}),
                ...(piece && piece.unityScene ? { unityScene: piece.unityScene } : {}),
                ...(piece && piece.moved ? { moved: { when: piece.moved.when.map(Conditions.describe), position: piece.moved.position } } : {}),
                point: unityOf(hit.point), local: unityOf(local), normal: normal ? unityOf(normal) : null,
                distance: +hit.distance.toFixed(2), triangle: hit.faceIndex, ...probeVertices(hit, top)
            };
            probeMark.position.copy(hit.point);
            probeMark.scale.setScalar(Math.max(0.03, hit.distance * 0.006));
            probeMark.visible = true;
        } else probeMark.visible = false;
        call("POST", "/api/probe", report).catch(fail);
        const h = report.hit;
        say(h ? `Probe: ${h.piece}${h.model ? " · " + h.model.split("/").pop() : ""} at (${h.point.join(", ")}), ${h.distance} m. Sent: say "what about this?"` : "Probe: nothing along the ray.");
    };

    // A piece's scripts, by name, for the probe report: its own (a layout prefab's Script lines, a
    // Unity prefab's C# ones) and those of what it uses; C# ones without a stand-in say so.
    function scriptsIn(name, seen = new Set()) {
        const e = state.library[name];
        if (!e || seen.has(name)) return [];
        seen.add(name);
        const own = (e.scripts || []).map(s => `${s.name}${s.url ? "" : " (no stand-in)"}${s.off ? " (off)" : ""}`);
        return [...own, ...(e.shapes || []).filter(s => s.kind === "use").flatMap(s => scriptsIn(s.name, seen))];
    }
    // ---------- inspect layers ----------
    // ☰ Inspect layers (shown when the scene has inspection models, "inspect:<Name>" pieces): each
    // layer's color and an on/off box, the same switch as ☰ Folders. A layer with nothing in it
    // (no triangles: say no orphans left) isn't listed.
    function inspectFolders() {
        const out = new Map(), filled = new Set();
        for (const o of allObjects()) {
            const f = o.userData.folder;
            if (!f || !f.startsWith("Inspect/")) continue;
            const entry = state.library[o.userData.pieceName] || {};
            const look = ((entry.parts || [])[0] || {}).inspect || {};
            out.set(f, look.color || "#ffffff");
            o.traverse(m => {
                const g = m.isMesh && m.geometry;
                if (g && (g.index ? g.index.count : (g.attributes.position || { count: 0 }).count)) filled.add(f);
            });
        }
        for (const f of out.keys()) if (!filled.has(f)) out.delete(f);
        return out;
    }
    $("inspectBtn").onclick = () => {
        const panel = $("folders");
        panel.innerHTML = "<div class='row'><b>Inspect layers</b></div>";
        for (const [folder, color] of [...inspectFolders()].sort()) {
            const row = document.createElement("label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !state.hiddenFolders.has(folder);
            box.onchange = () => {
                if (box.checked) state.hiddenFolders.delete(folder);
                else state.hiddenFolders.add(folder);
                saveHidden();
                for (const o of allObjects()) if (o.userData.folder === folder) o.visible = shown(o);
            };
            const swatch = document.createElement("span");
            swatch.style.cssText = `display:inline-block;width:0.9em;height:0.9em;border-radius:3px;margin:0 0.4em;vertical-align:middle;background:${color}`;
            row.append(box, swatch, folder.replace(/^Inspect\//, ""));
            panel.appendChild(row);
        }
        const close = document.createElement("button");
        close.textContent = "Close";
        close.onclick = closePanels;
        panel.appendChild(close);
        toggle("folders");
    };

    // ---------- origin ----------
    // ☰ Origin: the scene's "- Origin: x y z" (an assemblage's root) as axes 1.5 m long, drawn
    // through everything: red Unity +X, green +Y, blue +Z (0 degrees; the Amphitheater's podium).
    const originMark = new THREE.Group();
    {
        const axis = (to, color) => {
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]), new THREE.LineBasicMaterial({ color, depthTest: false }));
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
            tip.position.copy(to);
            tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().normalize());
            for (const o of [line, tip]) {
                o.renderOrder = 10;
                originMark.add(o);
            }
        };
        // Three.js mirrors Unity's X (web/space.js): Unity +X is Three's -X
        axis(new THREE.Vector3(-1.5, 0, 0), 0xff4040);
        axis(new THREE.Vector3(0, 1.5, 0), 0x40ff40);
        axis(new THREE.Vector3(0, 0, 1.5), 0x4080ff);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
        dot.renderOrder = 10;
        originMark.add(dot);
    }
    originMark.visible = false;
    world.add(originMark);
    function showOrigin() {
        originMark.visible = Boolean(state.showOrigin && state.origin);
        if (state.origin) originMark.position.setFromMatrixPosition(Space.pieceMatrix(THREE, { position: state.origin, rotation: [0, 0, 0], scale: [1, 1, 1] }));
    }

    // ---------- tweak ----------
    // Tweak (the sliders button right of fullscreen) reshapes pieces live: their family's worker (server.js,
    // unity.json tweakWorkers; modl's obj/serve.py) lists its tweakvars, the {name value unit}
    // tags of the model's doc. Tap one in the list, then drag left and right: geometry follows
    // the finger, textures follow when it lifts; a var that needs a full rebuild asks for a
    // number and rebuilds at once. Undo and redo step through tweaks. Leaving Tweak writes the
    // values into the doc and the full build into Canopy, and the scene reloads.
    state.tweakFamilies = [];
    state.tweak = null;
    state.tweakPicked = null; // the family of the material last tapped (pickMaterial)
    state.pickedObject = null; // the piece last tapped
    // Any piece can be selected by a tap, even one that can't be moved or deleted (another area's,
    // the scene beneath), for its material's shader properties in Tweak (Ken, 2026-11-07). They
    // are a family of their own, folder material:<guid>, all live; leaving Tweak writes them into
    // the .mat. Canopy's General and what lights as it does; other shaders have none yet.
    function materialFamily(guid, d, pieceName) {
        const value = (name, dflt) => (d.values && d.values[name] ? d.values[name][0] : dflt);
        const live = (name, label, dflt, min, max, step) => ({ name, label, value: value(name, dflt), min, max, step, live: [{ material: guid, property: name }] });
        const tile = (slot, label, t) => (t && t.scale[0] === t.scale[1] ? [{ name: `${slot}.scale`, label, value: t.scale[0], min: 0.05, max: 64, step: 0.05, live: [{ material: guid, property: `${slot}.scale` }] }] : []);
        return {
            folder: `material:${guid}`, family: d.name, assets: [pieceName], shaders: [],
            vars: [
                live("_Brightness", "Brightness", 1, 0, 10, 0.01), live("_Glossiness", "Gloss", 0, 0, 1, 0.01), live("_HighlightStrength", "Highlight strength", 0.2, 0, 10, 0.01),
                ...(d.normal ? [live("_NormalStrength", "Normal strength", 1, 0, 4, 0.01)] : []), ...tile("_NormalMap", "Normal tiling", d.normal), ...tile("_DetailTex", "Detail tiling", d.detail)
            ]
        };
    }
    // The selection box, by what can be done with the piece (Ken, 2026-11-07): green, moved and
    // tweaked; blue, moved; amber, tweaked; gray, neither.
    function showSelection() {
        const o = state.carried ? state.carried.object : state.pickedObject;
        highlight.visible = Boolean(o);
        if (!o) return;
        const move = Boolean(state.carried) || Boolean(state.scene && state.scene.editable && state.objects.includes(o)) || Boolean(o.userData.piece && o.userData.piece.placement);
        const asset = assetOf(o.userData.pieceName);
        const tweak = state.tweakFamilies.some(f => f.assets.includes(asset));
        highlight.material.color.setHex(move ? (tweak ? 0x4fe07a : 0x4fb3ff) : tweak ? 0xffb13d : 0x9aa3ad);
        highlight.setFromObject(o);
    }
    function clearSelection() {
        state.pickedObject = null;
        state.tweakFamilies = state.tweakFamilies.filter(f => f !== state.tweakPicked);
        state.tweakPicked = null;
        showSelection();
    }
    function pickMaterial(ray) {
        clearSelection();
        const hit = ray.intersectObjects([...state.baseObjects, ...state.objects].filter(o => o.visible), true).find(h => h.object.isMesh && h.object !== probeMark && visibleUp(h.object));
        if (hit) {
            let top = hit.object;
            while (top.parent && top.parent !== world) top = top.parent;
            const index = state.objects.indexOf(top), baseIndex = state.baseObjects.indexOf(top);
            const piece = index >= 0 ? state.pieces[index] : baseIndex >= 0 ? state.base[baseIndex] : null;
            const shown = hitMaterial(hit, piece), guid = shown.guid, d = guid && state.materials[guid];
            const name = piece ? piece.name : top.userData.pieceName || "that";
            state.pickedObject = top;
            const tweakable = d && d.general && shown.drawn.userData && shown.drawn.userData.highlight;
            if (tweakable) {
                state.tweakPicked = materialFamily(guid, d, assetOf(top.userData.pieceName));
                state.tweakFamilies.push(state.tweakPicked);
            }
            say(tweakable ? `${name}: ${d.name}. Tweak changes its material.` : `${name}${d ? `: ${d.name}` : ""}: no shader tweaks for it yet.`);
        }
        showSelection();
        updateUi();
    }
    async function findTweaks() {
        const sources = [...new Set([...state.base, ...state.pieces].map(p => (state.library[p.name] || {}).source).filter(Boolean))];
        state.tweakFamilies = sources.length ? (await call("POST", "/api/tweak/vars", { sources })).families : [];
        if (state.tweakPicked) state.tweakFamilies.push(state.tweakPicked);
        if (state.tweak) {
            // Reloaded mid-tweak (a rebuild, or the doc or script edited): the tweaks not yet
            // written stay, over the doc's values, and are put back on the rebuilt pieces.
            const doc = tweakDocValues();
            for (const [folder, values] of Object.entries(doc)) {
                const kept = state.tweak.values[folder] || {};
                state.tweak.values[folder] = Object.fromEntries(Object.entries(values).map(([name, x]) => [name, name in kept ? kept[name] : x]));
                if (JSON.stringify(state.tweak.values[folder]) !== JSON.stringify(values)) {
                    tweakMeshes(folder);
                    tweakTextures(folder);
                }
            }
            tweakLiveAll();
            renderTweaks();
        }
        updateUi();
    }
    // A piece's asset as a worker names it: its prefab's file ("Roof Leaf" is RoofLeaf.prefab).
    const assetOf = name => {
        const source = (state.library[name] || {}).source;
        return source ? source.split("/").pop().replace(/\.prefab$/, "") : name;
    };
    const tweakDocValues = () => Object.fromEntries(state.tweakFamilies.map(f => [f.folder, Object.fromEntries(f.vars.map(v => [v.name, v.value]))]));
    // Carrying or having tapped a piece, only its vars: its family's, those its models and textures use (the
    // worker's uses) and its material's live ones (Ken, 2026-11-04). all: every family's.
    const tweakVars = (all = false) => {
        const selected = !all && (state.carried ? state.carried.object : state.pickedObject);
        const name = selected && assetOf(selected.userData.pieceName);
        const keep = (f, v) => !name || (f.assets.includes(name) && (!f.uses || !f.uses[name] || f.uses[name].includes(v.name)));
        return state.tweakFamilies.flatMap(f => f.vars.filter(v => keep(f, v)).map(v => ({ ...v, folder: f.folder, key: `${f.folder}|${v.name}`, label: state.tweakFamilies.length > 1 ? `${f.family}.${v.name}` : v.name })))
            .sort((a, b) => a.label.localeCompare(b.label));
    };
    const tweakSelected = () => state.tweak && tweakVars().find(v => v.key === state.tweak.selected);
    const tweakText = v => `${v.label} ${+state.tweak.values[v.folder][v.name].toFixed(4)}${v.unit ? " " + v.unit : ""}`;
    $("tweakBtn").onclick = () => (state.tweak ? endTweak() : startTweak());
    function startTweak() {
        let selected = null;
        try { selected = localStorage.getItem("layout.tweakSelected"); } catch { /* none */ }
        state.tweak = { values: tweakDocValues(), undo: [], redo: [], selected, shader: null, drag: null, busy: false, again: null };
        state.tweak.start = JSON.stringify(state.tweak.values);
        showTweakList();
        updateUi();
    }
    async function endTweak() {
        const t = state.tweak;
        closePanels();
        $("tweakHud").style.display = "none";
        state.tweak = null;
        updateUi();
        if (JSON.stringify(t.values) === t.start) return say("Tweak: nothing changed.");
        // anchored pieces moved with their rings: the scene keeps their new places
        if (t.moved && state.scene && state.scene.editable) await call("POST", "/api/save", { name: state.scene.name, pieces: state.pieces }).catch(fail);
        say("Tweak: writing the values and rebuilding…");
        for (const f of state.tweakFamilies) {
            const values = tweakChanged(t, f.folder);
            if (!Object.keys(values).length) continue;
            try {
                if (f.folder.startsWith("material:")) await call("POST", "/api/material/write", { guid: f.folder.slice("material:".length), values });
                else await call("POST", "/api/tweak/write", { folder: f.folder, values });
            } catch (error) {
                fail(error);
            }
        }
        say("Tweak: written; the scene reloads when Canopy's files change.");
    }
    function showTweakList() {
        closePanels();
        renderTweaks();
        $("tweakPanel").style.display = "flex";
        let top = 0;
        try { top = +localStorage.getItem("layout.tweakScroll") || 0; } catch { /* none */ }
        $("tweakList").scrollTop = top;
    }
    $("tweakList").addEventListener("scroll", () => {
        try { localStorage.setItem("layout.tweakScroll", String($("tweakList").scrollTop)); } catch { /* private mode */ }
    });
    $("tweakClose").onclick = () => closePanels();
    $("tweakHud").onclick = () => showTweakList();
    // A material's live vars (all they set is on it: its shader's properties) are grouped under
    // one row, <name>Shaders (the worker's shaders), which opens them (Ken, 2026-11-04).
    function tweakShader(v) {
        const f = state.tweakFamilies.find(x => x.folder === v.folder);
        const on = new Set((v.live || []).map(set => set.material));
        const shader = on.size === 1 && (f.shaders || []).find(x => on.has(x.material));
        return shader ? { key: `${v.folder}|${shader.material}`, label: state.tweakFamilies.length > 1 ? `${f.family}.${shader.name}Shaders` : `${shader.name}Shaders` } : null;
    }
    function renderTweaks() {
        if (!state.tweak) return;
        const list = $("tweakList");
        const top = list.scrollTop;
        list.innerHTML = "";
        const row = (text, note, on, click) => {
            const div = document.createElement("div");
            div.className = on ? "on" : "";
            div.textContent = text;
            const small = document.createElement("small");
            small.textContent = note;
            div.appendChild(small);
            div.onclick = click;
            list.appendChild(div);
        };
        const vars = tweakVars();
        const groups = new Map();
        for (const v of vars) {
            const shader = tweakShader(v);
            if (shader) groups.set(shader.key, { ...shader, vars: [...(groups.get(shader.key) || { vars: [] }).vars, v] });
        }
        const open = groups.get(state.tweak.shader);
        if (!open) state.tweak.shader = null; // its vars went (a carried piece's list)
        const shown = open ? open.vars : [...vars.filter(v => !tweakShader(v)), ...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
        if (open) {
            row(`‹ ${open.label}`, "  · back to every tweakvar", false, () => {
                state.tweak.shader = null;
                renderTweaks();
                list.scrollTop = 0;
            });
        }
        for (const v of shown) {
            if (v.vars) {
                const on = v.vars.some(x => x.key === state.tweak.selected);
                row(`${v.label} ›`, `  · ${v.vars.length} shader properties`, on, () => {
                    state.tweak.shader = v.key;
                    renderTweaks();
                    list.scrollTop = 0;
                });
                continue;
            }
            const note = v.rebuild ? "  · rebuild: enter a number" : v.geometry || v.live ? "" : "  · textures: shown when you lift your finger";
            row(tweakText(v), note, v.key === state.tweak.selected, () => pickTweak(v));
        }
        list.scrollTop = top;
        const v = tweakSelected();
        $("tweakHud").textContent = v ? `${tweakText(v)} ⇆` : "";
        $("tweakHud").style.display = v && $("tweakPanel").style.display !== "flex" ? "block" : "none";
    }
    // Tapping the selected var again deselects it, so one finger looks around again.
    async function pickTweak(v) {
        state.tweak.selected = v.key === state.tweak.selected && !v.rebuild ? null : v.key;
        try { localStorage.setItem("layout.tweakSelected", state.tweak.selected || ""); } catch { /* private mode */ }
        closePanels();
        renderTweaks();
        if (!v.rebuild || !state.tweak.selected) return;
        const text = prompt(`${v.label}${v.unit ? ` (${v.unit})` : ""}: a full rebuild`, String(state.tweak.values[v.folder][v.name]));
        if (text === null || text.trim() === "" || !Number.isFinite(+text)) return;
        tweakRecord();
        state.tweak.values[v.folder][v.name] = tweakClamp(v, +text);
        renderTweaks();
        say(`Tweak: rebuilding with ${tweakText(v)}…`);
        // the full build is written at once; the scene reloads from it
        await call("POST", "/api/tweak/write", { folder: v.folder, values: tweakChanged(state.tweak, v.folder) }).catch(fail);
    }
    // A live var (modl's serve.py, vars): its materials' properties set at once, asking the server
    // nothing; leaving Tweak writes it and builds it (Ken, 2026-11-04: shader properties should
    // move in real time).
    function tweakLive(v) {
        const value = state.tweak.values[v.folder][v.name];
        for (const set of v.live || []) {
            for (const [key, m] of materials) {
                if (!key.startsWith(set.material + "|") || !m.userData.detail) continue;
                const detail = m.userData.detail;
                if (set.property === "_NormalStrength") {
                    m.userData.tilt = value;
                    m.normalScale.setScalar(value * (state.normalsTimes2 ? 2 : 1));
                }
                else if (set.property === "_Brightness") m.color.setRGB(...m.userData.lit(value * (set.scale || 1)));
                else if (set.property === "_Glossiness") {
                    m.roughness = 0.85 - 0.5 * value;
                    m.userData.gloss.value = value;
                }
                else if (set.property === "_HighlightStrength") m.userData.highlight.value = value;
                else if (set.property === "_DetailTex.scale") {
                    detail.repeat.set(value, value);
                    detail.tiled = true;
                }
                else if (set.property === "_NormalMap.scale") {
                    if (!m.userData.normalMap) continue;
                    // its own copy (the same pixels): others may share the texture at this tiling
                    if (!m.userData.normalOwn) {
                        const own = m.userData.normalMap.clone();
                        own.needsUpdate = true;
                        if (m.normalMap) m.normalMap = own;
                        m.userData.normalMap = own;
                        m.userData.normalOwn = true;
                    }
                    m.userData.normalMap.repeat.set(value, value);
                }
                else if (set.tiling) {
                    detail.repeat.set(set.tiling / value, set.tiling / value);
                    detail.tiled = true;
                } else if ("strength" in set) {
                    // baked at set.strength: d at value is 1 + value / strength (d - 1), its mean
                    // likewise, and the atlas was lightened for the baked mean
                    if (!set.strength) return say(`Tweak: ${v.name} was 0, so its detail can't be shown until Tweak is left.`);
                    const ratio = value / set.strength;
                    detail.ratio.value = ratio;
                    detail.gain.value = set.mean / (1 - ratio * (1 - set.mean));
                }
            }
        }
    }
    const tweakLiveAll = () => tweakVars(true).filter(v => v.live).forEach(tweakLive);
    // Only the vars tweaked since Tweak began are written: the others stay as the doc has them,
    // even where it changed after the page read it (Ken, 2026-11-04: writing them all put back
    // stale values over newer ones).
    function tweakChanged(t, folder) {
        const start = JSON.parse(t.start)[folder] || {};
        return Object.fromEntries(Object.entries(t.values[folder] || {}).filter(([name, value]) => start[name] !== value));
    }
    const tweakClamp = (v, x) => Math.min(v.max ?? Infinity, Math.max(v.min ?? -Infinity, Math.round(x / v.step) * v.step));
    function tweakRecord() {
        state.tweak.undo.push(JSON.stringify(state.tweak.values));
        state.tweak.redo = [];
        updateUi();
    }
    function tweakHistory(from, to) {
        if (!from.length) return;
        to.push(JSON.stringify(state.tweak.values));
        state.tweak.values = JSON.parse(from.pop());
        renderTweaks();
        updateUi();
        tweakLiveAll();
        for (const f of state.tweakFamilies) {
            tweakMeshes(f.folder);
            tweakTextures(f.folder);
        }
    }
    // A one-finger drag dx px from where it began, on the selected var: across the screen
    // spans its range (at most twice its value, so small values stay fine). Returns whether the
    // drag was the tweak's.
    function tweakDragging(dx) {
        const v = tweakSelected();
        if (!v || v.rebuild || $("tweakPanel").style.display === "flex") return false;
        const t = state.tweak;
        if (!t.drag) {
            t.drag = { from: t.values[v.folder][v.name], recorded: false };
        }
        let span = v.min != null && v.max != null ? v.max - v.min : 2 * Math.abs(t.drag.from) || 1;
        span = Math.max(Math.min(span, 2 * Math.abs(t.drag.from) || span), 20 * v.step);
        const value = tweakClamp(v, t.drag.from + dx / window.innerWidth * span);
        if (value !== t.values[v.folder][v.name]) {
            if (!t.drag.recorded) {
                t.undo.push(JSON.stringify(t.values));
                t.redo = [];
                t.drag.recorded = true;
                updateUi();
            }
            t.values[v.folder][v.name] = value;
            $("tweakHud").textContent = `${tweakText(v)} ⇆`;
            if (v.live) tweakLive(v);
            else if (v.geometry) tweakMeshes(v.folder);
        }
        return true;
    }
    function tweakReleased() {
        const t = state.tweak;
        if (!t || !t.drag) return;
        const changed = t.drag.recorded;
        t.drag = null;
        const v = tweakSelected();
        renderTweaks();
        if (t.reloadAfterDrag) {
            t.reloadAfterDrag = false;
            canopyReload(); // its reload puts the tweaks back, textures too
        } else if (changed && v && v.textures) tweakTextures(v.folder);
    }
    // New meshes for a family's pieces; one request at a time, the latest values winning.
    async function tweakMeshes(folder) {
        const t = state.tweak;
        if (!t || folder.startsWith("material:")) return;
        if (t.busy) {
            t.again = folder;
            return;
        }
        t.busy = true;
        try {
            const reply = await call("POST", "/api/tweak/meshes", { folder, values: t.values[folder] });
            // each model (an asset's LOD levels are models of their own) by name
            const made = new Map();
            const geometryOf = name => {
                const m = reply.meshes[name];
                if (!m) return null;
                if (!made.has(name)) {
                    const g = new THREE.BufferGeometry();
                    g.setAttribute("position", new THREE.Float32BufferAttribute(m.v, 3));
                    g.setAttribute("normal", new THREE.Float32BufferAttribute(m.n, 3));
                    g.setAttribute("uv", new THREE.Float32BufferAttribute(m.uv, 2));
                    g.setIndex(m.f);
                    g.computeBoundingSphere();
                    g.userData.tweak = true;
                    made.set(name, g);
                }
                return made.get(name);
            };
            const family = state.tweakFamilies.find(f => f.folder === folder);
            for (const o of allObjects()) {
                const asset = assetOf(o.userData.pieceName);
                if (!family || !family.assets.includes(asset)) continue;
                for (const mesh of o.children) {
                    const g = mesh.isMesh && geometryOf(mesh.userData.model);
                    if (!g) continue;
                    if (mesh.geometry.userData.tweak && ![...made.values()].includes(mesh.geometry)) mesh.geometry.dispose();
                    mesh.geometry = g;
                }
                // the asset's LODGroup: its size and each level's lowest screen height
                const lod = (reply.lods || {})[asset];
                // Anchored on a ring (a curved bench at its row's radius): in a scene with an
                // Origin, the piece keeps its angle (its Y turn) around the Origin and moves to
                // the ring's new radius, so tweaked rows widen or narrow in place.
                const anchor = (reply.anchors || {})[asset];
                const index = state.objects.indexOf(o);
                if (anchor && state.origin && index >= 0) {
                    const piece = state.pieces[index], turn = piece.rotation[1] * Math.PI / 180;
                    const x = state.origin[0] + anchor.ring * Math.sin(turn), z = state.origin[2] + anchor.ring * Math.cos(turn);
                    if (Math.abs(x - piece.position[0]) > 1e-4 || Math.abs(z - piece.position[2]) > 1e-4) {
                        piece.position = [x, piece.position[1], z];
                        o.matrix.copy(Space.pieceMatrix(THREE, piece));
                        o.matrixWorldNeedsUpdate = true;
                        t.moved = true;
                    }
                }
                for (const g of Object.values(o.userData.lodGroups || {})) {
                    if (!lod) break;
                    g.size = lod.size * (g.scale || 1);
                    g.heights = lod.heights;
                }
            }
        } catch (error) {
            fail(error);
        } finally {
            t.busy = false;
        }
        if (t.again && state.tweak === t) {
            const next = t.again;
            t.again = null;
            tweakMeshes(next);
        }
    }
    // Preview atlases for a family's pieces, after a drag (a couple of seconds).
    async function tweakTextures(folder) {
        const t = state.tweak;
        const family = state.tweakFamilies.find(f => f.folder === folder);
        if (!t || !family || folder.startsWith("material:")) return;
        say("Tweak: redoing the textures…");
        try {
            const urls = await call("POST", "/api/tweak/textures", { folder, values: t.values[folder] });
            const load = pair => Promise.all([texture({ url: pair.map, scale: [1, 1], offset: [0, 0] }, true), texture({ url: pair.normal, scale: [1, 1], offset: [0, 0] }, false)]);
            // the family's atlases, and those of assets with their own (the Hut's silk)
            const own = new Map();
            for (const more of urls.more || []) {
                const pair = await load(more);
                for (const name of more.assets) own.set(name, pair);
            }
            const shared = await load(urls);
            for (const o of allObjects()) {
                if (!family.assets.includes(assetOf(o.userData.pieceName))) continue;
                const [map, normal] = own.get(assetOf(o.userData.pieceName)) || shared;
                for (const mesh of o.children) {
                    if (!mesh.isMesh || !mesh.material || mesh.userData.untinted) continue;
                    for (const m of [mesh.material].flat()) {
                        if (map) m.map = map;
                        if (normal) m.normalMap = normal;
                        m.needsUpdate = true;
                    }
                }
            }
            say("Tweak: textures updated.");
        } catch (error) {
            fail(error);
        }
    }

    // ---------- panels and buttons ----------
    function updateUi() {
        const editable = state.scene && state.scene.editable;
        const carrying = Boolean(state.carried);
        document.body.classList.toggle("carrying", carrying);
        // Add places a piece; while carrying a tablet it picks the tablet's text instead.
        $("addBtn").disabled = carrying ? !takesText(state.carried) : !(editable || (state.scene && state.scene.kind === "area"));
        $("addBtn").textContent = carrying && takesText(state.carried) ? "Add text" : "Add";
        // Drop, Cancel and Delete appear only while carrying (Delete only for a placed piece).
        $("dropBtn").hidden = !carrying;
        $("cancelBtn").hidden = !carrying;
        $("deleteBtn").hidden = !carrying || (state.carried.index < 0 && state.carried.index !== PLACED);
        $("undoBtn").disabled = !state.undo.length || carrying;
        $("redoBtn").disabled = !state.redo.length || carrying;
        // While tweaking, Add, Drop, Cancel and Delete hide, and undo and redo step through tweaks.
        if (state.tweak) {
            for (const id of ["addBtn", "dropBtn", "cancelBtn", "deleteBtn"]) $(id).hidden = true;
            $("undoBtn").disabled = !state.tweak.undo.length;
            $("redoBtn").disabled = !state.tweak.redo.length;
        } else $("addBtn").hidden = false;
        $("tweakBtn").hidden = !state.tweakFamilies.length;
        $("tweakBtn").classList.toggle("on", Boolean(state.tweak));
        $("saveBtn").disabled = !editable || !state.dirty;
        $("saveBtn").textContent = state.dirty ? "Save ●" : "Save";
        $("menuBtn").textContent = state.dirty ? "☰ ●" : "☰";
        $("snapBtn").classList.toggle("on", state.snap);
        $("labelsBtn").classList.toggle("on", state.labels);
        $("texturesBtn").classList.toggle("on", state.textures);
        $("normalMapsBtn").classList.toggle("on", state.normalMaps);
        $("noAmbientBtn").classList.toggle("on", state.noAmbient);
        $("normals2Btn").classList.toggle("on", state.normalsTimes2);
        $("fullSunHighlightBtn").classList.toggle("on", state.fullSunHighlight);
        $("lightsBtn").classList.toggle("on", state.lights);
        $("lightViewBtn").classList.toggle("on", state.lightView);
        Lights.uniforms.canopyLightCount.value = state.lights ? Lights.SLOTS : 0;
        Lights.uniforms.canopyLightView.value = state.lightView ? 1 : 0;
        $("unityShadersBtn").classList.toggle("on", state.unityShaders);
        $("unityShadersBtn").hidden = !Object.values(state.materials || {}).some(d => d && d.unity);
        $("fogBtn").classList.toggle("on", state.fog);
        $("tickBtn").classList.toggle("on", state.ticking);
        $("lodTintBtn").classList.toggle("on", state.lodTint);
        $("fogClipBtn").classList.toggle("on", state.fogClip);
        $("cullingBtn").classList.toggle("on", state.culling);
        $("candidatesBtn").classList.toggle("on", state.candidates);
        $("candidatesBtn").hidden = !state.candidateCount;
        $("lodLegend").style.display = state.lodTint ? "block" : "none";
        $("scalebar").style.display = carrying && state.carried.index !== REF_CUBE ? "flex" : "none";
        $("refCubeBtn").classList.toggle("on", state.refCube);
        $("inspectBtn").hidden = !inspectFolders().size;
        $("originBtn").classList.toggle("on", state.showOrigin);
        $("wireframeBtn").classList.toggle("on", state.wireframe);
        $("conditionsBtn").textContent = `Conditions: ${state.conditions}`;
        $("inactiveBtn").classList.toggle("on", state.inactive);
        $("windBtn").textContent = `Wind: ${WIND_LEVELS[state.windLevel]}`;
        $("gustBtn").textContent = `Gusts: ${GUST_LEVELS[state.gustLevel]}`;
        $("gustKindBtn").textContent = `Gusts as: ${state.gustKind}`;
        $("originBtn").disabled = !state.origin;
        $("hudBtn").classList.toggle("on", Play.displayOn());
        $("ffBtn").textContent = `Fast forward${state.ffStage ? `: ${state.ffStage}` : ""} ▸`;
        buildFastForward();
    }
    const submenus = [...document.querySelectorAll(".submenu")];
    function closePanels() {
        for (const id of ["palette", "importPanel", "folders", "menu", "tweakPanel"]) $(id).style.display = "none";
        for (const m of submenus) m.style.display = "none";
    }
    // ☰ (Ken, 2026-11-08: nothing more than one level below it) holds Scene ▸, Edit ▸, Surfaces ▸,
    // Light ▸, Overlays ▸, World ▸, Fast forward ▸ and Game mode; in game mode only Fast forward ▸,
    // Game display, Reframe scene and Edit mode. Choosing one closes it; a submenu opens in its
    // place, with ‹ Back. Submenus of toggles (data-stay: Surfaces, Light, Overlays, World) stay
    // open while they are flipped, until a tap elsewhere; the others close once one is chosen.
    $("menuBtn").onclick = e => {
        e.stopPropagation();
        const open = $("menu").style.display === "flex" || submenus.some(m => m.style.display === "flex");
        closePanels();
        $("menu").style.display = open ? "none" : "flex";
    };
    for (const b of $("menu").querySelectorAll("button")) b.addEventListener("click", () => ($("menu").style.display = "none"));
    for (const b of $("menu").querySelectorAll("[data-sub]")) {
        b.addEventListener("click", e => {
            e.stopPropagation();
            closePanels();
            $(b.dataset.sub).style.display = "flex";
        });
    }
    for (const m of submenus) {
        m.querySelector(".back").onclick = e => {
            e.stopPropagation();
            closePanels();
            $("menu").style.display = "flex";
        };
        if (!m.dataset.stay) m.addEventListener("click", e => { if (e.target.closest("button") && !e.target.closest(".back")) m.style.display = "none"; });
    }
    document.addEventListener("pointerdown", e => {
        if ($("menu").style.display === "flex" && !$("menu").contains(e.target) && e.target !== $("menuBtn")) $("menu").style.display = "none";
        for (const m of submenus) if (m.style.display === "flex" && !m.contains(e.target) && e.target !== $("menuBtn")) m.style.display = "none";
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
                row.addEventListener("click", () => choose(x).catch(fail));
                list.appendChild(row);
            }
        };
        const onArea = state.scene && state.scene.kind === "area";
        const choose = async x => {
            if (onArea && paletteMode() === "scenes" && state.unityScene) return addPiece(x.piece, true);
            if (onArea && !await newScene(state.scene.name)) return;
            return addPiece(x.piece);
        };
        // Add places a single piece, or with Scenes a whole assemblage scene (its prefab).
        $("palettePieces").classList.toggle("on", paletteMode() === "pieces");
        $("paletteScenes").classList.toggle("on", paletteMode() === "scenes");
        if (paletteMode() === "scenes") {
            section("Scenes (assemblages)", (palette.scenes || []).filter(s => !state.scene || s.name !== state.scene.name).map(s => ({ label: s.name, piece: s.prefab })));
            return;
        }
        section("Modl models", palette.modl || []);
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
            // On an imported area of a Canopy scene, Scenes places an assemblage in that scene; Pieces
            // first makes a composed scene on the area, which stays read-only.
            if (state.carried) {
                texts = texts || (await call("GET", "/api/texts")).texts;
                $("paletteFilter").placeholder = "Filter text ids";
            } else {
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
    const paletteMode = () => {
        try { return localStorage.getItem("layout.paletteMode") || "pieces"; } catch { return "pieces"; }
    };
    const setPaletteMode = mode => {
        try { localStorage.setItem("layout.paletteMode", mode); } catch { /* private mode */ }
        renderPalette();
    };
    $("palettePieces").onclick = () => setPaletteMode("pieces");
    $("paletteScenes").onclick = () => setPaletteMode("scenes");
    $("paletteClose").onclick = closePanels;
    $("dropBtn").onclick = drop;
    $("cancelBtn").onclick = cancel;
    $("deleteBtn").onclick = remove;
    $("labelsBtn").onclick = () => {
        state.labels = !state.labels;
        saveToggles();
        refreshLabels();
        updateUi();
    };
    // ☰ Tick: off, scripts get dt 0, so the sea, wind and anything else animated stand still.
    $("tickBtn").onclick = () => {
        state.ticking = !state.ticking;
        saveToggles();
        updateUi();
    };
    $("fogBtn").onclick = () => {
        state.fog = !state.fog;
        saveToggles();
        applyClip();
        applyEnvironment();
        updateUi();
    };
    $("candidatesBtn").onclick = () => {
        state.candidates = !state.candidates;
        saveToggles();
        say(state.candidates ? "Showing candidate tree meshes (cache/candidates)." : "Showing the shipped tree meshes.");
        updateUi();
    };
    $("cullingBtn").onclick = () => {
        state.culling = !state.culling;
        saveToggles();
        for (const o of allObjects()) {
            o.userData.culled = false;
            o.visible = shown(o);
        }
        say(state.culling ? `Culling: pieces past their distance (${Math.round(fogDistance())} m by the fog, trees 400 m) are hidden, ${Math.round((state.cullSettings || {}).perFrame * 100 || 5)}% checked a frame.` : "Culling off.");
        updateUi();
    };
    $("fogClipBtn").onclick = () => {
        state.fogClip = !state.fogClip;
        saveToggles();
        const far = applyClip();
        say(`Far clip ${Math.round(far)} m${state.fogClip ? " (FarClipManager: where the fog hides 95%)" : ""}.`);
        updateUi();
    };
    $("lodTintBtn").onclick = () => {
        state.lodTint = !state.lodTint;
        saveToggles();
        updateUi();
    };
    $("originBtn").onclick = () => {
        state.showOrigin = !state.showOrigin;
        saveToggles();
        showOrigin();
        updateUi();
    };
    // ☰ World › Conditions cycles met, start, saved; ☰ World › Inactive draws what is off faint. Both rebuild.
    const CONDITION_SAYS = { met: "the game's conditions met (its flags as the game sets them)", start: "as a new game starts the scene's stage", saved: "as saved in Unity, conditions ignored" };
    $("conditionsBtn").onclick = () => {
        state.conditions = Conditions.MODES[(Conditions.MODES.indexOf(state.conditions) + 1) % Conditions.MODES.length];
        saveToggles();
        rebuildBase();
        rebuildWorld();
        say(`Conditions: ${CONDITION_SAYS[state.conditions]}.`);
        updateUi();
    };
    // ☰ Fast forward ▸: Off (start mode is the scene's own stage) or a stage to start the game at
    // (applyFastForward); choosing a stage switches World › Conditions to start. Rebuilds, and in
    // game mode starts the inventory over.
    function buildFastForward() {
        const ff = state.fastForward, own = (state.symbols && state.symbols.stage) || null;
        const stages = ff ? ff.order : [];
        $("ffList").innerHTML = [["", `Off${own ? ` (the scene's stage, ${own})` : ""}`], ...stages.map(n => [n, `${n}${ff.configs[ff.stages[n]] ? "" : " (no FastForwardConfig)"}`])]
            .map(([value, label]) => `<button data-stage="${value}" class="${state.ffStage === value ? "on" : ""}">${label}</button>`).join("");
    }
    // ☰ Fast forward ▸: the chooser's FF: <stage> scenes (loadScene), the camera kept; Off, the area
    // open as itself
    $("ffList").addEventListener("click", e => {
        const b = e.target.closest("button[data-stage]");
        if (!b) return;
        closePanels();
        if (!b.dataset.stage) {
            if (state.scene.ff) loadScene(`area:${state.scene.name}`, true).catch(fail);
            else say("Fast forward is off.");
            return;
        }
        loadScene(`ff:${b.dataset.stage}`, true).catch(fail);
    });
    // The areas the game shows at the fast-forward stage: each area's earliest place played by then,
    // or always shown; never a terrain-only work in progress.
    function ffAreasFor(stage) {
        const rank = n => state.stageOrder.indexOf(n), at = rank(stage);
        if (at < 0) throw new Error(`Fast forward: no stage ${stage}`);
        return state.areaNames.filter(a => {
            const info = state.areaStages[a];
            if (!info || !info.auto) return false;
            if (info.from === null) return true;
            const from = rank(info.from);
            return from >= 0 && from <= at;
        });
    }
    // ☰ World › Wind and Gusts cycle the leaves' steady wind and gusts through their levels, added
    // (LeafGust: scripts/LeafGust.js); Gusts as switches cylinders and waves. Nothing rebuilds.
    const WIND_LEVELS = ["still", "light", "medium", "strong"], GUST_LEVELS = ["none", "light", "medium", "strong"];
    $("windBtn").onclick = () => {
        state.windLevel = (state.windLevel + 1) % 4;
        saveToggles();
        say(`Steady wind: ${WIND_LEVELS[state.windLevel]}.`);
        updateUi();
    };
    $("gustBtn").onclick = () => {
        state.gustLevel = (state.gustLevel + 1) % 4;
        saveToggles();
        say(`Gusts: ${GUST_LEVELS[state.gustLevel]}, added to the steady wind.`);
        updateUi();
    };
    $("gustKindBtn").onclick = () => {
        state.gustKind = GUST_KINDS[(GUST_KINDS.indexOf(state.gustKind) + 1) % GUST_KINDS.length];
        saveToggles();
        applyEnvironment();
        say(state.gustKind === "waves" ? "Gusts as waves, travelling downwind." : "Gusts as cylinders, up to three at once.");
        updateUi();
    };
    $("inactiveBtn").onclick = () => {
        state.inactive = !state.inactive;
        saveToggles();
        rebuildBase();
        rebuildWorld();
        say(state.inactive ? "Inactive objects drawn faint." : "Inactive objects hidden.");
        updateUi();
    };
    $("wireframeBtn").onclick = () => {
        state.wireframe = !state.wireframe;
        saveToggles();
        updateUi();
    };
    // ☰ Reframe scene (Ken, 2026-11-06): back to seeing the whole scene, as a first load frames
    // it, when the camera has been steered too far away to find it.
    $("reframeBtn").onclick = $("reframeGameBtn").onclick = () => {
        if (!sceneExtent()) return say("Nothing in the scene to frame.");
        frameAll();
        say(`Reframed ${state.scene.name}.`);
    };
    $("refCubeBtn").onclick = () => {
        state.refCube = !state.refCube;
        saveToggles();
        showRefCube();
        updateUi();
    };
    $("snapBtn").onclick = () => {
        state.snap = !state.snap;
        saveToggles();
        updateUi();
    };
    $("undoBtn").onclick = () => {
        if (state.tweak) return tweakHistory(state.tweak.undo, state.tweak.redo);
        if (!state.undo.length) return;
        state.redo.push(snapshot());
        restore(state.undo.pop());
    };
    $("redoBtn").onclick = () => {
        if (state.tweak) return tweakHistory(state.tweak.redo, state.tweak.undo);
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
        const also = area ? state.also : []; // the areas drawn alongside come too, as Area lines
        const on = area ? ` on ${area}` : "";
        const name = prompt(`New scene${on}, "<Type> <Name>" (e.g. Landmark Ring Forge):`);
        if (!name) return false;
        await call("POST", "/api/new", { name, area, also });
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
                name: $("areaName").value,
                terrainOnly: $("terrainOnly").checked
            });
            closePanels();
            await refreshList(`area:${result.name}`);
            await loadScene(`area:${result.name}`);
        } catch (error) {
            fail(error);
        }
    };
    // ☰ Areas (Claude, 2026-11-03): other imported areas drawn alongside the scene, read-only, as
    // an area a composed scene sits on is (Unity scenes share one world, so they line up), e.g.
    // Beech while viewing Hawthorn. Remembered per scene in this browser; a
    // composed scene's own Area lines are always drawn. The first area gives the settings (fog,
    // environment); each area's pieces keep their own scene's stage for Conditions.
    const alsoKey = value => `layout.also.${value}`;
    function loadAlso(value) {
        try {
            const v = JSON.parse(localStorage.getItem(alsoKey(value)));
            return Array.isArray(v) ? v.filter(a => typeof a === "string") : [];
        } catch {
            return []; // unreadable or blocked storage: none
        }
    }
    function saveAlso(value, list) {
        try {
            localStorage.setItem(alsoKey(value), JSON.stringify(list));
        } catch {
            // storage blocked: the choice just isn't remembered
        }
    }
    $("areasBtn").onclick = () => {
        if (!state.scene) return;
        const value = `${state.scene.kind}:${state.scene.name}`;
        const fixed = new Set([...(state.scene.kind === "area" ? [state.scene.name] : state.areaLines), ...state.withAreas]);
        const panel = $("folders");
        panel.innerHTML = "<div class='row'><b>Areas drawn alongside</b></div>";
        for (const area of state.areaNames) {
            const row = document.createElement("label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = fixed.has(area) || state.also.includes(area);
            box.disabled = fixed.has(area);
            box.onchange = () => {
                if (state.dirty) {
                    box.checked = !box.checked;
                    say("Save first: changing the areas reloads the scene");
                    return;
                }
                const chosen = loadAlso(value).filter(a => a !== area && state.areaNames.includes(a));
                if (box.checked) chosen.push(area);
                saveAlso(value, chosen);
                closePanels();
                loadScene(value, true).catch(fail);
            };
            const why = !fixed.has(area) ? "" : area === state.scene.name ? " (this area)" : state.withAreas.includes(area) ? " (goes with it)" : " (an Area line)";
            row.append(box, ` ${area}${why}`);
            panel.appendChild(row);
        }
        const close = document.createElement("button");
        close.textContent = "Close";
        close.onclick = closePanels;
        panel.appendChild(close);
        toggle("folders");
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
                saveHidden();
                for (const o of allObjects()) if (o.userData.folder === folder) o.visible = shown(o);
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
        saveToggles();
        updateUi();
        if (!state.carried) rebuildWorld();
    };
    // Materials More Lights moved onto Canopy's shaders, drawn on Unity's again or not (materialFor).
    // ☰ Surfaces › Normal maps (Ken, 2026-11-06: are they drawn at all?): off, every material lit by
    // its mesh's own normals, to see what its normal map adds.
    $("normalMapsBtn").onclick = () => {
        state.normalMaps = !state.normalMaps;
        saveToggles();
        for (const m of materials.values()) {
            if (!m.userData || !m.userData.normalMap) continue;
            m.normalMap = state.normalMaps ? m.userData.normalMap : null;
            m.needsUpdate = true;
        }
        say(state.normalMaps ? "Normal maps on." : "Normal maps off: lit by the meshes' own normals.");
        updateUi();
    };
    $("noAmbientBtn").onclick = () => {
        state.noAmbient = !state.noAmbient;
        applyEnvironment();
        say(state.noAmbient ? "Ambient light off: the sun alone (not remembered)." : "Ambient light on, as the game's.");
        updateUi();
    };
    $("fullSunHighlightBtn").onclick = () => {
        state.fullSunHighlight = !state.fullSunHighlight;
        applyEnvironment();
        say(state.fullSunHighlight ? "Highlights at the full sun, as the committed General (not remembered)." : "Highlights at the sun's intensity, as Canopy's shaders now.");
        updateUi();
    };
    $("normals2Btn").onclick = () => {
        state.normalsTimes2 = !state.normalsTimes2;
        for (const m of materials.values()) if (m.userData && m.userData.tilt !== undefined) m.normalScale.setScalar(m.userData.tilt * (state.normalsTimes2 ? 2 : 1));
        say(state.normalsTimes2 ? "Normal maps twice as strong (not remembered)." : "Normal maps at their own strength.");
        updateUi();
    };
    $("lightsBtn").onclick = () => {
        state.lights = !state.lights;
        saveToggles();
        updateUi();
        say(state.lights ? `Lights on: up to ${Lights.SLOTS} point lights per mesh (${Lights.count()} near enough now).` : "Lights off: the sun and ambient only.");
    };
    $("lightViewBtn").onclick = () => {
        state.lightView = !state.lightView;
        saveToggles();
        updateUi();
        if (state.lightView) say("Light crowding: how many lights reach each mesh. Gray none, blue 1, green 2, yellow 3, red 4.");
    };
    $("unityShadersBtn").onclick = () => {
        state.unityShaders = !state.unityShaders;
        saveToggles();
        updateUi();
        if (!state.carried) {
            rebuildBase();
            rebuildWorld();
        }
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
    // An uncommitted Canopy file changed (e.g. modl's --write): reload the scene where it is,
    // with materials made afresh (they hold their textures' URLs). Mid-drag in Tweak it waits for
    // the finger to lift; in Tweak the values not yet written are kept and put back (findTweaks).
    events.addEventListener("canopy", () => canopyReload());
    function canopyReload() {
        if (!state.scene || state.dirty) return;
        // carrying (it may be tweaked), the reload waits for the carry to end, which would lose it
        if (state.carried) {
            state.reloadAfterCarry = true;
            return;
        }
        if (state.tweak && state.tweak.drag) {
            state.tweak.reloadAfterDrag = true;
            return;
        }
        materials.clear();
        loadScene(`${state.scene.kind}:${state.scene.name}`, true).then(() => say("Canopy files changed; reloaded.")).catch(fail);
    }
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
