#!/usr/bin/env bash
# session-rescue.sh — Auto-capture stackmemory handoff on session close
# Runs as a Stop hook. Silent on failure. Skips non-stackmemory projects.

set -euo pipefail

# Only run in stackmemory-initialized projects
[ -d ".stackmemory" ] || exit 0

# Require stackmemory CLI
command -v stackmemory >/dev/null 2>&1 || exit 0

# Capture without committing, compact format, 10s timeout
timeout 10 stackmemory capture --no-commit --format compact \
  -m "auto-rescue on session close" >/dev/null 2>&1 || true
