#!/bin/bash
# desire-path-hook.sh — PostToolUse hook for Claude Code
#
# Captures tool name + sanitized first arg to the action stream.
# No data/content captured — just the tool:target pair for pattern detection.
#
# Install in Claude Code settings.json:
#   { "event": "PostToolUse", "command": "~/.stackmemory/bin/desire-path-hook.sh" }
#
# Or in .claude/settings.local.json per-project.
#
# Opt out: STACKMEMORY_DESIRE_PATHS=0

# Quick exit if opted out
[ "$STACKMEMORY_DESIRE_PATHS" = "0" ] && exit 0
[ "$STACKMEMORY_DESIRE_PATHS" = "false" ] && exit 0

SM_DIR="${HOME}/.stackmemory"
DP_DIR="${SM_DIR}/desire-paths"
STREAM_FILE="${DP_DIR}/action-stream.jsonl"
MAX_SIZE=10485760  # 10MB

# Read hook input from stdin (Claude Code passes JSON)
INPUT=$(cat)

# Extract tool name and first arg from hook input
TOOL_NAME=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf-8'));
  console.log(d.tool_name || d.toolName || 'unknown');
" 2>/dev/null || echo "unknown")

FIRST_ARG=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf-8'));
  const args = d.tool_input || d.input || {};
  // Get the most meaningful arg (file_path, command, pattern, etc.)
  const key = Object.keys(args).find(k =>
    ['file_path','command','pattern','path','query','skill_path','url'].includes(k)
  ) || Object.keys(args)[0];
  const val = key ? String(args[key] || '').slice(0, 100) : '';
  console.log(val);
" 2>/dev/null || echo "")

DURATION=$(echo "$INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf-8'));
  console.log(d.duration_ms || d.duration || 0);
" 2>/dev/null || echo "0")

# Session ID from env or generate
SESSION_ID="${STACKMEMORY_SESSION:-${CLAUDE_SESSION_ID:-$(date +%s)}}"

# Ensure directory exists
mkdir -p "$DP_DIR" 2>/dev/null

# Rotate if too large
if [ -f "$STREAM_FILE" ]; then
  FILE_SIZE=$(stat -f%z "$STREAM_FILE" 2>/dev/null || stat -c%s "$STREAM_FILE" 2>/dev/null || echo 0)
  if [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
    mv "$STREAM_FILE" "${STREAM_FILE}.$(date +%s).bak" 2>/dev/null
  fi
fi

# Append entry (no content/data — just tool + target pattern)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"ts\":\"${TIMESTAMP}\",\"sid\":\"${SESSION_ID}\",\"tool\":\"${TOOL_NAME}\",\"target\":\"${FIRST_ARG}\",\"dur\":${DURATION}}" >> "$STREAM_FILE"
