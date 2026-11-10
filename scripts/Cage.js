// Stand-in for Canopy's Cage.cs (Ken, 2026-10-29): its sphere (cageSphere) is drawn in liveMat while
// anything guards the cage, else deadMat (AdjustMat, as RemapAllOwnedMaterials does it). Its guards
// are counted when a Canopy scene is imported (each active harvester whose HcGuard names it): the
// piece's "guards N". A cage placed in a composed scene has none. Game mode (web/play.js) counts
// them down as guards are killed (params.guards).
// Emptied, it vanishes (Ken, 2026-11-10; Cage.Update): unguarded, once the player (the camera)
// crosses breakDist (10 m on Canopy's cages) from it, either way, with no item left in its contents,
// its contents switch off: the sphere, the sky beams, the wardens and every particle system under
// them (hideMeshes: game mode's, so starting over brings them back). Canopy finds an item by its
// collider within the sphere; here, any item mesh under contents game mode hasn't taken.
Tickable.register("Cage", class extends Tickable {
    start() {
        const f = this.fields;
        if (typeof f.breakDist !== "number") throw new Error(`Cage ${this.piece.name}: no breakDist among its fields: re-import its area`);
        this.contents = this.objectOf(f.contents);
        if (!this.contents) throw new Error(`Cage ${this.piece.name}: its contents (${JSON.stringify(f.contents)}) isn't an object of its prefab`);
        this.wasFar = false; // so the first frame checks, as Cage's playerWasFar starts
    }
    tick() {
        const f = this.fields, guards = this.params.guards || 0, mat = guards > 0 ? f.liveMat : f.deadMat;
        if (mat && mat.asset) this.useMaterial(f.cageSphere, mat.asset);
        const off = this.prefab.off;
        if (guards > 0 || (off && off.has(this.contents.key))) return;
        const far = this.distanceToCamera(this.object) > f.breakDist;
        if (far !== this.wasFar && !this.holdsItem()) {
            this.hideMeshes(this.top, this.meshesUnder(this.contents.key), this.contents.key);
            return;
        }
        this.wasFar = far;
    }
    holdsItem() {
        return this.meshesUnder(this.contents.key).some(m => m.userData.part && m.userData.part.item && !m.userData.taken);
    }
});
