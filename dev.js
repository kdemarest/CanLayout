// Development runner: runs server.js and restarts it whenever a layout source file changes;
// the page notices the new server and reloads itself (see /events in server.js).
// Polls file times rather than using fs.watch, which is unreliable on Android shared storage.
// It restarts once changes have stopped: when the files have stayed the same for QUIET_MS, so
// several edits in a row (a tool writing file after file) bring one restart, after the last
// (Ken, 2026-10-29: a restart between two quick edits ran the first edit's code).
// Started in the background by runLayout.sh.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WATCHED = ['server.js', 'tools', 'web', 'materials', 'pfx', 'scripts', 'prefabs'];
const POLL_MS = 600;
const QUIET_MS = 1500;

function files() {
  const out = [];
  const walk = p => {
    const s = fs.statSync(p);
    if (s.isDirectory()) fs.readdirSync(p).forEach(n => walk(path.join(p, n)));
    else if (/\.(js|html|css|json)$/.test(p) || /prefabs[\\/][^\\/]+\.md$/.test(p)) out.push([p, s.mtimeMs, s.size]); // layout prefabs too
  };
  for (const w of WATCHED) walk(path.join(ROOT, w));
  return out;
}
const signature = () => files().map(([p, t, n]) => `${p}:${t}:${n}`).join('\n');

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

let running = signature(); // the files the server last started with
let last = running, changedAt = 0;
setInterval(() => {
  let now;
  try {
    now = signature();
  } catch (error) {
    return; // a file vanished mid-scan (an editor saving); try again next tick
  }
  if (now !== last) {
    last = now;
    changedAt = Date.now(); // still changing: wait for quiet
    return;
  }
  if (now !== running && Date.now() - changedAt >= QUIET_MS) {
    running = now;
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
