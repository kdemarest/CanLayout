// Development runner: runs server.js and restarts it whenever a layout source file changes;
// the page notices the new server and reloads itself (see /events in server.js).
// Polls file times rather than using fs.watch, which is unreliable on Android shared storage.
// Started in the background by runLayout.sh.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WATCHED = ['server.js', 'tools', 'web'];
const POLL_MS = 600;

function files() {
  const out = [];
  const walk = p => {
    const s = fs.statSync(p);
    if (s.isDirectory()) fs.readdirSync(p).forEach(n => walk(path.join(p, n)));
    else if (/\.(js|html|css|json)$/.test(p)) out.push([p, s.mtimeMs]);
  };
  for (const w of WATCHED) walk(path.join(ROOT, w));
  return out;
}
const signature = () => files().map(([p, t]) => `${p}:${t}`).join('\n');

let child = null;
let restarting = false;
function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { stdio: 'inherit' });
  child.on('exit', code => {
    child = null;
    if (restarting) {
      restarting = false;
      start();
    } else {
      console.log(`layout: server exited (${code}); restarting in 2 s`);
      setTimeout(start, 2000);
    }
  });
}
function restart(reason) {
  console.log(`layout: ${reason}; restarting`);
  if (child) {
    restarting = true;
    child.kill();
  } else {
    start();
  }
}

let last = signature();
setInterval(() => {
  let now;
  try {
    now = signature();
  } catch (error) {
    return; // a file vanished mid-scan (an editor saving); try again next tick
  }
  if (now !== last) {
    last = now;
    restart('files changed');
  }
}, POLL_MS);

const stop = () => {
  restarting = true; // keep the exit handler from restarting it
  if (child) child.kill();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
start();
