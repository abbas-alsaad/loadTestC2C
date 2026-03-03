#!/usr/bin/env bash
#
# Progressive Load Test Runner
#
# Runs k6 scenarios in sequence with increasing load stages.
# Results are saved to load-tests/results/ with timestamps.
#
# Usage:
#   ./load-tests/run.sh                          # Run all scenarios (smoke)
#   ./load-tests/run.sh --scenario presence-hub   # Single scenario
#   ./load-tests/run.sh --stage medium            # Specific stage
#   ./load-tests/run.sh --progressive             # Ramp through all stages
#   ./load-tests/run.sh --url https://custom.url  # Custom target
#
# Prerequisites:
#   brew install k6
#   psql -h <host> -U <user> -d <db> -f load-tests/scripts/seed-test-data.sql
#

set -euo pipefail

# ─── Defaults ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
TARGET_URL="${TARGET_URL:-https://c2c-uat.gini.iq}"
STAGE="smoke"
SCENARIO=""
PROGRESSIVE=false
ITEM_ID="${ITEM_ID:-}"
SELLER_ID="${SELLER_ID:-}"
SELLER_USER_ID="${SELLER_USER_ID:-}"
SELLER_USERNAME="${SELLER_USERNAME:-}"
BUYER_USER_ID="${BUYER_USER_ID:-}"
BUYER_USERNAME="${BUYER_USERNAME:-}"
EXTRA_ARGS=""

# ─── Parse arguments ──────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario|-s)
      SCENARIO="$2"
      shift 2
      ;;
    --stage|-t)
      STAGE="$2"
      shift 2
      ;;
    --url|-u)
      TARGET_URL="$2"
      shift 2
      ;;
    --progressive|-p)
      PROGRESSIVE=true
      shift
      ;;
    --item-id)
      ITEM_ID="$2"
      shift 2
      ;;
    --seller-id)
      SELLER_ID="$2"
      shift 2
      ;;
    --seller-user-id)
      SELLER_USER_ID="$2"
      shift 2
      ;;
    --seller-username)
      SELLER_USERNAME="$2"
      shift 2
      ;;
    --buyer-user-id)
      BUYER_USER_ID="$2"
      shift 2
      ;;
    --buyer-username)
      BUYER_USERNAME="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --scenario, -s NAME    Run specific scenario (presence-hub, message-hub,"
      echo "                         notification-broadcast, full-flow, presence-stress, chat-offers)"
      echo "  --stage, -t STAGE      Load stage (smoke, low, medium, high, breakpoint, extreme)"
      echo "  --url, -u URL          Target URL (default: https://c2c-uat.gini.iq)"
      echo "  --progressive, -p      Run all stages progressively (smoke → low → medium → high)"
      echo "  --item-id GUID         Item ID for message-hub / chat-offers scenario"
      echo "  --seller-id GUID       Seller ID for full-flow scenario"
      echo "  --seller-user-id GUID  Seller AppUserId for chat-offers scenario"
      echo "  --seller-username STR  Seller username for chat-offers scenario"
      echo "  --buyer-user-id GUID   Buyer AppUserId for chat-offers scenario"
      echo "  --buyer-username STR   Buyer username for chat-offers scenario"
      echo "  --help, -h             Show this help"
      exit 0
      ;;
    *)
      EXTRA_ARGS="${EXTRA_ARGS} $1"
      shift
      ;;
  esac
done

# ─── Verify k6 is installed ───────────────────────────────────
if ! command -v k6 &>/dev/null; then
  echo "❌ k6 is not installed. Install with: brew install k6"
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════╗"
echo "║            C2C SignalR Load Test Suite                   ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Target:  ${TARGET_URL}"
echo "║  Stage:   ${STAGE}"
echo "║  Time:    $(date '+%Y-%m-%d %H:%M:%S')"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Create results directory ──────────────────────────────────
mkdir -p "${RESULTS_DIR}"
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')

# ─── Build env args ───────────────────────────────────────────
build_env_args() {
  local stage="$1"
  local args="--env TARGET_URL=${TARGET_URL} --env STAGE=${stage}"

  if [[ -n "${ITEM_ID}" ]]; then
    args="${args} --env ITEM_ID=${ITEM_ID}"
  fi
  if [[ -n "${SELLER_ID}" ]]; then
    args="${args} --env SELLER_ID=${SELLER_ID}"
  fi
  if [[ -n "${SELLER_USER_ID}" ]]; then
    args="${args} --env SELLER_USER_ID=${SELLER_USER_ID}"
  fi
  if [[ -n "${SELLER_USERNAME}" ]]; then
    args="${args} --env SELLER_USERNAME=${SELLER_USERNAME}"
  fi
  if [[ -n "${BUYER_USER_ID}" ]]; then
    args="${args} --env BUYER_USER_ID=${BUYER_USER_ID}"
  fi
  if [[ -n "${BUYER_USERNAME}" ]]; then
    args="${args} --env BUYER_USERNAME=${BUYER_USERNAME}"
  fi

  echo "${args}"
}

