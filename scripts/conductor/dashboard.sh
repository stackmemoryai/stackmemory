#!/usr/bin/env bash
# Conductor Dashboard — real-time terminal monitor for conductor-status.json
# Usage: ./scripts/conductor/dashboard.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS_FILE="$REPO_ROOT/.stackmemory/conductor-status.json"
REFRESH=5

# --- Colors ---
RST='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
WHITE='\033[37m'
BG_RED='\033[41m'
BG_GREEN='\033[42m'
BG_YELLOW='\033[43m'

# --- Helpers ---
fmt_duration() {
  local ms=$1
  local total_sec=$((ms / 1000))
  local h=$((total_sec / 3600))
  local m=$(( (total_sec % 3600) / 60 ))
  local s=$((total_sec % 60))
  if (( h > 0 )); then
    printf "%dh %02dm %02ds" "$h" "$m" "$s"
  elif (( m > 0 )); then
    printf "%dm %02ds" "$m" "$s"
  else
    printf "%ds" "$s"
  fi
}

fmt_tokens() {
  local n=$1
  if (( n >= 1000000 )); then
    printf "%.1fM" "$(echo "scale=1; $n / 1000000" | bc)"
  elif (( n >= 1000 )); then
    printf "%.1fK" "$(echo "scale=1; $n / 1000" | bc)"
  else
    printf "%d" "$n"
  fi
}

# Budget bar: usage_pct [width]
budget_bar() {
  local pct=$1
  local width=${2:-30}
  local filled=$(( pct * width / 100 ))
  (( filled > width )) && filled=$width
  local empty=$(( width - filled ))

  local color="$GREEN"
  (( pct >= 50 )) && color="$YELLOW"
  (( pct >= 75 )) && color="$RED"

  printf "${color}"
  printf '%0.s█' $(seq 1 $filled 2>/dev/null) || true
  printf "${DIM}"
  printf '%0.s░' $(seq 1 $empty 2>/dev/null) || true
  printf "${RST} %3d%%" "$pct"
}

fmt_minutes() {
  local mins=$1
  if (( mins >= 60 )); then
    printf "%dh %dm" $((mins / 60)) $((mins % 60))
  else
    printf "%dm" "$mins"
  fi
}

# --- Main loop ---
trap 'tput cnorm 2>/dev/null; exit 0' INT TERM
tput civis 2>/dev/null  # hide cursor

