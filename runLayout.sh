#!/data/data/com.termux/files/usr/bin/bash
# Starts layout in the background, restarting it whenever its files change, and opens it.
#   runLayout         start (or say it is already running) and open http://localhost:8080
#   runLayout stop    stop it
#   runLayout log     follow its log
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$HOME/.cache/layout.pid"
LOG="$DIR/layout.log"
URL="http://localhost:${PORT:-8080}"
mkdir -p "$(dirname "$PIDFILE")"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  stop)
    if running; then kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "layout: stopped"; else echo "layout: not running"; fi
    exit 0 ;;
  log)
    exec tail -n 40 -f "$LOG" ;;
  start) ;;
  *) echo "usage: runLayout [start|stop|log]" >&2; exit 2 ;;
esac

if running; then
  echo "layout: already running (pid $(cat "$PIDFILE"))"
else
  : > "$LOG"
  nohup node "$DIR/dev.js" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  echo "layout: started (pid $(cat "$PIDFILE")); log: runLayout log"
fi
termux-open-url "$URL" 2>/dev/null || echo "open $URL"