# ─── Run a single scenario ────────────────────────────────────
run_scenario() {
  local name="$1"
  local stage="$2"
  local script="${SCRIPT_DIR}/scenarios/${name}.js"
  local k6_summary="${RESULTS_DIR}/${name}_${stage}_${TIMESTAMP}_k6native.json"
  local raw_file="${RESULTS_DIR}/${name}_${stage}_${TIMESTAMP}_raw.json"
  local html_report="${RESULTS_DIR}/${name}_${stage}_report.html"
  local json_report="${RESULTS_DIR}/${name}_${stage}_report.json"

  if [[ ! -f "${script}" ]]; then
    echo "⚠️  Scenario not found: ${script}"
    return 1
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ Running: ${name} (stage: ${stage})"
  echo "  Script:  ${script}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  local env_args
  env_args=$(build_env_args "${stage}")

  # Run k6 from the load-tests directory so handleSummary's
  # relative paths (./results/) resolve correctly.
  # shellcheck disable=SC2086
  (cd "${SCRIPT_DIR}" && \
    k6 run ${env_args} \
      --summary-export="${k6_summary}" \
      --out json="${raw_file}" \
      ${EXTRA_ARGS} \
      "${script}") || true

  echo ""
  echo "✅ ${name} (${stage}) complete."
  echo "   📊 HTML Report:  ${html_report}"
  echo "   📋 JSON Report:  ${json_report}"
  echo "   📦 k6 Native:    ${k6_summary}"
  echo "   📝 Raw Data:     ${raw_file}"
  echo ""
}

# ─── Scenario list ─────────────────────────────────────────────
ALL_SCENARIOS=("presence-hub" "notification-broadcast" "message-hub" "full-flow" "presence-stress" "chat-offers")

# Core scenarios (run first, always)
CORE_SCENARIOS=("presence-hub" "notification-broadcast")

# ─── Execute ───────────────────────────────────────────────────

if [[ "${PROGRESSIVE}" == true ]]; then
  # Progressive mode: ramp through stages
  RAMP_STAGES=("smoke" "low" "medium" "high")

  echo "🔄 Progressive mode: will run stages: ${RAMP_STAGES[*]}"
  echo ""

  for ramp_stage in "${RAMP_STAGES[@]}"; do
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║  Stage: ${ramp_stage}"
    echo "╚══════════════════════════════════════════════════════╝"

    if [[ -n "${SCENARIO}" ]]; then
      run_scenario "${SCENARIO}" "${ramp_stage}"
    else
      for scenario in "${CORE_SCENARIOS[@]}"; do
        run_scenario "${scenario}" "${ramp_stage}"
      done
    fi

    # Cool-down between stages
    if [[ "${ramp_stage}" != "${RAMP_STAGES[-1]}" ]]; then
      echo "⏸  Cool-down: 30 seconds before next stage..."
      sleep 30
    fi
  done

elif [[ -n "${SCENARIO}" ]]; then
  # Single scenario mode
  run_scenario "${SCENARIO}" "${STAGE}"

else
  # Run all core scenarios at the specified stage
  for scenario in "${CORE_SCENARIOS[@]}"; do
    run_scenario "${scenario}" "${STAGE}"
  done

  echo ""
  echo "ℹ️  To run message-hub, full-flow, or chat-offers, first seed test data:"
  echo "   psql -h <host> -U <user> -d <db> -f load-tests/scripts/seed-test-data.sql"
  echo ""
  echo "   Then run:"
  echo "   $0 --scenario message-hub"
  echo "   $0 --scenario full-flow"
  echo "   $0 --scenario chat-offers"
  echo "   $0 --scenario presence-stress"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  All tests complete!                                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Results saved to: ${RESULTS_DIR}/"
echo "║                                                          ║"
echo "║  For each scenario you'll find:                          ║"
echo "║    *_report.html   — Professional HTML report (open in   ║"
echo "║                      browser for best experience)        ║"
echo "║    *_report.json   — Machine-readable summary            ║"
echo "║    *_k6native.json — Full k6 native summary              ║"
echo "║    *_raw.json      — Raw metrics time-series data        ║"
echo "╚══════════════════════════════════════════════════════════╝"
