#!/bin/bash
set -e

SCRIPT_DIR="$(dirname "$0")"
echo "$SCRIPT_DIR}"
REPORTS_DIR="$SCRIPT_DIR/../reports"
echo "$REPORTS_DIR"
cd "$SCRIPT_DIR/../../.."

LATEST_JSON=$(ls -t "$REPORTS_DIR"/enygma-performance_*.json 2>/dev/null | head -n 1)
echo "$LATEST_JSON"
[ -z "$LATEST_JSON" ] && { echo "No JSON reports found"; exit 1; }

echo "Generating HTML report from: $(basename "$LATEST_JSON")"
./node_modules/.bin/ts-node test/performance/reporters/generateHtmlReport.ts "$LATEST_JSON"