#!/usr/bin/env bash

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if [ "${STACKMEMORY_VERIFY_SKIP:-0}" = "1" ]; then
  echo "[verify-staged] skipped because STACKMEMORY_VERIFY_SKIP=1"
  exit 0
fi

CHANGED_FILES="${STACKMEMORY_VERIFY_FILES:-}"
if [ -z "$CHANGED_FILES" ]; then
  CHANGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "[verify-staged] no staged files"
  exit 0
fi

matching_paths() {
  printf '%s\n' "$CHANGED_FILES" | grep -E "$1" || true
}

has_path() {
  printf '%s\n' "$CHANGED_FILES" | grep -E "$1" >/dev/null
}

run_shell() {
  echo "[verify-staged] $*"
  bash -lc "$*"
}

test_files="$(matching_paths '(^src/|^scripts/|^packages/).*((__tests__/.*)|(\.|-)test)\.ts$')"
if [ -n "$test_files" ]; then
  run_shell "npx vitest run $(printf '%s\n' "$test_files" | xargs) --reporter=dot"
fi

if has_path '^(src/|scripts/|packages/|templates/|Shadowbroker/|package\.json$|package-lock\.json$|tsconfig|esbuild\.config\.js$)'; then
  run_shell 'npm run build'
fi

echo "[verify-staged] passed"
