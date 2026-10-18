#!/usr/bin/env bash
# verify-test-determinism.sh — Run the contract test suite N times and verify
# zero inter-run variance (issue #246 acceptance criterion: 50x repeat with
# zero variance).
#
# Two things must hold on every run:
#   - the `test result:` summaries match (pass/fail/ignored counts; the
#     `finished in Ns` timing is stripped, since it differs on every run), and
#   - the golden output under test_snapshots/ is byte-identical to the first
#     run's, so a test whose snapshot depends on time, ordering or randomness
#     is caught even when it passes (issue #302).
#
# Usage:
#   bash scripts/verify-test-determinism.sh [REPEAT_COUNT]
#
# Arguments:
#   REPEAT_COUNT  Number of times to run the suite (default: 50)
#
# Exit codes:
#   0 — all runs passed with identical results
#   1 — at least one run failed or produced different output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACT_DIR="$ROOT_DIR/contracts/amana_escrow"
REPEAT_COUNT="${1:-50}"
SNAPSHOT_DIR="$CONTRACT_DIR/test_snapshots"
LOG_DIR=$(mktemp -d)
trap 'rm -rf "$LOG_DIR"' EXIT

# Strip per-run timing so only the outcome counts are compared.
summary() {
  grep '^test result:' "$1" | sed -E 's/; finished in [0-9.]+s$//' | sort
}

# Content hash of every snapshot file, keyed by path.
snapshot_digest() {
  if [[ -d "$SNAPSHOT_DIR" ]]; then
    (cd "$SNAPSHOT_DIR" && find . -type f -print0 | sort -z | xargs -0 sha256sum)
  fi
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Amana Escrow — Determinism Verification"
echo "  Running cargo test $REPEAT_COUNT times from $CONTRACT_DIR"
echo "═══════════════════════════════════════════════════════════════"
echo ""

PASS=0
FAIL=0
FIRST_SNAPSHOTS=""

for i in $(seq 1 "$REPEAT_COUNT"); do
  PADDED=$(printf "%03d" "$i")
  RUN_LOG="$LOG_DIR/run_$PADDED.log"

  echo -n "  [$PADDED/$REPEAT_COUNT] cargo test ..."

  if (cd "$CONTRACT_DIR" && cargo test --locked 2>&1) > "$RUN_LOG" 2>&1; then
    echo " ✅"
    PASS=$((PASS + 1))
  else
    echo " ❌"
    # The log directory is removed on exit, so surface the failure now.
    grep -E '^test .* FAILED$|panicked at|^error' "$RUN_LOG" | head -20 | sed 's/^/      /'
    FAIL=$((FAIL + 1))
    continue
  fi

  CURRENT_SNAPSHOTS=$(snapshot_digest)
  if [[ -z "$FIRST_SNAPSHOTS" ]]; then
    FIRST_SNAPSHOTS="$CURRENT_SNAPSHOTS"
  elif [[ "$CURRENT_SNAPSHOTS" != "$FIRST_SNAPSHOTS" ]]; then
    echo ""
    echo "  ⚠️  test_snapshots/ output changed on run $i"
    diff <(echo "$FIRST_SNAPSHOTS") <(echo "$CURRENT_SNAPSHOTS") | grep '^[<>]' | head -20 | sed 's/^/      /' || true
    FAIL=$((FAIL + 1))
  fi

  # After the first successful run, compare subsequent outputs
  if [[ "$i" -gt 1 ]]; then
    PREV_PADDED=$(printf "%03d" $((i - 1)))
    PREV_LOG="$LOG_DIR/run_$PREV_PADDED.log"
    # Compare the "test result:" summary lines to detect inter-run variance
    CURRENT_SUMMARY=$(summary "$RUN_LOG")
    PREVIOUS_SUMMARY=$(summary "$PREV_LOG")
    if [[ -f "$PREV_LOG" && "$CURRENT_SUMMARY" != "$PREVIOUS_SUMMARY" ]]; then
      echo ""
      echo "  ⚠️  Inter-run variance detected between run $((i-1)) and run $i"
      echo "    Previous: $PREVIOUS_SUMMARY"
      echo "    Current:  $CURRENT_SUMMARY"
      echo ""
      echo "  This indicates non-deterministic test behavior."
      echo "  See contracts/amana_escrow/docs/test-determinism.md for fix guidance."
      FAIL=$((FAIL + 1))
    fi
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (out of $REPEAT_COUNT runs)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "❌ Determinism verification FAILED."
  echo ""
  echo "  Possible causes:"
  echo "    - Non-deterministic collection ordering in assertions"
  echo "    - Wall-clock time dependency in tests"
  echo "    - Parallel test interference (shared mutable state)"
  echo "    - Flaky network or environment dependency"
  echo ""
  echo "  See: contracts/amana_escrow/docs/test-determinism.md"
  exit 1
else
  echo "✅ All $REPEAT_COUNT runs passed with zero inter-run variance."
  exit 0
fi
