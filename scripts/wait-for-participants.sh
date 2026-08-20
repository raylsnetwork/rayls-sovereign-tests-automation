#!/bin/bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO] $(date +'%H:%M:%S') - $1${NC}"; }
log_warn() { echo -e "${YELLOW}[WARN] $(date +'%H:%M:%S') - $1${NC}"; }
log_error() { echo -e "${RED}[ERROR] $(date +'%H:%M:%S') - $1${NC}"; }

log_info "=== Checking participant synchronization ==="

# Run TypeScript script (--transpile-only ignores type errors in other files)
npx ts-node --transpile-only ./scripts/wait-for-participants.ts
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_info "✓ Participants verified successfully!"
else
    log_error "✗ Participant verification failed"
    exit $EXIT_CODE
fi
