// Stand-in for Canopy's Abyss.cs (Ken, 2026-10-29). The sea's prefab is placed at the world's
// origin, as the game places Sea.prefab. Each frame its altitude is set (AlignAltitude): a scene's
// own (unity.json environment seaLevel, as a biome's localAltitude does), else localAltitude if not
// 0, else canonicalAltitude's height (SeaCanonicalAltitude, 135). And, as Sea.cs calls CenterOn
// with the player's head each frame, the water (waterSurface: both surfaces) is kept under the
// eye in steps of waterStepX by waterStepZ, moved only when the player looks steeply up from
// above the sea or down from below it (where the jump can't be seen), or is ten steps off.
Tickable.register("Abyss", class extends Tickable {
    start() {
        this.toWorld();
        this.step = [0, 0]; // the water's offset from where the prefab put it
        this.forward = new this.THREE.Vector3();
    }
    // Its height: where the sea is.
    altitude() {
        const env = this.environment() || {}, f = this.fields;
        if (typeof env.seaLevel === "number") return env.seaLevel;
        if (f.localAltitude) return f.localAltitude;
        const c = this.objectOf(f.canonicalAltitude);
        return c ? c.m[7] : 0;
    }
    tick() {
        const own = this.objectOf(this.object), f = this.fields;
        if (!own) return;
        const altitude = this.altitude();
        this.offset(this.object, [0, altitude - own.m[7], 0]);
        const water = this.objectOf(f.waterSurface);
        if (!water) return;
        const eye = this.camera.position, ex = -eye.x, ez = eye.z; // Unity's X is Three.js's mirrored
        const sx = f.waterStepX || 6, sz = f.waterStepZ || 6;
        const at = () => [water.m[3] + this.step[0], water.m[11] + this.step[1]];
        this.camera.getWorldDirection(this.forward);
        const under = eye.y < altitude;
        let move = (this.forward.y > 0.69 && !under) || (this.forward.y < -0.69 && under);
        if (Math.abs(ex - at()[0]) > sx * 10 || Math.abs(ez - at()[1]) > sz * 10) move = true;
        if (move) {
            // ForceVisualCorrection: whole steps until the eye is within half a step
            while (ex > at()[0] + sx * 0.5) this.step[0] += sx;
            while (ex < at()[0] - sx * 0.5) this.step[0] -= sx;
            while (ez > at()[1] + sz * 0.5) this.step[1] += sz;
            while (ez < at()[1] - sz * 0.5) this.step[1] -= sz;
        }
        this.offset(f.waterSurface, [this.step[0], 0, this.step[1]]);
    }
});
