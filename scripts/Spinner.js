// Stand-in for Canopy's Spinner.cs (Ken, 2026-10-29): turns partToSpin (else its own object) about
// spinAroundAxis (X, Y or Z: Spinner.axis's left, up and back) once every secondsToSpin seconds,
// in its own axes or, with useWorldAxis, the prefab's, from a random start, as Rotate does. spin is
// Spinner.spin, which a harvester's stand-in sets (Daisy.js); in the Foyer it never spins. A Cairn's
// start disabled until its portal is bought: tools/unity.js runs those as if paid.
Tickable.register("Spinner", class extends Tickable {
    start() {
        const f = this.fields;
        this.axis = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]][f.spinAroundAxis ?? 1] || [0, 1, 0];
        this.part = f.partToSpin || this.object;
        this.angle = Math.random() * 360;
        this.spin = this.piece.unityScene !== "Foyer";
        this.turn(this.part, this.axis, this.angle, Boolean(f.useWorldAxis));
    }
    tick(dt) {
        if (!this.spin) return;
        const f = this.fields;
        this.angle = (this.angle + dt * 360 / (f.secondsToSpin || 5)) % 360;
        this.turn(this.part, this.axis, this.angle, Boolean(f.useWorldAxis));
    }
});
