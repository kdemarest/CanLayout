// The sky (Ken, 2026-10-29), layout's own, a singleton: Canopy's sky is Game.unity's skybox (the
// CanSky material, unity.json environment sky) with EnvironmentManager.ManageSky setting CanSky's
// globals from the head's height each frame; this draws that shader, as GLSL, on a dome around
// the camera, behind everything. A sky point's height is the camera's plus its direction's y
// times skyRadius; below the black line it is black, else the fog color blended to the sky texture
// from BlendMax, then tinted (unity.json environment: skyBlendMin and Max, skyBlackMult and Add,
// skyTint, skyTintLevel, skyRadius: see tools/config.js). Without a Sky the background is plain.
// The Sky prefab (layout/prefabs/Sky.md) runs it.
Tickable.register("Skybox", class extends Tickable {
    static singleton = true;
    start() {
        const THREE = this.THREE;
        this.uniforms = {
            skyMap: { value: null }, skyHasMap: { value: 0 }, skyBlue: { value: new THREE.Color("#87a9c9") },
            skyFloor: { value: new THREE.Color() }, skyTint: { value: new THREE.Color() }, skyTintLevel: { value: 0 },
            skyBlendMin: { value: 0 }, skyBlendMax: { value: 0 }, skyBlackY: { value: -1e9 }, skyRadius: { value: 400 }
        };
        this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
            uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
            vertexShader: `varying vec3 vDir;
void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
            fragmentShader: `uniform sampler2D skyMap;
uniform float skyHasMap, skyTintLevel, skyBlendMin, skyBlendMax, skyBlackY, skyRadius;
uniform vec3 skyBlue, skyFloor, skyTint;
varying vec3 vDir;
void main() {
    vec3 d = normalize(vDir);
    float y = cameraPosition.y + d.y * skyRadius;
    vec3 c = vec3(0.0);
    if (y >= skyBlackY) {
        // the panorama the way Layout's background showed it (Three.js's equirectangular mapping)
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
        vec3 sky = skyHasMap > 0.5 ? texture2D(skyMap, uv).rgb : skyBlue;
        float t = clamp((y - skyBlendMax) / max(skyBlendMax - skyBlendMin, 0.0001), 0.0, 1.0);
        c = mix(skyFloor, sky, t);
        if (y > skyBlendMax) c = mix(c, skyTint, skyTintLevel);
    }
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
}`
        }));
        this.dome.frustumCulled = false;
        this.dome.renderOrder = -1000; // before every mesh, whatever its queue (app.js: queue - 3000 from 2501): it tests no depth
        this.scene.add(this.dome);
        this.mapFor = undefined; // the sky texture shown (its URL)
    }
    tick() {
        const env = this.environment(), u = this.uniforms, camera = this.camera;
        if (!env) return;
        const y = camera.position.y;
        this.dome.position.copy(camera.position);
        this.dome.scale.setScalar(Math.min(10, camera.far * 0.5));
        u.skyBlendMin.value = y + env.skyBlendMin;
        u.skyBlendMax.value = y + env.skyBlendMax;
        u.skyBlackY.value = env.skyBlackMult * y + env.skyBlackAdd;
        u.skyFloor.value.set(env.fogColor);
        u.skyTint.value.set(env.skyTint);
        u.skyTintLevel.value = env.skyTintLevel;
        u.skyRadius.value = env.skyRadius || 10 * camera.far; // see tools/config.js
        const map = (env.sky && env.sky.map) || null, url = map && map.url;
        if (this.mapFor !== url) {
            this.mapFor = url;
            u.skyHasMap.value = 0;
            this.texture(map, true).then(t => {
                if (!t || this.mapFor !== url) return;
                t.wrapS = this.THREE.RepeatWrapping;
                t.wrapT = this.THREE.ClampToEdgeWrapping;
                u.skyMap.value = t;
                u.skyHasMap.value = 1;
            });
        }
    }
    stop() {
        this.scene.remove(this.dome);
        this.dome.geometry.dispose();
        this.dome.material.dispose();
    }
});
