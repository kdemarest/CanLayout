// Stand-in for Canopy's Cage.cs (Ken, 2026-10-29): its sphere (cageSphere) is drawn in liveMat while
// anything guards the cage, else deadMat (AdjustMat, as RemapAllOwnedMaterials does it). Its guards
// are counted when a Canopy scene is imported (each active harvester whose HcGuard names it): the
// piece's "guards N". A cage placed in a composed scene has none.
Tickable.register("Cage", class extends Tickable {
    tick() {
        const f = this.fields, mat = (this.params.guards || 0) > 0 ? f.liveMat : f.deadMat;
        if (mat && mat.asset) this.useMaterial(f.cageSphere, mat.asset);
    }
});
