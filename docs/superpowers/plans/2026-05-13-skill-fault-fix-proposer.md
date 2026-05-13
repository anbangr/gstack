# Skill Fault Fix Proposer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gstack skill:propose-fix` — a CLI command that reads all investigation reports for a fault category, synthesizes the root cause across builds, and writes a fix proposal (advisory prose + ready-to-apply diffs for low-risk changes).

**Architecture:** A new standalone bash script (`bin/gstack-skill-propose-fix`) spawns a fix-proposer agent in the background with inline report content and source files. Fix proposals land in `~/.gstack/skill-faults/fix-proposals/`. A `.applied` marker tracks when a human has applied the fix. The existing `bin/gstack-skill-learned-faults` table gains a `FIX` column showing `—` / `proposed` / `applied` per category.

**Tech Stack:** bash, jq, Bun test (`bun:test`), TypeScript (tests only)

---

## File Structure

| File                              | Action | Responsibility                                                          |
| --------------------------------- | ------ | ----------------------------------------------------------------------- |
| `bin/gstack-skill-propose-fix`    | Create | Parse args; find reports; build agent prompt; spawn agent; `--all` mode |
| `bin/gstack-skill-learned-faults` | Modify | Add `FIX` column; update footer                                         |
| `test/skill-propose-fix.test.ts`  | Create | 9 tests covering both scripts                                           |

---

### Task 1: Write tests (TDD — tests first)

**Files:**

- Create: `test/skill-propose-fix.test.ts`

- [ ] **Step 1.1: Create the test file**

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const PROPOSE_SCRIPT = join(process.cwd(), "bin", "gstack-skill-propose-fix");
const LEARNED_FAULTS_SCRIPT = join(
  process.cwd(),
  "bin",
  "gstack-skill-learned-faults",
);

function makeTmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "gstack-pfix-"));
  mkdirSync(join(dir, "skill-faults", "fix-proposals"), { recursive: true });
  return dir;
}

function writeReport(
  faultDir: string,
  runId: string,
  category: string,
  content: string,
): void {
  writeFileSync(
    join(faultDir, `skill-fault-${runId}-${category}.md`),
    content,
    "utf8",
  );
}

function writePatterns(faultDir: string, patterns: object[]): void {
  writeFileSync(
    join(faultDir, "learned-patterns.json"),
    JSON.stringify(patterns, null, 2),
    "utf8",
  );
}

const PATTERN = {
  category: "MISSING_ENV_VAR",
  severity: "HIGH",
  description: "Missing environment variable",
  matcherKind: "stdout_contains",
  pattern: "env var not set",
  source: "investigator:skill-fault-discovery-abc.md",
  learnedAt: "2026-05-01T14:22:00Z",
  hitCount: 3,
};

