// Stand-in for Canopy's PfxLod.cs (Ken, 2026-10-29): every 5 s (first at a random moment), the
// player's (the camera's) distance past insideEdge, as a share of range, takes its particle system's
// emission from full down to minEmissionPercentage; below 0.4 a second the system pauses (Unity's
// Pause: its particles stay, frozen). Measured from the emitter: its extentBox isn't used.
Tickable.register("PfxLod", class extends Tickable {
    start() {
        this.factor = 1;
        this.left = Math.random() * 5;
    }
    tick(dt) {
        this.left -= dt;
        if (this.left > 0) return;
        this.left = 5;
        const f = this.fields, d = this.distanceToCamera(this.object);
        const pct = Math.min(1, Math.max(0, (d - (f.insideEdge ?? 10)) / Math.max(1, f.range ?? 100)));
        this.factor = 1 + ((f.minEmissionPercentage ?? 0) - 1) * pct;
    }
});
