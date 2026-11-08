// Stand-in for Canopy's Daisy.cs: its saw spins only while it is awake (sawSpinner.spin). It wakes
// with the player within its HcRange's awakeRange and sleeps beyond sleepRange; the camera stands in
// for the player. Its safe zone and void tests have no place in layout.
Tickable.register("Daisy", class extends Tickable {
    start() {
        this.awake = false;
    }
    tick() {
        const parts = [...this.prefab.components.values()];
        const range = parts.find(c => c.name === "HcRange");
        const saw = this.fields.sawSpinner && this.prefab.components.get(this.fields.sawSpinner.ref);
        if (!range || !saw) return;
        const distance = this.distanceToCamera(this.object);
        if (!this.awake && distance <= range.awakeRange) this.awake = true;
        else if (this.awake && distance > range.sleepRange) this.awake = false;
        saw.spin = this.awake;
    }
});
