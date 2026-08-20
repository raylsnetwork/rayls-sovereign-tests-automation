#!/bin/bash

# Get script directory (where this script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check for --skip-setup flag
SKIP_SETUP=false
for arg in "$@"; do
    if [[ "$arg" == "--skip-setup" ]]; then
        SKIP_SETUP=true
    fi
done

if [[ "$SKIP_SETUP" == "false" ]]; then
    # Contracts repo path (sibling directory)
    CONTRACTS_REPO="../rayls-privacy-contracts"

    echo "========================================="
    echo "🔧 SETUP: Preparing test environment"
    echo "========================================="

    # Copy .env from rayls-privacy-contracts
    if [[ -f "$CONTRACTS_REPO/.env" ]]; then
        echo "📋 Copying .env from rayls-privacy-contracts..."
        cp "$CONTRACTS_REPO/.env" .env
        echo "✅ .env copied successfully"
    else
        echo "⚠️ Warning: $CONTRACTS_REPO/.env not found"
        if [[ ! -f ".env" ]]; then
            echo "❌ No .env file available — aborting setup. Tests would fail with confusing RPC/config errors."
            exit 1
        else
            echo "📋 Using existing .env file"
        fi
    fi
fi
