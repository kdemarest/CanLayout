// Stand-in for Canopy's HcSpinner.cs (the Blazer, AmberSpin): turns partToSpin (else its own object)
// about its own up once every secondsToSpin seconds, always, from where the prefab put it.
Tickable.register("HcSpinner", class extends Tickable {
    start() {
        this.part = this.fields.partToSpin || this.object;
        this.angle = 0;
    }
    tick(dt) {
        this.angle = (this.angle + dt * 360 / (this.fields.secondsToSpin || 1)) % 360;
        this.turn(this.part, [0, 1, 0], this.angle);
    }
});
