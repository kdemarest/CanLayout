// Effects (Ken, 2026-10-28): a tiny particle system whose effects are code. An effect is a script
// (web/tickable.js) derived from Pfx, in pfx/<Name>.js, attached to a piece by a layout prefab's
// "- Script: pfx/<Name>.js | settings" line (e.g. layout/prefabs/Wind.md):
//   Tickable.register("Wind", class extends Pfx { spawn(p) {...} update(p, dt) {...} remove(p) {...} });
// Pfx spawns particles at params.rate a second, at most params.max at once, each { age: 0, life:
// params.life }, ageing them and ending each when its life is up. Everything is optional:
//   static space      "piece" (the default): it draws in the piece's own Unity axes (scaled with
//                     it); "world": in Unity's world (e.g. wind, which follows the camera)
//   static params     its defaults; rate (1), life (5) and max (100) are Pfx's
//   setup()           once, when it starts
//   spawn(p)          a new particle; set what it needs on p, or return false to spawn none this time
//   update(p, dt)     each frame, p.age already advanced; return false to end it early
//   remove(p)         when a particle ends
//   dispose()         when the piece leaves the scene
// It has, besides Tickable's: space (the group its meshes go in, in those Unity coordinates), eye
// (the camera there), particles, time (seconds since it started), inView(near, far) (a random
// point the camera sees) and ribbon(n, options) (below).
(function (root) {
    class Pfx extends Tickable {
        static params = { rate: 1, life: 5, max: 100 };
        static space = "piece";
        setup() {}
        spawn(p) {}
        update(p, dt) {}
        remove(p) {}
        dispose() {}
        start() {
            this.makeSpace(this.constructor.space === "world");
            this.particles = [];
            this.time = 0;
            this.owed = 0;
            this.setup();
        }
        tick(dt) {
            const q = this.params;
            this.time += dt;
            this.owed += q.rate * dt;
            for (; this.owed >= 1 && this.particles.length < q.max; this.owed--) {
                const p = { age: 0, life: q.life };
                if (this.spawn(p) === false) continue;
                this.particles.push(p);
            }
            this.owed = Math.min(this.owed, 1); // at max, no burst saved up for later
            for (let i = this.particles.length - 1; i >= 0; i--) {
                const p = this.particles[i];
                p.age += dt;
                if (p.age >= p.life || this.update(p, dt) === false) {
                    this.remove(p);
                    this.particles.splice(i, 1);
                }
            }
        }
        stop() {
            for (const p of this.particles || []) this.remove(p);
            this.dispose();
        }
        // A strip of n points facing the camera, for lines with thickness: set(points, width(i), alpha(i))
        // each frame (points in space's coordinates, at least 2). options: color, opacity, blending.
        ribbon(n, options = {}) {
            const THREE = this.THREE, space = this.space, eye = this.eye;
            const positions = new Float32Array(n * 2 * 3), colors = new Float32Array(n * 2 * 4);
            const index = [];
            for (let i = 0; i < n - 1; i++) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
            geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
            geometry.setIndex(index);
            const material = new THREE.MeshBasicMaterial({
                color: options.color ?? 0xffffff, vertexColors: true, transparent: true, opacity: options.opacity ?? 1,
                depthWrite: false, side: THREE.DoubleSide, blending: options.blending ?? THREE.NormalBlending
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.userData.debug = true; // not a Unity mesh: LOD tint leaves its color alone
            space.add(mesh);
            const a = new THREE.Vector3(), t = new THREE.Vector3(), side = new THREE.Vector3(), toEye = new THREE.Vector3();
            return {
                mesh,
                set(points, width, alpha) {
                    const m = Math.min(n, points.length);
                    for (let i = 0; i < n; i++) {
                        const k = Math.min(i, m - 1);
                        a.copy(points[k]);
                        t.copy(points[Math.min(k + 1, m - 1)]).sub(points[Math.max(k - 1, 0)]);
                        toEye.copy(eye).sub(a);
                        side.crossVectors(t, toEye).normalize().multiplyScalar((i < m ? width(k) : 0) / 2);
                        positions.set([a.x + side.x, a.y + side.y, a.z + side.z, a.x - side.x, a.y - side.y, a.z - side.z], i * 6);
                        const o = i < m ? alpha(k) : 0;
                        colors.set([1, 1, 1, o, 1, 1, 1, o], i * 8);
                    }
                    geometry.attributes.position.needsUpdate = true;
                    geometry.attributes.color.needsUpdate = true;
                    geometry.computeBoundingSphere(); // it moves: culling, picking and framing need its bounds
                    geometry.computeBoundingBox();
                },
                dispose() {
                    space.remove(mesh);
                    geometry.dispose();
                    material.dispose();
                }
            };
        }
    }
    root.Pfx = Pfx;
})(window);
