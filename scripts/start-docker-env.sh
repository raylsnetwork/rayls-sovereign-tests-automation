#!/bin/bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Parameters
NUM_PARTICIPANTS=${1:-2}
RELAYER_PATH="../rayls-sovereign-relayer"
COMPOSE_FILE="docker-compose.dev-local.yml"

log_info "=== Docker Environment Setup for CI ==="
log_info "Participants: $NUM_PARTICIPANTS"
echo ""

# Check if rayls-sovereign-relayer exists
if [ ! -d "$RELAYER_PATH" ]; then
    log_error "Directory $RELAYER_PATH not found!"
fi

cd "$RELAYER_PATH"

# Clean previous environment
log_info "Cleaning previous Docker environment..."
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true

# Run start_dev.sh in background (it runs attached by default)
log_info "Starting services in background..."
nohup ./start_dev.sh --clean --no-otel "$NUM_PARTICIPANTS" > /tmp/start_dev.log 2>&1 &
START_DEV_PID=$!

# Dynamically wait for containers to appear (i.e. docker compose has started creating them)
BOOT_TIMEOUT=120  # 2 minutes for containers to appear
BOOT_ELAPSED=0

log_info "Waiting for containers to start (timeout: ${BOOT_TIMEOUT}s)..."
while [ $BOOT_ELAPSED -lt $BOOT_TIMEOUT ]; do
    RUNNING=$(docker compose -f "$COMPOSE_FILE" ps 2>/dev/null | grep -c 'Up\|running\|healthy' 2>/dev/null; true)
    if [ "$RUNNING" -gt 0 ]; then
        log_info "✓ Containers are starting up (${RUNNING} running after ${BOOT_ELAPSED}s)"
        break
    fi
    log_info "Waiting for containers to appear... (${BOOT_ELAPSED}s/${BOOT_TIMEOUT}s)"
    sleep 5
    BOOT_ELAPSED=$((BOOT_ELAPSED + 5))
done

# Wait for relayer to be healthy
MAX_WAIT=1500  # 25 minutes
ELAPSED=0

log_info "Waiting for relayer-a to become healthy (timeout: ${MAX_WAIT}s)..."

while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATUS=$(docker compose -f "$COMPOSE_FILE" ps relayer-a 2>/dev/null | grep -E '(healthy|running)' || echo "")

    if [ -n "$STATUS" ]; then
        log_info "✓ relayer-a is ready after ${ELAPSED}s"
        break
    fi

    log_info "Waiting for relayer-a... (${ELAPSED}s/${MAX_WAIT}s)"
    sleep 10
    ELAPSED=$((ELAPSED + 10))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
    log_error "Timeout! relayer-a did not become ready in ${MAX_WAIT}s"
fi

echo ""
log_info "✓ Docker environment started successfully!"
echo ""

# Show services status
log_info "Services status:"
docker compose -f "$COMPOSE_FILE" ps