while true; do
  clear

  # Check file exists
  if [[ ! -f "$STATUS_FILE" ]]; then
    echo -e "${DIM}$(date '+%H:%M:%S')${RST}"
    echo ""
    echo -e "  ${YELLOW}Waiting for conductor to start...${RST}"
    echo -e "  ${DIM}Watching: $STATUS_FILE${RST}"
    echo ""
    echo -e "  ${DIM}Press Ctrl+C to exit${RST}"
    sleep "$REFRESH"
    continue
  fi

  # Parse JSON
  DATA=$(cat "$STATUS_FILE" 2>/dev/null) || { sleep "$REFRESH"; continue; }

  # Validate JSON
  if ! echo "$DATA" | jq empty 2>/dev/null; then
    echo -e "  ${RED}Invalid JSON in status file${RST}"
    sleep "$REFRESH"
    continue
  fi

  # Extract fields
  PID=$(echo "$DATA" | jq -r '.pid // "?"')
  STARTED_AT=$(echo "$DATA" | jq -r '.startedAt // 0')
  UPDATED_AT=$(echo "$DATA" | jq -r '.updatedAt // 0')
  QUEUED=$(echo "$DATA" | jq -r '.queued // 0')
  COMPLETED=$(echo "$DATA" | jq -r '.completed // 0')
  FAILED=$(echo "$DATA" | jq -r '.failed // 0')
  TOTAL_ATTEMPTS=$(echo "$DATA" | jq -r '.totalAttempts // 0')
  MAX_CONCURRENT=$(echo "$DATA" | jq -r '.maxConcurrent // 5')
  STOPPING=$(echo "$DATA" | jq -r '.stopping // false')
  RUNNING_COUNT=$(echo "$DATA" | jq -r '.running | length')

  # Rate limit
  RL_IN_BACKOFF=$(echo "$DATA" | jq -r '.rateLimit.inBackoff // false')
  RL_REMAINING=$(echo "$DATA" | jq -r '.rateLimit.backoffRemainingSec // 0')
  RL_TOTAL_HITS=$(echo "$DATA" | jq -r '.rateLimit.totalHits // 0')

  # Usage
  INPUT_TOKENS=$(echo "$DATA" | jq -r '.usage.inputTokens // 0')
  OUTPUT_TOKENS=$(echo "$DATA" | jq -r '.usage.outputTokens // 0')
  TOTAL_TOKENS=$(echo "$DATA" | jq -r '.usage.totalTokens // 0')
  EST_MESSAGES=$(echo "$DATA" | jq -r '.usage.estimatedMessages // 0')
  TOKENS_PER_MIN=$(echo "$DATA" | jq -r '.usage.tokensPerMin // 0')
  BUDGET_5X=$(echo "$DATA" | jq -r '.usage.budgetPct5x // 0')
  BUDGET_20X=$(echo "$DATA" | jq -r '.usage.budgetPct20x // 0')
  MINS_5X=$(echo "$DATA" | jq -r '.usage.minutesRemaining5x // 0')
  MINS_20X=$(echo "$DATA" | jq -r '.usage.minutesRemaining20x // 0')
  CACHE_HIT=$(echo "$DATA" | jq -r '.usage.cacheHitRate // 0')

  # Compute uptime
  NOW_MS=$(($(date +%s) * 1000))
  UPTIME_MS=$((NOW_MS - STARTED_AT))

  # --- Header ---
  echo -e "${BOLD}${CYAN}  CONDUCTOR DASHBOARD${RST}  ${DIM}$(date '+%H:%M:%S')${RST}"
  echo -e "  ${DIM}─────────────────────────────────────────────────${RST}"

  # PID & Uptime
  UPTIME_STR=$(fmt_duration "$UPTIME_MS")
  if [[ "$STOPPING" == "true" ]]; then
    echo -e "  PID ${WHITE}${PID}${RST}  ${DIM}|${RST}  Uptime ${WHITE}${UPTIME_STR}${RST}  ${DIM}|${RST}  ${BG_RED}${WHITE} STOPPING ${RST}"
  else
    echo -e "  PID ${WHITE}${PID}${RST}  ${DIM}|${RST}  Uptime ${WHITE}${UPTIME_STR}${RST}  ${DIM}|${RST}  ${BG_GREEN}${WHITE} ACTIVE ${RST}"
  fi
  echo ""

  # --- Running Agents ---
  echo -e "  ${BOLD}Running Agents${RST} (${RUNNING_COUNT}/${MAX_CONCURRENT})"
  if (( RUNNING_COUNT == 0 )); then
    echo -e "  ${DIM}  (none)${RST}"
  else
    echo -e "  ${DIM}  %-14s %-10s %-10s %s${RST}" "IDENTIFIER" "STATUS" "ATT" "RUNTIME"
    echo "$DATA" | jq -r '.running[] | "\(.identifier)|\(.status)|\(.attempt)|\(.runtime // 0)"' | while IFS='|' read -r ident status att runtime; do
      rt_str=$(fmt_duration "$runtime")
      case "$status" in
        running)  sc="${GREEN}${status}${RST}" ;;
        error)    sc="${RED}${status}${RST}" ;;
        *)        sc="${YELLOW}${status}${RST}" ;;
      esac
      printf "    %-14s %-20b %-6s %s\n" "$ident" "$sc" "$att" "$rt_str"
    done
  fi
  echo ""

  # --- Stats ---
  echo -e "  ${BOLD}Stats${RST}"
  echo -e "    Completed ${GREEN}${COMPLETED}${RST}  ${DIM}|${RST}  Failed ${RED}${FAILED}${RST}  ${DIM}|${RST}  Queued ${YELLOW}${QUEUED}${RST}  ${DIM}|${RST}  Attempts ${WHITE}${TOTAL_ATTEMPTS}${RST}"
  echo ""

  # --- Rate Limit ---
  echo -e "  ${BOLD}Rate Limit${RST}"
  if [[ "$RL_IN_BACKOFF" == "true" ]]; then
    echo -e "    ${BG_RED}${WHITE} BACKOFF ${RST}  ${RED}${RL_REMAINING}s remaining${RST}  ${DIM}|${RST}  Total hits: ${RL_TOTAL_HITS}"
  else
    echo -e "    ${GREEN}OK${RST}  ${DIM}|${RST}  Total hits: ${RL_TOTAL_HITS}"
  fi
  echo ""

  # --- Usage ---
  echo -e "  ${BOLD}Token Usage${RST}"
  echo -e "    Input  $(fmt_tokens "$INPUT_TOKENS")  ${DIM}|${RST}  Output  $(fmt_tokens "$OUTPUT_TOKENS")  ${DIM}|${RST}  Total  ${WHITE}$(fmt_tokens "$TOTAL_TOKENS")${RST}"
  echo -e "    Rate   ${WHITE}$(fmt_tokens "$TOKENS_PER_MIN")/min${RST}  ${DIM}|${RST}  Messages  ${WHITE}${EST_MESSAGES}${RST}  ${DIM}|${RST}  Cache hit  ${WHITE}${CACHE_HIT}%${RST}"
  echo ""

  # --- Budget Bars ---
  echo -e "  ${BOLD}Budget${RST}"
  printf "    5x   "
  budget_bar "$BUDGET_5X"
  printf "  ${DIM}~$(fmt_minutes "$MINS_5X") left${RST}\n"
  printf "    20x  "
  budget_bar "$BUDGET_20X"
  printf "  ${DIM}~$(fmt_minutes "$MINS_20X") left${RST}\n"
  echo ""

  # --- Footer ---
  echo -e "  ${DIM}Refresh: ${REFRESH}s  |  Ctrl+C to exit${RST}"

  sleep "$REFRESH"
done
