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
        fog: true,            // Canopy's fog (unity.json environment), on every material
        environment: null,    // the scene's unity.json environment: sun, ambient, fog, sky, sea
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
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        const log = gl.getShaderInfoLog(fragment) || gl.getShaderInfoLog(vertex) || gl.getProgramInfoLog(program);
        window.layoutError(`A surface shader didn't compile: ${String(log).trim().split("\n").slice(0, 3).join(" | ")}`);
    };
    // Fog by distance from the camera, as Canopy's shaders have it, not by depth along the view.
    THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace("- mvPosition.z", "length( mvPosition.xyz )");
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0.4, 1, 0.6);
    scene.add(sun);
    // The sea: one big plane at sea level that follows the camera (frame), drawn after the
    // opaque pieces, as Unity's sea queue (2950) is.
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000).rotateX(-Math.PI / 2), Surface.sea(null, 70));
    sea.frustumCulled = false;
    sea.renderOrder = -1;
    sea.visible = false;
    scene.add(sea);
    let skyFor; // the sky texture the background shows (its URL)
    // The sky: Canopy's CanSky.shader on a dome around the camera (drawn first, behind everything).
    // A sky point's height is the camera's plus its direction's y times skyRadius; below the black
    // line it is black, else the fog color blended to the sky texture from BlendMax, then tinted.
    const skyUniforms = {
        skyMap: { value: null }, skyHasMap: { value: 0 }, skyBlue: { value: new THREE.Color("#87a9c9") },
        skyFloor: { value: new THREE.Color() }, skyTint: { value: new THREE.Color() }, skyTintLevel: { value: 0 },
        skyBlendMin: { value: 0 }, skyBlendMax: { value: 0 }, skyBlackY: { value: -1e9 }, skyRadius: { value: 400 }
    };
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
        uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
        vertexShader: `varying vec3 vDir;
void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
        fragmentShader: `uniform sampler2D skyMap;
