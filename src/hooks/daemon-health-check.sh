#!/bin/bash
# daemon-health-check.sh — SessionStart hook for Claude Code / Codex
#
# Checks if the StackMemory daemon is alive. If not, restarts it.
# Install as a Claude Code SessionStart hook in settings.json:
#   { "event": "SessionStart", "command": "~/.stackmemory/bin/daemon-health-check.sh" }
#
# Self-healing: runs on every new session. If daemon is down, brings it back.

SM_DIR="${HOME}/.stackmemory"
PID_FILE="${SM_DIR}/daemon/daemon.pid"
STATUS_FILE="${SM_DIR}/daemon/daemon.status"

# Check if PID file exists and process is alive
check_daemon() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null)
  if [ -z "$pid" ]; then
    return 1
  fi

  # Check if process is actually running
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  else
    return 1
  fi
}

restart_daemon() {
  # Clean stale PID
  rm -f "$PID_FILE" 2>/dev/null

  # Update status to reflect it's down
  if [ -f "$STATUS_FILE" ]; then
    # Mark as not running (best-effort JSON update)
    local tmp
    tmp=$(mktemp)
    node -e "
      const fs = require('fs');
      try {
        const s = JSON.parse(fs.readFileSync('${STATUS_FILE}', 'utf-8'));
        s.running = false;
        s.errors = (s.errors || []).concat('daemon died, restarted by health check at ' + new Date().toISOString());
        fs.writeFileSync('${tmp}', JSON.stringify(s, null, 2));
      } catch { process.exit(0); }
    " 2>/dev/null && mv "$tmp" "$STATUS_FILE" 2>/dev/null
  fi

  # Try stackmemory CLI first, fall back to direct daemon start
  if command -v stackmemory &>/dev/null; then
    stackmemory daemon start &>/dev/null &
  elif [ -f "${SM_DIR}/bin/stackmemory" ]; then
    "${SM_DIR}/bin/stackmemory" daemon start &>/dev/null &
  else
    # Direct node invocation as last resort
    local daemon_script
    daemon_script=$(find "${HOME}/.nvm" "/opt/homebrew/lib" "/usr/local/lib" -path "*/stackmemory/dist/src/daemon/unified-daemon.js" 2>/dev/null | head -1)
    if [ -n "$daemon_script" ]; then
      node "$daemon_script" &>/dev/null &
    fi
  fi
}

# Main
if check_daemon; then
  # Daemon alive — emit brief status for hook output
  echo '{"hookSpecificOutput":{"daemonAlive":true,"pid":'$(cat "$PID_FILE")'}}'
else
  restart_daemon
  # Wait briefly for startup
  sleep 1
  if check_daemon; then
    echo '{"hookSpecificOutput":{"daemonAlive":true,"restarted":true,"pid":'$(cat "$PID_FILE" 2>/dev/null || echo 0)'}}'
  else
    echo '{"hookSpecificOutput":{"daemonAlive":false,"restartAttempted":true}}'
  fi
fi
