// Stand-in for Canopy's LeafGust.cs (Ken, 2026-10-31): the wind in the leaves, a steady wind
// everywhere plus gusts, each a level (0 still, 1 light, 2 medium, 3 strong), added in the leaf
// shader (app.js windPatch) and never past strong. Each tick it hands the shader the steady wind's
// direction and both strengths (leafWindNow, Unity's XZ), and up to three gusts, never more at
// once (leafGusts: centre x and z, radius, life 0 to 1 and back; leafGustDirs: heading x and z,
// soft edge, speed). Each gust passes through a point in front of the camera (nearest to farthest m away,
// within viewAngle degrees of where it faces), starting approach m upwind of it and ending as far
// downwind, building up and dying out over its life, so it is strongest there; it heads along
// direction (turned up to directionJitter degrees); the next waits at least interval seconds (give
// or take intervalJitter of it) and for a free slot. Light gusts are smaller, slower and rarer than
// medium's radius, speed and interval; strong ones bigger, faster and more often. The levels and
// whether gusts are cylinders come from ☰ View (windLevels()), else its fields as LeafGust.cs saves
// them, else its params (the defaults, and a script line's or piece's settings). The Wind effect
// (pfx/Wind.js) reads the same uniforms, to draw its lines where the wind is. ☰ Tick off freezes it.
const LEAF_GUSTS = 3; // what the shader reads
const LEVEL_STRENGTHS = [0, 0.4, 1, 1.7]; // gusts: none, light, medium, strong (LeafGust.LevelStrengths)
const STEADY_STRENGTHS = [0, 0.4, 0.7, 1]; // the steady wind: still, light, medium, strong, its strong a medium gust's (LeafGust.SteadyStrengths)
const GUST_RADIUS = [1, 0.6, 1, 1.4], GUST_SPEED = [1, 0.75, 1, 1.5], GUST_INTERVAL = [1, 1.4, 1, 0.7]; // shares of medium's
Tickable.register("LeafGust", class extends Tickable {
    static singleton = true;
    static params = { constantLevel: 1, gustLevel: 2, cylinderGusts: true, direction: [1, 0, 0.3], directionJitter: 15, radius: 25, edge: 4, speed: 4, nearest: 10, farthest: 60, viewAngle: 40, approach: 25, interval: 4, intervalJitter: 0.5 };
    start() {
        this.gusts = Array.from({ length: LEAF_GUSTS }, () => ({ alive: false, at: [0, 0], heading: [1, 0], radius: 0, speed: 1, age: 0, life: 1 }));
        this.wait = 0;
    }
    setting(name) {
        const chosen = this.windLevels && this.windLevels();
        if (chosen && chosen[name] !== undefined) return chosen[name];
        return this.fields[name] ?? this.params[name];
    }
    calm() {
        const d0 = this.setting("direction"), d = Array.isArray(d0) ? d0 : [d0.x, d0.y, d0.z];
        const len = Math.hypot(d[0], d[2]);
        return len ? [d[0] / len, d[2] / len] : [1, 0];
    }
    tick(dt) {
        const u = this.leafWind(), level = Math.max(0, Math.min(3, Math.round(this.setting("gustLevel"))));
        this.wait -= dt;
        this.gusts.forEach((g, i) => {
            if (g.alive) {
                g.age += dt;
                g.at[0] += g.heading[0] * g.speed * dt;
                g.at[1] += g.heading[1] * g.speed * dt;
                if (g.age >= g.life) g.alive = false;
            }
            if (!g.alive && this.wait <= 0 && this.setting("cylinderGusts") && level > 0) {
                this.spawn(g, level);
                const jitter = this.setting("intervalJitter");
                this.wait = this.setting("interval") * GUST_INTERVAL[level] * (1 + (Math.random() * 2 - 1) * jitter);
            }
            u.leafGusts.value[i].set(g.at[0], g.at[1], g.radius, g.alive ? Math.sin(Math.PI * g.age / g.life) : 0);
            u.leafGustDirs.value[i].set(g.heading[0], g.heading[1], this.setting("edge"), g.speed); // speed: for the Wind's lines
        });
        const [cx, cz] = this.calm(), steady = Math.max(0, Math.min(3, Math.round(this.setting("constantLevel"))));
        u.leafWindNow.value.set(cx, cz, STEADY_STRENGTHS[steady], LEVEL_STRENGTHS[level]);
    }
    spawn(g, level) {
        const turned = ([x, z], a) => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
        const rad = Math.PI / 180, r = () => Math.random() * 2 - 1;
        const heading = turned(this.calm(), r() * this.setting("directionJitter") * rad);
        // a point in front of the camera, which the gust passes through at its height (Unity's X is
        // Three.js's mirrored)
        const eye = this.camera.position, ahead = new this.THREE.Vector3();
        this.camera.getWorldDirection(ahead);
        const flat = Math.hypot(ahead.x, ahead.z);
        const facing = flat > 1e-2 ? turned([-ahead.x / flat, ahead.z / flat], r() * this.setting("viewAngle") * rad) : heading;
        const reach = this.setting("nearest") + Math.random() * (this.setting("farthest") - this.setting("nearest"));
        const target = [-eye.x + facing[0] * reach, eye.z + facing[1] * reach], approach = this.setting("approach");
        const speed = Math.max(this.setting("speed") * GUST_SPEED[level], 0.01);
        Object.assign(g, {
            alive: true, age: 0, heading, radius: this.setting("radius") * GUST_RADIUS[level], speed,
            at: [target[0] - heading[0] * approach, target[1] - heading[1] * approach],
            life: 2 * approach / speed
        });
    }
    stop() {
        const u = this.leafWind();
        for (const v of u.leafGusts.value) v.w = 0; // no wind left blowing
        u.leafWindNow.value.set(1, 0, 0, 0);
    }
});
