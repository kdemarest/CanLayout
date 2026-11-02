// Stand-in for Canopy's WaterScroller.cs (Ken, 2026-10-29): each frame its two scrolls move by
// flow1 and flow2 (texture widths a second) times dt, and become the sea shaders' _WaterScroll1
// and 2, or with `below` the underside's _WaterScrollBelow1 and 2 (ShaderVars passes them on).
Tickable.register("WaterScroller", class extends Tickable {
    start() {
        const f = this.fields, v = (o) => [(o && o.x) || 0, (o && o.y) || 0];
        this.flows = [v(f.flow1), v(f.flow2)];
        this.scrolls = [v(f.WaterScroll1), v(f.WaterScroll2)];
        const u = Surface.uniforms;
        this.targets = f.below ? [u.canopyWaterScrollBelow1, u.canopyWaterScrollBelow2] : [u.canopyWaterScroll1, u.canopyWaterScroll2];
    }
    tick(dt) {
        this.scrolls.forEach((s, i) => {
            s[0] += this.flows[i][0] * dt;
            s[1] += this.flows[i][1] * dt;
            this.targets[i].value.set(s[0], s[1]);
        });
    }
});
