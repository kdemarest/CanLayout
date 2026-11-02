// Stand-in for Unity's particle systems (Shuriken; Ken, 2026-10-29: the Driller's smoke first), from
// tools/particles.js's description of each: a system that plays on awake emits at its rate and
// bursts from its shape (cone, sphere, hemisphere, box, circle, edge), each particle starting with
// its lifetime, speed, size, rotation and color, then sized, turned, colored and pushed over its
// life by those modules, with gravity and noise (Ken, 2026-10-29: the gems' breadcrumbs wander), in
// the emitter's space or the world's; drawn as camera-facing
// billboards (a texture sheet animated) in one batch, by a port of its material's shader
// (Canopy/ParticleContrast, ParticleGeneral, ParticleSolid; others as texture times color). Modules
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
    const HEAD = `
uniform sampler2D map;
uniform vec4 mapST;
uniform vec4 tint;
uniform float density, contrast, brightness, fogLevel, cutoff, canopyFogDensitySquared;
uniform vec3 canopyAmbient, canopySunColor;
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
    gl_FragColor = vec4(col.rgb * (canopyAmbient + 0.6 * canopySunColor) * fog(), 1.0);
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
            if (!this.playing) return;
            for (const u of f.unsupported) {
                if (warned.has(u)) continue;
                warned.add(u); // once a page, by what isn't done
                console.warn(`particles: ${u} isn't drawn (first seen on ${(this.objectOf(this.object) || {}).name || "?"})`);
            }
            const THREE = this.THREE;
            this.makeSpace(f.world);
            this.particles = [];
            this.clock = -sample(f.startDelay, 0, Math.random());
            this.owed = 0;
            this.E = new THREE.Matrix4();
            this.R = new THREE.Matrix4();
            this.Q = new THREE.Quaternion();
            this.v = new THREE.Vector3();
            this.w = new THREE.Vector3();
            this.box = new THREE.Box3(); // round its particles, in its space's axes, as of the last update
            this.seen = new THREE.Box3();
            this.missed = 0; // seconds off screen, for pause and catch up
            this.build(Math.min(f.maxParticles, 2000));
            if (f.prewarm && f.looping) for (let t = 0; t < f.duration; t += 0.1) this.step(0.1);
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
            const d = (f.material && this.describe(f.material.asset)) || null;
            const look = SHADERS[d && d.shaderName] || SHADERS.default;
            const v = (name, start) => ((d && d.values && d.values[name]) || start);
            const tc = v("_TintColor", null) || v("_Tint", [1, 1, 1, 1]);
            if (!softDot) {
                const n = 32, px = new Uint8Array(n * n * 4);
                for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2); px.set([255, 255, 255, Math.max(0, 1 - r) ** 2 * 255], (y * n + x) * 4); }
                softDot = new THREE.DataTexture(px, n, n);
                softDot.needsUpdate = true;
            }
            const st = d && d.map ? [...d.map.scale, ...d.map.offset] : [1, 1, 0, 0];
            const u = Surface.uniforms;
            this.material = new THREE.ShaderMaterial({
                uniforms: {
                    map: { value: softDot }, mapST: { value: new THREE.Vector4(...st) },
                    tint: { value: new THREE.Vector4(linear(tc[0]), linear(tc[1]), linear(tc[2]), tc[3] ?? 1) },
                    density: { value: v("_Density", [1])[0] }, contrast: { value: v("_Contrast", [1])[0] }, brightness: { value: v("_Brightness", [1])[0] },
                    fogLevel: { value: v("_FogLevel", [1])[0] }, cutoff: { value: v("_Cutoff", [0.5])[0] },
                    canopyFogDensitySquared: u.canopyFogDensitySquared, canopyAmbient: u.canopyAmbient, canopySunColor: u.canopySunColor
                },
                vertexShader: VERTEX, fragmentShader: HEAD + look.frag,
                transparent: !look.solid, depthWrite: Boolean(look.solid), side: THREE.DoubleSide,
                blending: look.blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending
            });
            if (d && d.map) this.texture(d.map, true).then(t => { if (t) this.material.uniforms.map.value = t; });
            this.mesh = new THREE.Mesh(geometry, this.material);
            this.mesh.renderOrder = ((d && d.queue) ?? 3000) - 3000; // its render queue, as app.js orders meshes
            this.mesh.frustumCulled = false; // its particles go where they go
            this.mesh.userData.debug = true;
            this.space.add(this.mesh);
        }
        // The emitter's place and turn in the space particles live in (the world's, or the prefab's).
        emitter() {
            const p = this.positionOf(this.object), q = this.rotationOf(this.object);
            this.E.compose(p, q, this.v.set(1, 1, 1));
            if (this.fields.world) {
                this.group.updateWorldMatrix(true, false);
                this.E.premultiply(Space.mirrorX(this.group.matrixWorld.clone())); // Unity's world, from Three.js's
            }
            this.Q.setFromRotationMatrix(this.R.extractRotation(this.E));
            return this.E;
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
                const vel = dir.multiplyScalar(sample(f.speed, tn, r()));
                if (f.world) { pos.applyMatrix4(this.E); vel.applyQuaternion(this.Q); }
                let rot = sample(f.rotation, tn, r());
                if (f.randomizeRotation && r() < f.randomizeRotation * 0.5) rot = -rot;
                this.particles.push({ pos, vel, age: 0, life: Math.max(0.01, sample(f.lifetime, tn, r())), size: sample(f.size, tn, r()), rot, color: colorAt(f.color, tn, r()), rs: r(), rz: r(), rc: r(), rv: r(), rf: r(), rn: r(), row: Math.floor(r() * 1000) });
            }
        }
        step(dt, factor = 1) {
            const f = this.fields, THREE = this.THREE;
            this.emitter();
            const before = this.clock;
            this.clock += dt * f.simulationSpeed;
            if (this.clock >= 0 && (f.looping || this.clock <= f.duration)) {
                const t = f.looping ? this.clock % f.duration : this.clock, prev = f.looping ? before % f.duration : before, tn = t / f.duration;
                this.owed += sample(f.emission.rate, tn, Math.random()) * factor * dt * f.simulationSpeed;
                const whole = Math.floor(this.owed);
                this.owed -= whole;
                this.emit(whole, tn);
                for (const b of f.emission.bursts) {
                    for (let c = 0; c < b.cycles; c++) {
                        const at = b.time + c * b.interval;
                        const crossed = prev <= t ? at > prev && at <= t : at > prev || at <= t; // the loop wrapped
                        if (crossed && Math.random() < b.probability) this.emit(Math.round(sample(b.count, tn, Math.random())), tn);
                    }
                }
            }
            // gravity, down in the world (in the emitter's axes when particles live there)
            const down = new THREE.Vector3(0, -9.81, 0);
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
                if (p.age >= p.life) { this.particles.splice(i, 1); continue; }
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
                if (f.rotationOverLife) p.rot += sample(f.rotationOverLife, tl, p.rs) * dt;
            }
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
                const size = p.size * (f.sizeOverLife ? sample(f.sizeOverLife, tl, p.rz) : 1);
                a.iSize.setX(i, size);
                this.box.expandByPoint(this.w.copy(at).addScalar(size / 2)).expandByPoint(this.w.copy(at).addScalar(-size / 2));
                a.iRot.setX(i, p.rot);
                const c = f.colorOverLife ? colorAt(f.colorOverLife, tl, p.rc) : [1, 1, 1, 1];
                // Unity hands the shader its particles' colors converted to linear only when the renderer's
                // Apply Active Color Space is on (Canopy draws in linear); off, as on most of Canopy's, they
                // go as they are, so they look stronger (Ken, 2026-10-30: the gems' green showed white)
                const cv = f.applyColorSpace ? linear : x => x;
                a.iColor.setXYZW(i, cv(p.color[0] * c[0]), cv(p.color[1] * c[1]), cv(p.color[2] * c[2]), p.color[3] * c[3]);
                if (sheet) {
                    const tx = sheet.tilesX, ty = sheet.tilesY, frames = sheet.row === null ? tx * ty : tx;
                    const k = Math.min(frames - 1, Math.max(0, Math.floor(((sample(sheet.frame, (tl * sheet.cycles) % 1, p.rf) + sample(sheet.start, 0, p.rf)) % 1) * frames)));
                    const row = sheet.row === null ? Math.floor(k / tx) : sheet.row < 0 ? p.row % ty : sheet.row, col = k % tx;
                    a.iUv.setXYZW(i, col / tx, 1 - (row + 1) / ty, 1 / tx, 1 / ty); // Unity's frame 0 is top left
                } else a.iUv.setXYZW(i, 0, 0, 1, 1);
            });
            for (const x of Object.values(a)) x.needsUpdate = true;
            this.mesh.geometry.instanceCount = this.particles.length;
        }
        tick(dt) {
            if (!this.playing) return;
            // Unity culls a system whose renderer its LODGroup has off (it pauses while unseen)
            const shown = this.lodShowing(this.lod) && this.distanceToCamera(this.object) < 100;
            this.mesh.visible = shown;
            if (!shown) return;
            if (this.pfxLod === undefined) this.pfxLod = [...this.prefab.components.values()].find(c => c.name === "PfxLod" && c.object === this.object) || null;
            const factor = this.pfxLod ? this.pfxLod.factor : 1;
            const f = this.fields, mode = f.cullingMode === 0 || f.cullingMode === undefined ? (f.looping ? 2 : 3) : f.cullingMode;
            const run = s => { if (!this.pfxLod || sample(f.emission.rate, 0.5, 0.5) * factor >= 0.4) this.step(s, factor); }; // else PfxLod paused it: frozen where they are
            if (!this.onScreen()) {
                this.mesh.visible = false;
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
        }
    });
})();
