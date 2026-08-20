#!/bin/bash
#
# sync-gnark-verifiers.sh
#
# Copies Solidity verifier contracts from rayls-privacy-gnark-api/last_build/
# to rayls-privacy-contracts/src/rayls-protocol/Enygma/ directories.
#
# This ensures the on-chain verifier contracts match the gnark proving keys,
# preventing "verifyProof returned false: Invalid proof" errors.
#
# Usage:
#   ./scripts/sync-gnark-verifiers.sh
#   ./scripts/sync-gnark-verifiers.sh --dry-run
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

GNARK_DIR="${GNARK_DIR:-$BASE_DIR/rayls-privacy-gnark-api}"
CONTRACTS_DIR="${CONTRACTS_DIR:-$BASE_DIR/rayls-privacy-contracts}"

GNARK_BUILD="$GNARK_DIR/last_build"
PAYMENTS_DST="$CONTRACTS_DIR/src/rayls-protocol/Enygma/Enygma-Payments"
DVP_DST="$CONTRACTS_DIR/src/rayls-protocol/Enygma/Enygma-DVP"

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
    DRY_RUN=true
    echo "[DRY RUN] No files will be modified."
fi

# Validate directories exist
if [ ! -d "$GNARK_BUILD" ]; then
    echo "Error: gnark-api last_build directory not found at $GNARK_BUILD" >&2
    echo "  Make sure rayls-privacy-gnark-api is cloned alongside this repo." >&2
    exit 1
fi

if [ ! -d "$CONTRACTS_DIR" ]; then
    echo "Error: contracts directory not found at $CONTRACTS_DIR" >&2
    echo "  Make sure rayls-privacy-contracts is cloned alongside this repo." >&2
    exit 1
fi

# DVP verifiers (by name pattern)
DVP_PATTERNS="EnygmaJoinSplitVerifier Erc721OwnershipVerifier Erc1155JoinSplitVerifier"

copied=0
skipped=0
mismatched=0

echo "Syncing gnark verifier contracts..."
echo "  Source:  $GNARK_BUILD"
echo "  Target:  $PAYMENTS_DST"
echo "          $DVP_DST"
echo ""

for sol_file in "$GNARK_BUILD"/*.sol; do
    basename=$(basename "$sol_file")

    # Skip _raw files (intermediate artifacts)
    if [[ "$basename" == *"_raw"* ]]; then
        continue
    fi

    # Determine destination directory
    dst_dir="$PAYMENTS_DST"
    name_no_ext="${basename%.sol}"
    for pattern in $DVP_PATTERNS; do
        if [ "$name_no_ext" = "$pattern" ]; then
            dst_dir="$DVP_DST"
            break
        fi
    done

    dst_file="$dst_dir/$basename"

    # Check if destination exists
    if [ ! -f "$dst_file" ]; then
        echo "  [NEW]      $basename -> $(basename $dst_dir)/"
    elif diff -q "$sol_file" "$dst_file" > /dev/null 2>&1; then
        echo "  [OK]       $basename (already in sync)"
        skipped=$((skipped + 1))
        continue
    else
        echo "  [UPDATED]  $basename -> $(basename $dst_dir)/"
        mismatched=$((mismatched + 1))
    fi

    if [ "$DRY_RUN" = false ]; then
        mkdir -p "$dst_dir"
        cp "$sol_file" "$dst_file"
    fi
    copied=$((copied + 1))
done

echo ""
if [ "$DRY_RUN" = true ]; then
    echo "Dry run complete: $copied would be copied, $skipped already in sync, $mismatched out of sync."
else
    echo "Sync complete: $copied copied, $skipped already in sync."
fi

if [ $mismatched -gt 0 ] && [ "$DRY_RUN" = false ]; then
    echo ""
    echo "WARNING: $mismatched verifier(s) were out of sync and have been updated."
    echo "You MUST rebuild the contracts Docker image for the changes to take effect:"
    echo "  cd $BASE_DIR/rayls-privacy-relayer-api && docker compose -f docker-compose.dev-local.yml build contracts"
fi
