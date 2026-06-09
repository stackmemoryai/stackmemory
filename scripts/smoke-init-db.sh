#!/usr/bin/env bash
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

# Smoke test: verify wrappers auto-init StackMemory and create context.db
#
# Steps:
#  - Create a fresh git repo
#  - Prepend a PATH shim so "stackmemory" resolves to local dist CLI
#  - Run each wrapper with flags to avoid external tool execution
#  - Assert .stackmemory/context.db is created (DB enabled)
#
# Notes:
#  - Requires that better-sqlite3 can load on this system.
#  - Unsets env that disables DB in CLI (STACKMEMORY_TEST_SKIP_DB).

WS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_CLI="$WS_ROOT/dist/src/cli/index.js"
if [[ ! -f "$DIST_CLI" ]]; then
  echo "dist CLI not found at $DIST_CLI; run: npm run build" >&2
  exit 1
fi

TEST_ROOT="$WS_ROOT/tmp/smoke-db-$(date +%s)"
SM_BIN_DIR="$TEST_ROOT/bin"
mkdir -p "$SM_BIN_DIR" "$TEST_ROOT"

# PATH shim for stackmemory -> local dist CLI
cat > "$SM_BIN_DIR/stackmemory" <<EOS
#!/usr/bin/env bash
exec node "$DIST_CLI" "$@"
EOS
chmod +x "$SM_BIN_DIR/stackmemory"

# Fresh git repo
mkdir -p "$TEST_ROOT/repo"
cd "$TEST_ROOT/repo"
git init -q
echo "# Smoke Test Repo" > README.md
git add README.md
git -c user.email=test@example.com -c user.name=test commit -q -m "init"

# PATH and env (ensure DB path is taken)
export PATH="$SM_BIN_DIR:$PATH"
unset STACKMEMORY_TEST_SKIP_DB || true
unset VITEST || true
unset NODE_ENV || true

failures=0

run_case() {
  local name="$1"; shift
  local cmd=("$@")
  rm -rf .stackmemory
  set +e
  ( "${cmd[@]}" ) >/dev/null 2>&1
  local rc=$?
  set -e

# Use Node version from .nvmrc
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_VER=$(cat "$(git rev-parse --show-toplevel)/.nvmrc" 2>/dev/null || echo "20")
  NODE_PATH=$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER}"* 2>/dev/null | head -1)
  [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi
  if [[ -f .stackmemory/context.db ]]; then
    echo "$name: DB_OK (rc=$rc)"
  else
    echo "$name: DB_MISSING (rc=$rc)"; failures=$((failures+1))
  fi
}

# Run wrappers to trigger auto-init
run_case codex-sm    "$WS_ROOT/bin/codex-sm"    --no-context --no-trace --codex-bin /bin/false
run_case opencode-sm "$WS_ROOT/bin/opencode-sm" --no-context --no-trace --opencode-bin /bin/false
run_case claude-sm   "$WS_ROOT/bin/claude-sm"   --no-context --no-trace --claude-bin /bin/false

if [[ $failures -eq 0 ]]; then
  echo "ALL_DB_OK"
  exit 0
else
  echo "FAILURES=$failures"
  exit 1
fi


