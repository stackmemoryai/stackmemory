#!/usr/bin/env bash
#
# StackMemory Portal — VPS setup script.
#
# Provisions a fresh Debian/Ubuntu box (e.g. a Hetzner CX22, ~€4.5/mo) to run
# Claude Code 24/7 inside tmux, reachable from a browser over Tailscale.
#
#   curl -fsSL https://raw.githubusercontent.com/stackmemoryai/stackmemory/main/scripts/portal/setup.sh | bash
#
# Idempotent: safe to re-run. Re-run after editing PORTAL_* env vars below.
set -euo pipefail

PORTAL_USER="${PORTAL_USER:-$(whoami)}"
PORTAL_PORT="${PORTAL_PORT:-7799}"
PORTAL_SESSION="${PORTAL_SESSION:-claude}"
PORTAL_WORKDIR="${PORTAL_WORKDIR:-$HOME/work}"
NODE_MAJOR="${NODE_MAJOR:-20}"

log() { printf '\033[36m[portal-setup]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; fi
fi

log "1/6 Installing base packages (tmux, git, curl, build tools)…"
if have apt-get; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y tmux git curl ca-certificates build-essential python3
fi

log "2/6 Installing Node.js ${NODE_MAJOR}.x…"
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
log "    node $(node -v) / npm $(npm -v)"

log "3/6 Installing Claude Code + StackMemory…"
have claude || $SUDO npm install -g @anthropic-ai/claude-code
$SUDO npm install -g @stackmemoryai/stackmemory
# node-pty powers the browser terminal; build tools above let it compile.
$SUDO npm install -g node-pty || log "    (node-pty global install failed — install it in the portal's working dir)"

log "4/6 Installing Tailscale…"
if ! have tailscale; then
  curl -fsSL https://tailscale.com/install.sh | $SUDO sh
fi
log "    Run 'sudo tailscale up' to join your tailnet (prints an auth URL)."

log "5/6 Preparing working directory at ${PORTAL_WORKDIR}…"
mkdir -p "$PORTAL_WORKDIR"

log "6/6 Next steps:"
cat <<EOF

  StackMemory Portal is installed. To finish:

  1. Join Tailscale:        sudo tailscale up
  2. Authenticate Claude:   tmux new -s ${PORTAL_SESSION} 'claude'   # log in (max plan), then detach: Ctrl-b d
  3. Start the portal:      stackmemory portal start --port ${PORTAL_PORT} --session ${PORTAL_SESSION} --cwd ${PORTAL_WORKDIR}
  4. Open the printed http://100.x.y.z:${PORTAL_PORT}/?token=... URL from any device on your tailnet.

  For 24/7 operation, install the systemd service:
    sudo cp scripts/portal/stackmemory-portal.service /etc/systemd/system/
    sudo systemctl enable --now stackmemory-portal

EOF
