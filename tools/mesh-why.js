// What tools/mesh-clean.js changed near a point, from its change log (cache/mesh-clean/<mesh>.jsonl):
//   node tools/mesh-why.js [<mesh name, default Tangle_LOD0>] [x y z | --probe <n>] [--r <mesh units, default 1>]
//   node tools/mesh-why.js --probes [<how many, default 10>]   (the recent probes, numbered)
// --json prints one object instead: { piece, ring, rings, atOrigin, trunk, vertexDistance, changes:
// [{ d, rule, piece, rings (changed), triangles, why }] } (the server adds it to each probe).
// The point is in mesh units (a probe's "local"); without one, a probe's from cache/probes.jsonl:
// probe 1 the most recent, 2 the one before, and so on (Ken, 2026-10-28: "probe 2").
// Says which branch and ring the point is on in the mesh mesh-clean read, then each change within r
// of it, nearest first: the rule, the branch, the rings it changed, how many triangles, and why.
const fs = require('fs');
const path = require('path');
const M = require('./unity-mesh.js');
const MC = require('./mesh-clean.js');

const CACHE = path.join(__dirname, '..', 'cache');
const args = process.argv.slice(2);
const probes = fs.readFileSync(path.join(CACHE, 'probes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).reverse();
const where = p => (p.hit ? `${p.hit.piece} at ${p.hit.local.join(' ')}` : 'nothing');
if (args[0] === '--probes') {
  probes.slice(0, +args[1] || 10).forEach((p, i) => console.log(`probe ${i + 1}  ${p.at}  ${p.scene}: ${where(p)}`));
  process.exit(0);
}
const json = args.includes('--json');
if (json) args.splice(args.indexOf('--json'), 1);
const say = json ? () => {} : console.log;
const ri = args.indexOf('--r'), r = ri >= 0 ? +args.splice(ri, 2)[1] : 1;
const pi = args.indexOf('--probe'), which = pi >= 0 ? +args.splice(pi, 2)[1] : 1;
const name = args.length && isNaN(+args[0]) ? args.shift() : 'Tangle_LOD0';
let point = args.length >= 3 ? args.slice(0, 3).map(Number) : null;
if (!point) {
  const probe = probes[which - 1];
  if (!probe) throw new Error(`there is no probe ${which} (${probes.length} kept)`);
  if (!probe.hit) throw new Error(`probe ${which} hit nothing`);
  point = probe.hit.local;
  say(`probe ${which} (${probe.at}, ${probe.scene}): ${where(probe)} (mesh units)`);
}
const lines = fs.readFileSync(path.join(CACHE, 'mesh-clean', name + '.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const head = lines.shift();
say(`change log: ${head.file}, run ${head.run}: ${head.triangles} triangles -> ${head.after}; ${lines.length} changes`);

// the branch under the point, in the mesh mesh-clean read
const a = MC.analyse(M.readMesh(MC.readCanopyMesh(head.file)));
let near = null, nd = Infinity;
a.pos.forEach((q, v) => { if (!q) return; const d = Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]); if (d < nd) { nd = d; near = v; } });
const piece = a.pieceOf.get(near), info = a.ringsByPiece.get(piece);
say(`nearest vertex ${nd.toFixed(3)} away: piece ${piece}, ring ${info ? info.ringOf.get(near) : '?'} of ${info ? info.rings.length : '?'}${a.atOrigin.has(piece) ? ', at the trunk origin' : ''}${piece === a.trunk ? ' (the trunk)' : ''}`);
const mine = lines.filter(x => x.piece === piece);
say(mine.length ? `piece ${piece}'s changes: ${mine.map(x => `${x.rule} (rings ${x.changedRings ? x.changedRings.join('-') : '-'}, ${x.tris.length} triangles)`).join('; ')}` : `piece ${piece}: no changes`);

const hits = lines.map(x => ({ x, d: Math.min(Infinity, ...x.at.map(q => Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]))) })).filter(h => h.d <= r).sort((p, q) => p.d - q.d);
if (json) {
  console.log(JSON.stringify({ piece, ring: info ? info.ringOf.get(near) : null, rings: info ? info.rings.length : null, atOrigin: a.atOrigin.has(piece), trunk: piece === a.trunk, vertexDistance: +nd.toFixed(3), changes: hits.map(({ x, d }) => ({ d: +d.toFixed(3), rule: x.rule, piece: x.piece, rings: x.changedRings, triangles: x.tris.length, why: x.why })) }));
  process.exit(0);
}
say(hits.length ? `within ${r}:` : `no changes within ${r} (mesh units; --r to widen)`);
for (const { x, d } of hits) {
  const extra = Object.entries(x).filter(([k]) => !['rule', 'piece', 'rings', 'atOrigin', 'changedRings', 'tris', 'verts', 'at', 'why', 'detail'].includes(k)).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ');
  console.log(`  ${d.toFixed(2)}  ${x.rule}: piece ${x.piece} (${x.rings} rings${x.atOrigin ? ', at origin' : ''}), rings ${x.changedRings ? x.changedRings.join('-') : '-'}, ${x.tris.length} triangles, ${x.verts} vertices${extra ? '; ' + extra : ''}\n        ${x.why}`);
}
