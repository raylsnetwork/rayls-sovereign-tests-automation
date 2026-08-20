#!/bin/bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO] $(date +'%H:%M:%S') - $1${NC}"; }
log_warn() { echo -e "${YELLOW}[WARN] $(date +'%H:%M:%S') - $1${NC}"; }
log_error() { echo -e "${RED}[ERROR] $(date +'%H:%M:%S') - $1${NC}"; }

COMPOSE_FILE="${1:-docker-compose.dev-local.yml}"
MAX_WAIT=${2:-300}  # 5 minutes default
RELAYER_PATH="../rayls-sovereign-relayer"

# Critical services that must be healthy
CRITICAL_SERVICES=(
    "mongodb"
    "postgres"
    "contracts"
    "pn-a"
    "pn-b"
    "private-hub"
)

log_info "Checking critical services health..."
log_info "Compose file: $COMPOSE_FILE"
log_info "Maximum timeout: ${MAX_WAIT}s"
echo ""

cd "$RELAYER_PATH"

# Function to check if a service is healthy
check_service_health() {
    local SERVICE=$1
    local STATUS=$(docker compose -f "$COMPOSE_FILE" ps "$SERVICE" 2>/dev/null | grep -E '\(healthy\)|\(running\)' || echo "")

    if [ -n "$STATUS" ]; then
        return 0  # Healthy
    else
        return 1  # Not healthy
    fi
}

# Wait for all critical services
ELAPSED=0
ALL_HEALTHY=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    ALL_HEALTHY=true

    for SERVICE in "${CRITICAL_SERVICES[@]}"; do
        if ! check_service_health "$SERVICE"; then
            ALL_HEALTHY=false
            log_warn "Waiting for service: $SERVICE (${ELAPSED}s/${MAX_WAIT}s)"
            break
        fi
    done

    if [ "$ALL_HEALTHY" = true ]; then
        log_info "✓ All critical services are ready!"
        echo ""

        # Show final status
        log_info "Services status:"
        docker compose -f "$COMPOSE_FILE" ps

        exit 0
    fi

    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

# Timeout reached
log_error "Timeout! Services did not become ready in ${MAX_WAIT}s"
log_error "Current services status:"
docker compose -f "$COMPOSE_FILE" ps

exit 1
