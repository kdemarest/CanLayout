// What one server request spent its time on, for layout.log. The server is synchronous, so a
// request's work runs start to finish and one module-level record is enough.
//   begin()            starts a request's record
//   time(label, fn)    runs fn, adding its own time to label: a step timed inside it counts as
//                      that step's, not this one's, so labels nest; time nothing covers is "other"
//   count(label, n)    adds n to a count (meshes fetched, textures converted, ...)
//   report()           "1.8 s: docs 0.7 s, prefabs 0.4 s, ...; prepares 2, meshes fetched 3"
let current = null;

function begin() {
  current = { start: Date.now(), ms: {}, counts: {}, inner: [] };
}
function time(label, fn) {
  if (!current) return fn();
  const start = Date.now();
  current.inner.push(0); // the time of steps timed inside this one
  try {
    return fn();
  } finally {
    const took = Date.now() - start;
    const inner = current.inner.pop();
    current.ms[label] = (current.ms[label] || 0) + took - inner;
    if (current.inner.length) current.inner[current.inner.length - 1] += took;
  }
}
function count(label, n = 1) {
  if (current && n) current.counts[label] = (current.counts[label] || 0) + n;
}
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
function report() {
  if (!current) return '';
  const total = Date.now() - current.start;
  const other = total - Object.values(current.ms).reduce((a, b) => a + b, 0);
  const steps = Object.entries({ ...current.ms, other }).filter(([, ms]) => ms >= 50).sort((a, b) => b[1] - a[1]).map(([label, ms]) => `${label} ${seconds(ms)}`);
  const counts = Object.entries(current.counts).map(([label, n]) => `${label} ${n}`);
  return `${seconds(total)}${steps.length ? `: ${steps.join(', ')}` : ''}${counts.length ? `; ${counts.join(', ')}` : ''}`;
}

module.exports = { begin, time, count, report };
