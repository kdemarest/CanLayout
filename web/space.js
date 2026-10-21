// Unity <-> Three.js placement math. Pieces store Unity values: position, euler rotation in
// degrees (Unity order: Z, then X, then Y, so q = qy * qx * qz), and scale, all left-handed.
// Three.js space is Unity's with X mirrored: M_three = S * M_unity * S, S = diag(-1, 1, 1, 1).
// Loaded as a plain script in the browser (window.Space); Node tests require() it.
(function (root) {
    const DEG = Math.PI / 180;

    function unityEulerToQuaternion(THREE, rotation) {
        const axis = (x, y, z, degrees) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z), degrees * DEG);
        return axis(0, 1, 0, rotation[1]).multiply(axis(1, 0, 0, rotation[0])).multiply(axis(0, 0, 1, rotation[2]));
    }

    function quaternionToUnityEuler(q) {
        const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
        const x = q.x / n, y = q.y / n, z = q.z / n, w = q.w / n;
        const m02 = 2 * (x * z + w * y), m12 = 2 * (y * z - w * x), m22 = 1 - 2 * (x * x + y * y);
        const m10 = 2 * (x * y + w * z), m11 = 1 - 2 * (x * x + z * z), m00 = 1 - 2 * (y * y + z * z), m20 = 2 * (x * z - w * y);
        const ex = Math.asin(Math.max(-1, Math.min(1, -m12)));
        const gimbal = Math.abs(m12) >= 0.9999999;
        const ey = gimbal ? Math.atan2(-m20, m00) : Math.atan2(m02, m22);
        const ez = gimbal ? 0 : Math.atan2(m10, m11);
        const degrees = v => ((v / DEG) % 360 + 360) % 360;
        return [degrees(ex), degrees(ey), degrees(ez)];
    }

    // In place: S * M * S.
    function mirrorX(matrix) {
        const e = matrix.elements;
        for (let i = 0; i < 16; i++) {
            if ((i % 4 === 0) !== (Math.floor(i / 4) === 0)) {
                e[i] = -e[i];
            }
        }
        return matrix;
    }

    // A piece's Three.js matrix.
    function pieceMatrix(THREE, piece) {
        const unity = new THREE.Matrix4().compose(
            new THREE.Vector3(...piece.position),
            unityEulerToQuaternion(THREE, piece.rotation),
            new THREE.Vector3(...piece.scale)
        );
        return mirrorX(unity);
    }

    // Unity position, rotation, and scale from a Three.js matrix.
    function placementOf(THREE, matrix) {
        const unity = mirrorX(matrix.clone());
        const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
        unity.decompose(position, rotation, scale);
        return { position: position.toArray(), rotation: quaternionToUnityEuler(rotation), scale: scale.toArray() };
    }

    // A library part's local matrix (row-major, Unity space, relative to the piece) in Three.js space.
    function partMatrix(THREE, rows) {
        return mirrorX(new THREE.Matrix4().set(...rows));
    }

    const Space = { unityEulerToQuaternion, quaternionToUnityEuler, mirrorX, pieceMatrix, placementOf, partMatrix };
    if (typeof module === "object" && module.exports) {
        module.exports = Space;
    } else {
        root.Space = Space;
    }
})(typeof window !== "undefined" ? window : globalThis);
