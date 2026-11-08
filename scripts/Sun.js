// The sun (Ken, 2026-11-01), layout's own, a singleton: the scene's one light, Canopy's, from
// unity.json's environment (sunDirection, toward the sun in Unity's world; sunColor; ambient,
// Canopy's ambient intensity). Canopy's shaders, which web/surface.js draws, take these already;
// this lights Three.js's own materials (shapes, Unity shaders without a port) as Canopy/General
// lights: the albedo times the ambient, plus times N·L in the sun's color. Three.js's Lambert is
// the albedo over pi per unit of light, so both lights are pi strong. While it runs, the page's
// plain lights (app.js, userData.plainLight) are off. The Sun prefab (layout/prefabs/Sun.md) runs it.
Tickable.register("Sun", class extends Tickable {
    static singleton = true;
    start() {
        const THREE = this.THREE;
        this.light = new THREE.DirectionalLight(0xffffff, Math.PI);
        this.ambient = new THREE.AmbientLight(0xffffff, Math.PI);
        this.scene.add(this.light, this.ambient);
        this.plain = this.scene.children.filter(o => o.userData.plainLight);
        for (const o of this.plain) o.visible = false;
    }
    tick() {
        const env = this.environment();
        if (!env) return;
        const [x, y, z] = env.sunDirection;
        this.light.position.set(-x, y, z).normalize(); // Unity's world is Three.js's with X mirrored
        this.light.color.set(env.sunColor);
        this.light.intensity = Math.PI * (env.sunIntensity ?? 1); // the mood's, live (web/environment.js)
        // Canopy's ambient is a gray as Unity's inspector shows it (sRGB), as web/surface.js takes it
        this.ambient.color.setRGB(env.ambient, env.ambient, env.ambient, this.THREE.SRGBColorSpace);
    }
    stop() {
        this.scene.remove(this.light, this.ambient);
        this.light.dispose();
        this.ambient.dispose();
        for (const o of this.plain) o.visible = true;
    }
});
