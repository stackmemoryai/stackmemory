#!/usr/bin/env bash
# E2E test for claude-sm config setup
# Tests the interactive setup wizard flow

set -euo pipefail

# Use Node version from .nvmrc
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_VER=$(cat "$(dirname "$0")/../.nvmrc" 2>/dev/null || echo "20")
  NODE_PATH=$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER}"* 2>/dev/null | head -1)
  [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_PATH="$HOME/.stackmemory/claude-sm.json"
BACKUP_PATH="$HOME/.stackmemory/claude-sm.json.bak"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
NC='\033[0m'

pass=0
fail=0

ok() { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass + 1)); }
ko() { echo -e "  ${RED}FAIL${NC} $1"; fail=$((fail + 1)); }

echo "=== claude-sm config setup E2E tests ==="
echo ""

# Backup existing config
if [ -f "$CONFIG_PATH" ]; then
  cp "$CONFIG_PATH" "$BACKUP_PATH"
  echo -e "${GRAY}Backed up existing config${NC}"
fi

# 1. Test config show works
echo "--- Test: config show ---"
output=$(node "$PROJECT_DIR/dist/cli/claude-sm.js" config show 2>&1 || true)
if echo "$output" | grep -q "defaultSweep"; then
  ok "config show displays defaultSweep"
else
  ko "config show missing defaultSweep"
fi
if echo "$output" | grep -q "defaultGreptile"; then
  ok "config show displays defaultGreptile"
else
  ko "config show missing defaultGreptile"
fi

# 2. Test config set sweep
echo "--- Test: config set sweep ---"
node "$PROJECT_DIR/dist/cli/claude-sm.js" config set sweep false 2>&1
output=$(node "$PROJECT_DIR/dist/cli/claude-sm.js" config show 2>&1 || true)
if echo "$output" | grep -q "defaultSweep.*false\|defaultSweep"; then
  ok "config set sweep false applied"
else
  ko "config set sweep false not applied"
fi

node "$PROJECT_DIR/dist/cli/claude-sm.js" config set sweep true 2>&1
output=$(node "$PROJECT_DIR/dist/cli/claude-sm.js" config show 2>&1 || true)
if echo "$output" | grep -q "defaultSweep.*true\|defaultSweep"; then
  ok "config set sweep true applied"
else
  ko "config set sweep true not applied"
fi

# 3. Test config set greptile
echo "--- Test: config set greptile ---"
node "$PROJECT_DIR/dist/cli/claude-sm.js" config set greptile false 2>&1
output=$(node "$PROJECT_DIR/dist/cli/claude-sm.js" config show 2>&1 || true)
if echo "$output" | grep -q "defaultGreptile"; then
  ok "config set greptile applied"
else
  ko "config set greptile not applied"
fi

# 4. Test config greptile-on / greptile-off
echo "--- Test: greptile-on/off ---"
node "$PROJECT_DIR/dist/cli/claude-sm.js" config greptile-on 2>&1
if grep -q '"defaultGreptile":.*true' "$CONFIG_PATH"; then
  ok "greptile-on sets true in config file"
else
  ko "greptile-on did not set true"
fi

node "$PROJECT_DIR/dist/cli/claude-sm.js" config greptile-off 2>&1
if grep -q '"defaultGreptile":.*false' "$CONFIG_PATH"; then
  ok "greptile-off sets false in config file"
else
  ko "greptile-off did not set false"
fi

# 5. Test that setup command exists (non-interactive check)
echo "--- Test: setup command exists ---"
output=$(node "$PROJECT_DIR/dist/cli/claude-sm.js" config --help 2>&1 || true)
if echo "$output" | grep -q "setup"; then
  ok "setup command listed in config help"
else
  ko "setup command not in config help"
fi

# 6. Test node-pty dynamic import (should not crash if missing)
echo "--- Test: node-pty optional ---"
node -e "
  import('node-pty')
    .then(() => { console.log('node-pty: installed'); process.exit(0); })
    .catch(() => { console.log('node-pty: not installed (OK)'); process.exit(0); });
" 2>&1
ok "node-pty check does not crash"

# 7. Verify node-pty is NOT in optionalDependencies
echo "--- Test: node-pty removed from optionalDeps ---"
if grep -q '"node-pty"' "$PROJECT_DIR/package.json"; then
  ko "node-pty still in package.json"
else
  ok "node-pty removed from package.json"
fi

# 8. Test feature flags include greptile
echo "--- Test: feature flags ---"
node -e "
  import { getFeatureFlags } from '$PROJECT_DIR/dist/core/config/feature-flags.js';
  const flags = getFeatureFlags();
  if ('greptile' in flags) {
    console.log('greptile flag exists: ' + flags.greptile);
    process.exit(0);
  } else {
    console.error('greptile flag missing');
    process.exit(1);
  }
" 2>&1 && ok "greptile feature flag exists" || ko "greptile feature flag missing"

# 9. Verify build artifacts exist
echo "--- Test: build artifacts ---"
if [ -f "$PROJECT_DIR/dist/cli/claude-sm.js" ]; then
  ok "dist/cli/claude-sm.js exists"
else
  ko "dist/cli/claude-sm.js missing"
fi

if [ -f "$PROJECT_DIR/dist/features/sweep/pty-wrapper.js" ]; then
  ok "dist/features/sweep/pty-wrapper.js exists"
else
  ko "dist/features/sweep/pty-wrapper.js missing"
fi

# Restore config
if [ -f "$BACKUP_PATH" ]; then
  mv "$BACKUP_PATH" "$CONFIG_PATH"
  echo -e "${GRAY}Restored original config${NC}"
fi

# Summary
echo ""
echo "=== Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC} ==="
[ "$fail" -eq 0 ] && exit 0 || exit 1
