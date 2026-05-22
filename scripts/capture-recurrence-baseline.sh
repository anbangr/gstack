#!/usr/bin/env bash
# capture-recurrence-baseline.sh
# Phase 1 human-action helper: run the baseline capture and verify expected categories.
#
# Usage:
#   ./scripts/capture-recurrence-baseline.sh

set -euo pipefail

echo "=== 1. Running measure-halt-recurrence ==="
bun run measure-halt-recurrence || true

echo ""
echo "=== 2. Per-category summary from learned-patterns.json ==="
jq 'group_by(.category) | map({category: .[0].category, count: length, hits: (map(.hitCount // 0) | add)})' ~/.gstack/skill-faults/learned-patterns.json

echo ""
echo "=== 3. Verification: check for expected categories ==="

categories=(
  "git-worktree-index-lock-path-assumption"
  "release-daemon wrong-PR"
  "provider stall/quota/overload"
  "review/QA dirty non-test hygiene"
  "red-gate runner mismatch"
)

for cat in "${categories[@]}"; do
  found=$(jq --arg cat "$cat" 'group_by(.category) | map(.[0].category) | contains([$cat])' ~/.gstack/skill-faults/learned-patterns.json)
  if [ "$found" = "true" ]; then
    echo "  ✓ $cat: PRESENT"
  else
    echo "  ✗ $cat: MISSING"
  fi
done

echo ""
echo "=== Baseline capture complete ==="
echo "Review the output above and record the results in the plan file."
