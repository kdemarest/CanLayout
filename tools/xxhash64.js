// xxHash64 (seed 0), for Unity's model ids: newer Unity names an object inside a model file by
// the signed xxHash64 of "Type:<Class>-><name><n>", n counting objects of that name from 0
// (e.g. Type:Mesh->Herb_Rice_Jar_1A10 is mesh -8354949339318772137).
const M = (1n << 64n) - 1n;
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n, P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;
const mul = (a, b) => (a * b) & M;
const round = (acc, v) => mul(rotl((acc + mul(v, P2)) & M, 31), P1);
const merge = (acc, v) => (mul(acc ^ round(0n, v), P1) + P4) & M;

function xxhash64(buf) {
  const n = buf.length, u64 = o => buf.readBigUInt64LE(o), u32 = o => BigInt(buf.readUInt32LE(o));
  let i = 0, h;
  if (n >= 32) {
    let v1 = (P1 + P2) & M, v2 = P2, v3 = 0n, v4 = (M + 1n - P1) & M;
    for (; i + 32 <= n; i += 32) { v1 = round(v1, u64(i)); v2 = round(v2, u64(i + 8)); v3 = round(v3, u64(i + 16)); v4 = round(v4, u64(i + 24)); }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
    for (const v of [v1, v2, v3, v4]) h = merge(h, v);
  } else h = P5;
  h = (h + BigInt(n)) & M;
  for (; i + 8 <= n; i += 8) h = (mul(rotl(h ^ round(0n, u64(i)), 27), P1) + P4) & M;
  if (i + 4 <= n) { h = (mul(rotl(h ^ mul(u32(i), P1), 23), P2) + P3) & M; i += 4; }
  for (; i < n; i++) h = mul(rotl(h ^ mul(BigInt(buf[i]), P5), 11), P1);
  h = mul(h ^ (h >> 33n), P2);
  h = mul(h ^ (h >> 29n), P3);
  return h ^ (h >> 32n);
}
// Unity's id for the n-th object of a class and name in a model file, as a decimal string.
const unityId = (cls, name, n = 0) => BigInt.asIntN(64, xxhash64(Buffer.from(`Type:${cls}->${name}${n}`))).toString();

module.exports = { xxhash64, unityId };
