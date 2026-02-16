#!/bin/bash
# Chime once when Claude Code needs user input
# Uses macOS system sound

# Prevent multiple chimes by checking if we recently played
CHIME_LOCK="/tmp/claude-chime-lock"
CHIME_COOLDOWN=2  # seconds

if [ -f "$CHIME_LOCK" ]; then
  LAST_CHIME=$(cat "$CHIME_LOCK")
  NOW=$(date +%s)
  DIFF=$((NOW - LAST_CHIME))
  if [ "$DIFF" -lt "$CHIME_COOLDOWN" ]; then
    exit 0  # Skip chime if too recent
  fi
fi

# Record chime time
date +%s > "$CHIME_LOCK"

# Play system sound (Glass is a nice subtle chime)
afplay /System/Library/Sounds/Glass.aiff &
