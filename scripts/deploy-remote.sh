#!/bin/bash
# Symbiont Remote Deploy — SSH wrapper for deploy-core.sh
# Usage: deploy-remote.sh [--skip-tests]
#
# Runs deploy-core.sh on the remote server via SSH.

set -euo pipefail

HOST="${DEPLOY_HOST:-home}"
SIA_DIR="${DEPLOY_SIA_DIR:-~/sia}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Pass through args
ARGS="$*"

echo -e "${GREEN}=== Symbiont Remote Deploy ===${NC}"
echo "  Host: $HOST"
echo "  Dir:  $SIA_DIR"

# SSH connectivity check
echo -n "  SSH: "
ssh "$HOST" "echo ok" >/dev/null 2>&1 || { echo -e "${RED}FAIL${NC}"; exit 1; }
echo -e "${GREEN}OK${NC}"

# Run deploy-core.sh on remote
ssh -t "$HOST" "cd $SIA_DIR && ./scripts/deploy-core.sh $ARGS"
