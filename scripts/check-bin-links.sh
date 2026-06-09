#!/usr/bin/env bash
# check-bin-links.sh — Verify all package.json bin entries are linked
# under the ACTIVE node version(s). Only checks versions currently in PATH,
# not every installed nvm version. Run after npm link or node version changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_JSON="$PKG_DIR/package.json"

if [ ! -f "$PKG_JSON" ]; then
  echo "No package.json found at $PKG_DIR" >&2
  exit 1
fi

BIN_NAMES=$(node -e "const p=require('$PKG_JSON'); Object.keys(p.bin||{}).forEach(n=>console.log(n))")

# Only check active node bin dirs (from PATH, not all installed versions)
NODE_DIRS=()

# Current node's bin dir (always check)
CURRENT_NODE_DIR=$(dirname "$(which node 2>/dev/null || echo "")")
[ -d "$CURRENT_NODE_DIR" ] && NODE_DIRS+=("$CURRENT_NODE_DIR")

# Also check the nvm default alias if it differs
if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/alias/default" ]; then
  DEFAULT_VER=$(cat "$NVM_DIR/alias/default" 2>/dev/null || true)
  if [ -n "$DEFAULT_VER" ]; then
    # Resolve alias to full version
    DEFAULT_DIR=$(ls -d "$NVM_DIR/versions/node/$DEFAULT_VER"*/bin 2>/dev/null | head -1 || true)
    if [ -n "$DEFAULT_DIR" ] && [ -d "$DEFAULT_DIR" ] && [ "$DEFAULT_DIR" != "$CURRENT_NODE_DIR" ]; then
      NODE_DIRS+=("$DEFAULT_DIR")
    fi
  fi
fi

if [ ${#NODE_DIRS[@]} -eq 0 ]; then
  echo "No active node found in PATH"
  exit 0
fi

MISSING=0
LINKED=0

for dir in "${NODE_DIRS[@]}"; do
  # Get a human label
  label="$dir"
  if [[ "$dir" == *nvm* ]]; then
    label=$(echo "$dir" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "$dir")
  fi

  for name in $BIN_NAMES; do
    if [ -f "$dir/$name" ] || [ -L "$dir/$name" ]; then
      LINKED=$((LINKED + 1))
    else
      echo "MISSING: $name not linked in $dir ($label)"
      MISSING=$((MISSING + 1))
    fi
  done
done

echo ""
echo "Checked: ${#NODE_DIRS[@]} node dir(s) | Linked: $LINKED | Missing: $MISSING"

if [ $MISSING -gt 0 ]; then
  echo ""
  echo "Fix: cd $PKG_DIR && npm link"
  exit 1
fi

echo "All bin entries linked."
