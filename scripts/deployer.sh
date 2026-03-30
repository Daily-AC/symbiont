#!/bin/bash
# Symbiont Deployer Daemon — watches for deploy requests
#
# Runs as a separate systemd service. When Symbiont writes a deploy-request.json,
# this daemon picks it up, runs deploy-core.sh, and writes the result.

set -euo pipefail

SIA_DIR="${SIA_DIR:-$HOME/sia}"
DATA_DIR="$SIA_DIR/data"
REQUEST_FILE="$DATA_DIR/deploy-request.json"
RESULT_FILE="$DATA_DIR/deploy-result.json"
DEPLOY_SCRIPT="$SIA_DIR/scripts/deploy-core.sh"
LOG_FILE="$DATA_DIR/deploy.log"
POLL_INTERVAL=5

mkdir -p "$DATA_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "Deployer daemon started (watching $REQUEST_FILE)"

while true; do
  if [ -f "$REQUEST_FILE" ]; then
    # Read and remove request atomically
    REQUEST=$(cat "$REQUEST_FILE")
    rm -f "$REQUEST_FILE"

    TRIGGER=$(echo "$REQUEST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('trigger','unknown'))" 2>/dev/null || echo "unknown")
    DESC=$(echo "$REQUEST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description',''))" 2>/dev/null || echo "")

    log "Deploy request received: trigger=$TRIGGER desc=$DESC"

    # Record start
    PREV_HASH=$(cd "$SIA_DIR" && git rev-parse --short HEAD)
    START_TIME=$(date -Iseconds)

    # Execute deployment
    DEPLOY_EXIT=0
    "$DEPLOY_SCRIPT" 2>&1 | tee -a "$LOG_FILE" || DEPLOY_EXIT=$?

    NEW_HASH=$(cd "$SIA_DIR" && git rev-parse --short HEAD)
    END_TIME=$(date -Iseconds)

    # Write result
    if [ "$DEPLOY_EXIT" -eq 0 ]; then
      STATUS="done"
      log "Deploy succeeded: $PREV_HASH → $NEW_HASH"
    else
      STATUS="failed"
      log "Deploy failed (exit code $DEPLOY_EXIT)"
    fi

    cat > "$RESULT_FILE" << EOJSON
{
  "status": "$STATUS",
  "trigger": "$TRIGGER",
  "description": "$DESC",
  "prev_hash": "$PREV_HASH",
  "new_hash": "$NEW_HASH",
  "started_at": "$START_TIME",
  "finished_at": "$END_TIME",
  "exit_code": $DEPLOY_EXIT
}
EOJSON

    log "Result written to $RESULT_FILE"
  fi

  sleep "$POLL_INTERVAL"
done
