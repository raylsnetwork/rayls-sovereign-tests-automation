#!/bin/bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Configuration
CONTRACTS_PATH="../rayls-privacy-contracts"
TARGET_DIR="contracts/remote"

log_info "=== Sync Contracts (Local) ==="

# Check if rayls-contracts exists
if [ ! -d "$CONTRACTS_PATH" ]; then
    log_error "Directory $CONTRACTS_PATH not found! Clone rayls-privacy-contracts as a sibling directory first."
fi

if [ ! -d "$CONTRACTS_PATH/src" ]; then
    log_error "Source directory $CONTRACTS_PATH/src not found!"
fi

# Show source info
BRANCH=$(git -C "$CONTRACTS_PATH" branch --show-current 2>/dev/null || echo "unknown")
COMMIT=$(git -C "$CONTRACTS_PATH" log -1 --oneline 2>/dev/null || echo "unknown")
log_info "Source: $CONTRACTS_PATH"
log_info "Branch: $BRANCH"
log_info "Commit: $COMMIT"
echo ""

# Wipe old contracts & recreate
log_info "Cleaning old contracts..."
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

# Copy sources (excluding Foundry test files *.t.sol)
log_info "Copying sources from $CONTRACTS_PATH/src (excluding Foundry tests)..."
rsync -a --exclude='*.t.sol' "$CONTRACTS_PATH/src/" "$TARGET_DIR/"

# Count files
FILE_COUNT=$(find "$TARGET_DIR" -name "*.sol" | wc -l)
log_info "Copied $FILE_COUNT Solidity files"
echo ""

# Clean hardhat cache
log_info "Cleaning hardhat cache..."
npx hardhat clean

# Compile
log_info "Compiling contracts..."
npx hardhat compile

echo ""
log_info "✓ Contracts synced and compiled successfully!"
log_info "  Source: $BRANCH @ ${COMMIT:0:7}"
log_info "  Target: $TARGET_DIR"
