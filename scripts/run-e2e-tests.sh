#!/bin/bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO] $(date +'%H:%M:%S') - $1${NC}"; }
log_warn() { echo -e "${YELLOW}[WARN] $(date +'%H:%M:%S') - $1${NC}"; }
log_error() { echo -e "${RED}[ERROR] $(date +'%H:%M:%S') - $1${NC}"; }

# Parameters
TEST_SUITE=${1:-"e2e"}  # e2e, smoke, regression
REPORT_DIR="./test-results"
TIMESTAMP=$(date +'%Y%m%d-%H%M%S')

log_info "=== E2E Test Execution ==="
log_info "Suite: $TEST_SUITE"
log_info "Report dir: $REPORT_DIR"
echo ""

# Create reports directory
mkdir -p "$REPORT_DIR"

# Function to run test suite
run_test_suite() {
    local SUITE_NAME=$1
    local NPM_SCRIPT=$2

    log_info "Running suite: $SUITE_NAME"

    local LOG_FILE="$REPORT_DIR/${SUITE_NAME}-${TIMESTAMP}.log"

    set +e
    npm run "$NPM_SCRIPT" 2>&1 | tee "$LOG_FILE"
    local EXIT_CODE=${PIPESTATUS[0]}
    set -e

    if [ $EXIT_CODE -eq 0 ]; then
        log_info "✓ Suite $SUITE_NAME: PASSED"
        return 0
    else
        log_error "✗ Suite $SUITE_NAME: FAILED (exit code: $EXIT_CODE)"
        return $EXIT_CODE
    fi
}

# Execute the requested suite
FINAL_RESULT=0

case $TEST_SUITE in
    smoke)
        log_info "Running SMOKE tests..."
        run_test_suite "smoke" "test:smoke" || FINAL_RESULT=$?
        ;;

    regression)
        log_info "Running REGRESSION tests..."
        run_test_suite "regression" "test:regression" || FINAL_RESULT=$?
        ;;

    e2e)
        log_info "Running full E2E suite..."
        run_test_suite "e2e-full" "test:e2e-full-no-security" || FINAL_RESULT=$?
        ;;

    enygma-transfers)
        log_info "Running Enygma transfers tests..."
        run_test_suite "enygma-transfers" "test:e2e-enygma-transfers" || FINAL_RESULT=$?
        ;;

    enygma-batch)
        log_info "Running Enygma batch tests..."
        run_test_suite "enygma-batch" "test:e2e-enygma-batch" || FINAL_RESULT=$?
        ;;

    e2e-full)
        log_info "Running full E2E suite..."
        run_test_suite "e2e-full" "test:e2e-full" || FINAL_RESULT=$?
        ;;

    *)
        log_error "Unknown suite: $TEST_SUITE"
        log_info "Available suites: e2e, smoke, regression, enygma-transfers, enygma-batch"
        exit 1
        ;;
esac

echo ""
log_info "=== Execution Summary ==="
log_info "Suite: $TEST_SUITE"
log_info "Logs saved in: $REPORT_DIR"

if [ $FINAL_RESULT -eq 0 ]; then
    log_info "✓ All tests PASSED!"
    exit 0
else
    log_error "✗ Tests FAILED with exit code $FINAL_RESULT"
    exit $FINAL_RESULT
fi
