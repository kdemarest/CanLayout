// Stand-in for Canopy's Sea.cs (Ken, 2026-10-29), a singleton (one sea at a time): it gives the
// shaders the sea's height (its abyss's altitude) and how things darken below it (EnvSetShaderVars:
// dimAmountDefault, where the game's mood leaves it, and dimDepth). Without a Sea nothing darkens
// and there is no waterline. Its CenterOn call is in Abyss.js.
Tickable.register("Sea", class extends Tickable {
    static singleton = true;
    tick() {
        const u = Surface.uniforms, f = this.fields, abyss = this.componentOf(f.abyss);
        u.canopySeaLevel.value = abyss ? abyss.altitude() : 0;
        // the mood's dimAmount, live (web/environment.js), else the Sea's default
        const env = this.environment() || {};
        u.canopyDimAmount.value = typeof env.dimAmount === "number" ? env.dimAmount : f.dimAmountDefault ?? f.dimAmount ?? 0.3;
        u.canopyDimDepth.value = f.dimDepth ?? 3;
    }
    stop() {
        Surface.uniforms.canopySeaLevel.value = -1e9; // no sea
    }
});
