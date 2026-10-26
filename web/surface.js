// Canopy surface shaders in the browser. A Unity shader with a surface function between MODL
// SURFACE markers (modl/tools/shaders.js writes them; tools/scene.js reads them out) is drawn
// here with that same function, compiled as GLSL, inside the lighting the Unity shader wraps
// it in (CanopyLight there; keep the two alike): one sun, ambient, Blinn-Phong gloss, emission,
// exp2 fog. The surface code is HLSL kept to what GLSL shares; the prelude maps the names that
// differ. It sees positions and normals in Unity's space: Three.js's with X mirrored back.
// Also Canopy's sea for the rest of the page: the sea surface (Unity's SeaSurface shader) and
// the darkening of everything below the waterline that Canopy's shaders do (underSea).
// Loaded as a plain script (window.Surface).
(function (root) {
    const PRELUDE = `
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define float2x2 mat2
#define float3x3 mat3
#define float4x4 mat4
#define int2 ivec2
#define int3 ivec3
#define int4 ivec4
#define lerp mix
#define frac fract
#define atan2 atan
#define ddx dFdx
#define ddy dFdy
#define rsqrt inversesqrt
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
float fmod(float x, float y) { return x - y * trunc(x / y); }
vec2 fmod(vec2 x, vec2 y) { return x - y * trunc(x / y); }
vec3 fmod(vec3 x, vec3 y) { return x - y * trunc(x / y); }
vec4 fmod(vec4 x, vec4 y) { return x - y * trunc(x / y); }
struct SurfIn { vec3 objPos; vec3 objNormal; vec3 worldPos; vec3 worldNormal; vec3 viewDir; vec2 uv; float time; };
struct SurfOut { vec3 albedo; vec3 emission; float gloss; float specular; vec3 normal; float alpha; };
uniform mat4 modelMatrix;
vec3 ObjectToWorldNormal(vec3 n) { return normalize(inverse(transpose(mat3(modelMatrix))) * (n * vec3(-1.0, 1.0, 1.0))) * vec3(-1.0, 1.0, 1.0); }
`;
    const VERTEX = `
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
const vec3 FLIP = vec3(-1.0, 1.0, 1.0);
void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vObjPos = position * FLIP;
    vObjNormal = normal * FLIP;
    vWorldPos = world.xyz * FLIP;
    vWorldNormal = inverse(transpose(mat3(modelMatrix))) * normal * FLIP;
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`;
    const LIGHT = `
uniform vec3 canopySunDirection;
uniform vec3 canopySunColor;
uniform vec3 canopyAmbient;
uniform vec3 canopyFogColor;
uniform float canopyFogDensitySquared;
uniform float canopyTime;
uniform float canopySeaLevel;
uniform float canopyDimAmount;
uniform float canopyDimDepth;
uniform float canopyHeadUnder;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
vec4 canopyLight(SurfIn s, SurfOut o) {
    vec3 albedo = o.albedo;
    bool below = canopyHeadUnder < 0.5 && s.worldPos.y < canopySeaLevel;
    if (below) albedo *= canopyDimAmount * saturate(1.0 - (canopySeaLevel - s.worldPos.y) / max(canopyDimDepth, 1e-5));
    vec3 L = normalize(canopySunDirection);
    vec3 H = normalize(L + s.viewDir);
    vec3 N = normalize(o.normal);
    vec3 diffuse = max(dot(N, L), 0.0) * albedo;
    float ndoth = max(dot(N, H), 0.0);
    float n2 = ndoth * ndoth;
    float n8 = n2 * n2 * n2 * n2;
    float n64 = n8 * n8 * n8 * n8 * n8 * n8 * n8 * n8;
    float specTerm = o.gloss == 0.0 ? 0.0 : mix(n8, n64, o.gloss);
    vec3 specular = specTerm * o.specular * canopySunColor * o.gloss;
    vec3 lit = canopyAmbient * albedo + diffuse + specular + o.emission;
    if (below) return vec4(lit, o.alpha);
    vec3 d = cameraPosition * vec3(-1.0, 1.0, 1.0) - s.worldPos;
    float f = exp2(-canopyFogDensitySquared * dot(d, d));
    return vec4(mix(canopyFogColor, lit, saturate(f)), o.alpha);
}
void main() {
    SurfIn s;
    s.objPos = vObjPos;
    s.objNormal = normalize(vObjNormal);
    s.worldPos = vWorldPos;
    s.worldNormal = normalize(vWorldNormal);
    s.viewDir = normalize(cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos);
    s.uv = vUv;
    s.time = canopyTime;
    SurfOut o;
    o.albedo = vec3(1.0);
    o.emission = vec3(0.0);
    o.gloss = 0.0;
    o.specular = 0.2;
    o.normal = s.worldNormal;
    o.alpha = 1.0;
    surface(s, o);
    gl_FragColor = canopyLight(s, o);
    #include <colorspace_fragment>
}
`;
    // Unity's SeaSurface, still: its normal map sampled once (Unity blends two scrolling samples),
    // tiled over the world; only the sun's glints show, and it is clear looking down, opaque
    // toward the horizon. Drawn from above only, as in Unity (Cull Back).
    const SEA_VERTEX = `
varying vec3 vWorldPos;
void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz * vec3(-1.0, 1.0, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
}
`;
    const SEA_FRAGMENT = `
uniform vec3 canopySunDirection;
uniform vec3 canopyFogColor;
uniform float canopyFogDensitySquared;
uniform sampler2D seaNormal;
uniform vec4 seaColor;
uniform float seaGloss;
uniform float seaAnglePct;
uniform float seaGlintAlpha;
uniform float seaTile;
varying vec3 vWorldPos;
void main() {
    vec3 n = texture2D(seaNormal, vWorldPos.xz / seaTile).xyz * 2.0 - 1.0;
    vec3 N = normalize(vec3(n.x, n.z, n.y)); // tangent along X, bitangent along Z, up
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    vec3 V = normalize(toCamera);
    vec3 H = normalize(normalize(canopySunDirection) + V);
    float ndoth = clamp(dot(N, H), 0.0, 1.0);
    float n2 = ndoth * ndoth;
    float n8 = n2 * n2 * n2 * n2;
    vec3 color = seaColor.rgb * n8 * seaGloss;
    float distanceSquared = dot(toCamera, toCamera);
    color = mix(canopyFogColor, color, exp2(-canopyFogDensitySquared * distanceSquared));
    float viewAngleAlpha = clamp(1.0 - seaAnglePct * abs(V.y), 0.0, 1.0);
    float distanceAlpha = clamp(distanceSquared * 0.001 * seaGlintAlpha, 0.0, 1.0);
    gl_FragColor = vec4(color, mix(seaColor.a, 1.0, clamp(viewAngleAlpha + distanceAlpha, 0.0, 1.0)));
    #include <colorspace_fragment>
}
`;
    // Canopy's globals, shared by every surface material (set by setEnvironment; canopyTime and
    // canopyHeadUnder each frame).
    const uniforms = {
        canopySunDirection: { value: new THREE.Vector3(0, 1, 0) },
        canopySunColor: { value: new THREE.Color(1, 1, 1) },
        canopyAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) },
        canopyFogColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
        canopyFogDensitySquared: { value: 0 },
        canopyTime: { value: 0 },
        canopySeaLevel: { value: -1e9 },
        canopyDimAmount: { value: 1 },
        canopyDimDepth: { value: 1 },
        canopyHeadUnder: { value: 0 }
    };
    // Colors are as Unity's inspector shows them (sRGB); Unity hands shaders linear values, and
    // so does THREE.Color.
    const linear = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

    // env: unity.json's environment (tools/config.js); fog off draws none.
    function setEnvironment(env, fog) {
        const sun = env.sunDirection;
        uniforms.canopySunDirection.value.set(sun[0], sun[1], sun[2]).normalize();
        uniforms.canopySunColor.value.set(env.sunColor);
        uniforms.canopyAmbient.value.copy(linear(env.ambient, env.ambient, env.ambient));
        uniforms.canopyFogColor.value.set(env.fogColor);
        uniforms.canopyFogDensitySquared.value = fog ? env.fogDensity * env.fogDensity : 0;
        uniforms.canopySeaLevel.value = env.seaLevel;
        uniforms.canopyDimAmount.value = env.dimAmount;
        uniforms.canopyDimDepth.value = env.dimDepth;
    }

    // For a built-in Three.js material's onBeforeCompile: below the waterline (while the camera
    // is above it) it darkens toward black within dimDepth and takes no fog, as Canopy/General
    // does (which darkens the color before lighting; this, the lit result).
    function underSea(shader) {
        for (const name of ["canopySeaLevel", "canopyDimAmount", "canopyDimDepth", "canopyHeadUnder"]) shader.uniforms[name] = uniforms[name];
        shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying float vCanopyWorldY;")
            .replace("#include <project_vertex>", `#include <project_vertex>
    vec4 canopyWorld = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
    canopyWorld = instanceMatrix * canopyWorld;
#endif
    vCanopyWorldY = ( modelMatrix * canopyWorld ).y;`);
        shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", `#include <common>
varying float vCanopyWorldY;
uniform float canopySeaLevel;
uniform float canopyDimAmount;
uniform float canopyDimDepth;
uniform float canopyHeadUnder;`)
            .replace("#include <fog_fragment>", `float canopyBelow = canopySeaLevel - vCanopyWorldY;
    if ( canopyHeadUnder < 0.5 && canopyBelow > 0.0 ) gl_FragColor.rgb *= canopyDimAmount * clamp( 1.0 - canopyBelow / max( canopyDimDepth, 1e-5 ), 0.0, 1.0 );
    else {
#include <fog_fragment>
    }`);
    }

    // The sea surface for Unity's sea material description d (tools/scene.js): its color, gloss
    // and alpha settings; tile is how many meters its normal map spans. setNormal gives the map.
    function sea(d, tile) {
        const v = (name, start) => (d && d.values && d.values[name]) || start;
        const c = v("_Color", [0.27, 0.53, 0.68, 0.18]), rgb = linear(c[0], c[1], c[2]);
        const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
        flat.needsUpdate = true;
        return new THREE.ShaderMaterial({
            uniforms: {
                canopySunDirection: uniforms.canopySunDirection,
                canopyFogColor: uniforms.canopyFogColor,
                canopyFogDensitySquared: uniforms.canopyFogDensitySquared,
                seaNormal: { value: flat },
                seaColor: { value: new THREE.Vector4(rgb.r, rgb.g, rgb.b, c[3]) },
                seaGloss: { value: v("_Glossiness", [0.34])[0] },
                seaAnglePct: { value: v("_AnglePct", [1.5])[0] },
                seaGlintAlpha: { value: v("_GlintAlpha", [0.13])[0] },
                seaTile: { value: tile }
            },
            vertexShader: SEA_VERTEX,
            fragmentShader: SEA_FRAGMENT,
            transparent: true,
            depthWrite: false
        });
    }

    // A Three.js material for a Unity material description with a surface (tools/scene.js):
    // each property takes the material's value, else the shader's default.
    function material(d, options) {
        const own = {};
        const declare = [];
        for (const p of d.surface.properties) {
            const v = (d.values && d.values[p.name]) || p.value;
            if (p.type === "Color" || p.type === "Vector") {
                const c = p.type === "Color" ? linear(v[0], v[1], v[2]) : { r: v[0], g: v[1], b: v[2] };
                own[p.name] = { value: new THREE.Vector4(c.r, c.g, c.b, v[3] ?? 1) };
                declare.push(`uniform vec4 ${p.name};`);
            } else {
                own[p.name] = { value: v[0] };
                declare.push(`uniform float ${p.name};`);
            }
        }
        return new THREE.ShaderMaterial({
            uniforms: { ...uniforms, ...own },
            vertexShader: VERTEX,
            fragmentShader: `${PRELUDE}\n${declare.join("\n")}\n${d.surface.code}\n${LIGHT}`,
            side: THREE.DoubleSide,
            ...options
        });
    }

    root.Surface = { uniforms, setEnvironment, underSea, material, sea };
})(window);
