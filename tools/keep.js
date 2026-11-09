// What layout works out once and keeps on disk as well as in memory, so a restarted server (dev.js
// restarts it on every layout edit) doesn't redo seconds of unchanged work on its first load (Ken,
// 2026-11-09). keep(name): { get() -> its object (loaded once, {} if none), save() } in
// cache/<name>.json; save writes a moment later (several changes, one write) and again as the
// process exits. Each user keys its own entries by what they depend on (a file's blob, time, size),
// so a stale file is never trusted, only not used.
const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, '..', 'cache');
const kept = new Map();
function keep(name) {
  if (kept.has(name)) return kept.get(name);
  const file = path.join(CACHE, name + '.json');
  let data = null, timer = null, dirty = false;
  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file); // never half a file for another process to read
    } catch (error) {
      console.error(`keep ${name}: ${error.message}`);
    }
  };
  const k = {
    get() {
      if (!data) {
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
      }
      return data;
    },
    save() {
      dirty = true;
      if (!timer) {
        timer = setTimeout(write, 1000);
        if (timer.unref) timer.unref();
      }
    },
    flush: write
  };
  kept.set(name, k);
  return k;
}
process.on('exit', () => { for (const k of kept.values()) k.flush(); });
// dev.js stops the server with a signal; exit cleanly so what was kept is written
for (const sig of ['SIGTERM', 'SIGINT']) {
  if (!process.listenerCount(sig)) process.once(sig, () => process.exit(0));
}

module.exports = { keep };
