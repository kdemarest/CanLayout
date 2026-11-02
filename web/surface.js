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
    // The sea's two surfaces (Ken, 2026-10-29), drawn as Canopy's shaders draw them, on Sea.prefab's
    // own meshes (its 840 m squares) and their UVs: each samples one normal map twice, at each
    // _NormalN's tiling and offset plus the scroll WaterScroller drifts it by (canopyWaterScroll1
    // and 2 above, ...Below1 and 2 under). The surface's frame comes from screen derivatives of
    // position and UV (layout's meshes have no tangents), in Unity's world.
    const WATER_VERTEX = `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vObjPos;
void main() {
    vObjPos = position * vec3(-1.0, 1.0, 1.0); // the mesh's own space, Unity's way round
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz * vec3(-1.0, 1.0, 1.0);
    vNormal = normalize(inverse(transpose(mat3(modelMatrix))) * normal) * vec3(-1.0, 1.0, 1.0);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
}
`;
    const WATER_COMMON = `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
uniform sampler2D seaNormal;
uniform vec4 seaST1;
uniform vec4 seaST2;
uniform vec3 canopyFogColor;
uniform float canopyFogDensitySquared;
// Tangent (along +u), bitangent (+v) and normal at this point.
mat3 waterFrame() {
    vec3 N = normalize(vNormal);
    vec3 dp1 = dFdx(vWorldPos), dp2 = dFdy(vWorldPos);
    vec2 duv1 = dFdx(vUv), duv2 = dFdy(vUv);
    vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float s = sign(dot(dp1, dp2perp)) * inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
    return mat3(T * s, B * s, N);
}
`;
    // Unity's SeaSurface, as Canopy/SeaSurface.shader: the two normals added; only the sun's
    // glints show (Blinn to the 8th, times gloss), and it is clear looking down, opaque toward the
    // horizon. Drawn from above only, as in Unity (Cull Back).
    const SEA_FRAGMENT = `${WATER_COMMON}
uniform vec3 canopySunDirection;
uniform vec4 seaColor;
uniform float seaGloss;
uniform float seaAnglePct;
uniform float seaGlintAlpha;
uniform vec2 canopyWaterScroll1;
uniform vec2 canopyWaterScroll2;
void main() {
    vec3 n1 = texture2D(seaNormal, vUv * seaST1.xy + seaST1.zw + canopyWaterScroll1).xyz * 2.0 - 1.0;
    vec3 n2 = texture2D(seaNormal, vUv * seaST2.xy + seaST2.zw + canopyWaterScroll2).xyz * 2.0 - 1.0;
    vec3 N = normalize(waterFrame() * normalize(n1 + n2));
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    vec3 V = normalize(toCamera);
    vec3 H = normalize(normalize(canopySunDirection) + V);
    float ndoth = clamp(dot(N, H), 0.0, 1.0);
    float n2h = ndoth * ndoth;
    float n8 = n2h * n2h * n2h * n2h;
    vec3 color = seaColor.rgb * n8 * seaGloss;
    float distanceSquared = dot(toCamera, toCamera);
    color = mix(canopyFogColor, color, exp2(-canopyFogDensitySquared * distanceSquared));
    float viewAngleAlpha = clamp(1.0 - seaAnglePct * abs(V.y), 0.0, 1.0);
    float distanceAlpha = clamp(distanceSquared * 0.001 * seaGlintAlpha, 0.0, 1.0);
    gl_FragColor = vec4(color, mix(seaColor.a, 1.0, clamp(viewAngleAlpha + distanceAlpha, 0.0, 1.0)));
    #include <colorspace_fragment>
}
`;
    // The sea's underside, as Canopy/WaterBelow.shader draws it since Claude, 2026-10-29 (Ken: a
    // shader of Canopy's own, as cheap as can be, not Unity's Standard lighting): the two
    // samples weighted by _NormalStrength1 and 2 and unpacked together; its
    // color lit by the ambient light (from below the sun can't reach it), plus a sheen of the
    // water's own color (the fog's) at grazing angles, Schlick's Fresnel times _Glossiness; fog
    // at _FogLevel of its density; _Color's alpha. Seen from below (Cull Back on a face turned down).
    const BELOW_FRAGMENT = `${WATER_COMMON}
uniform vec3 canopyAmbient;
uniform vec4 belowColor;
uniform vec2 belowStrength;
uniform float belowGloss;
uniform float belowFogLevel;
uniform vec2 canopyWaterScrollBelow1;
uniform vec2 canopyWaterScrollBelow2;
void main() {
    vec3 t1 = texture2D(seaNormal, vUv * seaST1.xy + seaST1.zw + canopyWaterScrollBelow1).xyz;
    vec3 t2 = texture2D(seaNormal, vUv * seaST2.xy + seaST2.zw + canopyWaterScrollBelow2).xyz;
    vec3 N = normalize(waterFrame() * normalize((t1 * belowStrength.x + t2 * belowStrength.y) * 2.0 - 1.0));
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    float c = 1.0 - clamp(dot(N, normalize(toCamera)), 0.0, 1.0);
    float c2 = c * c;
    float fresnel = 0.04 + 0.96 * c2 * c2 * c;
    vec3 color = belowColor.rgb * canopyAmbient + belowGloss * fresnel * canopyFogColor;
    color = mix(canopyFogColor, color, exp2(-canopyFogDensitySquared * belowFogLevel * belowFogLevel * dot(toCamera, toCamera)));
    gl_FragColor = vec4(color, belowColor.a);
    #include <colorspace_fragment>
}
`;
    // Canopy/Water (Ken, 2026-10-29: the Mega's shield, WaterBubble.mat), as its shader: the sea's two
    // scrolled samples (_WaterScroll1 and 2), each unpacked and weighted by its strength, then
    // added; lit by the sun (Lambert), a sharp highlight (Blinn to the 16th times _Glossiness, if
    // _SpecularHighlights) and the ambient light; Canopy's fog at _FogLevel of its density², except
    // below the waterline seen from above; _Color's alpha.
    const BUBBLE_FRAGMENT = `${WATER_COMMON}
uniform vec3 canopySunDirection;
uniform vec3 canopySunColor;
uniform vec3 canopyAmbient;
uniform float canopySeaLevel;
uniform float canopyHeadUnder;
uniform vec4 bubbleColor;
uniform vec2 bubbleStrength;
uniform float bubbleGloss;
uniform float bubbleSpecular;
uniform float bubbleFogLevel;
uniform vec2 canopyWaterScroll1;
uniform vec2 canopyWaterScroll2;
void main() {
    vec3 n1 = (texture2D(seaNormal, vUv * seaST1.xy + seaST1.zw + canopyWaterScroll1).xyz * 2.0 - 1.0) * bubbleStrength.x;
    vec3 n2 = (texture2D(seaNormal, vUv * seaST2.xy + seaST2.zw + canopyWaterScroll2).xyz * 2.0 - 1.0) * bubbleStrength.y;
    vec3 N = normalize(waterFrame() * normalize(n1 + n2));
    vec3 L = normalize(canopySunDirection);
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    vec3 H = normalize(L + normalize(toCamera));
    float h = max(dot(N, H), 0.0), h2 = h * h, h4 = h2 * h2, h8 = h4 * h4;
    vec3 color = canopyAmbient * bubbleColor.rgb + max(dot(N, L), 0.0) * canopySunColor * bubbleColor.rgb + (bubbleSpecular > 0.5 ? h8 * h8 * bubbleGloss * canopySunColor : vec3(0.0));
    if (canopyHeadUnder > 0.5 || vWorldPos.y >= canopySeaLevel) color = mix(canopyFogColor, color, clamp(exp2(-canopyFogDensitySquared * bubbleFogLevel * dot(toCamera, toCamera)), 0.0, 1.0));
    gl_FragColor = vec4(color, bubbleColor.a);
    #include <colorspace_fragment>
}
`;
    // Canopy/Force Field (Ken, 2026-10-29: the cages' spheres, Cage.cs's liveMat and deadMat), as its
    // shader: its texture, scrolled by _ScrollDirection a second, times _Color and _FresnelPower
    // raised to the rim (_RimPower at the centre up to 1 at the edge, from the view and the
    // normal), faded by the rim, kept within _Color; no lighting or fog.
    const FIELD_FRAGMENT = `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
uniform sampler2D fieldMap;
uniform vec4 fieldST;
uniform vec2 fieldScroll;
uniform vec4 fieldColor;
uniform float fieldFresnel;
uniform float fieldRim;
uniform float canopyTime;
void main() {
    vec3 toCamera = normalize(cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos);
    float rim = fieldRim + (1.0 - clamp(dot(toCamera, normalize(vNormal)), 0.0, 1.0)) * (1.0 - fieldRim);
    vec4 pixel = texture2D(fieldMap, vUv * fieldST.xy + fieldST.zw + fieldScroll * canopyTime) * fieldColor * pow(fieldFresnel, rim);
    gl_FragColor = clamp(pixel * rim, vec4(0.0), fieldColor);
    #include <colorspace_fragment>
}
`;
    // Canopy/CloudTextured (Ken, 2026-10-29: clouds, CloudMat), as its shader: _EdgeTint at grazing
    // angles to _Tint facing the eye, mottled by _NoiseTex looked up at sines of the mesh's own
    // position (times _NoiseScale), times _Brightness; lit by the sun (its direction times
    // _Inverted, 1 lit from above; never darker than _Underglow), a highlight (_Glossiness times
    // 128 its power, times _Metallic) and the ambient light; Canopy's fog at _FogLevel, except
    // below the waterline seen from above. Opaque. (_SunIntensity is taken as 1.)
    const CLOUD_FRAGMENT = `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vObjPos;
uniform sampler2D noiseMap;
uniform vec4 cloudTint;
uniform vec4 cloudEdge;
uniform float cloudMetallic, cloudGloss, cloudBrightness, cloudUnderglow, cloudNoiseScale, cloudNoiseStrength, cloudInverted, cloudFogLevel;
uniform vec3 canopySunDirection, canopySunColor, canopyAmbient, canopyFogColor;
uniform float canopyFogDensitySquared, canopySeaLevel, canopyHeadUnder;
void main() {
    vec3 N = normalize(vNormal);
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    vec3 V = normalize(toCamera);
    vec4 base = mix(cloudEdge, cloudTint, clamp(dot(N, V), 0.0, 1.0));
    float s = cloudNoiseScale;
    vec2 uv = vec2(sin(vObjPos.x * s) + cos(vObjPos.z * s), sin(vObjPos.y * s) + cos(vObjPos.x * s)) * 0.5 + 0.5;
    vec3 albedo = mix(base, texture2D(noiseMap, uv), cloudNoiseStrength).rgb * cloudBrightness;
    vec3 L = normalize(cloudInverted * canopySunDirection + 1e-8);
    float ndotl = max(dot(N, L), 0.0);
    vec3 diffuse = albedo * canopySunColor * (cloudUnderglow + ndotl * (1.0 - cloudUnderglow));
    float specular = pow(max(dot(N, normalize(L + V)), 0.0), cloudGloss * 128.0);
    vec3 color = diffuse + specular * canopySunColor * cloudMetallic + canopyAmbient;
    if (canopyHeadUnder > 0.5 || vWorldPos.y >= canopySeaLevel) color = mix(canopyFogColor, color, clamp(exp2(-canopyFogDensitySquared * cloudFogLevel * cloudFogLevel * dot(toCamera, toCamera)), 0.0, 1.0));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
}
`;
    // Canopy/Goop (Ken, 2026-10-29: goop, GoopMat), as its shader's surface: _Tint, shading to
    // 2 (_NearColor - 0.5) within _TransitionDistance of the eye (cubed), mottled by _NoiseTex times
    // 2 (_InnerTint - 0.5), looked up at sines of the world position drifting with _GoopScroll
    // (seconds since the start: canopyTime) times _ScrollRate, times _Brightness; its normal map at
    // the same place times _NormalScale, tilted by _NormalStrength. Unity lights it with Standard;
    // here, simply: the sun (Lambert) and the ambient light on the albedo (less what _Metallic
    // reflects), a highlight from _Glossiness, and Canopy's fog (Canopy turns Unity's on at start). Opaque.
    const GOOP_FRAGMENT = `${WATER_COMMON}
uniform sampler2D noiseMap;
uniform sampler2D normalMap;
uniform vec4 goopTint, goopInner, goopNear;
uniform float goopTransition, goopScrollRate, goopMetallic, goopGloss, goopBrightness, goopNoiseScale, goopNoiseStrength, goopNormalStrength, goopNormalScale;
uniform vec3 canopySunDirection, canopySunColor, canopyAmbient;
uniform float canopyTime;
void main() {
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    float near = clamp(1.0 - length(toCamera) / goopTransition, 0.0, 1.0);
    vec4 tinted = mix(goopTint, 2.0 * (goopNear - 0.5), near * near * near);
    float s = canopyTime * goopScrollRate, k = goopNoiseScale;
    vec2 uv = vec2(sin((vWorldPos.x + s) * k) + cos(vWorldPos.z * k), sin((vWorldPos.y - s) * k) + cos(vWorldPos.x * k)) * 0.5 + 0.5;
    vec3 albedo = mix(tinted, texture2D(noiseMap, uv) * (2.0 * (goopInner - 0.5)), goopNoiseStrength).rgb * goopBrightness;
    vec3 n = texture2D(normalMap, uv * goopNormalScale).xyz * 2.0 - 1.0;
    n.xy *= goopNormalStrength;
    vec3 N = normalize(waterFrame() * normalize(n));
    vec3 L = normalize(canopySunDirection), V = normalize(toCamera);
    float shine = exp2(10.0 * goopGloss + 1.0);
    vec3 color = albedo * (1.0 - goopMetallic) * (canopyAmbient + canopySunColor * max(dot(N, L), 0.0))
        + canopySunColor * mix(vec3(0.04), albedo, goopMetallic) * goopGloss * pow(max(dot(N, normalize(L + V)), 0.0), shine);
    color = mix(canopyFogColor, color, clamp(exp2(-canopyFogDensitySquared * dot(toCamera, toCamera)), 0.0, 1.0));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
}
`;
    // Canopy/DiffuseGlow (Ken, 2026-10-29: the mana fire on flamers, ManaFireMat; its file is
    // Glow.shader), as its shader: unlit, its texture's color, but where any channel is above
    // _GlowThreshold, the color squared times _GlowBrightness (it blazes), fogged at _GlowFogLevel
    // of the fog there and fully elsewhere. Opaque.
    const GLOW_FRAGMENT = `
varying vec3 vWorldPos;
varying vec2 vUv;
uniform sampler2D fieldMap;
uniform vec4 fieldST;
uniform float glowThreshold, glowBrightness, glowFogLevel;
uniform vec3 canopyFogColor;
uniform float canopyFogDensitySquared;
void main() {
    vec4 col = texture2D(fieldMap, vUv * fieldST.xy + fieldST.zw);
    float fogLevel = 1.0;
    if (col.r > glowThreshold || col.g > glowThreshold || col.b > glowThreshold) {
        col.rgb = col.rgb * col.rgb * glowBrightness;
        fogLevel = glowFogLevel;
    }
    vec3 toCamera = cameraPosition * vec3(-1.0, 1.0, 1.0) - vWorldPos;
    col.rgb = mix(canopyFogColor, col.rgb, clamp(exp2(-canopyFogDensitySquared * fogLevel * fogLevel * dot(toCamera, toCamera)), 0.0, 1.0));
    gl_FragColor = vec4(col.rgb, 1.0);
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
        canopyWaterScroll1: { value: new THREE.Vector2() },
        canopyWaterScroll2: { value: new THREE.Vector2() },
        canopyWaterScrollBelow1: { value: new THREE.Vector2() },
        canopyWaterScrollBelow2: { value: new THREE.Vector2() },
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
        // the waterline and how dark below it: the Sea's (layout/scripts/Sea.js), none without one
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

    // A material for some of Canopy's own shaders, drawn by name (d.shaderName): the sea's two
    // surfaces, Water (bubbles and shields), Force Field (cages), CloudTextured (clouds), Goop and
    // DiffuseGlow (the mana fire).
    // Its look comes from the material description d (tools/scene.js): values (the shader's
    // defaults where the material has none), and textures' tilings; app.js gives the textures
    // (uniforms seaNormal, fieldMap, noiseMap, normalMap). Null for any other shader.
    function byShader(d, options) {
        const v = (name, start) => (d.values && d.values[name]) || start;
        const st = t => new THREE.Vector4(...(t ? t.scale : [1, 1]), ...(t ? t.offset : [0, 0]));
        const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1), white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        flat.needsUpdate = white.needsUpdate = true;
        const c = v("_Color", [0, 0.25, 0.35, 0]), rgb = linear(c[0], c[1], c[2]);
        const shared = { seaNormal: { value: flat }, seaST1: { value: st(d.normal1) }, seaST2: { value: st(d.normal2 || d.normal1) }, canopyFogColor: uniforms.canopyFogColor, canopyFogDensitySquared: uniforms.canopyFogDensitySquared };
        const make = (own, fragmentShader, look = {}) => new THREE.ShaderMaterial({ uniforms: { ...shared, ...own }, vertexShader: WATER_VERTEX, fragmentShader, transparent: true, depthWrite: false, ...look, ...options });
        if (d.shaderName === "Canopy/SeaSurface") return make({
            canopySunDirection: uniforms.canopySunDirection,
            seaColor: { value: new THREE.Vector4(rgb.r, rgb.g, rgb.b, c[3]) },
            seaGloss: { value: v("_Glossiness", [0.6])[0] },
            seaAnglePct: { value: v("_AnglePct", [1])[0] },
            seaGlintAlpha: { value: v("_GlintAlpha", [0.1])[0] },
            canopyWaterScroll1: uniforms.canopyWaterScroll1,
            canopyWaterScroll2: uniforms.canopyWaterScroll2
        }, SEA_FRAGMENT);
        if (d.shaderName === "Canopy/WaterBelow") return make({
            canopyAmbient: uniforms.canopyAmbient,
            belowColor: { value: new THREE.Vector4(rgb.r, rgb.g, rgb.b, c[3]) },
            belowStrength: { value: new THREE.Vector2(v("_NormalStrength1", [0.17])[0], v("_NormalStrength2", [0.8])[0]) },
            belowGloss: { value: v("_Glossiness", [0.6])[0] },
            belowFogLevel: { value: v("_FogLevel", [0])[0] },
            canopyWaterScrollBelow1: uniforms.canopyWaterScrollBelow1,
            canopyWaterScrollBelow2: uniforms.canopyWaterScrollBelow2
        }, BELOW_FRAGMENT);
        if (d.shaderName === "Canopy/Water") return make({
            canopySunDirection: uniforms.canopySunDirection, canopySunColor: uniforms.canopySunColor, canopyAmbient: uniforms.canopyAmbient,
            canopySeaLevel: uniforms.canopySeaLevel, canopyHeadUnder: uniforms.canopyHeadUnder,
            bubbleColor: { value: new THREE.Vector4(rgb.r, rgb.g, rgb.b, c[3]) },
            bubbleStrength: { value: new THREE.Vector2(v("_NormalStrength1", [0.17])[0], v("_NormalStrength2", [0.8])[0]) },
            bubbleGloss: { value: v("_Glossiness", [0.6])[0] },
            bubbleSpecular: { value: v("_SpecularHighlights", [1])[0] },
            bubbleFogLevel: { value: v("_FogLevel", [1])[0] },
            canopyWaterScroll1: uniforms.canopyWaterScroll1,
            canopyWaterScroll2: uniforms.canopyWaterScroll2
        }, BUBBLE_FRAGMENT);
        const opaque = { transparent: false, depthWrite: true };
        const col = (name, start) => { const x = v(name, start), l = linear(x[0], x[1], x[2]); return new THREE.Vector4(l.r, l.g, l.b, x[3] ?? 1); };
        const one = (name, start) => v(name, [start])[0];
        if (d.shaderName === "Canopy/CloudTextured") return make({
            noiseMap: { value: white },
            cloudTint: { value: col("_Tint", [0.5, 0.5, 0.5, 1]) }, cloudEdge: { value: col("_EdgeTint", [0.2, 0.2, 0.2, 1]) },
            cloudMetallic: { value: one("_Metallic", 0) }, cloudGloss: { value: one("_Glossiness", 0) }, cloudBrightness: { value: one("_Brightness", 1) },
            cloudUnderglow: { value: one("_Underglow", 0) }, cloudNoiseScale: { value: one("_NoiseScale", 1) }, cloudNoiseStrength: { value: one("_NoiseStrength", 0.5) },
            cloudInverted: { value: one("_Inverted", 1) }, cloudFogLevel: { value: one("_FogLevel", 1) },
            canopySunDirection: uniforms.canopySunDirection, canopySunColor: uniforms.canopySunColor, canopyAmbient: uniforms.canopyAmbient,
            canopySeaLevel: uniforms.canopySeaLevel, canopyHeadUnder: uniforms.canopyHeadUnder
        }, CLOUD_FRAGMENT, opaque);
        if (d.shaderName === "Canopy/Goop") return make({
            noiseMap: { value: white }, normalMap: { value: flat },
            goopTint: { value: col("_Tint", [0.5, 0.5, 0.5, 1]) }, goopInner: { value: col("_InnerTint", [0.2, 0.2, 0.2, 1]) }, goopNear: { value: col("_NearColor", [1, 0.5, 0.5, 1]) },
            goopTransition: { value: one("_TransitionDistance", 10) }, goopScrollRate: { value: one("_ScrollRate", 1) },
            goopMetallic: { value: one("_Metallic", 0) }, goopGloss: { value: one("_Glossiness", 0) }, goopBrightness: { value: one("_Brightness", 1) },
            goopNoiseScale: { value: one("_NoiseScale", 1) }, goopNoiseStrength: { value: one("_NoiseStrength", 0.5) },
            goopNormalStrength: { value: one("_NormalStrength", 1) }, goopNormalScale: { value: one("_NormalScale", 1) },
            canopySunDirection: uniforms.canopySunDirection, canopySunColor: uniforms.canopySunColor, canopyAmbient: uniforms.canopyAmbient, canopyTime: uniforms.canopyTime
        }, GOOP_FRAGMENT, opaque);
        if (d.shaderName === "Canopy/DiffuseGlow") return make({
            fieldMap: { value: white }, fieldST: { value: st(d.map) },
            glowThreshold: { value: one("_GlowThreshold", 0.5) }, glowBrightness: { value: one("_GlowBrightness", 100) }, glowFogLevel: { value: one("_GlowFogLevel", 1) }
        }, GLOW_FRAGMENT, opaque);
        if (d.shaderName === "Canopy/Force Field") {
            const f = v("_Color", [1, 1, 1, 1]), fc = linear(f[0], f[1], f[2]), scroll = v("_ScrollDirection", [0, 0]);
            return make({
                fieldMap: { value: white },
                fieldST: { value: st(d.map) },
                fieldScroll: { value: new THREE.Vector2(scroll[0] || 0, scroll[1] || 0) },
                fieldColor: { value: new THREE.Vector4(fc.r, fc.g, fc.b, f[3]) },
                fieldFresnel: { value: v("_FresnelPower", [3])[0] },
                fieldRim: { value: v("_RimPower", [0.5])[0] },
                canopyTime: uniforms.canopyTime
            }, FIELD_FRAGMENT);
        }
        return null;
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

    root.Surface = { uniforms, setEnvironment, underSea, material, byShader };
})(window);
