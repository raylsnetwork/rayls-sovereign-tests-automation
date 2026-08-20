#!/bin/bash
#
# Setup /etc/hosts for Docker services
# Adds service name mappings to localhost
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[✓]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
log_error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Docker service hostnames
SERVICES=(
    "mongodb"
    "postgres"
    "pn-a" "pn-b" "pn-c" "pn-d" "pn-e" "pn-f"
    "private-hub"
    "contracts"
    "proofs-api"
    "cts-a" "cts-b" "cts-c" "cts-d" "cts-e" "cts-f"
    "relayer-a" "relayer-b" "relayer-c" "relayer-d" "relayer-e" "relayer-f"
    "pubrelayer-a" "pubrelayer-b" "pubrelayer-c" "pubrelayer-d" "pubrelayer-e" "pubrelayer-f"
    "ops-api-a" "ops-api-b" "ops-api-c" "ops-api-d" "ops-api-e" "ops-api-f"
    "governance-api"
    "governance-flagger"
    "governance-listener"
    "otel"
    "nats"
    "backend-a" "backend-b" "backend-c" "backend-d" "backend-e" "backend-f"
    "public-chain"
)

echo "=========================================="
echo "  Docker Services /etc/hosts Setup"
echo "=========================================="
echo ""

# Check if running with sudo
if [ "$EUID" -ne 0 ]; then
    log_error "Please run with sudo: sudo ./scripts/setup-hosts.sh"
fi

HOSTS_FILE="/etc/hosts"
BACKUP_FILE="/etc/hosts.backup-$(date +%Y%m%d-%H%M%S)"

# Backup current hosts file
log_info "Creating backup: $BACKUP_FILE"
cp "$HOSTS_FILE" "$BACKUP_FILE"

# Check which entries are missing
MISSING_SERVICES=()
for SERVICE in "${SERVICES[@]}"; do
    if ! grep -q "127.0.0.1 $SERVICE" "$HOSTS_FILE"; then
        MISSING_SERVICES+=("$SERVICE")
    fi
done

if [ ${#MISSING_SERVICES[@]} -eq 0 ]; then
    log_info "All Docker services already configured in /etc/hosts"
    exit 0
fi

log_warn "Adding ${#MISSING_SERVICES[@]} missing service(s) to /etc/hosts"
echo ""

# Add marker comment
if ! grep -q "# Docker Services - rayls-automation" "$HOSTS_FILE"; then
    echo "" >> "$HOSTS_FILE"
    echo "# Docker Services - rayls-automation" >> "$HOSTS_FILE"
fi

# Add missing services
for SERVICE in "${MISSING_SERVICES[@]}"; do
    echo "127.0.0.1 $SERVICE" >> "$HOSTS_FILE"
    log_info "Added: $SERVICE"
done

echo ""
log_info "✓ /etc/hosts updated successfully!"
log_info "Backup saved: $BACKUP_FILE"
echo ""
log_info "Services configured: ${#SERVICES[@]}"
log_info "Services added: ${#MISSING_SERVICES[@]}"

