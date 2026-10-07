#!/usr/bin/env bash
# Starts Fig if it isn't running, or restarts it if it is frozen. Safe to run as often as you like.
#
# Hook it up so it runs on boot AND every minute, whichever your machine/sandbox supports:
#   cron:      * * * * * /path/to/claudes_fig/scripts/ensure-running.sh
#              @reboot   /path/to/claudes_fig/scripts/ensure-running.sh
#   boot hook: call this script from the sandbox's startup command
#   systemd:   see deploy/fig.service (preferred on a normal Linux box)
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
NOTE() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [ensure-running] $*" >> "$LOGS/crash.log"; }

# Only one ensure-running at a time.
exec 9>"$LOGS/ensure-running.lock"
if command -v flock >/dev/null 2>&1; then flock -n 9 || exit 0; fi

# Alive and not a zombie (a killed process can linger as a zombie if nothing reaps it).
alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != "Z" ]; fi
}

NODE="${NODE:-$(command -v node)}"
if [ -z "$NODE" ]; then NOTE "node not found on PATH"; exit 1; fi

sup_pid="$(cat "$LOGS/supervisor.pid" 2>/dev/null || true)"
beat_ms="$(cut -d' ' -f1 "$LOGS/heartbeat" 2>/dev/null || echo 0)"
now_ms="$(( $(date +%s) * 1000 ))"
age_s="$(( (now_ms - ${beat_ms:-0}) / 1000 ))"

if alive "$sup_pid"; then
  # Supervisor alive. Healthy if Fig wrote a heartbeat in the last 3 minutes.
  if [ "$age_s" -lt 180 ]; then exit 0; fi
  # Give a fresh start a moment to log in before calling it dead.
  start_s="$(stat -c %Y "$LOGS/supervisor.pid" 2>/dev/null || echo 0)"
  if [ $(( $(date +%s) - start_s )) -lt 120 ]; then exit 0; fi
  NOTE "supervisor $sup_pid alive but no heartbeat for ${age_s}s; restarting everything"
  kill -TERM "$sup_pid" 2>/dev/null; sleep 5; kill -KILL "$sup_pid" 2>/dev/null
  fig_pid="$(cat "$LOGS/fig.pid" 2>/dev/null || true)"
  [ -n "$fig_pid" ] && kill -KILL "$fig_pid" 2>/dev/null
  rm -f "$LOGS/supervisor.pid" "$LOGS/fig.pid"
else
  # No supervisor. Make sure no orphaned Fig is still holding the token.
  fig_pid="$(cat "$LOGS/fig.pid" 2>/dev/null || true)"
  if alive "$fig_pid"; then
    NOTE "orphan Fig pid $fig_pid without supervisor; stopping it"
    kill -TERM "$fig_pid" 2>/dev/null; sleep 3; kill -KILL "$fig_pid" 2>/dev/null
  fi
  rm -f "$LOGS/supervisor.pid" "$LOGS/fig.pid"
  NOTE "Fig was not running (last heartbeat ${age_s}s ago); starting it"
fi

if command -v setsid >/dev/null 2>&1; then
  setsid nohup "$NODE" "$ROOT/scripts/supervise.js" >> "$LOGS/supervise.out" 2>&1 < /dev/null 9>&- &
else
  nohup "$NODE" "$ROOT/scripts/supervise.js" >> "$LOGS/supervise.out" 2>&1 < /dev/null 9>&- &
fi
exit 0
