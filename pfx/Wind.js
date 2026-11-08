// Wind (Ken, 2026-10-28), an experiment (Canopy has no wind lines yet), in the spirit of Valheim's:
// thick lines, a very light tan with a soft, rounded front (Ken, 2026-10-30), drawn where the leaves'
// wind is (Ken, 2026-10-31): it follows LeafGust (scripts/LeafGust.js), reading the uniforms it sets
// for the leaf shader. Lines come two ways:
// - The steady wind's: rate a second at strength 1 (medium; none when still), heading along the
//   steady wind, at speed times its strength (light, medium, strong: 2, 3.5 and 5 m/s; Ken,
//   2026-10-31). Each starts upwind of a point the
//   camera sees (view m off), at its height, placed so that on its way it passes through that
//   point, at most behind[1] m back.
// - Each gust's: gustRate a second at strength 1, at a point the camera sees that is inside the
//   gust's circle (gustInside of its radius; else anywhere in that circle, at the height of a point
//   in view), heading with it at its own speed, so they travel with the gust and show where its
//   leaves are moving; they last gustLife seconds.
// Lines are drawn where the camera looks, looking down too (Ken, 2026-10-31: they used to start
// within spread m of the camera's height, Ken, 2026-10-29, so none showed looking down), never
// lower than aboveSea m over the sea.
// A line is a chain of points: only its head moves, weaving gently on a sine (its drift up and down
// at most `weave` m per meter travelled, side to side `sway`), laying a point every `spacing` m;
// laid points stay put, and the tail consumes the oldest, so the line is the head's last `length`
// m of path. When its life is nearly up the head stops and the tail eats what is left. (The wind
// used to blow in gusts of its own, on for `on` seconds, off for `off`; LeafGust's gusts are the
// wind's gusts now.) A singleton: one wind at a time. The Wind prefab (layout/prefabs/Wind.md)
// runs it; settings on its Script line or a piece ("rate 2, speed 4") override these params.
// Meters and seconds, Unity's axes.
Tickable.register("Wind", class extends Pfx {
    static singleton = true;
    static space = "world";
    static params = {
        rate: 0.4,            // the steady wind's lines a second, at strength 1 (medium); a third of what it was (Ken, 2026-11-03)
        life: 10,             // seconds from the head starting to the tail being eaten up
        max: 60,
        view: [4, 25],        // how far from the camera the point in view it passes through lies
        behind: [10, 30],     // how far upwind of that point the head starts, at most (the first is unused)
        speed: 5,             // the steady wind's lines' head, at strength 1 (strong)
        gustRate: 1,          // a gust's lines a second, at strength 1; a third of what it was (Ken, 2026-11-03)
        gustLife: 5,          // seconds a gust's line lasts
        gustInside: 0.7,      // the share of a gust's radius its lines start within
        weave: [0.2, 7],      // up and down: the most drift per meter travelled, wavelength
        sway: [0.1, 11],      // side to side (Z): the same
        length: 4,            // of the chain
        spacing: 0.2,         // between laid points
        width: 0.12,
        opacity: 0.55,
        color: 0xece0c8,      // a very light tan
        headFade: 0.15,       // the front share of a line (by length): fading in from near transparent, and
                              // rounded, narrow at the tip to full width (Ken, 2026-10-30)
        nosePoints: 8,        // extra points drawing that rounded front
        aboveSea: 3           // the least height over the sea (where there is one) a line starts at
    };
    // Where lines come from now, from LeafGust's uniforms: the steady wind, and each gust alive,
    // with how many lines a second each makes. Pfx spawns at params.rate, their sum.
    tick(dt) {
        const q = this.params, u = this.leafWind && this.leafWind(), now = u && u.leafWindNow.value;
        if (this.steadyRate !== undefined) q.rate = this.steadyRate;
        const sources = [];
        if (now && now.z > 0) sources.push({ rate: q.rate * now.z, heading: [now.x, now.y], speed: q.speed * now.z });
        if (now && now.w > 0) {
            u.leafGusts.value.forEach((g, i) => {
                const d = u.leafGustDirs.value[i];
                if (g.w > 0) sources.push({ rate: q.gustRate * now.w * g.w, heading: [d.x, d.y], gust: g, speed: d.w || q.speed });
            });
        }
        this.sources = sources;
        this.steadyRate = this.steadyRate ?? q.rate; // its own (the params' or a setting's)
        q.rate = sources.reduce((sum, src) => sum + src.rate, 0);
        super.tick(dt);
        q.rate = this.steadyRate;
    }
    spawn(p) {
        const q = this.params, r = Math.random, sources = this.sources || [];
        let pick = r() * sources.reduce((sum, src) => sum + src.rate, 0), src = null;
        for (const s of sources) if ((pick -= s.rate) <= 0) { src = s; break; }
        src = src || sources[sources.length - 1];
        if (!src) return false;
        const [hx, hz] = src.heading;
        if (src.gust) p.life = q.gustLife;
        const drain = q.length / src.speed; // seconds the tail takes to eat the chain once the head stops
        p.laying = Math.max(0.5, p.life - drain); // seconds the head moves
        const sea = Surface.uniforms.canopySeaLevel.value; // -1e9 without a sea
        const above = y => Math.max(y, sea + q.aboveSea);
        if (src.gust) {
            // a point in view inside the gust's circle, travelling with it; a few tries, else
            // anywhere in the circle at the height of a point in view
            const g = src.gust, inside = g.z * q.gustInside;
            for (let i = 0; i < 8 && !p.head; i++) {
                const at = this.inView(q.view[0], q.view[1]);
                if (Math.hypot(at.x - g.x, at.z - g.y) < inside) p.head = new this.THREE.Vector3(at.x, above(at.y), at.z);
            }
            if (!p.head) {
                const a = r() * Math.PI * 2, reach = Math.sqrt(r()) * inside;
                p.head = new this.THREE.Vector3(g.x + Math.cos(a) * reach, above(this.inView(q.view[0], q.view[1]).y), g.y + Math.sin(a) * reach);
            }
        } else {
            // upwind of a point in view, at its height, reaching it after a second and before the head stops
            const at = this.inView(q.view[0], q.view[1]);
            const back = src.speed * (1 + r() * Math.max(0, Math.min(p.laying - 2, q.behind[1] / src.speed - 1)));
            p.head = new this.THREE.Vector3(at.x - hx * back, above(at.y), at.z - hz * back);
        }
        p.heading = [hx, hz];
        p.speed = src.speed;
        p.travelled = 0;
        p.sinceLaid = 0;
        p.chain = [p.head.clone()]; // laid points, newest first
        p.phase = [r() * Math.PI * 2, r() * Math.PI * 2];
        p.n = Math.ceil(q.length / q.spacing) + 2 + q.nosePoints;
        p.nose = Array.from({ length: q.nosePoints }, () => new this.THREE.Vector3());
        p.line = this.ribbon(p.n, { opacity: q.opacity, color: q.color });
    }
    update(p, dt) {
        const q = this.params, wave = (w, phase) => w[0] * Math.sin(2 * Math.PI * p.travelled / w[1] + phase);
        const moving = p.age < p.laying, [hx, hz] = p.heading;
        if (moving) {
            const step = p.speed * dt, across = step * wave(q.sway, p.phase[1]);
            p.travelled += step;
            p.head.x += step * hx - across * hz;
            p.head.y += step * wave(q.weave, p.phase[0]);
            p.head.z += step * hz + across * hx;
            p.sinceLaid += step;
            if (p.sinceLaid >= q.spacing) {
                p.chain.unshift(p.head.clone());
                p.sinceLaid = 0;
            }
        }
        // The tail consumes: while the head moves the chain keeps its length; after, it shrinks at the head's pace.
        const keep = moving ? p.n - 1 : p.n - 1 - Math.floor((p.age - p.laying) * p.speed / q.spacing);
        while (p.chain.length > Math.max(0, keep)) p.chain.pop();
        if (!p.chain.length) return false;
        const points = moving ? [p.head, ...p.chain] : p.chain;
        if (points.length < 2) return;
        this.draw(p, points);
    }
    // The line through points (head first), measured along its length: its front headFade drawn with
    // nosePoints of its own (closer together toward the tip), widening from nothing as a rounded nose
    // (a quarter ellipse) while it fades in from 5% of full opacity; then tapering to the tail, which
    // fades out over its last third.
    draw(p, points) {
        const q = this.params, along = [0];
        for (let k = 1; k < points.length; k++) along.push(along[k - 1] + points[k].distanceTo(points[k - 1]));
        const total = along[along.length - 1] || 1e-6, nose = q.headFade * total;
        const drawn = [], dist = [];
        let k = 1;
        for (let i = 0; i < q.nosePoints; i++) {
            const d = nose * (1 - Math.cos((i / q.nosePoints) * Math.PI / 2));
            while (k < along.length - 1 && along[k] < d) k++;
            const t = Math.min(1, Math.max(0, (d - along[k - 1]) / ((along[k] - along[k - 1]) || 1e-6)));
            drawn.push(p.nose[i].lerpVectors(points[k - 1], points[k], t));
            dist.push(d);
        }
        for (let j = 0; j < points.length; j++) if (along[j] >= nose) { drawn.push(points[j]); dist.push(along[j]); }
        const smooth = x => x * x * (3 - 2 * x);
        p.line.set(drawn,
            i => { const d = dist[i], round = d < nose ? Math.sqrt(Math.max(0, 1 - (1 - d / nose) ** 2)) : 1; return q.width * (1 - 0.6 * d / total) * round; },
            i => { const u = dist[i] / total; return (0.05 + 0.95 * smooth(Math.min(1, u / q.headFade))) * Math.min(1, 1.5 * (1 - u)); });
    }
    remove(p) {
        if (p.line) p.line.dispose();
    }
});
