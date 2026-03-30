#!/bin/bash
# Symbiont Deploy Core — runs on the target machine
# Usage: deploy-core.sh [--skip-tests] [--rollback]
#
# Called by:
#   - deploy-remote.sh (CC remote deploy via SSH)
#   - deployer.sh (Sia self-evolution daemon)

set -euo pipefail

SIA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="sia"
DASHBOARD_PORT=18080
GATEWAY_PORT=18090

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

step() { echo -e "\n${GREEN}[$1]${NC} $2"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

# Parse args
SKIP_TESTS=false
DO_ROLLBACK=false
for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
    --rollback) DO_ROLLBACK=true ;;
  esac
done

cd "$SIA_DIR"

# --- Rollback function ---
PREV_HASH=$(git rev-parse HEAD)

rollback() {
  warn "Deployment failed, rolling back to $PREV_HASH..."
  git checkout "$PREV_HASH" 2>/dev/null || true
  systemctl --user restart "$SERVICE" 2>/dev/null || true
  sleep 5
  # Verify rollback health
  if curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Rolled back successfully to $PREV_HASH${NC}"
  else
    fail "Rollback also failed! Manual intervention needed."
  fi
}

# --- Manual rollback mode ---
if [ "$DO_ROLLBACK" = true ]; then
  rollback
  exit 0
fi

# --- Deploy flow ---
echo -e "${GREEN}=== Symbiont Deploy ===${NC}"
echo "  Directory: $SIA_DIR"
echo "  Previous:  $PREV_HASH"

# Step 1: Pull code
step "1/6" "Pulling code..."
# Stash runtime changes (manifest edits by Sia, etc.)
git stash -q 2>/dev/null || true
PULL_OUTPUT=$(git pull origin master 2>&1)
git stash pop -q 2>/dev/null || true
echo "$PULL_OUTPUT"
NEW_HASH=$(git rev-parse HEAD)
echo "  Now at: $NEW_HASH"

# Step 2: Install deps if needed
if echo "$PULL_OUTPUT" | grep -qE "package(-lock)?\.json"; then
  step "2/6" "Dependencies changed, installing..."
  npm install 2>&1 | tail -3
else
  step "2/6" "Dependencies unchanged, skipping"
fi

# Step 3: Run tests
if [ "$SKIP_TESTS" = false ]; then
  step "3/6" "Running unit tests..."
  TEST_OUTPUT=$(node --experimental-strip-types --test $(ls tests/*.test.ts | grep -v -e e2e -e integration) 2>&1 || true)
  FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep -c "^not ok" || true)
  PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -c "^ok" || true)
  echo "  Results: $PASS_COUNT passed, $FAIL_COUNT failed"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "$TEST_OUTPUT" | grep "^not ok" || true
    warn "Tests failed! Rolling back..."
    rollback
    exit 1
  fi
else
  step "3/6" "Skipping tests (--skip-tests)"
fi

# Step 4: Restart service
step "4/6" "Restarting Sia..."
systemctl --user restart "$SERVICE"
sleep 5

# Step 5: Health checks
step "5/6" "Health checks..."
HEALTH_OK=true

DASH_HEALTH=$(curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" 2>/dev/null || echo "FAIL")
if [ "$DASH_HEALTH" = "FAIL" ]; then
  sleep 3
  DASH_HEALTH=$(curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" 2>/dev/null || echo "FAIL")
fi
if [ "$DASH_HEALTH" = "FAIL" ]; then
  warn "Dashboard health check failed"
  HEALTH_OK=false
else
  echo -e "  ${GREEN}✓${NC} Dashboard OK"
fi

GW_HEALTH=$(curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null || echo "FAIL")
if [ "$GW_HEALTH" != "FAIL" ]; then
  GW_TOOLS=$(echo "$GW_HEALTH" | grep -o '"tools":[0-9]*' | grep -o '[0-9]*' || echo "?")
  echo -e "  ${GREEN}✓${NC} Gateway OK (${GW_TOOLS} tools)"
else
  warn "Gateway health check failed"
  HEALTH_OK=false
fi

if [ "$HEALTH_OK" = false ]; then
  warn "Health checks failed! Rolling back..."
  rollback
  exit 1
fi

# Step 6: Record release
step "6/6" "Recording release..."
GIT_HASH=$(git rev-parse --short HEAD)
VERSION=$(date +%Y.%m.%d)-$GIT_HASH
COMMITS_JSON=$(git log "${PREV_HASH}..HEAD" --oneline --format='%s' 2>/dev/null | head -10 | python3 -c "
import sys, json
commits = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(commits))
" 2>/dev/null || echo '[]')
RELEASE_BODY="{\"version\":\"$VERSION\",\"commits\":$COMMITS_JSON,\"git_hash\":\"$GIT_HASH\"}"
curl -sf -X POST "http://127.0.0.1:${DASHBOARD_PORT}/api/releases" \
  -H 'Content-Type: application/json' \
  -d "$RELEASE_BODY" >/dev/null 2>&1 \
  && echo "  Version: $VERSION" \
  || warn "Release record failed (non-blocking)"

# Check Feishu connection
FEISHU_OK=$(journalctl --user -u "$SERVICE" --no-pager -n 20 2>/dev/null | grep -c 'WSClient connected' || echo "0")
if [ "$FEISHU_OK" -gt 0 ]; then
  echo -e "  ${GREEN}✓${NC} Feishu connected"
else
  warn "Feishu connection not confirmed (may still be initializing)"
fi

echo -e "\n${GREEN}=== Deploy complete: $PREV_HASH → $NEW_HASH ===${NC}"
