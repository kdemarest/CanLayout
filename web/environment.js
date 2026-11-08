// Canopy's EnvironmentManager in the browser (Claude, 2026-11-03; Ken: fog, ambient and sun
// "reasonably mimic the game"): each frame, from where the camera is, the game's light, fog and
// sky, from what tools/moods.js reads out of Canopy (the zones, their moods, the Sea's, Game.unity's
// Fog, sun and CanSky values). As EnvironmentManager.Update does:
//   the dominant BiomeZone: of the active zones, the one the camera is most within (GetPercentWithin:
//     1 inside the falloff margin, easing to 0 at the zone's edge), else the default zone
//   its MoodVisual, or under the sea the Sea's, unless the zone's mood overrides the sea
//   pctDepth: the camera's height between the mood's yBottom and yTop (under the sea, its depth
//     over the Sea's maxDepth); pctLight: pctDepth times (1 - overcast), overcast 0 here
//   fog (Fog.AdjustNaturalFog): color fogColor(pctDepth), density fogDensity(pctDepth), at least
//     Fog's fogDensityMinimum; sun (ManageSun): intensity sunIntensity(pctLight), color and angle the
//     sun's own unless the mood sets them; ambient ambientIntensity(pctLight); sky (ManageSky): tint
//     skyTint(pctLight), level skyTintLevel(pctDepth), the mood's sky material or the default; the
//     sea's dimming the mood's dimAmount or the Sea's default
//   each eased toward its value as Perp.Towards does (the gap closed at dt / lerpSpeed a frame:
//     the mood's fogLerpSpeed, else Fog's), the fog snapping when the camera crosses the waterline
//     and everything on a load or a jump (over 50 m in a frame)
// Not here: clouds', goop's, ink's, poison's and death's fog, rain's overcast, FogEase.
// Writes into the page's environment object (state.environment): sunDirection, sunColor,
// sunIntensity, ambient, fogColor, fogDensity, skyTint, skyTintLevel, the CanSky values, sky,
// dimAmount, seaIntensity. Loaded as a plain script (window.Environment).
(function (root) {
    // ---------- Unity's AnimationCurve and Gradient ----------
    // A curve: { keys: [{ t, v, i (in slope; null: infinite, a step), o, w (weighted mode: 1 in,
    // 2 out), iw, ow }] }, clamped outside its keys; no keys is 0.
    function curve(c, x) {
        const k = c.keys;
        if (!k.length) return 0;
        if (k.length === 1 || x <= k[0].t) return k[0].v;
        if (x >= k[k.length - 1].t) return k[k.length - 1].v;
        let j = 1;
        while (k[j].t < x) j++;
        const a = k[j - 1], b = k[j], dt = b.t - a.t;
        if (dt <= 0) return b.v;
        if (a.o === null || b.i === null) return a.v; // a stepped tangent
        const s = (x - a.t) / dt, m0 = a.o * dt, m1 = b.i * dt;
        const wo = a.w & 2 ? a.ow : 1 / 3, wi = b.w & 1 ? b.iw : 1 / 3;
        if (Math.abs(wo - 1 / 3) < 1e-6 && Math.abs(wi - 1 / 3) < 1e-6) {
            const s2 = s * s, s3 = s2 * s;
            return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * m1;
        }
        // weighted: a cubic Bezier, its handles wo and wi of the way across; x(u) = s solved by bisection
        const bez = (p0, p1, p2, p3, u) => { const v = 1 - u; return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3; };
        let lo = 0, hi = 1, u = s;
        for (let n = 0; n < 30; n++) {
            u = (lo + hi) / 2;
            if (bez(0, wo, 1 - wi, 1, u) < s) lo = u; else hi = u;
        }
        return bez(a.v, a.v + wo * m0, b.v - wi * m1, b.v, u);
    }
    // A gradient: { mode (0 blend, 1 fixed; 2, perceptual, blended as 0), colors: [[t, r, g, b]],
    // alphas: [[t, a]] }, its keys' values as stored (sRGB): [r, g, b].
    function gradient(g, t) {
        const k = g.colors;
        if (!k.length) return [1, 1, 1];
        if (t <= k[0][0]) return k[0].slice(1);
        if (t >= k[k.length - 1][0]) return k[k.length - 1].slice(1);
        let j = 1;
        while (k[j][0] < t) j++;
        const a = k[j - 1], b = k[j];
        if (g.mode === 1 || b[0] <= a[0]) return b.slice(1);
        const f = (t - a[0]) / (b[0] - a[0]);
        return [1, 2, 3].map(q => a[q] + (b[q] - a[q]) * f);
    }

    // ---------- zones (BiomeZone.PercentFromCenter, GetPercentWithin; ExtVector3's measures) ----------
    function percentFromCenter(z, p) {
        if (z.kind === "box") return Math.max(...[0, 1, 2].map(q => Math.abs(p[q] - z.center[q]) / (z.size[q] / 2)));
        const total = Math.max(z.height, z.radius * 2), reach = total / 2 - z.radius;
        const top = [0, 1, 2].map(q => z.position[q] + z.center[q] + z.up[q] * reach);
        const bottom = [0, 1, 2].map(q => z.position[q] + z.center[q] - z.up[q] * reach);
        const d = p[1] > top[1] ? Math.hypot(p[0] - top[0], p[1] - top[1], p[2] - top[2])
            : p[1] < bottom[1] ? Math.hypot(p[0] - bottom[0], p[1] - bottom[1], p[2] - bottom[2])
                : Math.hypot(p[0] - z.position[0], p[2] - z.position[2]);
        return d / z.scaledRadius;
    }
    function percentWithin(z, p) {
        const pct = percentFromCenter(z, p), inner = 1 - z.falloff;
        return pct >= 1 ? 0 : pct < inner ? 1 : (1 - pct) / z.falloff;
    }

    // ---------- the frame's environment ----------
    let data = null, eased = null, last = null, wasInSea = null, status = null;
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const hex = c => "#" + c.map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("");
    // live: tools/moods.js's environment, its sky materials described (skyMaterials, by guid); null: none
    function load(live) {
        data = live && live.moods && live.moods.length ? live : null;
        eased = null;
        last = null;
        wasInSea = null;
        status = null;
    }
    // Perp.Towards: the gap closed at dt / rate (snapped within 0.0001)
    const towards = (v, t, dt, rate) => {
        const n = v + (t - v) * Math.min(1, dt / Math.max(1e-6, rate));
        return Math.abs(t - n) <= 0.0001 ? t : n;
    };
    // env: the page's environment object, written into; p: the camera in Unity's world [x, y, z];
    // seaLevel: the sea's height (null: no sea). Returns false without data.
    function step(env, p, dt, seaLevel, snap = false) {
        if (!data) return false;
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 50) snap = true;
        last = p.slice();
        let zone = null, within = 0;
        for (const z of data.zones) {
            if (!z.active) continue;
            const w = percentWithin(z, p);
            if (w > within) { zone = z; within = w; }
        }
        const zoneMood = data.moods[zone ? zone.mood : data.defaultMood] || data.moods[0];
        const sea = data.sea, inSea = seaLevel !== null && p[1] < seaLevel;
        const useSea = inSea && sea && data.moods[sea.mood] && !zoneMood.overrideSea;
        const mood = useSea ? data.moods[sea.mood] : zoneMood;
        const pctDepth = inSea && sea ? clamp01((p[1] - (seaLevel - sea.maxDepth)) / sea.maxDepth) : clamp01((p[1] - mood.yBottom) / (mood.yTop - mood.yBottom));
        const pctLight = pctDepth; // no overcast
        const rate = mood.fogLerpSpeed >= 0 ? mood.fogLerpSpeed : data.fog.lerpSpeed;
        const sun = data.sun || { color: [1, 1, 1], euler: [50, -30, 0] };
        const target = {
            fog: gradient(mood.fogColor, pctDepth), fogDensity: curve(mood.fogDensity, pctDepth),
            sunIntensity: curve(mood.sunIntensity, pctLight), sunColor: mood.useSunColor ? mood.sunColor : sun.color,
            sunAngle: mood.useSunAngle ? mood.sunAngle : sun.euler[0], ambient: curve(mood.ambientIntensity, pctLight),
            skyTint: gradient(mood.skyTint, pctLight), skyTintLevel: curve(mood.skyTintLevel, pctDepth),
            dimAmount: mood.dimAmount !== -999 ? mood.dimAmount : sea ? sea.dimAmountDefault : 0.3, seaIntensity: curve(mood.seaIntensity, pctLight)
        };
        const fogSnap = snap || (wasInSea !== null && inSea !== wasInSea);
        wasInSea = inSea;
        if (!eased || snap) eased = JSON.parse(JSON.stringify(target));
        else {
            const e = eased;
            for (const k of ["fogDensity", "sunIntensity", "sunAngle", "ambient", "skyTintLevel", "dimAmount", "seaIntensity"]) e[k] = towards(e[k], target[k], dt, rate);
            for (const k of ["fog", "sunColor", "skyTint"]) e[k] = e[k].map((v, q) => towards(v, target[k][q], dt, rate));
            if (fogSnap) { e.fog = target.fog.slice(); e.fogDensity = target.fogDensity; }
        }
        const e = eased, a = e.sunAngle * Math.PI / 180, b = sun.euler[1] * Math.PI / 180;
        // toward the sun: minus the light's forward, Unity's Euler(angle, y, z) applied to +Z
        env.sunDirection = [-Math.cos(a) * Math.sin(b), Math.sin(a), -Math.cos(a) * Math.cos(b)];
        env.sunColor = hex(e.sunColor);
        env.sunIntensity = e.sunIntensity;
        env.ambient = e.ambient;
        env.fogColor = hex(e.fog);
        env.fogDensity = Math.max(e.fogDensity, data.fog.densityMinimum);
        env.skyTint = hex(e.skyTint);
        env.skyTintLevel = e.skyTintLevel;
        env.dimAmount = e.dimAmount;
        env.seaIntensity = e.seaIntensity;
        const sky = data.sky;
        if (sky) {
            // CanSky's globals: Skybox.js adds the camera's height to the blends (their mults are 1 in Game.unity)
            env.skyBlendMin = sky.blendMinAdd;
            env.skyBlendMax = sky.blendMaxAdd;
            env.skyBlackMult = sky.blackMult;
            env.skyBlackAdd = sky.blackAdd;
        }
        const skyGuid = mood.sky || (sky && sky.materialDefault);
        if (skyGuid && data.skyMaterials && data.skyMaterials[skyGuid]) env.sky = data.skyMaterials[skyGuid];
        status = { zone: zone ? `${zone.scene}/${zone.name}` : "default", within, mood: mood.label || mood.object, moodFile: mood.file, inSea, pctDepth, pctLight };
        return true;
    }
    // Self-checks of the curve and gradient evaluation (Environment.test(): a list of failures).
    function test() {
        const bad = [];
        const near = (name, got, want) => { if (Math.abs(got - want) > 1e-4) bad.push(`${name}: ${got} (want ${want})`); };
        const flat = { keys: [{ t: 0, v: 0.35, i: 0, o: 0, w: 0, iw: 1 / 3, ow: 1 / 3 }, { t: 1, v: 0.018, i: 0, o: 0, w: 0, iw: 1 / 3, ow: 1 / 3 }] };
        near("flat tangents, middle (smoothstep)", curve(flat, 0.5), (0.35 + 0.018) / 2);
        near("flat tangents, a quarter", curve(flat, 0.25), 0.35 + (0.018 - 0.35) * (3 * 0.0625 - 2 * 0.015625));
        near("clamped below", curve(flat, -1), 0.35);
        near("clamped above", curve(flat, 2), 0.018);
        const line = { keys: [{ t: 0, v: 0.05, i: 0.15, o: 0.15, w: 0, iw: 1 / 3, ow: 1 / 3 }, { t: 1, v: 0.2, i: 0.15, o: 0.15, w: 0, iw: 1 / 3, ow: 1 / 3 }] };
        near("linear tangents", curve(line, 0.4), 0.05 + 0.15 * 0.4);
        const weighted = { keys: [{ t: 0, v: 0.05, i: 0.15, o: 0.15, w: 3, iw: 1 / 3, ow: 1 / 3 }, { t: 1, v: 0.2, i: 0.15, o: 0.15, w: 3, iw: 1 / 3, ow: 1 / 3 }] };
        near("weighted at a third is unweighted", curve(weighted, 0.4), 0.05 + 0.15 * 0.4);
        const step = { keys: [{ t: 0, v: 1, i: 0, o: null, w: 0, iw: 1 / 3, ow: 1 / 3 }, { t: 1, v: 2, i: 0, o: 0, w: 0, iw: 1 / 3, ow: 1 / 3 }] };
        near("stepped", curve(step, 0.9), 1);
        near("no keys", curve({ keys: [] }, 0.5), 0);
        const g = { mode: 0, colors: [[0.6, 0.1, 0.1, 0.1], [1, 0.3, 0.5, 0.7]], alphas: [] };
        near("gradient before its first key", gradient(g, 0.2)[0], 0.1);
        near("gradient blended", gradient(g, 0.8)[1], 0.3);
        near("gradient fixed", gradient({ ...g, mode: 1 }, 0.8)[2], 0.7);
        const cap = { kind: "capsule", position: [0, 100, 0], center: [0, -10, 0], up: [0, 1, 0], radius: 10, height: 0, scaledRadius: 20, falloff: 0.1 };
        near("capsule beside its line", percentFromCenter(cap, [10, 90, 0]), 0.5);
        near("capsule above its top", percentFromCenter(cap, [0, 110, 0]), 1);
        near("within, inside the falloff margin", percentWithin(cap, [17, 90, 0]), 1);
        near("within, in the falloff", percentWithin(cap, [19, 90, 0]), 0.5);
        const box = { kind: "box", center: [0, 0, 0], size: [10, 20, 40] };
        near("box", percentFromCenter(box, [2.5, 5, 10]), 0.5);
        return bad;
    }
    root.Environment = { load, step, status: () => status, test, curve, gradient };
})(typeof window !== "undefined" ? window : globalThis);
