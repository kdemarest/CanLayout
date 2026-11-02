// Stand-in for Canopy's HcFaceTarget.cs (Ken, 2026-10-29): turns partToRotate toward its harvester's
// aim (Quaternion.LookRotation from it to the point, flat with stayFlat), at most rotationSpeed
// degrees a second (RotateTowards). The aim is what a stand-in for the harvester on the same object
// gives (aimPoint: Flamer.js's, with no target); without one it stays as the prefab has it.
Tickable.register("HcFaceTarget", class extends Tickable {
    start() {
        this.part = this.fields.partToRotate || this.object;
        this.look = new this.THREE.Matrix4();
        this.want = new this.THREE.Quaternion();
        this.zero = new this.THREE.Vector3();
        this.up = new this.THREE.Vector3(0, 1, 0);
    }
    tick(dt) {
        const owner = [...this.prefab.components.values()].find(c => c !== this && c.object === this.object && c.aimPoint);
        const target = owner && owner.aimPoint();
        if (!target) return;
        const delta = target.sub(this.positionOf(this.part));
        if (this.fields.stayFlat) delta.y = 0;
        if (delta.lengthSq() < 1e-12) return;
        this.want.setFromRotationMatrix(this.look.lookAt(delta, this.zero, this.up)); // its forward (+Z) along delta, up as near Y as can be
        const now = this.rotationOf(this.part).rotateTowards(this.want, dt * (this.fields.rotationSpeed ?? 90) * Math.PI / 180);
        this.orient(this.part, now);
    }
});
