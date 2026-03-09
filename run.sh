#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# C2C SignalR Load Test — Runner Script
# ═══════════════════════════════════════════════════════════════════════════════
# Usage:
#   ./run.sh --scenario smoke
#   ./run.sh --scenario ramp --base-url wss://my-server.com
#   ./run.sh --scenario all
#
# Required env vars:
#   C2C_TOKEN_KEY   — The symmetric JWT signing key (same as .NET TokenKey)
#
# Optional env vars:
#   C2C_BASE_URL    — Target server (default: wss://ws-c2c-api-uat.gini.iq)
#   C2C_USER_PREFIX — Username prefix (default: loadtest_user_)
#   C2C_SEED_FILE   — Path to test-items.json (default: ./seed/test-items.json)
#   C2C_RESULTS_DIR — Report output dir (default: ./results)
#   C2C_VERBOSE     — Show per-user logs (default: false)
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Parse arguments ──────────────────────────────────────────────────────────
SCENARIO=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --scenario|-s)
      SCENARIO="$2"
      shift 2
      ;;
    --base-url)
      export C2C_BASE_URL="$2"
      shift 2
      ;;
    --verbose)
      export C2C_VERBOSE="true"
      shift
      ;;
    --help|-h)
      echo ""
      echo "Usage: ./run.sh --scenario <name>"
      echo ""
      echo "Scenarios:"
      echo "  smoke        Quick validation (10 users, ~30s)"
      echo "  ramp         Connection scalability (0→5000, ~17min)"
      echo "  heartbeat    Sustained presence (2000 users, 30min)"
      echo "  chat         Message throughput (500 pairs, ~15min)"
      echo "  notification Notification fanout (2000 users, 10min)"
      echo "  mixed        Production simulation (5000 users, 20min)"
      echo "  breakpoint   Find ceiling (incremental until failure)"
      echo "  all          Run all scenarios sequentially"
      echo ""
      echo "Required: C2C_TOKEN_KEY environment variable"
      echo ""
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      exit 1
      ;;
  esac
done

if [[ -z "$SCENARIO" ]]; then
  echo -e "${RED}Error: --scenario is required${NC}"
  echo "Run: ./run.sh --help"
  exit 1
fi

# ── Pre-checks ───────────────────────────────────────────────────────────────
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  C2C SignalR Load Test Runner${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"

# Check Node.js version
if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is not installed (requires >= 18.0.0)${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
  echo -e "${RED}Error: Node.js >= 18.0.0 required (found: $(node -v))${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"

# Check TOKEN_KEY
if [[ -z "${C2C_TOKEN_KEY:-}" ]]; then
  echo -e "${RED}  ✗ C2C_TOKEN_KEY is not set${NC}"
  echo ""
  echo "  Set it with: export C2C_TOKEN_KEY='your-secret-key'"
  echo "  This must match the TokenKey in your .NET backend's appsettings."
  exit 1
fi
echo -e "${GREEN}  ✓ C2C_TOKEN_KEY is set${NC}"

# Install dependencies if needed
if [[ ! -d "node_modules" ]]; then
  echo -e "${YELLOW}  ⏳ Installing dependencies...${NC}"
  npm install --silent
fi
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# Target URL
echo -e "${GREEN}  ✓ Target: ${C2C_BASE_URL:-wss://ws-c2c-api-uat.gini.iq}${NC}"
echo ""

# ── Map scenario name to file ────────────────────────────────────────────────
run_scenario() {
  local name=$1
  local file=""

  case $name in
    smoke)        file="scenarios/01-smoke.js" ;;
    ramp)         file="scenarios/02-presence-ramp.js" ;;
    heartbeat)    file="scenarios/03-presence-heartbeat.js" ;;
    chat)         file="scenarios/04-chat-throughput.js" ;;
    notification) file="scenarios/05-notification-fanout.js" ;;
    mixed)        file="scenarios/06-mixed-realistic.js" ;;
    breakpoint)   file="scenarios/07-breakpoint.js" ;;
    *)
      echo -e "${RED}Unknown scenario: $name${NC}"
      echo "Available: smoke, ramp, heartbeat, chat, notification, mixed, breakpoint, all"
      exit 1
      ;;
  esac

  echo -e "${CYAN}Running: $name ($file)${NC}"
  node "$file"
  local exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}  ✅ $name PASSED${NC}"
  else
    echo -e "${RED}  ❌ $name FAILED (exit code: $exit_code)${NC}"
  fi

  return $exit_code
}

# ── Execute ──────────────────────────────────────────────────────────────────
if [[ "$SCENARIO" == "all" ]]; then
  SCENARIOS=("smoke" "ramp" "heartbeat" "chat" "notification" "mixed" "breakpoint")
  PASSED=0
  FAILED=0

  for s in "${SCENARIOS[@]}"; do
    echo ""
    if run_scenario "$s"; then
      ((PASSED++))
    else
      ((FAILED++))
    fi
  done

  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "  Results: ${GREEN}${PASSED} passed${NC} / ${RED}${FAILED} failed${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"

  [[ $FAILED -eq 0 ]] && exit 0 || exit 1
else
  run_scenario "$SCENARIO"
fi
