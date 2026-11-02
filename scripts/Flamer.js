// Stand-in for Canopy's Flamer.cs (Ken, 2026-10-29), as a flamer looks with no target (Flamer and
// its varieties, e.g. Blowtorch): GetHeadRotationPosition gives straightUp, which rides on its
// Spinner, so the head (its HcFaceTarget's part) sweeps round after it; and only while the player
// (the camera here) is within scanRange (40 m), as OnUpdateActivity turns its HcFaceTarget on.
Tickable.register("Flamer", class extends Tickable {
    // Where its HcFaceTarget aims, or null when it doesn't turn.
    aimPoint() {
        const f = this.fields;
        if (!f.straightUp || this.distanceToCamera(this.object) > (f.scanRange ?? 40)) return null;
        return this.positionOf(f.straightUp);
    }
});
