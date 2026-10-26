// What one server request spent its time on, for layout.log. The server is synchronous, so a
// request's work runs start to finish and one module-level record is enough.
//   begin()            starts a request's record
//   time(label, fn)    runs fn, adding its time to label (labels don't nest: time leaf steps)
//   count(label, n)    adds n to a count (meshes fetched, textures converted, ...)
//   report()           "1.8 s: docs 0.7 s, prefabs 0.4 s, ...; prepares 2, meshes fetched 3"
let current = null;

function begin() {
  current = { start: Date.now(), ms: {}, counts: {} };
}
function time(label, fn) {
  if (!current) return fn();
  const start = Date.now();
  try {
    return fn();
  } finally {
    current.ms[label] = (current.ms[label] || 0) + Date.now() - start;
  }
}
function count(label, n = 1) {
  if (current && n) current.counts[label] = (current.counts[label] || 0) + n;
}
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
function report() {
  if (!current) return '';
  const total = Date.now() - current.start;
  const steps = Object.entries(current.ms).filter(([, ms]) => ms >= 50).sort((a, b) => b[1] - a[1]).map(([label, ms]) => `${label} ${seconds(ms)}`);
  const counts = Object.entries(current.counts).map(([label, n]) => `${label} ${n}`);
  return `${seconds(total)}${steps.length ? `: ${steps.join(', ')}` : ''}${counts.length ? `; ${counts.join(', ')}` : ''}`;
}

module.exports = { begin, time, count, report };