uniform float skyHasMap, skyTintLevel, skyBlendMin, skyBlendMax, skyBlackY, skyRadius;
uniform vec3 skyBlue, skyFloor, skyTint;
varying vec3 vDir;
void main() {
    vec3 d = normalize(vDir);
    float y = cameraPosition.y + d.y * skyRadius;
    vec3 c = vec3(0.0);
    if (y >= skyBlackY) {
        // the panorama the way Layout's background showed it (Three.js's equirectangular mapping)
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
        vec3 sky = skyHasMap > 0.5 ? texture2D(skyMap, uv).rgb : skyBlue;
        float t = clamp((y - skyBlendMax) / max(skyBlendMax - skyBlendMin, 0.0001), 0.0, 1.0);
        c = mix(skyFloor, sky, t);
        if (y > skyBlendMax) c = mix(c, skyTint, skyTintLevel);
    }
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
}`
    }));
    skyDome.frustumCulled = false;
    skyDome.renderOrder = -2;
    scene.add(skyDome);
    // Each frame, from the camera's height (the game uses the player's head).
    function updateSky() {
        const env = state.environment;
        if (!env) return;
        const y = camera.position.y;
        skyDome.position.copy(camera.position);
        skyDome.scale.setScalar(Math.min(10, camera.far * 0.5));
        skyUniforms.skyBlendMin.value = y + env.skyBlendMin;
        skyUniforms.skyBlendMax.value = y + env.skyBlendMax;
        skyUniforms.skyBlackY.value = env.skyBlackMult * y + env.skyBlackAdd;
    }
    // The scene's unity.json environment: the sun's direction and color, Canopy's fog (it keeps
    // exp2(-(density * distance)^2) of a color, Three.js exp(-(d * distance)^2)), the sky (a
    // panorama, sky blue until it loads) and the sea at its level.
    function applyEnvironment() {
        const env = state.environment;
        if (!env) return;
        const [x, y, z] = env.sunDirection;
        sun.position.set(-x, y, z).normalize(); // Unity's world is Three.js's with X mirrored
        sun.color.set(env.sunColor);
        scene.fog = state.fog ? new THREE.FogExp2(env.fogColor, env.fogDensity * Math.sqrt(Math.LN2)) : null;
        Surface.setEnvironment(env, state.fog);
        skyUniforms.skyFloor.value.set(env.fogColor);
        skyUniforms.skyTint.value.set(env.skyTint);
        skyUniforms.skyTintLevel.value = env.skyTintLevel;
        skyUniforms.skyRadius.value = env.skyRadius || 10 * camera.far; // see tools/config.js; applyClip keeps it
        const skyUrl = (env.sky && env.sky.map && env.sky.map.url) || null;
        if (skyFor !== skyUrl) {
            skyFor = skyUrl;
            scene.background = null;
            skyUniforms.skyHasMap.value = 0;
            texture(env.sky && env.sky.map, true).then(t => {
                if (!t || skyFor !== skyUrl) return;
                t.wrapS = THREE.RepeatWrapping;
                t.wrapT = THREE.ClampToEdgeWrapping;
                skyUniforms.skyMap.value = t;
                skyUniforms.skyHasMap.value = 1;
            });
        }
        const seaKey = JSON.stringify([env.sea, env.seaTile]);
        if (sea.userData.for !== seaKey) {
            sea.userData.for = seaKey;
            const material = sea.material = Surface.sea(env.sea, env.seaTile);
            texture(env.sea && env.sea.normal, false).then(t => {
                if (t) material.uniforms.seaNormal.value = t;
            });
        }
        sea.position.y = env.seaLevel;
        sea.visible = true;
    }
    const world = new THREE.Group();
    scene.add(world);
    // Near and far planes: the game's, from unity.json (near, far) when a scene loads; the game's
    // 0.03 to 400 m also keeps enough depth precision that far crossings (trunks at the sea) don't flicker.
    const camera = new THREE.PerspectiveCamera(55, 1, 0.03, 400);
    camera.position.set(0, 5, 15);
    camera.lookAt(0, 0, 0);
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
        for (const line of text.split("\n")) {
            const p = line.trim().split(/\s+/);
            if (p[0] === "#" && p[1] === "leaves") leaves = { per: +p[3], list: p.slice(4).flatMap(r => { const [a, b] = r.split("-").map(Number); return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i); }) };
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
        return g;
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
    // thinning in the leaf material (thinPatch). Leaves are runs of faces, in LeafSplit's order.
    function leafGeometry(base, split) {
        const g = base.clone();
        const count = g.attributes.position.count, tris = count / 3;
        const per = base.userData.leaves ? base.userData.leaves.per : tris / split.leafCount;
        const list = base.userData.leaves ? base.userData.leaves.list : Array.from({ length: Math.round(tris / per) }, (_, i) => i);
        const p = g.attributes.position.array, rank = new Float32Array(count), centre = new Float32Array(count * 3);
        list.forEach((leaf, j) => {
            const first = j * per * 3, last = (j + 1) * per * 3;
            const c = [0, 0, 0];
            for (let k = first; k < last; k++) for (let a = 0; a < 3; a++) c[a] += p[k * 3 + a] / (last - first);
            for (let k = first; k < last; k++) {
                rank[k] = leafRank(leaf);
                centre.set(c, k * 3);
            }
        });
        g.setAttribute("leafRank", new THREE.BufferAttribute(rank, 1));
        g.setAttribute("leafCenter", new THREE.BufferAttribute(centre, 3));
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
    function materialFor(guid, faint, split, strip) {
        const d = guid && state.materials[guid];
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
        const key = `${guid}|${faint}${split ? "|" + JSON.stringify([split.thin, split.maxDistance]) : ""}${strip ? "|strip" : ""}`;
        if (materials.has(key)) return materials.get(key);
        // Faces as the Unity shader culls them (tools/scene.js cullOf); strips and LeafSplit's
        // leaves draw both sides, as the game does (front and back instances).
        const side = strip || split || d.cull === 'Off' ? THREE.DoubleSide : d.cull === 'Front' ? THREE.BackSide : THREE.FrontSide;
        // A surface shader's material (web/surface.js); faint ones stay plain.
        if (d.surface && !faint) {
            materials.set(key, Surface.material(d, { side }));
            return materials.get(key);
        }
        let c = d.color.slice(0, 3).map(v => v * (d.brightness || 1));
        const top = Math.max(...c);
        if (top > 1) c = c.map(v => v / top);
        const opacity = faint ? 0.35 : d.transparent ? Math.min(1, d.color[3]) : 1;
        const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(...c), roughness: 0.85, metalness: 0, side, transparent: opacity < 1, opacity });
        // Shader patches, applied in order: darkening under the sea, LeafSplit's thinning, the detail texture.
        const patches = [["sea", Surface.underSea]];
        if (split) patches.push(["thin", thinPatch(split)]);
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
                m.normalMap = t;
                m.needsUpdate = true;
            }
        });
        if (d.detail) {
            texture(d.detail, true).then(t => {
                if (!t) return;
                // Multiply the detail texture in, tiled by its own scale, as the Unity shader does.
                m.defines = { ...(m.defines || {}), USE_UV: "" };
                patches.push(["detail", shader => {
                    shader.uniforms.detailMap = { value: t };
                    shader.uniforms.detailRepeat = { value: new THREE.Vector2(d.detail.scale[0], d.detail.scale[1]) };
                    shader.uniforms.detailOffset = { value: new THREE.Vector2(d.detail.offset[0], d.detail.offset[1]) };
                    shader.fragmentShader = "uniform sampler2D detailMap;\nuniform vec2 detailRepeat;\nuniform vec2 detailOffset;\n" + shader.fragmentShader.replace(
                        "#include <map_fragment>",
                        "#include <map_fragment>\n\tdiffuseColor.rgb *= texture2D(detailMap, vUv * detailRepeat + detailOffset).rgb;"
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
    // A Three.js group for one piece; its parts load asynchronously. tint replaces its materials.
    function buildObject(piece, tint) {
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.matrix.copy(Space.pieceMatrix(THREE, piece));
        const entry = state.library[piece.name];
        group.userData.folder = folderOf(entry || (piece.source ? { source: piece.source } : null));
        group.visible = shown(group);
        const faint = /\binactive\b/.test(piece.extra || "");
        const parts = piece.parts || (entry ? entry.parts : []); // an imported instance may carry its own
        // LOD groups (see updateLods): meshes that are one level of a group start hidden.
        const lodGroups = piece.lodGroups || (entry && entry.lodGroups) || null;
        if (lodGroups && Object.keys(lodGroups).length) group.userData.lodGroups = lodGroups;
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
                    const mesh = new THREE.Mesh(geometry, tint || (part.debug ? debugMaterial(part.debug, part.strip) : materialFor(part.material, faint, part.leafSplit, part.strip)));
                    if (part.debug) mesh.userData.debug = true;
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
        $("unityScene").innerHTML = list.unityScenes.map(n => `<option>${n}</option>`).join("");
        if (select) sel.value = select;
        return list;
    }
    // Textures, ☰ Snap, ☰ Labels, ☰ Fog and ☰ LOD tint are remembered per scene, in this browser; a scene not
    // seen before starts with these.
    const TOGGLES = { textures: true, snap: false, labels: false, fog: true, lodTint: false, candidates: false, fogClip: false, culling: false };
    const togglesKey = () => `layout.toggles.${state.scene.kind}:${state.scene.name}`;
    function loadToggles() {
        let saved;
        try {
            saved = JSON.parse(localStorage.getItem(togglesKey())) || {};
        } catch {
            saved = {}; // unreadable or blocked storage: start fresh
        }
        for (const [name, start] of Object.entries(TOGGLES)) state[name] = typeof saved[name] === "boolean" ? saved[name] : start;
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
    const cameraKey = () => `layout.camera.${state.scene.kind}:${state.scene.name}`;
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
            return true;
        } catch {
            return false;
        }
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
        const started = performance.now(), before = { meshes: geometries.size, textures: textures.size };
        const data = await call("GET", `/api/scene?kind=${kind}&name=${encodeURIComponent(name)}`);
        const fetched = performance.now();
        state.scene = { name, kind, editable: data.editable };
        loadToggles();
        state.pieces = data.pieces;
        state.area = data.area || null;
        state.base = data.base || [];
        Object.assign(state.library, data.library);
        Object.assign(state.materials, data.materials || {});
        state.environment = data.environment || null;
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
        localStorage.setItem("layout.scene", value);
        updateUi();
        const on = state.area ? `, on ${state.area} (${state.base.length}, read-only)` : "";
        say(`${name}: ${data.pieces.length} pieces${on}${data.problems.length ? `; ${data.problems.length} meshes failed` : ""}${data.editable ? "" : " (read-only; Add starts a scene on it)"}`);
        logLoad(name, started, fetched, before).catch(() => {});
    }
    // Tells layout.log how long the page took: the scene's JSON, then its meshes and textures,
    // which load after the scene appears (textures once their mesh is in).
    async function logLoad(name, started, fetched, before) {
        await Promise.all(geometries.values());
        await Promise.all(textures.values());
        const s = ms => `${(ms / 1000).toFixed(1)} s`;
        const done = performance.now();
        const text = `${s(done - started)}: scene JSON ${s(fetched - started)}, meshes and textures ${s(done - fetched)}; downloaded ${geometries.size - before.meshes} meshes, ${textures.size - before.textures} textures`;
        await call("POST", "/api/loaded", { name, text });
    }
    // Shown: not in a folder ☰ Folders hides, and not culled (☰ Culling).
    function shown(o) {
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
        camera.updateProjectionMatrix();
        if (env) skyUniforms.skyRadius.value = env.skyRadius || 10 * far;
        return far;
    }
    // The scene's middle and size; its size sets how far the camera frames it from and how fast
    // the camera moves, so it is worked out on every load, the camera restored or not.
    function sceneExtent() {
        const box = new THREE.Box3();
        for (const p of [...state.base, ...state.pieces]) box.expandByPoint(new THREE.Vector3(-p.position[0], p.position[1], p.position[2]));
        if (box.isEmpty()) return null;
        const size = Math.max(4, box.getSize(new THREE.Vector3()).length());
        state.orbitDistance = size * 0.8;
        return box.getCenter(new THREE.Vector3());
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
    // orbiting and spinning (A, D) take that pose again (holdingCarried).
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
        say(`Carrying ${name}. Move to carry it, drag to circle it, A and D to spin it, then Drop.${takesText(state.carried) ? " Add text picks its text." : ""}`);
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
    // stays put; A and D spin it instead (spin). A drag the width of the screen goes a quarter
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
    function speed() {
        const base = state.carried ? sizeOf(state.carried.object) * 1.5 : state.orbitDistance * 0.3;
        return Math.max(0.5, base * 0.5); // halved for now (Ken, 2026-10-21)
    }

    // Touch: one finger looks around (or, carrying, circles the piece); a pinch travels
    // forward and back like W and S, at their speed (spreading 200 px is a second of W); a tap selects.
    const pointers = new Map();
    let gesture = null;
    let pinchStart = null; // the fingers' spread when the pinch began
    canvas.addEventListener("pointerdown", e => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
        pinchStart = null;
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
            // Faster the farther the fingers have spread (or closed) since the pinch began: up to
            // four times at 300 px (Ken, 2026-10-26).
            if (pinchStart === null) pinchStart = before;
            const ramp = 1 + 3 * Math.min(1, Math.abs(after - pinchStart) / 300);
            move("forward", (after - before) / 200 * speed() * ramp);
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
        const objects = state.carried ? [...allObjects(), state.carried.object] : allObjects();
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
        }
    }
    $("lodLegend").innerHTML = LOD_COLORS.map((c, i) => `<span style="color:${c}">L${i}</span>`).join(" ") + ' <span id="lodTris"></span>';
    let lodShown = 0;

    const heldFor = new Map(); // seconds each move key has been held
    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        // A and D sidestep at half speed (Ken, 2026-10-22); carrying, they spin the piece a quarter
        // turn a second (Ken, 2026-10-25).
        // Over 1.4 s of holding, W and S speed up from a third of the speed to four times it, Q and E
        // from a sixth to twice it (Ken, 2026-10-26).
        const RAMPS = { forward: [1 / 3, 4], back: [1 / 3, 4], up: [1 / 6, 2], down: [1 / 6, 2] };
        for (const d of [...heldFor.keys()]) if (!held.has(d)) heldFor.delete(d);
        for (const direction of held) {
            heldFor.set(direction, (heldFor.get(direction) || 0) + dt);
            const sideways = direction === "left" || direction === "right";
            const [from, to] = RAMPS[direction] || [1, 1];
            const ramp = from + (to - from) * Math.min(1, heldFor.get(direction) / 1.4);
            if (state.carried && sideways) spin((direction === "left" ? -1 : 1) * Math.PI / 2 * dt); // A clockwise from above (Ken, 2026-10-25)
            else move(direction, speed() * dt * (sideways ? 0.5 : ramp));
        }
        if (state.carried) {
            state.carried.object.matrix.copy(carriedMatrix());
            for (const s of labels.children) if (s.userData.object === state.carried.object) placeLabel(s, s.userData.object);
            state.carried.object.updateMatrixWorld(true);
            highlight.setFromObject(state.carried.object);
            highlight.visible = true;
        }
        Surface.uniforms.canopyTime.value = now / 1000;
        // Canopy darkens what is under the sea only while the eye is above it.
        Surface.uniforms.canopyHeadUnder.value = camera.position.y < sea.position.y ? 1 : 0;
        sea.position.x = camera.position.x;
        sea.position.z = camera.position.z;
        updateCulling();
        updateLods();
        updateSky();
        saveCamera(now);
        renderer.render(scene, camera);
        if (state.lodTint && now - lodShown > 500) {
            lodShown = now;
            const culled = state.culling ? allObjects().filter(o => o.userData.culled).length : 0;
            $("lodTris").textContent = `${renderer.info.render.triangles.toLocaleString()} triangles${state.culling ? `, ${culled} pieces culled` : ""}`;
        }
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
        $("texturesBtn").classList.toggle("on", state.textures);
        $("fogBtn").classList.toggle("on", state.fog);
        $("lodTintBtn").classList.toggle("on", state.lodTint);
        $("fogClipBtn").classList.toggle("on", state.fogClip);
        $("cullingBtn").classList.toggle("on", state.culling);
        $("candidatesBtn").classList.toggle("on", state.candidates);
        $("candidatesBtn").hidden = !state.candidateCount;
        $("lodLegend").style.display = state.lodTint ? "block" : "none";
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
        saveToggles();
        refreshLabels();
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
    $("snapBtn").onclick = () => {
        state.snap = !state.snap;
        saveToggles();
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
