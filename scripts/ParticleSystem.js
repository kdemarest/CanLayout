// Stand-in for Unity's particle systems (Shuriken; Ken, 2026-10-29: the Driller's smoke first), from
// tools/particles.js's description of each: a system that plays on awake emits at its rate and
// bursts from its shape (cone, sphere, hemisphere, box, circle, edge), each particle starting with
// its lifetime, speed, size, rotation and color, then sized, turned, colored and pushed over its
// life by those modules, with gravity and noise (Ken, 2026-10-29: the gems' breadcrumbs wander), in
// the emitter's space or the world's; drawn as camera-facing
// billboards (a texture sheet animated) in one batch (none in render mode None), and its trails
// (below) in another, each by a port of its material's shader
// (Canopy/ParticleContrast, ParticleGeneral, ParticleSolid, ParticleUnlit, TransparentLit; others
// as texture times color). Modules
// it doesn't do are named once in the console. As in the game, a system in a LODGroup level runs
// and shows only while that level is drawn, and a PfxLod beside it (scripts/PfxLod.js) thins its
// emission with distance and pauses it; and here one more than 100 m from the camera waits (the
// Tangle has some 280 that play by themselves). Off screen (the box round its particles, as of its
// last update, out of the camera's view) it does what its cullingMode says, as Unity does: automatic
// pauses a looping system and keeps simulating any other; pause; pause, then catch up the time
// missed (up to its duration) when seen again; or always simulate. Canopy/Blank (it clips every
// pixel) draws nothing.
(function () {
    const lerp = (a, b, t) => a + (b - a) * t;
    const slope = v => (Number.isFinite(v) ? v : 0);
    // a Unity curve's keys ([time, value, inSlope, outSlope]) at t: Hermite between keys
    function keysAt(k, t) {
        const n = k ? k.length : 0;
        if (!n) return 0;
        if (t <= k[0][0]) return k[0][1];
        if (t >= k[n - 1][0]) return k[n - 1][1];
        let i = 0;
        while (i < n - 2 && t > k[i + 1][0]) i++;
        const [t0, v0, , o0] = k[i], [t1, v1, i1] = k[i + 1], d = t1 - t0 || 1e-6, s = (t - t0) / d, s2 = s * s, s3 = s2 * s;
        return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * d * slope(o0) + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * d * slope(i1);
    }
    // Noise: Ken Perlin's improved gradient noise (2002), about -1 to 1, in one, two or three
    // dimensions (Unity's noise quality: low, medium, high).
    const PERM = (() => {
        const p = Array.from({ length: 256 }, (_, i) => i);
        let seed = 1337;
        for (let i = 255; i > 0; i--) {
            seed = (seed * 16807) % 2147483647;
            const j = seed % (i + 1);
            [p[i], p[j]] = [p[j], p[i]];
        }
        return Uint8Array.from([...p, ...p]);
    })();
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    function grad(h, x, y, z) {
        const u = (h & 15) < 8 ? x : y, v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z;
        return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    }
    function noise3(x, y, z) {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
        x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
        const u = fade(x), v = fade(y), w = fade(z), P = PERM;
        const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
        return lerp(lerp(lerp(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), lerp(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
            lerp(lerp(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), lerp(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v), w);
    }
    // The noise's push on a particle at pos (out, per second): each axis its own field (offset
    // apart), sampled at pos times the frequency, moved along by the scroll, its octaves added (each
    // octaveScale finer and octaveMultiplier weaker), times that axis's strength at tl (its life so
    // far) over the frequency with damping (Unity: higher frequency reduces the strength
    // proportionally), times positionAmount.
    const AXIS = [[0, 0, 0], [31.4, 47.2, 12.8], [-19.1, 83.7, -55.3]];
    function noisePush(n, pos, tl, r, scroll, out) {
        const amount = sample(n.position, tl, r) / (n.damping ? n.frequency || 1 : 1);
        const v = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
            let total = 0, freq = n.frequency, weight = 1;
            for (let o = 0; o < n.octaves; o++) {
                const at = [pos.x * freq + scroll, n.quality >= 1 ? pos.y * freq + scroll : 0, n.quality >= 2 ? pos.z * freq + scroll : 0];
                total += weight * noise3(at[0] + AXIS[a][0], at[1] + AXIS[a][1], at[2] + AXIS[a][2]);
                freq *= n.octaveScale;
                weight *= n.octaveMultiplier;
            }
            v[a] = total * sample(n.strength[a], tl, r) * amount;
        }
        return out.set(v[0], v[1], v[2]);
    }
    // a min-max curve at t (0 to 1), r the particle's random for "between two" modes
    function sample(c, t, r) {
        if (!c) return 0;
        if (c.mode === 1) return c.scalar * keysAt(c.maxKeys, t);
        if (c.mode === 2) return c.scalar * lerp(keysAt(c.minKeys, t), keysAt(c.maxKeys, t), r);
        if (c.mode === 3) return lerp(c.min, c.scalar, r);
        return c.scalar;
    }
    function gradientAt(g, t) {
        const pick = (keys, n) => {
            if (!keys.length) return Array(n).fill(1);
            if (t <= keys[0][0]) return keys[0].slice(1);
            for (let i = 0; i < keys.length - 1; i++) {
                const a = keys[i], b = keys[i + 1];
                if (t <= b[0]) {
                    if (g.fixed) return b.slice(1);
                    const s = (t - a[0]) / (b[0] - a[0] || 1e-6);
                    return a.slice(1).map((v, j) => lerp(v, b[j + 1], s));
                }
            }
            return keys[keys.length - 1].slice(1);
        };
        return [...pick(g.colors, 3), pick(g.alphas, 1)[0]];
    }
    // a min-max color at t (sRGB, as Unity keeps it)
    function colorAt(c, t, r) {
        if (!c) return [1, 1, 1, 1];
        if (c.mode === 1 && c.maxGradient) return gradientAt(c.maxGradient, t);
        if (c.mode === 2) return c.min.map((v, i) => lerp(v, c.max[i], r));
        if (c.mode === 3 && c.minGradient && c.maxGradient) { const a = gradientAt(c.minGradient, t), b = gradientAt(c.maxGradient, t); return a.map((v, i) => lerp(v, b[i], r)); }
        if (c.mode === 4 && c.maxGradient) return gradientAt(c.maxGradient, r);
        return c.max;
    }
    const linear = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

    const VERTEX = `
attribute vec3 iPos;
attribute float iSize;
attribute float iRot;
attribute vec4 iColor;
attribute vec4 iUv;
varying vec2 vUv;
varying vec4 vColor;
varying float vDist;
void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float c = cos(iRot), s = sin(iRot);
    vec2 q = position.xy * iSize;
    mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    vUv = iUv.xy + uv * iUv.zw;
    vColor = iColor;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
}`;
    // a trail's strip: its points already placed and facing the camera, on the CPU
    const TRAIL_VERTEX = `
attribute vec4 tColor;
varying vec2 vUv;
varying vec4 vColor;
varying float vDist;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vUv = uv;
    vColor = tColor;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
}`;
    const TRAIL_POINTS = 4000; // at most, in all of a system's trails
    const HEAD = `
uniform sampler2D map;
uniform vec4 mapST;
uniform vec4 tint;
uniform float density, contrast, brightness, fogLevel, cutoff, canopyFogDensitySquared;
uniform vec3 canopyAmbient, canopySunLight;
varying vec2 vUv;
varying vec4 vColor;
varying float vDist;
float fog() { return clamp(exp2(-canopyFogDensitySquared * fogLevel * fogLevel * vDist * vDist), 0.0, 1.0); }
vec4 texel() { return texture2D(map, vUv * mapST.xy + mapST.zw); }
`;
    // each shader's look, as its Unity source (fog fades toward black, as UNITY_APPLY_FOG_COLOR(..., 0) does)
    const SHADERS = {
        "Canopy/ParticleContrast": { blending: "normal", frag: `
void main() {
    vec4 tex = texel();
    vec3 rgb = vColor.rgb * tex.rgb * tex.a * brightness * tint.rgb;
    float a = clamp(density * vColor.a * tex.a * tint.a, 0.0, 1.0);
    rgb *= (a - 0.5) * contrast + 0.5;
    gl_FragColor = vec4(rgb * fog(), a);
    #include <colorspace_fragment>
}` },
        "Canopy/ParticleGeneral": { blending: "additive", frag: `
void main() {
    vec4 tex = texel();
    vec3 rgb = (vColor.rgb + tex.rgb) * brightness * tint.rgb;
    float a = clamp(density * vColor.a * tex.a, 0.0, 1.0);
    gl_FragColor = vec4(rgb * fog(), a);
    #include <colorspace_fragment>
}` },
        "Canopy/ParticleSolid": { blending: "normal", solid: true, frag: `
void main() {
    vec4 tex = texel();
    if (tex.a < cutoff) discard;
    vec4 col = tex * vColor * tint;
    gl_FragColor = vec4(col.rgb * (canopyAmbient + 0.6 * canopySunLight) * fog(), 1.0);
    #include <colorspace_fragment>
}` },
        // Canopy/ParticleUnlit (More Lights phase 3): Unity's Particles/Standard Unlit as Canopy uses it:
        // the texture times _Color, the particle's color by _ColorMode (0 multiply; 1, 2, 5 add,
        // subtract, difference by _ColorAddSubDiff; 3 overlay), _Mode's alpha (1 cut, 2 to 5
        // blended, 6 modulate), blended as its _DstBlend says (One: additive)
        "Canopy/ParticleUnlit": { blending: "material", tint: "_Color", frag: `
uniform float colorMode, alphaMode;
uniform vec4 addSubDiff;
void main() {
    vec4 a = texel() * tint;
    if (colorMode == 3.0) {
        a.rgb = mix(1.0 - 2.0 * (1.0 - a.rgb) * (1.0 - vColor.rgb), 2.0 * a.rgb * vColor.rgb, step(a.rgb, vec3(0.5)));
        a.a *= vColor.a;
    } else if (colorMode == 1.0 || colorMode == 2.0 || colorMode == 5.0) {
        a.rgb = a.rgb + vColor.rgb * addSubDiff.x;
        a.rgb = mix(a.rgb, abs(a.rgb), addSubDiff.y);
        a.a *= vColor.a;
    } else a *= vColor;
    if (alphaMode == 1.0 && a.a < cutoff) discard;
    if (alphaMode == 6.0) a.rgb = mix(vec3(1.0), a.rgb, a.a);
    if (alphaMode < 2.0 || alphaMode > 5.0) a.a = 1.0;
    gl_FragColor = vec4(a.rgb * fog(), a.a);
    #include <colorspace_fragment>
}` },
        // Canopy/TransparentLit's particles (SmokeLight): the texture times _Tint times the
        // particle's color, lit as ParticleSolid is here, blended by its alpha
        "Canopy/TransparentLit": { blending: "normal", frag: `
void main() {
    vec4 col = texel() * vColor * tint;
    gl_FragColor = vec4(col.rgb * (canopyAmbient + 0.6 * canopySunLight) * fog(), col.a);
    #include <colorspace_fragment>
}` },
        default: { blending: "normal", frag: `
void main() {
    vec4 col = texel() * vColor;
    gl_FragColor = vec4(col.rgb * fog(), col.a);
    #include <colorspace_fragment>
}` }
    };
    const warned = new Set();
    let frustum = null, frustumAt = null; // the camera's view, worked out once a frame
    let softDot = null; // Unity's Default-Particle stand-in: a soft round dot

    Tickable.register("ParticleSystem", class extends Tickable {
        start() {
            const f = this.fields;
            const d = (f.material && this.describe(f.material.asset)) || null;
            this.playing = f.playOnAwake && f.renderOn !== false && Boolean(f.emission) && !(d && d.shaderName === "Canopy/Blank");
            // one an EffectBoolFade fades in (tools/unity.js fades): it plays while a gate on it or its
            // piece holds (web/tickable.js switches it off when it doesn't); with none, nothing in
            // Layout would ever fade it in
            if (f.fades && !this.when && !(this.piece && this.piece.when)) this.playing = false;
            if (!this.playing) return;
            for (const u of f.unsupported) {
                if (warned.has(u)) continue;
                warned.add(u); // once a page, by what isn't done
                console.warn(`particles: ${u} isn't drawn (first seen on ${(this.objectOf(this.object) || {}).name || "?"})`);
            }
            const THREE = this.THREE;
            this.makeSpace(f.world);
            this.E = new THREE.Matrix4();
            this.R = new THREE.Matrix4();
            this.Q = new THREE.Quaternion();
            this.v = new THREE.Vector3();
            this.w = new THREE.Vector3();
            this.box = new THREE.Box3(); // round its particles, in its space's axes, as of the last update
            this.seen = new THREE.Box3();
            this.scaling();
            this.build(Math.min(f.maxParticles, 2000));
            if (f.trail) this.buildTrails(TRAIL_POINTS);
            this.restart();
        }
        // Playing from the start, none yet (prewarmed, a looping one that says so), as on awake.
        restart() {
            const f = this.fields;
            this.particles = [];
            this.clock = -sample(f.startDelay, 0, Math.random());
            this.owed = 0;
            this.stepped = false; // no step yet: a burst at time 0 is still to fire
            this.missed = 0; // seconds off screen, for pause and catch up
            this.emitted = 0; // particles made so far: a ribbon takes every ribbonCount-th
            this.orphans = []; // trails whose particles died, fading out point by point (dieWithParticles off)
            this.box.makeEmpty();
            if (f.prewarm && f.looping) for (let t = 0; t < f.duration; t += 0.1) this.step(0.1);
        }
        // Its object switched off (web/tickable.js): its particles gone, as Unity's SetActive(false)
        // takes them; back on, it plays from the start, as on awake.
        switchOff() {
            if (!this.playing) return;
            this.particles = [];
            this.orphans = [];
            this.show(false);
        }
        switchOn() {
            if (this.playing) this.restart();
        }

        build(max) {
            const THREE = this.THREE, f = this.fields;
            const geometry = new THREE.InstancedBufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
            geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
            geometry.setIndex([0, 1, 2, 0, 2, 3]);
            const attr = n => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
            this.attrs = { iPos: attr(3), iSize: attr(1), iRot: attr(1), iColor: attr(4), iUv: attr(4) };
            for (const [k, a] of Object.entries(this.attrs)) geometry.setAttribute(k, a);
            geometry.instanceCount = 0;
            this.max = max;
            this.material = this.look(f.material, VERTEX);
            this.mesh = new THREE.Mesh(geometry, this.material);
            this.mesh.renderOrder = this.material.userData.order;
            this.mesh.frustumCulled = false; // its particles go where they go
            this.mesh.userData.debug = true;
            this.space.add(this.mesh);
        }
        // A material drawing as its Unity material's shader does (null: Unity's Default-Particle),
        // with this vertex shader; userData.order is its render queue as app.js orders meshes.
        look(material, vertexShader) {
            const THREE = this.THREE;
            const d = (material && this.describe(material.asset)) || null;
            const look = SHADERS[d && d.shaderName] || SHADERS.default;
            const v = (name, start) => ((d && d.values && d.values[name]) || start);
            const tc = (look.tint && v(look.tint, null)) || v("_TintColor", null) || v("_Tint", [1, 1, 1, 1]);
            if (!softDot) {
                const n = 32, px = new Uint8Array(n * n * 4);
                for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2); px.set([255, 255, 255, Math.max(0, 1 - r) ** 2 * 255], (y * n + x) * 4); }
                softDot = new THREE.DataTexture(px, n, n);
                softDot.needsUpdate = true;
            }
            const st = d && d.map ? [...d.map.scale, ...d.map.offset] : [1, 1, 0, 0];
            const u = Surface.uniforms;
            const out = new THREE.ShaderMaterial({
                uniforms: {
                    map: { value: softDot }, mapST: { value: new THREE.Vector4(...st) },
                    tint: { value: new THREE.Vector4(linear(tc[0]), linear(tc[1]), linear(tc[2]), tc[3] ?? 1) },
                    density: { value: v("_Density", [1])[0] }, contrast: { value: v("_Contrast", [1])[0] }, brightness: { value: v("_Brightness", [1])[0] },
                    fogLevel: { value: v("_FogLevel", [1])[0] }, cutoff: { value: v("_Cutoff", [0.5])[0] },
                    colorMode: { value: v("_ColorMode", [0])[0] }, alphaMode: { value: v("_Mode", [0])[0] }, addSubDiff: { value: new THREE.Vector4(...v("_ColorAddSubDiff", [0, 0, 0, 0])) },
                    canopyFogDensitySquared: u.canopyFogDensitySquared, canopyAmbient: u.canopyAmbient, canopySunLight: u.canopySunLight
                },
                vertexShader, fragmentShader: HEAD + look.frag,
                transparent: !look.solid, depthWrite: Boolean(look.solid), side: THREE.DoubleSide,
                blending: look.blending === "additive" || (look.blending === "material" && v("_DstBlend", [10])[0] === 1) ? THREE.AdditiveBlending : THREE.NormalBlending
            });
            if (d && d.map) this.texture(d.map, true).then(t => { if (t) out.uniforms.map.value = t; });
            out.userData.order = ((d && d.queue) ?? 3000) - 3000;
            return out;
        }
        // A particle's size and color (sRGB, as Unity keeps it) now, tl its life so far (0 to 1).
        sizeOf(p, tl) {
            return p.size * this.sizeScale * (this.fields.sizeOverLife ? sample(this.fields.sizeOverLife, tl, p.rz) : 1);
        }
        colorOf(p, tl) {
            const c = this.fields.colorOverLife ? colorAt(this.fields.colorOverLife, tl, p.rc) : [1, 1, 1, 1];
            return p.color.map((v, i) => v * c[i]);
        }
        // Unity hands the shader its particles' colors converted to linear only when the renderer's
        // Apply Active Color Space is on (Canopy draws in linear); off, as on most of Canopy's, they
        // go as they are, so they look stronger (Ken, 2026-10-30: the gems' green showed white)
        get toShader() {
            return this.fields.applyColorSpace ? linear : x => x;
        }
        // Drawn or not: the billboards (none in render mode None) and the trails.
        show(on) {
            this.mesh.visible = on && this.fields.renderMode !== 5;
            if (this.trails) this.trails.mesh.visible = on;
        }
        // Unity's scalingMode (Claude, 2026-11-09: 850 of the 1379 systems drawn, hierarchy-scaled under
        // a cage's 0.25 and the like, were drawn up to 4 times too big and, in local space, moving 4
        // times too far): hierarchy (0) scales the particles' size, where they start and, in local
        // space, how they move by the emitter's world scale; local (1) by its own scale only, never
        // its parents'; shape (2) only where they start, by its world scale. A local-space system is
        // drawn inside its piece (scaled by the piece's scale), a world-space one in the world, so
        // each scale is taken over what its space already gives. Sets eScale (the emitter matrix's),
        // shapeScale (where particles start, before it) and sizeScale.
        scaling() {
            const f = this.fields, THREE = this.THREE, o = this.objectOf(this.object), objects = this.prefab.objects || {};
            if (![0, 1, 2].includes(f.scaling)) throw new Error(`particles: no scalingMode on ${(o || {}).name || this.object}: re-import its area (tools/particles.js reads it)`);
            if (!o) throw new Error(`particles: no object ${this.object} for the system`);
            const len = m => Math.hypot(m[0], m[4], m[8]);
            this.group.updateWorldMatrix(true, false);
            const piece = Math.abs(new THREE.Vector3().setFromMatrixScale(this.group.matrixWorld).x) || 1;
            const father = o.father && objects[o.father];
            const world = len(o.m) * piece, own = father ? len(o.m) / (len(father.m) || 1) : world;
            const k = f.scaling === 0 ? { size: world, shape: world, move: world } : f.scaling === 1 ? { size: own, shape: own, move: own } : { size: 1, shape: world, move: 1 };
            if (f.world) Object.assign(this, { eScale: k.shape / piece, shapeScale: 1, sizeScale: k.size });
            else Object.assign(this, { eScale: k.move / piece, shapeScale: k.shape / (k.move || 1), sizeScale: k.size / piece });
        }
        // The emitter's place and turn in the space particles live in (the world's, or the prefab's).
        emitter() {
            const p = this.positionOf(this.object), q = this.fields.aim ? this.aimed(p) : this.rotationOf(this.object);
            this.E.compose(p, q, this.v.set(this.eScale, this.eScale, this.eScale));
            if (this.fields.world) this.E.premultiply(Space.mirrorX(this.worldMatrix())); // Unity's world, from Three.js's (moved with a carried item)
            this.Q.setFromRotationMatrix(this.R.extractRotation(this.E));
            return this.E;
        }
        // A guard's beam (tools/unity.js guardBeams): turned to fields.aim (the cage, in the prefab's
        // axes) from p, as Transform.LookAt turns it: its Z there, its Y as near up as can be.
        aimed(p) {
            const THREE = this.THREE, z = new THREE.Vector3(...this.fields.aim).sub(p).normalize();
            const x = new THREE.Vector3(0, 1, 0).cross(z).normalize(), y = z.clone().cross(x);
            return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
        }
        // Where a new particle starts and which way it goes, in the emitter's own axes.
        shape() {
            const THREE = this.THREE, s = this.fields.shape, r = Math.random;
            const pos = new THREE.Vector3(), dir = new THREE.Vector3(0, 0, 1);
            if (!s) return { pos, dir };
            const unit = () => { const z = r() * 2 - 1, a = r() * Math.PI * 2, k = Math.sqrt(1 - z * z); return new THREE.Vector3(k * Math.cos(a), k * Math.sin(a), z); };
            const radial = () => Math.sqrt(lerp((1 - s.thickness) ** 2, 1, r())) * s.radius;
            const arc = () => r() * s.arc * Math.PI / 180;
            if (s.type === 0 || s.type === 1 || s.type === 2 || s.type === 3) {
                dir.copy(unit());
                if ((s.type === 2 || s.type === 3) && dir.z < 0) dir.z = -dir.z;
                pos.copy(dir).multiplyScalar(s.radius * Math.cbrt(lerp((1 - s.thickness) ** 3, 1, r())));
            } else if ([4, 7, 8, 9].includes(s.type)) {
                const rho = radial(), phi = arc(), tilt = s.angle * Math.PI / 180 * (s.radius ? rho / s.radius : 1);
                pos.set(rho * Math.cos(phi), rho * Math.sin(phi), 0);
                dir.set(Math.sin(tilt) * Math.cos(phi), Math.sin(tilt) * Math.sin(phi), Math.cos(tilt));
                if (s.type === 8 || s.type === 9) pos.addScaledVector(dir, s.length * r());
            } else if (s.type === 5 || s.type === 15 || s.type === 16) {
                pos.set(r() - 0.5, r() - 0.5, r() - 0.5);
            } else if (s.type === 10 || s.type === 11 || s.type === 17) {
                const rho = radial(), phi = arc();
                pos.set(rho * Math.cos(phi), rho * Math.sin(phi), 0);
                dir.set(Math.cos(phi), Math.sin(phi), 0);
            } else if (s.type === 12) {
                pos.set((r() * 2 - 1) * s.radius, 0, 0);
                dir.set(0, 1, 0);
            }
            if (s.randomDirection) dir.lerp(unit(), s.randomDirection).normalize();
            const turn = Space.unityEulerToQuaternion(THREE, s.rotation);
            pos.multiply(new THREE.Vector3(...s.scale)).applyQuaternion(turn).add(new THREE.Vector3(...s.position));
            dir.applyQuaternion(turn).normalize();
            return { pos, dir };
        }
        emit(count, tn) {
            const f = this.fields, r = Math.random;
            for (let n = 0; n < count && this.particles.length < this.max; n++) {
                const { pos, dir } = this.shape();
                pos.multiplyScalar(this.shapeScale);
                const vel = dir.multiplyScalar(sample(f.speed, tn, r()));
                if (f.world) { pos.applyMatrix4(this.E); vel.applyQuaternion(this.Q); }
                let rot = sample(f.rotation, tn, r());
                if (f.randomizeRotation && r() < f.randomizeRotation * 0.5) rot = -rot;
                const p = { pos, vel, age: 0, life: Math.max(0.01, sample(f.lifetime, tn, r())), size: sample(f.size, tn, r()), rot, color: colorAt(f.color, tn, r()), rs: r(), rz: r(), rc: r(), rv: r(), rf: r(), rn: r(), row: Math.floor(r() * 1000) };
                const tr = f.trail;
                if (tr) p.ribbon = this.emitted++ % tr.ribbonCount;
                if (tr && tr.mode === 0 && r() < tr.ratio) p.trail = { points: [], life: sample(tr.lifetime, tn, r()) * p.life * (tr.sizeAffectsLifetime ? p.size : 1) };
                this.particles.push(p);
            }
        }
        step(dt, factor = 1) {
            const f = this.fields, THREE = this.THREE;
            this.emitter();
            const before = this.clock;
            this.clock += dt * f.simulationSpeed;
            if (this.clock >= 0 && (f.looping || this.clock <= f.duration)) {
                // prev: just before 0 on its first step, so a burst at time 0 fires as it starts
                const t = f.looping ? this.clock % f.duration : this.clock, prev = !this.stepped ? -1e-9 : f.looping ? before % f.duration : before, tn = t / f.duration;
                this.stepped = true;
                this.owed += sample(f.emission.rate, tn, Math.random()) * factor * dt * f.simulationSpeed;
                const whole = Math.floor(this.owed);
                this.owed -= whole;
                this.emit(whole, tn);
                for (const b of f.emission.bursts) {
                    // cycles 0 is Unity's Infinite: every interval through the system's duration
                    // (Claude, 2026-11-10: the Tangle's DeviceSkyPfx, 20 every 10 s, never emitted)
                    const cycles = b.cycles > 0 ? b.cycles : Math.max(1, Math.ceil((f.duration - b.time) / Math.max(b.interval, 0.01)));
                    for (let c = 0; c < cycles; c++) {
                        const at = b.time + c * b.interval;
                        const crossed = prev <= t ? at > prev && at <= t : at > prev || at <= t; // the loop wrapped
                        if (crossed && Math.random() < b.probability) this.emit(Math.round(sample(b.count, tn, Math.random())), tn);
                    }
                }
            }
            // gravity, down in the world (in the emitter's axes when particles live there): Canopy's
            // physics gravity times the system's gravityModifier, as Unity's (Claude, 2026-11-09: it
            // was 9.81, Unity's default, but Canopy's is 3, ProjectSettings/DynamicsManager.asset, so
            // the 607 systems rising by a negative modifier, -0.2 mostly, rose 3.3 times too fast)
            const down = new THREE.Vector3(0, -this.gravity(), 0);
            const toLocal = this.Q.clone().invert();
            if (!f.world) down.applyQuaternion(toLocal);
            const vol = f.velocityOverLife, noise = f.noise;
            if (noise) {
                const tn = f.looping ? (this.clock % f.duration) / f.duration : Math.min(1, Math.max(0, this.clock / f.duration));
                this.scroll = (this.scroll || 0) + sample(noise.scroll, tn, 0.5) * dt;
                this.n = this.n || new THREE.Vector3();
            }
            for (let i = this.particles.length - 1; i >= 0; i--) {
                const p = this.particles[i];
                p.age += dt;
                if (p.age >= p.life) {
                    if (p.trail && !f.trail.dieWithParticles && p.trail.points.length) this.orphans.push({ ...p.trail, p, tl: 1 });
                    this.particles.splice(i, 1);
                    continue;
                }
                const tl = p.age / p.life;
                p.vel.addScaledVector(down, sample(f.gravity, tl, p.rv) * dt);
                this.w.copy(p.vel);
                if (vol) {
                    this.v.set(sample(vol.x, tl, p.rv), sample(vol.y, tl, p.rv), sample(vol.z, tl, p.rv));
                    if (vol.world && !f.world) this.v.applyQuaternion(toLocal);
                    if (!vol.world && f.world) this.v.applyQuaternion(this.Q);
                    this.w.add(this.v);
                }
                if (noise) this.w.add(noisePush(noise, p.pos, tl, p.rn, this.scroll, this.n)); // in the simulation's space, where p.pos is
                p.pos.addScaledVector(this.w, dt);
                if (p.trail) this.trailPoint(p);
                if (f.rotationOverLife) p.rot += sample(f.rotationOverLife, tl, p.rs) * dt;
            }
        }
        // Trails: a particle's leaves a point wherever it has gone minVertexDistance from the last,
        // each point lasting the trail's lifetime; in the trail's space (the world's: where the
        // particle was, wherever the emitter goes then; else the emitter's, as particles are).
        trailSpace() {
            return this.fields.world || this.fields.trail.world;
        }
        trailPoint(p) {
            const at = p.pos.clone();
            if (!this.fields.world && this.fields.trail.world) at.applyMatrix4(this.E);
            const pts = p.trail.points, last = pts[pts.length - 1];
            if (!last || last.pos.distanceTo(at) >= this.fields.trail.minVertexDistance) pts.push({ pos: at, time: this.clock });
        }
        expireTrails() {
            const cut = t => { while (t.points.length && this.clock - t.points[0].time > t.life) t.points.shift(); };
            for (const p of this.particles) if (p.trail) cut(p.trail);
            for (const o of this.orphans) cut(o);
            this.orphans = this.orphans.filter(o => o.points.length > 1);
        }
        buildTrails(max) {
            const THREE = this.THREE;
            const geometry = new THREE.BufferGeometry();
            const attr = n => new THREE.BufferAttribute(new Float32Array(max * 2 * n), n).setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute("position", attr(3));
            geometry.setAttribute("uv", attr(2));
            geometry.setAttribute("tColor", attr(4));
            geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(max * 6), 1).setUsage(THREE.DynamicDrawUsage));
            geometry.setDrawRange(0, 0);
            const material = this.look(this.fields.trailMaterial, TRAIL_VERTEX);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.renderOrder = material.userData.order;
            mesh.frustumCulled = false;
            mesh.userData.debug = true;
            this.space.add(mesh);
            this.trails = { mesh, geometry, material, max };
        }
        // Each trail as a strip, head first, in the space's axes: { pos, size, color }, one of each
        // per point. A per-particle trail runs from the particle back along its points, its size and
        // color the particle's now; a ribbon through its particles, newest first, each point its own
        // particle's. A point on the one before (it has no direction) is left out. The points'
        // vectors are kept and reused frame to frame.
        strips() {
            const f = this.fields, tr = f.trail, E = this.E, out = [];
            const pool = this.pool = this.pool || [];
            let used = 0;
            const place = (v, local) => {
                const w = pool[used] || (pool[used] = new this.THREE.Vector3());
                used++;
                w.copy(v);
                return local ? w.applyMatrix4(E) : w;
            };
            const look = (p, tl) => {
                const c = tr.inheritColor ? this.colorOf(p, tl) : [1, 1, 1, 1], o = colorAt(tr.colorOverLife, tl, p.rc);
                return [tr.sizeAffectsWidth ? this.sizeOf(p, tl) : 1, [c[0] * o[0], c[1] * o[1], c[2] * o[2], c[3] * o[3]]];
            };
            const add = (strip, v, [size, color]) => {
                const last = strip.pos[strip.pos.length - 1];
                if (last && last.distanceToSquared(v) <= 1e-8) return;
                strip.pos.push(v);
                strip.size.push(size);
                strip.color.push(color);
            };
            const strip = () => { const s = { pos: [], size: [], color: [] }; out.push(s); return s; };
            if (tr.mode === 1) {
                const ribbons = Array.from({ length: tr.ribbonCount }, () => []);
                for (const p of this.particles) ribbons[p.ribbon].push(p);
                for (const r of ribbons) {
                    r.sort((x, y) => x.age - y.age);
                    const s = strip();
                    if (tr.attach && r.length) add(s, place(this.v.setFromMatrixPosition(E), false), look(r[0], r[0].age / r[0].life));
                    for (const p of r) add(s, place(p.pos, !f.world), look(p, p.age / p.life));
                }
                return out;
            }
            const local = !this.trailSpace();
            const trail = (points, head, p, tl) => {
                const s = strip(), l = look(p, tl);
                if (head) add(s, place(head, !f.world), l);
                for (let i = points.length - 1; i >= 0; i--) add(s, place(points[i].pos, local), l);
            };
            for (const p of this.particles) if (p.trail) trail(p.trail.points, p.pos, p, p.age / p.life);
            for (const o of this.orphans) trail(o.points, null, o.p, o.tl);
            return out;
        }
        // The strips, facing the camera: width over the trail (from its head, by length) times each
        // point's size, color over the trail times each point's; u by the texture mode (stretched,
        // tiled by length, spread or repeated per segment), v across.
        drawTrails() {
            const tr = this.fields.trail, g = this.trails.geometry, max = this.trails.max, cv = this.toShader;
            const P = g.attributes.position.array, UV = g.attributes.uv.array, C = g.attributes.tColor.array, I = g.index.array;
            const t = this.v, side = this.w, toEye = this.toEye = this.toEye || new this.THREE.Vector3(), along = this.along = this.along || [];
            const fixed = tr.colorOverTrail.mode === 0 ? colorAt(tr.colorOverTrail, 0, 0.5) : null;
            let n = 0, k = 0;
            for (const { pos, size, color } of this.strips()) {
                const m = pos.length;
                if (m < 2 || n + m > max) continue;
                along[0] = 0;
                for (let i = 1; i < m; i++) along[i] = along[i - 1] + pos[i].distanceTo(pos[i - 1]);
                const length = along[m - 1] || 1;
                for (let i = 0; i < m; i++) {
                    const q = pos[i], by = along[i] / length, v = n + i, o = v * 6, w = v * 4, h = v * 8;
                    t.copy(pos[Math.min(i + 1, m - 1)]).sub(pos[Math.max(i - 1, 0)]);
                    toEye.copy(this.eye).sub(q);
                    side.crossVectors(t, toEye).normalize().multiplyScalar(sample(tr.width, by, 0.5) * size[i] / 2);
                    P[o] = q.x + side.x; P[o + 1] = q.y + side.y; P[o + 2] = q.z + side.z;
                    P[o + 3] = q.x - side.x; P[o + 4] = q.y - side.y; P[o + 5] = q.z - side.z;
                    const u = tr.textureMode === 1 ? along[i] : tr.textureMode === 2 ? i / (m - 1) : tr.textureMode === 3 ? i : by;
                    UV[w] = u; UV[w + 1] = 0; UV[w + 2] = u; UV[w + 3] = 1;
                    const c = fixed || colorAt(tr.colorOverTrail, by, 0.5), pc = color[i];
                    C[h] = C[h + 4] = cv(pc[0] * c[0]);
                    C[h + 1] = C[h + 5] = cv(pc[1] * c[1]);
                    C[h + 2] = C[h + 6] = cv(pc[2] * c[2]);
                    C[h + 3] = C[h + 7] = pc[3] * c[3];
                    this.box.expandByPoint(q);
                    if (i) {
                        const a = 2 * (v - 1);
                        I[k] = a; I[k + 1] = a + 1; I[k + 2] = a + 2; I[k + 3] = a + 1; I[k + 4] = a + 3; I[k + 5] = a + 2;
                        k += 6;
                    }
                }
                n += m;
            }
            for (const name of ["position", "uv", "tColor"]) g.attributes[name].needsUpdate = true;
            g.index.needsUpdate = true;
            g.setDrawRange(0, k);
        }
        draw() {
            const f = this.fields, a = this.attrs, sheet = f.sheet, at = this.v;
            this.box.makeEmpty();
            if (!this.particles.length) this.box.expandByPoint(at.setFromMatrixPosition(this.E));
            this.particles.forEach((p, i) => {
                const tl = p.age / p.life;
                at.copy(p.pos);
                if (!f.world) at.applyMatrix4(this.E);
                a.iPos.setXYZ(i, at.x, at.y, at.z);
                const size = this.sizeOf(p, tl);
                a.iSize.setX(i, size);
                this.box.expandByPoint(this.w.copy(at).addScalar(size / 2)).expandByPoint(this.w.copy(at).addScalar(-size / 2));
                a.iRot.setX(i, p.rot);
                const c = this.colorOf(p, tl), cv = this.toShader;
                a.iColor.setXYZW(i, cv(c[0]), cv(c[1]), cv(c[2]), c[3]);
                if (sheet) {
                    const tx = sheet.tilesX, ty = sheet.tilesY, frames = sheet.row === null ? tx * ty : tx;
                    const k = Math.min(frames - 1, Math.max(0, Math.floor(((sample(sheet.frame, (tl * sheet.cycles) % 1, p.rf) + sample(sheet.start, 0, p.rf)) % 1) * frames)));
                    const row = sheet.row === null ? Math.floor(k / tx) : sheet.row < 0 ? p.row % ty : sheet.row, col = k % tx;
                    a.iUv.setXYZW(i, col / tx, 1 - (row + 1) / ty, 1 / tx, 1 / ty); // Unity's frame 0 is top left
                } else a.iUv.setXYZW(i, 0, 0, 1, 1);
            });
            for (const x of Object.values(a)) x.needsUpdate = true;
            this.mesh.geometry.instanceCount = this.particles.length;
            if (this.trails) {
                this.expireTrails();
                this.drawTrails();
            }
        }
        tick(dt) {
            if (!this.playing) return;
            // Unity culls a system whose renderer its LODGroup has off (it pauses while unseen)
            const shown = this.lodShowing(this.lod) && this.distanceToCamera(this.object) < 100;
            this.show(shown);
            if (!shown) return;
            if (this.pfxLod === undefined) this.pfxLod = [...this.prefab.components.values()].find(c => c.name === "PfxLod" && c.object === this.object) || null;
            const factor = this.pfxLod ? this.pfxLod.factor : 1;
            const f = this.fields, mode = f.cullingMode === 0 || f.cullingMode === undefined ? (f.looping ? 2 : 3) : f.cullingMode;
            const run = s => { if (!this.pfxLod || sample(f.emission.rate, 0.5, 0.5) * factor >= 0.4) this.step(s, factor); }; // else PfxLod paused it: frozen where they are
            if (!this.onScreen()) {
                this.show(false);
                if (mode === 3) { run(dt); this.draw(); } // keeps its box up to date, to be seen again
                else if (mode === 1) this.missed = Math.min(this.missed + dt, f.duration);
                return;
            }
            for (; this.missed > 0; this.missed -= 0.1) run(Math.min(0.1, this.missed)); // pause and catch up
            this.missed = 0;
            run(dt);
            this.draw();
        }
        // Is the box round its particles (as of the last update) in the camera's view?
        onScreen() {
            const THREE = this.THREE, camera = this.camera;
            if (frustumAt !== Ticker.frame) {
                frustumAt = Ticker.frame;
                camera.updateMatrixWorld();
                frustum = frustum || new THREE.Frustum();
                frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
            }
            if (this.box.isEmpty()) return true; // not drawn yet
            this.space.updateWorldMatrix(true, false);
            return frustum.intersectsBox(this.seen.copy(this.box).applyMatrix4(this.space.matrixWorld));
        }
        stop() {
            if (!this.mesh) return;
            this.mesh.geometry.dispose();
            this.material.dispose();
            if (this.trails) {
                this.trails.geometry.dispose();
                this.trails.material.dispose();
            }
        }
    });
})();