describe("gstack-skill-propose-fix", () => {
  test("no args → usage message and non-zero exit", () => {
    const dir = makeTmpHome();
    try {
      const r = spawnSync(PROPOSE_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).not.toBe(0);
      expect((r.stderr ?? "") + (r.stdout ?? "")).toMatch(/[Uu]sage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("category with no reports → error on stderr and non-zero exit", () => {
    const dir = makeTmpHome();
    try {
      const r = spawnSync(PROPOSE_SCRIPT, ["MISSING_CAT"], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(
        "No investigation reports found for category: MISSING_CAT",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("category with matching report → output path printed and exit 0", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    try {
      writeReport(
        faultDir,
        "run123",
        "TEST_FIXER_LOOP",
        "# Investigation\nLoop did not converge.",
      );
      const r = spawnSync(PROPOSE_SCRIPT, ["TEST_FIXER_LOOP"], {
        env: {
          ...process.env,
          GSTACK_HOME: dir,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: "true",
        },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Fix proposer spawned for TEST_FIXER_LOOP");
      expect(r.stdout).toContain("fix-proposals/TEST_FIXER_LOOP-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--all with 2 categories, 1 already proposed → spawns only 1", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writeReport(faultDir, "run1", "CAT_A", "Investigation A");
      writeReport(faultDir, "run2", "CAT_B", "Investigation B");
      writeFileSync(
        join(proposalsDir, "CAT_B-20260101T000000Z.md"),
        "existing",
        "utf8",
      );

      const r = spawnSync(PROPOSE_SCRIPT, ["--all"], {
        env: {
          ...process.env,
          GSTACK_HOME: dir,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: "true",
        },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("CAT_A");
      expect(r.stdout).not.toContain("CAT_B");
      expect(r.stdout).toContain("1 fix proposer(s) spawned in background.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--all with all categories already proposed → no unfixed found", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writeReport(faultDir, "run1", "CAT_A", "Investigation A");
      writeFileSync(
        join(proposalsDir, "CAT_A-20260101T000000Z.md"),
        "existing",
        "utf8",
      );

      const r = spawnSync(PROPOSE_SCRIPT, ["--all"], {
        env: {
          ...process.env,
          GSTACK_HOME: dir,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: "true",
        },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("No unfixed categories found.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gstack-skill-learned-faults FIX column", () => {
  test("no proposal file → FIX column shows —", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    try {
      writePatterns(faultDir, [PATTERN]);
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/MISSING_ENV_VAR.*—/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("proposal file exists, no .applied → FIX shows proposed", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writePatterns(faultDir, [PATTERN]);
      writeFileSync(
        join(proposalsDir, "MISSING_ENV_VAR-20260501T000000Z.md"),
        "proposal",
        "utf8",
      );
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/MISSING_ENV_VAR.*proposed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".applied marker present → FIX shows applied", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writePatterns(faultDir, [PATTERN]);
      writeFileSync(
        join(proposalsDir, "MISSING_ENV_VAR-20260501T000000Z.md"),
        "proposal",
        "utf8",
      );
      writeFileSync(
        join(proposalsDir, "MISSING_ENV_VAR-20260501T000000Z.md.applied"),
        "",
        "utf8",
      );
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/MISSING_ENV_VAR.*applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("footer includes propose-fix --all hint", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    try {
      writePatterns(faultDir, [PATTERN]);
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("gstack skill:propose-fix --all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 1.2: Run tests — they must all fail (scripts don't exist yet)**

```bash
bun test test/skill-propose-fix.test.ts
```

Expected: all 9 tests fail with "spawn error" or "ENOENT" (scripts not found). If any pass, something is wrong.

- [ ] **Step 1.3: Commit the failing tests**

```bash
git add test/skill-propose-fix.test.ts
git commit -m "test(propose-fix): add 9 failing tests for propose-fix CLI and FIX column"
```

---

### Task 2: Implement `bin/gstack-skill-propose-fix`

**Files:**

- Create: `bin/gstack-skill-propose-fix`

- [ ] **Step 2.1: Create the script**

```bash
#!/usr/bin/env bash
# gstack-skill-propose-fix — synthesize AI fix proposals from fault investigation reports
#
# Usage:
#   gstack skill:propose-fix <CATEGORY>   — propose fix for one category
#   gstack skill:propose-fix --all        — propose fixes for all categories with no proposal yet
#
# Env overrides (for testing):
#   GSTACK_HOME                     — override ~/.gstack state directory
#   GSTACK_FAULT_INVESTIGATOR_COMMAND — override AI command (e.g. set to "true" in tests)
set -uo pipefail

GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"
FAULT_DIR="$GSTACK_HOME/skill-faults"
PROPOSALS_DIR="$FAULT_DIR/fix-proposals"
MAX_REPORTS=5

usage() {
  echo "Usage: gstack skill:propose-fix <CATEGORY>" >&2
  echo "       gstack skill:propose-fix --all" >&2
  exit 1
}

# Repo root — needed to inline build/SKILL.md.tmpl into the agent prompt
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

# AI command — use override for tests; otherwise detect from gstack-config
_CMD="${GSTACK_FAULT_INVESTIGATOR_COMMAND:-}"
if [ -z "$_CMD" ]; then
  _PROVIDER=$(gstack-config get fault_investigator_provider 2>/dev/null || echo "claude")
  case "$_PROVIDER" in
    gemini) _CMD="gemini" ;;
    kimi)   _CMD="kimi-code" ;;
    *)      _CMD="claude" ;;
  esac
fi

mkdir -p "$PROPOSALS_DIR"

# ─── propose_for_category ────────────────────────────────────────────────────
# Spawns a background AI agent to write a fix proposal for the given category.
# Prints "Fix proposer spawned for <CATEGORY> → <output-path>" on success.
# Prints an error to stderr and returns 1 if no reports are found.
propose_for_category() {
  local category="$1"

  # Per-fault investigation reports: skill-fault-<runId>-<CATEGORY>.md
  local reports
  reports=$(find "$FAULT_DIR" -maxdepth 1 \
    -name "skill-fault-*-${category}.md" 2>/dev/null \
    | sort -r | head -"$MAX_REPORTS")

  # Discovery report referenced by learned-patterns.json source field
  local learned_json="$FAULT_DIR/learned-patterns.json"
  if [ -f "$learned_json" ]; then
    local src
    src=$(jq -r --arg c "$category" \
      '.[] | select(.category==$c) | .source // ""' \
      "$learned_json" 2>/dev/null \
      | sed 's|^investigator:||' | head -1)
    if [ -n "$src" ] && [ -f "$FAULT_DIR/$src" ]; then
      reports="$FAULT_DIR/$src"$'\n'"$reports"
    fi
  fi

  if [ -z "$reports" ]; then
    echo "No investigation reports found for category: $category" >&2
    return 1
  fi

  # Output path
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local out="$PROPOSALS_DIR/${category}-${ts}.md"

  # Inline report contents (at most MAX_REPORTS)
  local report_block=""
  local count=0
  while IFS= read -r rpt && [ "$count" -lt "$MAX_REPORTS" ]; do
    [ -z "$rpt" ] && continue
    report_block+="=== $(basename "$rpt") ==="$'\n'"$(cat "$rpt")"$'\n\n'
    count=$((count + 1))
  done <<< "$reports"

  # Source file — inlined so the agent can reference exact line content
  local skill_tmpl=""
  if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/build/SKILL.md.tmpl" ]; then
    skill_tmpl=$(cat "$REPO_ROOT/build/SKILL.md.tmpl")
  fi

  # Learned fault metadata (if applicable)
  local fault_meta=""
  if [ -f "$learned_json" ]; then
    fault_meta=$(jq -r --arg c "$category" \
      '.[] | select(.category==$c) | "Description: " + .description + "\nHit count: " + (.hitCount|tostring)' \
      "$learned_json" 2>/dev/null || true)
  fi

  local prompt
  prompt="You are a fix proposer for the gstack build skill.

Fault category: $category
$fault_meta

Investigation reports (most recent first, capped at $MAX_REPORTS):
$report_block

Source file — build/SKILL.md.tmpl:
$skill_tmpl

Risk tiering rubric:
- SKILL.md.tmpl adds content only (new guard/check/step, additive only): LOW RISK — produce a diff block
- SKILL.md.tmpl modifies or removes existing steps: HIGH RISK — advisory only
- .ts adds a null check or constant, ≤10 lines: LOW RISK — produce a diff block
- .ts touches algorithm logic, error handling, or sequencing: HIGH RISK — advisory only
- Any change >20 lines or touching multiple call sites: HIGH RISK — advisory only

Write a fix proposal to: $out

Required file structure:
  # Fix Proposal: $category
  Generated: <ISO timestamp>
  Evidence: <N> investigation reports
    - <report filenames>
  Fault type: static|learned

  ## Root Cause Analysis
  [Synthesized root cause across all reports — not a per-build narrative]

  ## Recommended Fix

  ### Summary
  [One paragraph: what to change and why]

  ### <path/to/file>  [LOW RISK — patch provided]
  **What:** ...
  **Why:** ...
  \`\`\`diff
  ...
  \`\`\`

  ### <path/to/file>  [HIGH RISK — advisory only]
  **What:** ...
  **Why:** ...
  **To implement:** [prose — human writes the code]

  ## Apply Instructions
  1. Review each diff above
  2. Apply low-risk patches: copy manually or git apply
  3. Run bun test to verify
  4. touch $out.applied when done

IMPORTANT: ONLY read files and write the fix proposal to $out. Do NOT modify any source files."

  $_CMD -p "$prompt" --tool Read --tool Write > /dev/null 2>&1 &
  echo "Fix proposer spawned for $category → $out"
}

# ─── main ────────────────────────────────────────────────────────────────────
if [ $# -eq 0 ]; then
  usage
fi

if [ "$1" = "--all" ]; then
  # Collect all categories from per-fault report filenames + learned-patterns.json
  all_cats=""

  while IFS= read -r f; do
    cat=$(basename "$f" .md | grep -oE '[A-Z][A-Z0-9_]+$' 2>/dev/null || true)
    [ -n "$cat" ] && all_cats="$all_cats"$'\n'"$cat"
  done < <(find "$FAULT_DIR" -maxdepth 1 -name "skill-fault-*-*.md" 2>/dev/null || true)

  if [ -f "$FAULT_DIR/learned-patterns.json" ]; then
    all_cats="$all_cats"$'\n'"$(jq -r '.[].category' "$FAULT_DIR/learned-patterns.json" 2>/dev/null || true)"
  fi

  spawned=0
  while IFS= read -r cat; do
    [ -z "$cat" ] && continue
    # Skip if a proposal already exists for this category
    if find "$PROPOSALS_DIR" -maxdepth 1 -name "${cat}-*.md" 2>/dev/null | grep -q .; then
      continue
    fi
    propose_for_category "$cat" && spawned=$((spawned + 1))
  done < <(echo "$all_cats" | sort -u)

  if [ "$spawned" -eq 0 ]; then
    echo "No unfixed categories found."
  else
    echo "$spawned fix proposer(s) spawned in background."
  fi
else
  propose_for_category "$1"
fi
```

- [ ] **Step 2.2: Make the script executable**

```bash
chmod +x bin/gstack-skill-propose-fix
```

- [ ] **Step 2.3: Run the propose-fix tests — they must pass**

```bash
bun test test/skill-propose-fix.test.ts --testNamePattern "gstack-skill-propose-fix"
```

Expected output: 5 tests pass. If any fail, read the error and fix the script before continuing.

- [ ] **Step 2.4: Commit**

```bash
git add bin/gstack-skill-propose-fix
git commit -m "feat(bin): add gstack-skill-propose-fix CLI"
```

---

### Task 3: Update `bin/gstack-skill-learned-faults` to add FIX column

**Files:**

- Modify: `bin/gstack-skill-learned-faults`

The current file is 79 lines. Make exactly four edits:

- [ ] **Step 3.1: Add `PROPOSALS_DIR` variable after `PATTERNS_FILE`**

At line 12 (`PATTERNS_FILE=...`), add the line below it:

```bash
PROPOSALS_DIR="$GSTACK_HOME/skill-faults/fix-proposals"
```

- [ ] **Step 3.2: Update the table header (line 40–41) to include FIX column**

Replace:

```bash
printf "%-26s %-8s %4s  %-19s %-29s\n" "CATEGORY" "SEV" "HITS" "LEARNED" "SOURCE"
printf "%s  %s  %s  %s  %s\n" "──────────────────────────────" "────────" "────" "───────────────────" "─────────────────────────────"
```

With:

```bash
printf "%-26s %-8s %4s  %-8s %-19s %-29s\n" "CATEGORY" "SEV" "HITS" "FIX" "LEARNED" "SOURCE"
printf "%s  %s  %s  %s  %s  %s\n" "──────────────────────────────" "────────" "────" "────────" "───────────────────" "─────────────────────────────"
```

- [ ] **Step 3.3: Add fix status computation inside the while loop, just after `category_display=...` (line 46)**

Insert after `category_display="${category:0:26}"`:

```bash
  # Determine fix proposal status for this category
  fix_status="—"
  if [ -d "$PROPOSALS_DIR" ]; then
    if find "$PROPOSALS_DIR" -maxdepth 1 -name "${category}-*.md.applied" 2>/dev/null | grep -q .; then
      fix_status="applied"
    elif find "$PROPOSALS_DIR" -maxdepth 1 -name "${category}-*.md" ! -name "*.applied" 2>/dev/null | grep -q .; then
      fix_status="proposed"
    fi
  fi
```

- [ ] **Step 3.4: Update the row printf (line 69) to include `$fix_status`**

Replace:

```bash
  printf "%-26s %-8s %4s  %-19s %-29s\n" "$category_display" "$sev_display" "$hits_padded" "$learned_display" "$source_display"
```

With:

```bash
  printf "%-26s %-8s %4s  %-8s %-19s %-29s\n" "$category_display" "$sev_display" "$hits_padded" "$fix_status" "$learned_display" "$source_display"
```

- [ ] **Step 3.5: Add `propose-fix --all` hint to footer (after line 78)**

After the existing `echo "Edit $PATTERNS_FILE directly..."` line, add:

```bash
echo "Run 'gstack skill:propose-fix --all' to generate fix proposals for unfixed categories."
```

- [ ] **Step 3.6: Run the FIX column tests — they must pass**

```bash
bun test test/skill-propose-fix.test.ts --testNamePattern "gstack-skill-learned-faults FIX column"
```

Expected: 4 tests pass. If any fail, read the error and fix the script.

- [ ] **Step 3.7: Run all tests to make sure nothing regressed**

```bash
bun test
```

Expected: all tests pass. Fix any failures before continuing.

- [ ] **Step 3.8: Commit**

```bash
git add bin/gstack-skill-learned-faults
git commit -m "feat(bin): add FIX column and propose-fix hint to gstack-skill-learned-faults"
```

---

## Verification

```bash
# All free tests pass
bun test

# Manual smoke test (optional — requires actual investigation reports on disk):
# 1. Confirm no proposals yet:
gstack skill:learned-faults   # FIX column shows — for all categories

# 2. Propose fix for a category that has investigation reports:
gstack skill:propose-fix TEST_FIXER_LOOP
# Expected: "Fix proposer spawned for TEST_FIXER_LOOP → ~/.gstack/skill-faults/fix-proposals/TEST_FIXER_LOOP-<ts>.md"

# 3. After agent finishes, check the proposal file:
ls ~/.gstack/skill-faults/fix-proposals/
cat ~/.gstack/skill-faults/fix-proposals/TEST_FIXER_LOOP-*.md

# 4. Check table now shows proposed:
gstack skill:learned-faults   # FIX column shows "proposed" for TEST_FIXER_LOOP

# 5. Mark applied and verify:
touch ~/.gstack/skill-faults/fix-proposals/TEST_FIXER_LOOP-*.md.applied
gstack skill:learned-faults   # FIX column shows "applied"

# 6. Run --all to confirm no-unfixed when all are proposed:
gstack skill:propose-fix --all
# Expected: "No unfixed categories found."
```
