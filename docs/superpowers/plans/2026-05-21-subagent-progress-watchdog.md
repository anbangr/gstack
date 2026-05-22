# Subagent Progress Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the stall-watchdog a structured progress signal from spawned subagents so it stops false-positive-killing legitimately busy LLM work, catches "noisy stdout but no real progress" stalls, and emits quotable kill reasons in halt-events.

**Architecture:** Three units with disjoint concerns. A new pure-function parser (`subagent-progress-parser.ts`) converts vendor CLI stdout lines into `ProgressEvent | null`. The existing `stall-watchdog.ts` gains an optional `parseProgress` callback that drives tool-aware stall windows (`fast` / `slow`) and a progress-gap detector. The existing `halt-events.ts` gains three additive optional fields (`killReason`, `lastTool`, `lastBucket`). Everything is gated by `GSTACK_TOOL_AWARE_WATCHDOG` and degrades to today's flat-window behavior when the parser returns null or the env var is `0`.

**Tech Stack:** TypeScript on Bun. Tests with `bun:test`. No new dependencies. No new I/O primitives.

**Spec:** [docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md](docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md).

---

## File Structure

| File                                                             | Purpose                                                                                                                                                                     | Status |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| `build/orchestrator/subagent-progress-parser.ts`                 | Unit A — pure parser. Provider-specific functions that take a stdout line and return `ProgressEvent                                                                         | null`. | New |
| `build/orchestrator/stall-watchdog.ts`                           | Unit B — add `parseProgress`, `toolStallMs`, `progressGapMs` options. New internal state. New decision arms.                                                                | Modify |
| `build/orchestrator/halt-events.ts`                              | Unit C — three optional fields on `HaltEvent`. Additive.                                                                                                                    | Modify |
| `build/orchestrator/build-config.ts`                             | New plain module-level exports for `TOOL_AWARE_STALL_MS`, `PROGRESS_GAP_MS`, `TOOL_BUCKET`. NOT added to `BUILD_DEFAULTS` (that loads from JSON; these are code constants). | Modify |
| `build/orchestrator/sub-agents.ts`                               | Wire provider-appropriate parser into the single `attachStallWatchdog` call site (line ~707). Read env-var kill switch.                                                     | Modify |
| `build/orchestrator/__tests__/subagent-progress-parser.test.ts`  | Unit A tests — fixture-driven, per-provider.                                                                                                                                | New    |
| `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts` | Unit B tests — fake clock + fake child, covers windowing + progress-gap.                                                                                                    | New    |
| `test/fixtures/subagent-stdout/gemini.txt` + `.golden.json`      | Real Gemini stdout sample + expected events.                                                                                                                                | New    |
| `test/fixtures/subagent-stdout/codex.txt` + `.golden.json`       | Real Codex stdout sample + expected events.                                                                                                                                 | New    |
| `test/fixtures/subagent-stdout/claude.txt` + `.golden.json`      | Real Claude stdout sample + expected events.                                                                                                                                | New    |
| `test/fixtures/subagent-stdout/kimi.txt` + `.golden.json`        | Real Kimi stdout sample — silent by design, expected mostly nulls.                                                                                                          | New    |

**Note on `BUILD_DEFAULTS`:** the spec proposed adding `toolAwareStallMs` and `progressGapMs` to `BUILD_DEFAULTS`, but `BUILD_DEFAULTS` is loaded from `build/configure.cm` JSON with a typed schema in [build/orchestrator/build-config.ts:36-48](build/orchestrator/build-config.ts#L36-L48). Adding to that schema requires JSON-config migration which is overkill for v1 code constants. Instead we add plain module-level `export const` declarations in the same file. If operators need to tune them later, they go through env vars or a future schema migration. This is an intentional deviation from the spec's "Constants and config" section; the values themselves are unchanged.

**Note on existing `classifyXLine` functions:** `stall-watchdog.ts` already exports `classifyClaudeLine`, `classifyGeminiLine`, `classifyCodexLine`, `classifyKimiLine` (lines 257-307). These are booleans for the unimplemented stream-json flip. The new `subagent-progress-parser.ts` is a different abstraction (returns `ProgressEvent | null`, supports prose-mode for today's CLIs). Both coexist; the new module is what the watchdog actually consumes via `parseProgress`. The old functions remain exported for back-compat in tests.

---

## Task 1: Add tool-aware constants to build-config.ts

**Files:**

- Modify: `build/orchestrator/build-config.ts` (append-only — new exports at the bottom of the file, before line 332's `export const BUILD_DEFAULTS = loadBuildDefaults()`)

- [ ] **Step 1: Read the current end-of-file region**

Run: `tail -30 build/orchestrator/build-config.ts`

Expected: see `export const BUILD_DEFAULTS = loadBuildDefaults();` on line 332.

- [ ] **Step 2: Append the constants block**

Insert at the very end of `build/orchestrator/build-config.ts` (after line 332):

```ts
/**
 * Tool-aware stall windows. Used by the watchdog when a subagent's stdout
 * line is classified into a known tool bucket. See
 * docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md.
 *
 * Plain module constants — not part of BUILD_DEFAULTS — because they are
 * code defaults, not operator-tunable JSON config. Tuning at v1 happens
 * via the GSTACK_TOOL_AWARE_WATCHDOG=0 kill switch, not per-bucket env
 * vars.
 */
export const TOOL_AWARE_STALL_MS = {
  fast: 90_000, // 90s — Edit, Read, Write, Grep, Glob, default Bash
  slow: 600_000, // 10min — WebFetch, codex_review, kimi_print, long Bash
} as const;

/**
 * Max milliseconds of "noisy stdout but no classified progress event"
 * before the watchdog fires progress_gap. Gated on having seen at least
 * one classified event in this run — see stall-watchdog.ts.
 */
export const PROGRESS_GAP_MS = 300_000; // 5min

export type ToolBucket = "fast" | "slow";

/**
 * Tool-name → bucket map. Unknown tool names are intentionally absent
 * (the parser returns null for them, routing through legacy stallMs).
 * Adding a new tool is a one-line change here.
 */
export const TOOL_BUCKET: Readonly<Record<string, ToolBucket>> = {
  // Filesystem / search / shell — fast
  Edit: "fast",
  Read: "fast",
  Write: "fast",
  Grep: "fast",
  Glob: "fast",
  Bash: "fast", // most bashes; long bashes have their own watchdog timeout
  apply_patch: "fast", // Codex edit primitive

  // Network / LLM-driven — slow
  WebFetch: "slow",
  WebSearch: "slow",
  codex_review: "slow",
  kimi_print: "slow",
};
```

- [ ] **Step 3: Run typecheck to verify the additions compile**

Run: `bun run tsc --noEmit 2>&1 | grep -E "build-config|error" | head -20`

Expected: no errors involving `build-config.ts`. (Other unrelated errors in the codebase are fine — we only care this file is clean.)

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/build-config.ts
git commit -m "build: add tool-aware stall-window constants

TOOL_AWARE_STALL_MS, PROGRESS_GAP_MS, TOOL_BUCKET as plain module
exports. Not part of BUILD_DEFAULTS (JSON-loaded schema); v1 ships
as code defaults, env-var kill switch covers ops needs."
```

---

## Task 2: Define ProgressEvent type and parser scaffolding

**Files:**

- Create: `build/orchestrator/subagent-progress-parser.ts`

- [ ] **Step 1: Create the new file with the type, the bucket-lookup helper, and four stub parsers**

```ts
/**
 * Subagent progress parser — pure functions only, no I/O.
 *
 * Converts a single line of a subagent's stdout into a structured
 * ProgressEvent or null. The watchdog uses non-null events to apply
 * tool-aware stall windows; null lines fall through to the legacy
 * silence-based path. See
 * docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md.
 *
 * Provider strategy:
 *   - Claude: parses stream-json `tool_use` events if/when --output-format
 *     stream-json is enabled. Until then, returns null on most lines.
 *   - Gemini: pattern-matches prose markers from default `gemini --yolo`
 *     output (today's invocation).
 *   - Codex: anchors on the `exec\n<cmd>\n in <cwd>\n succeeded in Xms`
 *     prose block emitted by `codex exec`.
 *   - Kimi: silent by design (`--print --final-message-only`); always
 *     returns null. The cpu-mode watchdog covers liveness for Kimi.
 *
 * Ambiguous lines return null. The bucket lookup runs through TOOL_BUCKET
 * from build-config.ts — tools absent from that table return null even
 * when the line is otherwise pattern-matched.
 */

import { TOOL_BUCKET, type ToolBucket } from "./build-config";

export interface ProgressEvent {
  event: "TOOL_START" | "TOOL_END";
  tool: string;
  bucket: ToolBucket;
  ts: number;
}

/**
 * Look up the bucket for a parsed tool name. Returns null when the tool
 * isn't in TOOL_BUCKET — the caller should then return null from the
 * top-level parser so the watchdog falls back to legacy stallMs.
 */
function bucketFor(tool: string): ToolBucket | null {
  return TOOL_BUCKET[tool] ?? null;
}

export function parseGeminiLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

export function parseCodexLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

export function parseKimiLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

export function parseClaudeLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

// Test-only export so unit tests can verify the bucket gating without
// re-exporting the entire TOOL_BUCKET table.
export const __internals = { bucketFor };
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep "subagent-progress-parser" | head -10`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add build/orchestrator/subagent-progress-parser.ts
git commit -m "build: scaffold subagent-progress-parser

ProgressEvent type + bucket-lookup helper + four stub parsers (all
return null). Subsequent commits flesh out per-provider patterns."
```

---

## Task 3: Test fixture infrastructure — directory and a Codex sample

**Files:**

- Create: `test/fixtures/subagent-stdout/codex.txt`
- Create: `test/fixtures/subagent-stdout/codex.golden.json`

- [ ] **Step 1: Create the codex fixture (real stdout pattern from a recent run)**

Create `test/fixtures/subagent-stdout/codex.txt` with this content (each line is a separate stdout line; the fixture mimics `codex exec` output as captured under `~/.gstack/build-state/<run>/phase-*-review-*.log`):

```
OpenAI Codex v0.128.0 (research preview)
--------
workdir: /tmp/example
model: gpt-5.5
provider: openai
--------
user
Read review context at /tmp/example/input.md and review the diff.
exec
/bin/zsh -lc "git diff main..HEAD" in /tmp/example
 succeeded in 12ms:
+++ diff content here
exec
/bin/zsh -lc "cat /tmp/example/input.md" in /tmp/example
 succeeded in 4ms:
review content
codex
Reviewed the diff. The change is safe to land.
```

- [ ] **Step 2: Create the golden file**

Create `test/fixtures/subagent-stdout/codex.golden.json`:

```json
{
  "comment": "Each row is { lineIndex, expected }. lineIndex is 0-based against codex.txt after splitting on \\n. expected=null means parser must return null for that line.",
  "rows": [
    { "lineIndex": 0, "expected": null },
    { "lineIndex": 1, "expected": null },
    { "lineIndex": 2, "expected": null },
    { "lineIndex": 7, "expected": null },
    {
      "lineIndex": 8,
      "expected": { "event": "TOOL_START", "tool": "Bash", "bucket": "fast" }
    },
    { "lineIndex": 9, "expected": null },
    {
      "lineIndex": 10,
      "expected": { "event": "TOOL_END", "tool": "Bash", "bucket": "fast" }
    }
  ]
}
```

Note: `ts` is omitted from `expected` because the parser will set it from the caller's `now` — the test asserts the other fields and checks `ts === now`.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/subagent-stdout/codex.txt test/fixtures/subagent-stdout/codex.golden.json
git commit -m "test: codex stdout fixture + golden events

Real codex exec output shape: 'exec\\n<cmd>\\n in <cwd>\\n succeeded
in Xms:' is the anchor for TOOL_START/TOOL_END."
```

---

## Task 4: Implement Codex parser (TDD)

**Files:**

- Modify: `build/orchestrator/subagent-progress-parser.ts`
- Create: `build/orchestrator/__tests__/subagent-progress-parser.test.ts`

- [ ] **Step 1: Write the failing test (codex case)**

Create `build/orchestrator/__tests__/subagent-progress-parser.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseCodexLine,
  parseGeminiLine,
  parseKimiLine,
  parseClaudeLine,
  type ProgressEvent,
} from "../subagent-progress-parser";

const FIXTURE_ROOT = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "subagent-stdout",
);

interface GoldenRow {
  lineIndex: number;
  expected: Omit<ProgressEvent, "ts"> | null;
}

function loadFixture(name: string): { lines: string[]; rows: GoldenRow[] } {
  const text = fs.readFileSync(path.join(FIXTURE_ROOT, `${name}.txt`), "utf8");
  const golden = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, `${name}.golden.json`), "utf8"),
  ) as { rows: GoldenRow[] };
  return { lines: text.split("\n"), rows: golden.rows };
}

function assertRow(
  name: string,
  parser: (line: string, now: number) => ProgressEvent | null,
) {
  const { lines, rows } = loadFixture(name);
  const NOW = 1_000_000;
  for (const row of rows) {
    const line = lines[row.lineIndex];
    const got = parser(line, NOW);
    if (row.expected === null) {
      expect(got).toBeNull();
    } else {
      expect(got).not.toBeNull();
      expect(got!.event).toBe(row.expected.event);
      expect(got!.tool).toBe(row.expected.tool);
      expect(got!.bucket).toBe(row.expected.bucket);
      expect(got!.ts).toBe(NOW);
    }
  }
}

describe("parseCodexLine", () => {
  it("matches the golden fixture", () => {
    assertRow("codex", parseCodexLine);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test build/orchestrator/__tests__/subagent-progress-parser.test.ts -t "parseCodexLine"`

Expected: FAIL — parser currently returns null on every line, so the `TOOL_START` and `TOOL_END` rows fail with `expect(got).not.toBeNull()`.

- [ ] **Step 3: Implement parseCodexLine**

In `build/orchestrator/subagent-progress-parser.ts`, replace the stub `parseCodexLine` with:

```ts
/**
 * Codex `exec` block markers. The block shape is:
 *   exec
 *   /bin/zsh -lc "<cmd>" in <cwd>
 *    succeeded in Xms:
 * We map every `exec` line to TOOL_START with tool="Bash" (Codex's
 * shell tool maps to our Bash bucket), and every ` succeeded in ` line
 * to TOOL_END. Lines that contain `succeeded in` but don't start with
 * leading whitespace are NOT matched (avoids false-matching prose).
 */
export function parseCodexLine(
  line: string,
  now: number,
): ProgressEvent | null {
  if (line === "exec") {
    const bucket = bucketFor("Bash");
    if (bucket === null) return null;
    return { event: "TOOL_START", tool: "Bash", bucket, ts: now };
  }
  if (/^ succeeded in \d+ms:?$/.test(line)) {
    const bucket = bucketFor("Bash");
    if (bucket === null) return null;
    return { event: "TOOL_END", tool: "Bash", bucket, ts: now };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test build/orchestrator/__tests__/subagent-progress-parser.test.ts -t "parseCodexLine"`

Expected: PASS — golden rows match.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/subagent-progress-parser.ts \
        build/orchestrator/__tests__/subagent-progress-parser.test.ts
git commit -m "parser: codex exec-block anchor → TOOL_START/TOOL_END

'exec' line → TOOL_START Bash. ' succeeded in Xms:' line → TOOL_END
Bash. Both gated on TOOL_BUCKET['Bash'] being present (it is). Fixture
test pins the shape."
```

---

## Task 5: Implement Gemini parser (TDD)

**Files:**

- Create: `test/fixtures/subagent-stdout/gemini.txt`
- Create: `test/fixtures/subagent-stdout/gemini.golden.json`
- Modify: `build/orchestrator/subagent-progress-parser.ts`
- Modify: `build/orchestrator/__tests__/subagent-progress-parser.test.ts`

- [ ] **Step 1: Create the gemini fixture**

Create `test/fixtures/subagent-stdout/gemini.txt`:

```
Gemini CLI 0.4.2
working dir: /tmp/example
> Read instructions at /tmp/example/input.md
Tool: read_file
  path: /tmp/example/input.md
Tool finished.
Tool: write_file
  path: /tmp/example/output.md
Tool finished.
> done
```

- [ ] **Step 2: Create the golden file**

Create `test/fixtures/subagent-stdout/gemini.golden.json`:

```json
{
  "comment": "Gemini emits 'Tool: <name>' and 'Tool finished.' prose markers.",
  "rows": [
    { "lineIndex": 0, "expected": null },
    {
      "lineIndex": 3,
      "expected": { "event": "TOOL_START", "tool": "Read", "bucket": "fast" }
    },
    {
      "lineIndex": 5,
      "expected": { "event": "TOOL_END", "tool": "Read", "bucket": "fast" }
    },
    {
      "lineIndex": 6,
      "expected": { "event": "TOOL_START", "tool": "Write", "bucket": "fast" }
    },
    {
      "lineIndex": 8,
      "expected": { "event": "TOOL_END", "tool": "Write", "bucket": "fast" }
    }
  ]
}
```

- [ ] **Step 3: Add the test case (will fail)**

Append to the `describe` blocks in `build/orchestrator/__tests__/subagent-progress-parser.test.ts`:

```ts
describe("parseGeminiLine", () => {
  it("matches the golden fixture", () => {
    assertRow("gemini", parseGeminiLine);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test build/orchestrator/__tests__/subagent-progress-parser.test.ts -t "parseGeminiLine"`

Expected: FAIL.

- [ ] **Step 5: Implement parseGeminiLine**

Replace the stub in `build/orchestrator/subagent-progress-parser.ts`:

```ts
/**
 * Gemini prose-mode markers. Today's `gemini --yolo` emits:
 *   Tool: <snake_name>
 *     path: ...
 *   Tool finished.
 * We track the most recent TOOL_START name on a per-line basis via a
 * module-private variable... NO. That would not be pure. Instead, the
 * TOOL_END row's lookup uses the line text alone — but "Tool finished."
 * doesn't carry the tool name, so we can't emit a meaningful TOOL_END
 * from a single line. v1 compromise: only emit TOOL_START. TOOL_END is
 * inferred at the watchdog level when the next TOOL_START arrives or
 * when the stall window closes. This keeps the parser pure.
 */
const GEMINI_TOOL_MAP: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  grep: "Grep",
  glob: "Glob",
  run_shell_command: "Bash",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

export function parseGeminiLine(
  line: string,
  now: number,
): ProgressEvent | null {
  const m = /^Tool: (\w+)/.exec(line);
  if (!m) return null;
  const canonical = GEMINI_TOOL_MAP[m[1]];
  if (!canonical) return null;
  const bucket = bucketFor(canonical);
  if (bucket === null) return null;
  return { event: "TOOL_START", tool: canonical, bucket, ts: now };
}
```

- [ ] **Step 6: Update the golden fixture to drop TOOL_END expectations**

Replace `test/fixtures/subagent-stdout/gemini.golden.json` with:

```json
{
  "comment": "Gemini emits 'Tool: <name>' lines. v1 parser emits TOOL_START only; TOOL_END is inferred at the watchdog level.",
  "rows": [
    { "lineIndex": 0, "expected": null },
    {
      "lineIndex": 3,
      "expected": { "event": "TOOL_START", "tool": "Read", "bucket": "fast" }
    },
    { "lineIndex": 5, "expected": null },
    {
      "lineIndex": 6,
      "expected": { "event": "TOOL_START", "tool": "Write", "bucket": "fast" }
    },
    { "lineIndex": 8, "expected": null }
  ]
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test build/orchestrator/__tests__/subagent-progress-parser.test.ts -t "parseGeminiLine"`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add build/orchestrator/subagent-progress-parser.ts \
        build/orchestrator/__tests__/subagent-progress-parser.test.ts \
        test/fixtures/subagent-stdout/gemini.txt \
        test/fixtures/subagent-stdout/gemini.golden.json
git commit -m "parser: gemini 'Tool: <name>' → TOOL_START

snake_case tool names mapped to canonical PascalCase via GEMINI_TOOL_MAP.
TOOL_END is inferred at the watchdog (next TOOL_START or stall) since
'Tool finished.' carries no name. Parser stays pure."
```

---

## Task 6: Implement Kimi and Claude parsers (both return null at v1)

**Files:**

- Create: `test/fixtures/subagent-stdout/kimi.txt`
- Create: `test/fixtures/subagent-stdout/kimi.golden.json`
- Create: `test/fixtures/subagent-stdout/claude.txt`
- Create: `test/fixtures/subagent-stdout/claude.golden.json`
- Modify: `build/orchestrator/__tests__/subagent-progress-parser.test.ts`

The spec specifies these return null at v1: Kimi is silent by design (`--print --final-message-only`), and Claude isn't invoked with `--output-format stream-json` today. We still want fixtures + tests pinning the behavior so a future flip is detectable.

- [ ] **Step 1: Create kimi fixture**

Create `test/fixtures/subagent-stdout/kimi.txt`:

```
[OUT] /tmp/example/output.md
[ERR]
[ERR] To resume this session: kimi -r abc-123
```

Create `test/fixtures/subagent-stdout/kimi.golden.json`:

```json
{
  "comment": "Kimi --print --final-message-only is silent. All lines parse to null. CPU-mode watchdog covers liveness.",
  "rows": [
    { "lineIndex": 0, "expected": null },
    { "lineIndex": 1, "expected": null },
    { "lineIndex": 2, "expected": null }
  ]
}
```

- [ ] **Step 2: Create claude fixture**

Create `test/fixtures/subagent-stdout/claude.txt`:

```
Loading skill: using-superpowers
Working on the task.
Done.
```

Create `test/fixtures/subagent-stdout/claude.golden.json`:

```json
{
  "comment": "Claude is invoked in default prose mode today. v1 parser returns null. When --output-format stream-json is enabled later, this fixture will be replaced with JSON lines.",
  "rows": [
    { "lineIndex": 0, "expected": null },
    { "lineIndex": 1, "expected": null },
    { "lineIndex": 2, "expected": null }
  ]
}
```

- [ ] **Step 3: Add the test cases**

Append to `build/orchestrator/__tests__/subagent-progress-parser.test.ts`:

```ts
describe("parseKimiLine", () => {
  it("returns null for all lines (silent by design)", () => {
    assertRow("kimi", parseKimiLine);
  });
});

describe("parseClaudeLine", () => {
  it("returns null for all lines (no stream-json yet)", () => {
    assertRow("claude", parseClaudeLine);
  });
});
```

- [ ] **Step 4: Run all parser tests**

Run: `bun test build/orchestrator/__tests__/subagent-progress-parser.test.ts`

Expected: 4 tests pass (codex, gemini, kimi, claude).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/subagent-stdout/kimi.txt \
        test/fixtures/subagent-stdout/kimi.golden.json \
        test/fixtures/subagent-stdout/claude.txt \
        test/fixtures/subagent-stdout/claude.golden.json \
        build/orchestrator/__tests__/subagent-progress-parser.test.ts
git commit -m "parser: pin kimi/claude null behavior with fixtures

Both return null at v1 by design. Fixtures + tests make a future
stream-json flip detectable (golden must change)."
```

---

## Task 7: Add bucket-gating regression test

**Files:**

- Modify: `build/orchestrator/__tests__/subagent-progress-parser.test.ts`

The parser must return null when a recognized tool name isn't in `TOOL_BUCKET`. This protects against the "new tool we haven't classified" failure mode in the spec.

- [ ] **Step 1: Write the failing test**

Append to `build/orchestrator/__tests__/subagent-progress-parser.test.ts`:

```ts
describe("bucket gating", () => {
  it("returns null for a Gemini tool not in TOOL_BUCKET", () => {
    // 'image_generation' is a hypothetical tool not in TOOL_BUCKET.
    // Even if Gemini emits 'Tool: image_generation', parser must return
    // null so the watchdog falls back to legacy stallMs.
    const line = "Tool: image_generation";
    const got = parseGeminiLine(line, 1000);
    expect(got).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test build/orchestrator/__tests__/subagent-progress-parser.test.ts -t "bucket gating"`

Expected: PASS — `image_generation` isn't in `GEMINI_TOOL_MAP`, so the parser returns null at the first lookup. This is the "two-line shield" — the snake→canonical map AND the canonical→bucket map both filter, so a Gemini tool we recognize but haven't classified still returns null. The test pins this invariant.

- [ ] **Step 3: Commit**

```bash
git add build/orchestrator/__tests__/subagent-progress-parser.test.ts
git commit -m "test: pin parser null-fallback for unmapped tools"
```

---

## Task 8: Extend StallWatchdogOptions and types

**Files:**

- Modify: `build/orchestrator/stall-watchdog.ts`

- [ ] **Step 1: Add the new options to the interface**

In `build/orchestrator/stall-watchdog.ts`, find `export interface StallWatchdogOptions` (around line 46) and add the three new optional fields. Keep the existing fields untouched.

Add after the existing `sampleCpuFn?` field (around line 89, before the closing `}`):

```ts
  /**
   * Optional progress-line parser. When provided, the watchdog feeds
   * each stdout/stderr line to this function. Non-null ProgressEvents
   * update internal state:
   *   - TOOL_START sets currentToolBucket and lastClassifiedActivityAt.
   *   - TOOL_END clears currentToolBucket; lastClassifiedActivityAt updates.
   * The effective stall window per tick depends on currentToolBucket:
   *   - "slow" → toolStallMs.slow
   *   - "fast" → toolStallMs.fast
   *   - null   → legacy stallMs (today's behavior)
   * Required pair: toolStallMs and progressGapMs must also be set when
   * parseProgress is provided.
   */
  parseProgress?: (
    line: string,
    now: number,
  ) => import("./subagent-progress-parser").ProgressEvent | null;

  /** Tool-aware window thresholds. Required when parseProgress is set. */
  toolStallMs?: { fast: number; slow: number };

  /**
   * Max ms the watchdog tolerates noisy stdout with no parsed events
   * before firing SIGTERM with killReason="progress_gap". Required when
   * parseProgress is set. Gated on having seen at least one parsed
   * event in this run — see implementation.
   */
  progressGapMs?: number;
```

- [ ] **Step 2: Extend the controller return shape**

`killReason()` already exists on `StallWatchdogController` (line 113 returns `string | undefined`). The spec wants two values: `"silence" | "progress_gap"`. The existing implementation returns `"auth_required"` and `"stall"`. Extend the union; do not narrow it.

In `build/orchestrator/stall-watchdog.ts`, find the existing comment on `killReason` (around line 112-113):

```ts
/** If the watchdog killed for an auth prompt, returns "auth_required". */
killReason: () => string | undefined;
```

Replace with:

```ts
/**
 * Why the watchdog killed. Returns:
 *   - "auth_required" — auth-prompt fast-kill (pre-existing).
 *   - "stall"         — legacy silence-based stall (pre-existing).
 *   - "silence"       — tool-aware silence kill (new, when parseProgress set).
 *   - "progress_gap"  — noisy stdout without classified progress (new).
 *   - undefined       — watchdog has not killed.
 */
killReason: () => string | undefined;
```

- [ ] **Step 3: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep "stall-watchdog" | head -20`

Expected: no new errors. (The cyclic import of `ProgressEvent` from `./subagent-progress-parser` resolves cleanly because `subagent-progress-parser.ts` only imports from `./build-config`, not from `./stall-watchdog`.)

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/stall-watchdog.ts
git commit -m "watchdog: add parseProgress/toolStallMs/progressGapMs opts

Interface-only change. No new behavior yet — fields are optional and
unused. Lets the test in the next task target the new shape."
```

---

## Task 9: Wire tool-aware windowing into the watchdog (TDD)

**Files:**

- Create: `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`
- Modify: `build/orchestrator/stall-watchdog.ts`

- [ ] **Step 1: Write the first failing test — slow bucket gives a longer window**

Create `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`. Copy the `makeFakeClock` and `makeFakeChild` helpers from the existing `stall-watchdog.test.ts` (lines 14-114) — the existing file shows the harness pattern. Then add:

```ts
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { attachStallWatchdog } from "../stall-watchdog";
import type { ProgressEvent } from "../subagent-progress-parser";
import type { ChildProcess } from "node:child_process";

// PASTE makeFakeClock() and makeFakeChild() here verbatim from
// stall-watchdog.test.ts lines 14-114. They are not exported from the
// test module — copying is the established pattern for this test suite.

// [insert makeFakeClock here]
// [insert makeFakeChild here]

function slowToolStart(now: number): ProgressEvent {
  return { event: "TOOL_START", tool: "WebFetch", bucket: "slow", ts: now };
}
function fastToolStart(now: number): ProgressEvent {
  return { event: "TOOL_START", tool: "Edit", bucket: "fast", ts: now };
}

describe("attachStallWatchdog tool-aware", () => {
  it("slow bucket survives 8min of silence (slow window is 10min)", () => {
    const { clock, advance } = makeFakeClock();
    const { child, emitStdout } = makeFakeChild();
    let killed = false;

    const w = attachStallWatchdog(
      { mode: "stream", child },
      {
        stallMs: 60_000, // legacy 60s — irrelevant once slow bucket is active
        provider: "shell",
        clock,
        onStallKill: () => {
          killed = true;
        },
        parseProgress: (line) =>
          line === "TOOL_START_SLOW" ? slowToolStart(clock.now()) : null,
        toolStallMs: { fast: 90_000, slow: 600_000 },
        progressGapMs: 300_000,
      },
    );

    emitStdout("TOOL_START_SLOW\n");
    advance(8 * 60_000); // 8 minutes
    expect(killed).toBe(false);
    expect(w.stallKilled()).toBe(false);

    w.stop();
  });
});
```

- [ ] **Step 2: Run the test — it should fail because tool-aware windowing isn't wired yet**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "slow bucket survives"`

Expected: FAIL — at 60s of silence (legacy `stallMs`), the watchdog kills, so `killed` is `true` after 8min.

- [ ] **Step 3: Wire `parseProgress` into the `onLine` handler and `poll`**

In `build/orchestrator/stall-watchdog.ts`, inside `attachStallWatchdog` (after the existing variable declarations around line 344):

Add new state right after `let killReason: string | undefined = undefined;`:

```ts
// Tool-aware state. All null when parseProgress is not provided —
// the legacy branches below treat null exactly as today's behavior.
const parseProgress = opts.parseProgress;
const toolStallMs = opts.toolStallMs;
const progressGapMs = opts.progressGapMs;
let currentToolBucket: "fast" | "slow" | null = null;
let lastClassifiedActivityAt: number | null = null;
let lastClassifiedTool: string | null = null;
// Sticky bucket — represents the bucket at the most recent classified
// event, preserved past TOOL_END. Task 14 wires the controller getter.
let lastClassifiedBucket: "fast" | "slow" | null = null;
```

Inside the existing `onLine` handler (around line 375), after the `if (/\S/.test(text)) recordActivity();` line, parse progress events. Insert this block before the auth-prompt check:

```ts
// Tool-aware progress parsing. Lines are split on \n inside this
// chunk; each non-empty line goes to the parser. Errors swallowed —
// a throwing parser falls through to legacy behavior, which is
// exactly today's degradation.
if (parseProgress && !killed) {
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue;
    let evt: ProgressEvent | null = null;
    try {
      evt = parseProgress(rawLine, clock.now());
    } catch {
      // Parser threw. Treat this line as if it returned null.
      evt = null;
    }
    if (evt === null) continue;
    lastClassifiedActivityAt = clock.now();
    lastClassifiedTool = evt.tool;
    lastClassifiedBucket = evt.bucket;
    if (evt.event === "TOOL_START") {
      currentToolBucket = evt.bucket;
    } else {
      // TOOL_END clears the bucket (the next tick uses the legacy
      // stallMs window until a new TOOL_START arrives). We do NOT
      // clear lastClassifiedBucket — it's sticky for halt-event quoting.
      currentToolBucket = null;
    }
  }
}
```

Add the `ProgressEvent` import at the top of the file (after the existing imports around line 37):

```ts
import type { ProgressEvent } from "./subagent-progress-parser";
```

Then replace the silence-check inside `poll` (around line 467-470):

```ts
    const silence = clock.now() - lastActivityAt;
    if (silence >= stallMs) {
```

with:

```ts
    const silence = clock.now() - lastActivityAt;
    // Effective stall window:
    //   - "slow" → toolStallMs.slow
    //   - "fast" → toolStallMs.fast
    //   - null   → legacy stallMs
    // The legacy path is preserved EXACTLY when parseProgress is absent
    // or when no TOOL_START has been observed yet.
    let effectiveStallMs = stallMs;
    if (currentToolBucket !== null && toolStallMs) {
      effectiveStallMs =
        currentToolBucket === "slow" ? toolStallMs.slow : toolStallMs.fast;
    }
    if (silence >= effectiveStallMs) {
```

- [ ] **Step 4: Run the test — it should pass**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "slow bucket survives"`

Expected: PASS. The watchdog now sees `currentToolBucket === "slow"` after the `TOOL_START_SLOW` line, uses `toolStallMs.slow = 600_000`, and doesn't trip at 8 minutes.

- [ ] **Step 5: Run the existing watchdog test suite — make sure nothing regresses**

Run: `bun test build/orchestrator/__tests__/stall-watchdog.test.ts`

Expected: ALL existing tests still pass. (None of them set `parseProgress`, so `currentToolBucket` stays `null` throughout, and the effective window equals `stallMs`. This is the degrade-to-legacy invariant.)

- [ ] **Step 6: Commit**

```bash
git add build/orchestrator/stall-watchdog.ts \
        build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts
git commit -m "watchdog: tool-aware stall window via parseProgress

TOOL_START sets currentToolBucket; the silence check uses
toolStallMs.{fast,slow} when set, else legacy stallMs. Existing
suite unaffected (no test sets parseProgress)."
```

---

## Task 10: Add killReason="silence" when tool-aware path kills

**Files:**

- Modify: `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`
- Modify: `build/orchestrator/stall-watchdog.ts`

- [ ] **Step 1: Write the failing test**

Append to `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts` inside the existing `describe`:

```ts
it("fast bucket kills at 90s with killReason=silence", () => {
  const { clock, advance } = makeFakeClock();
  const { child, emitStdout } = makeFakeChild();
  let killedSilenceMs: number | null = null;

  const w = attachStallWatchdog(
    { mode: "stream", child },
    {
      stallMs: 60_000,
      provider: "shell",
      clock,
      onStallKill: (s) => {
        killedSilenceMs = s;
      },
      parseProgress: (line) =>
        line === "TOOL_START_FAST" ? fastToolStart(clock.now()) : null,
      toolStallMs: { fast: 90_000, slow: 600_000 },
      progressGapMs: 300_000,
    },
  );

  emitStdout("TOOL_START_FAST\n");
  advance(120_000); // 120s — past the 90s fast window

  expect(w.stallKilled()).toBe(true);
  expect(killedSilenceMs).not.toBeNull();
  expect(killedSilenceMs! >= 90_000).toBe(true);
  expect(w.killReason()).toBe("silence");

  w.stop();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "fast bucket kills"`

Expected: FAIL — `killReason()` currently returns `"stall"` (the legacy code sets `killReason ?? "stall"` in the silence-kill branch).

- [ ] **Step 3: Set killReason="silence" in the tool-aware path**

In `build/orchestrator/stall-watchdog.ts`, find the silence-kill branch (the `if (silence >= effectiveStallMs)` block from Task 9). Replace this line:

```ts
killReason = killReason ?? "stall";
```

with:

```ts
// "silence" when the tool-aware path is active (parseProgress set,
// we have a current bucket or have ever classified). "stall" for
// the legacy path so existing consumers / tests see the same string.
if (killReason === undefined) {
  killReason =
    parseProgress && lastClassifiedActivityAt !== null ? "silence" : "stall";
}
```

- [ ] **Step 4: Run the new test — it passes**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "fast bucket kills"`

Expected: PASS.

- [ ] **Step 5: Run the existing watchdog suite — legacy path still says "stall"**

Run: `bun test build/orchestrator/__tests__/stall-watchdog.test.ts`

Expected: ALL pass. (Legacy tests don't set `parseProgress`, so `parseProgress` is `undefined` and `killReason` stays `"stall"`.)

- [ ] **Step 6: Commit**

```bash
git add build/orchestrator/stall-watchdog.ts \
        build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts
git commit -m "watchdog: distinguish 'silence' (tool-aware) from 'stall' (legacy)

killReason='silence' only when parseProgress is wired AND we've seen
at least one classified event. Legacy path is byte-identical."
```

---

## Task 11: Progress-gap detector (TDD)

**Files:**

- Modify: `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`
- Modify: `build/orchestrator/stall-watchdog.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`:

```ts
it("kills with killReason=progress_gap when noisy stdout has no parsed events", () => {
  const { clock, advance } = makeFakeClock();
  const { child, emitStdout } = makeFakeChild();
  let killedSilenceMs: number | null = null;

  const w = attachStallWatchdog(
    { mode: "stream", child },
    {
      stallMs: 60_000,
      provider: "shell",
      clock,
      onStallKill: (s) => {
        killedSilenceMs = s;
      },
      parseProgress: (line) =>
        line === "TOOL_START_FAST" ? fastToolStart(clock.now()) : null,
      toolStallMs: { fast: 90_000, slow: 600_000 },
      progressGapMs: 300_000, // 5 min
    },
  );

  // Seed a classified event so the gap detector is "armed".
  emitStdout("TOOL_START_FAST\n");
  // Immediately TOOL_END equivalent: clear the bucket by emitting a
  // non-classified line. Then the bucket is null, fast window is gone.
  // To keep the fast-kill from firing, emit a noisy non-classified
  // line every 30s for 6 minutes. Stdout is fresh (lastActivityAt
  // resets every chunk), so legacy stallMs does NOT trip; but
  // progressGapMs (5min, only-on-classified-events) MUST trip.
  //
  // First clear the bucket — emit a fake "TOOL_END" line that the
  // parser treats as null. We'll use literal "noise" so the parser
  // (which only knows TOOL_START_FAST/SLOW) returns null and
  // currentToolBucket stays "fast"... wait, currentToolBucket is set
  // from the prior TOOL_START. The bucket only clears on a TOOL_END
  // ProgressEvent. Our parser doesn't emit TOOL_END for "noise". So
  // the bucket stays "fast" — fast window is 90s, and noisy stdout
  // resets lastActivityAt every chunk, so fast window never closes.
  //
  // That's actually the bug we're testing — the gap detector must
  // still fire even with bucket="fast" and fresh lastActivityAt.

  for (let i = 0; i < 12; i++) {
    advance(30_000); // 30s
    emitStdout("noise\n");
  }
  // 12 * 30s = 360s = 6 min. Gap is 5 min, so the watchdog should
  // have fired between minute 5 and minute 6.

  expect(w.stallKilled()).toBe(true);
  expect(w.killReason()).toBe("progress_gap");
  expect(killedSilenceMs).not.toBeNull();

  w.stop();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "progress_gap"`

Expected: FAIL — at minute 6, `stallKilled()` is `false` because nothing in the existing watchdog checks the gap.

- [ ] **Step 3: Add the progress-gap arm to `poll`**

In `build/orchestrator/stall-watchdog.ts`, inside `poll`, add this block AFTER the existing silence-check block (the one with `if (silence >= effectiveStallMs)`). The gap check runs only when the silence check did NOT trip (the `killed` guard handles that).

```ts
// Progress-gap arm. Gated on:
//   - parseProgress is wired,
//   - we've seen at least one classified event in this run,
//   - the gap since the last classified event exceeds progressGapMs.
// Independent of lastActivityAt — that's the whole point. A subagent
// that's babbling but not making classifiable progress should be
// killed even if stdout is fresh.
if (
  !killed &&
  parseProgress &&
  progressGapMs !== undefined &&
  lastClassifiedActivityAt !== null
) {
  const gap = clock.now() - lastClassifiedActivityAt;
  if (gap >= progressGapMs) {
    killed = true;
    killReason = "progress_gap";
    try {
      opts.onStallKill?.(gap);
    } catch {
      // Callback errors are swallowed.
    }
    if (source.mode === "stream" || source.mode === "cpu") {
      const pid = source.child.pid;
      if (typeof pid === "number") {
        killProcessAndGroup(pid, "SIGTERM");
        killTimerHandle = clock.setTimeout(() => {
          killProcessAndGroup(pid, "SIGKILL");
        }, gracePeriodMs);
      }
      if (pollHandle !== null) {
        clock.clearInterval(pollHandle);
        pollHandle = null;
      }
      source.child.stdout?.off("data", onLine);
      source.child.stderr?.off("data", onLine);
    } else {
      stop();
    }
  }
}
```

- [ ] **Step 4: Run the new test**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "progress_gap"`

Expected: PASS.

- [ ] **Step 5: Run the full watchdog suite**

Run: `bun test build/orchestrator/__tests__/stall-watchdog.test.ts build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`

Expected: all pass — legacy tests unaffected (they don't set `parseProgress`, so `lastClassifiedActivityAt` stays `null` and the gap arm short-circuits).

- [ ] **Step 6: Commit**

```bash
git add build/orchestrator/stall-watchdog.ts \
        build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts
git commit -m "watchdog: progress-gap kill arm

When parseProgress is wired and we've seen >=1 classified event but
the last one is >progressGapMs old, SIGTERM with reason=progress_gap.
Independent of raw stdout activity — catches 'babbling but not
working' stuck subagents. Legacy path unaffected."
```

---

## Task 12: Parser-throws regression test

**Files:**

- Modify: `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`

- [ ] **Step 1: Write the test**

Append:

```ts
it("parser throw does not crash the watchdog", () => {
  const { clock, advance } = makeFakeClock();
  const { child, emitStdout } = makeFakeChild();
  let killed = false;

  const w = attachStallWatchdog(
    { mode: "stream", child },
    {
      stallMs: 60_000,
      provider: "shell",
      clock,
      onStallKill: () => {
        killed = true;
      },
      parseProgress: () => {
        throw new Error("parser blew up");
      },
      toolStallMs: { fast: 90_000, slow: 600_000 },
      progressGapMs: 300_000,
    },
  );

  // Throwing parser must not propagate. stdout still resets
  // lastActivityAt, so the watchdog should NOT kill in the first 30s.
  emitStdout("any text\n");
  advance(30_000);
  expect(killed).toBe(false);
  expect(w.stallKilled()).toBe(false);

  // Past legacy stallMs of silence → legacy kill fires (no classified
  // events ever, so neither tool-aware nor progress-gap path triggers).
  advance(35_000); // total 65s — past 60s stallMs
  expect(killed).toBe(true);
  expect(w.killReason()).toBe("stall"); // legacy reason

  w.stop();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "parser throw"`

Expected: PASS (parser-throw branch is already inside the try/catch added in Task 9).

- [ ] **Step 3: Commit**

```bash
git add build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts
git commit -m "test: pin parser-throw degrades to legacy stall"
```

---

## Task 13: Add killReason + lastTool + lastBucket to HaltEvent schema

**Files:**

- Modify: `build/orchestrator/halt-events.ts`

- [ ] **Step 1: Add the optional fields to the HaltEvent interface**

In `build/orchestrator/halt-events.ts`, find the `HaltEvent` interface (lines 29-64). Add the new fields inside `snapshot`, since per the existing pattern that's where watchdog-derived diagnostic data lives (next to `stdoutTail`).

Insert into the `snapshot` block (before the closing `};` around line 63):

```ts
    /**
     * Why the watchdog killed. Absent for non-watchdog halts. New in
     * v1.40.x — see docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md.
     */
    killReason?: "silence" | "progress_gap" | "stall" | "auth_required";

    /** Last classified tool at kill time. Null when never classified. */
    lastTool?: string | null;

    /** Last classified bucket at kill time. Null when never classified. */
    lastBucket?: "fast" | "slow" | null;
```

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep "halt-events" | head -20`

Expected: no errors.

- [ ] **Step 3: Run halt-events tests if any exist**

Run: `ls build/orchestrator/__tests__/ | grep -i halt`

If a test file exists (e.g., `halt-events.test.ts`), run: `bun test build/orchestrator/__tests__/halt-events.test.ts`

Expected: all pass (additive optional fields don't break existing assertions).

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/halt-events.ts
git commit -m "halt-events: add killReason/lastTool/lastBucket fields

Additive only. Optional. Existing consumers ignore unknown fields.
Lets the watchdog quote its kill reason in fault rows."
```

---

## Task 14: Expose lastTool/lastBucket from the watchdog controller

**Files:**

- Modify: `build/orchestrator/stall-watchdog.ts`
- Modify: `build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`

The watchdog already exposes `killReason()`. Add `lastTool()` and `lastBucket()` getters so the wrapper in `sub-agents.ts` can hand them to halt-event emission.

- [ ] **Step 1: Write the failing test**

Append:

```ts
it("exposes lastTool and lastBucket at kill time", () => {
  const { clock, advance } = makeFakeClock();
  const { child, emitStdout } = makeFakeChild();

  const w = attachStallWatchdog(
    { mode: "stream", child },
    {
      stallMs: 60_000,
      provider: "shell",
      clock,
      onStallKill: () => {},
      parseProgress: (line) =>
        line === "TOOL_START_FAST" ? fastToolStart(clock.now()) : null,
      toolStallMs: { fast: 90_000, slow: 600_000 },
      progressGapMs: 300_000,
    },
  );

  emitStdout("TOOL_START_FAST\n");
  advance(120_000); // past 90s fast window

  expect(w.lastTool()).toBe("Edit");
  expect(w.lastBucket()).toBe("fast");

  w.stop();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "lastTool and lastBucket"`

Expected: FAIL — `lastTool` and `lastBucket` are not on the controller.

- [ ] **Step 3: Add to controller**

In `build/orchestrator/stall-watchdog.ts`:

1. In the `StallWatchdogController` interface (around line 92-114), add after `killReason`:

```ts
/**
 * Last classified tool name at kill time, or null if never
 * classified. Set when parseProgress is wired and at least one
 * ProgressEvent was emitted.
 */
lastTool: () => string | null;

/**
 * Last classified bucket at kill time, or null. Mirrors lastTool.
 */
lastBucket: () => "fast" | "slow" | null;
```

2. In the `attachStallWatchdog` return value (around line 532-540), add:

```ts
    lastTool: () => lastClassifiedTool,
    lastBucket: () => lastClassifiedBucket,
```

`lastClassifiedBucket` was already declared and populated in Task 9 — it sticks past `TOOL_END` so "bucket at the last classified event" survives even after the bucket clears for windowing purposes. This task just exposes it on the controller.

- [ ] **Step 4: Run the test**

Run: `bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts -t "lastTool and lastBucket"`

Expected: PASS.

- [ ] **Step 5: Run all watchdog tests**

Run: `bun test build/orchestrator/__tests__/stall-watchdog.test.ts build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add build/orchestrator/stall-watchdog.ts \
        build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts
git commit -m "watchdog: expose lastTool/lastBucket on controller

Tracked separately from currentToolBucket — represents 'bucket at the
last classified event', preserved past TOOL_END. Halt-event emission
quotes these."
```

---

## Task 15: Wire parser + env-var kill switch into sub-agents.ts

**Files:**

- Modify: `build/orchestrator/sub-agents.ts`

- [ ] **Step 1: Add helper to pick the right parser per provider**

In `build/orchestrator/sub-agents.ts`, add this helper right after `pickProviderForBin` (which ends around line 436):

```ts
import type { ProgressEvent } from "./subagent-progress-parser";
import {
  parseGeminiLine,
  parseCodexLine,
  parseKimiLine,
  parseClaudeLine,
} from "./subagent-progress-parser";
import { TOOL_AWARE_STALL_MS, PROGRESS_GAP_MS } from "./build-config";

/**
 * Pick the parser for a provider, or `null` to disable tool-aware
 * windowing for this subagent. Null is returned when the env-var kill
 * switch is set OR the provider has no useful parser (shell etc.).
 *
 * Exported for tests in __tests__/sub-agents-parser-pick.test.ts.
 */
export function pickParserForProvider(
  provider: Provider,
): ((line: string, now: number) => ProgressEvent | null) | null {
  if (process.env.GSTACK_TOOL_AWARE_WATCHDOG === "0") return null;
  switch (provider) {
    case "gemini":
      return parseGeminiLine;
    case "codex":
      return parseCodexLine;
    case "kimi":
      return parseKimiLine;
    case "claude":
      return parseClaudeLine;
    default:
      return null;
  }
}
```

(The two `import` blocks should be merged with the existing imports at the top of the file — they're shown together here for clarity.)

- [ ] **Step 2: Wire into the `attachStallWatchdog` call**

Find the existing call at line ~707:

```ts
const watchdog = attachStallWatchdog(
  useCpuWatchdog ? { mode: "cpu", child } : { mode: "stream", child },
  {
    stallMs: args.timeoutMs,
    provider: pickProviderForBin(args.bin),
    onStallKill: (silenceMs) => {
      stallKilled = true;
      stallSilenceMs = silenceMs;
    },
  },
);
```

Replace with:

```ts
const provider = pickProviderForBin(args.bin);
const parseProgress = pickParserForProvider(provider);
const watchdog = attachStallWatchdog(
  useCpuWatchdog ? { mode: "cpu", child } : { mode: "stream", child },
  {
    stallMs: args.timeoutMs,
    provider,
    onStallKill: (silenceMs) => {
      stallKilled = true;
      stallSilenceMs = silenceMs;
    },
    ...(parseProgress
      ? {
          parseProgress,
          toolStallMs: TOOL_AWARE_STALL_MS,
          progressGapMs: PROGRESS_GAP_MS,
        }
      : {}),
  },
);
```

- [ ] **Step 3: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep "sub-agents.ts" | head -20`

Expected: no errors.

- [ ] **Step 4: Run the existing sub-agents tests to verify no regression**

Run: `bun test build/orchestrator/__tests__/auth-prompt-watchdog.test.ts`

Expected: all pass — the auth-prompt path is unchanged; only the watchdog options got more fields.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/sub-agents.ts
git commit -m "sub-agents: wire per-provider parser into spawnCaptured

Gated by GSTACK_TOOL_AWARE_WATCHDOG (default on, =0 disables). 'shell'
provider gets no parser and stays on legacy. Codex/Gemini/Claude/Kimi
all get their respective parsers; null returns from parsers route
through legacy stallMs as before."
```

---

## Task 16: Expose killReason/lastTool/lastBucket from spawnCaptured result

**Files:**

- Modify: `build/orchestrator/sub-agents.ts`

The watchdog now knows these. The `SubAgentResult` returned by `spawnCaptured` is the natural carrier into the orchestrator's halt-event emission path.

- [ ] **Step 1: Find the SubAgentResult interface**

Run: `grep -n "stallKilled" build/orchestrator/sub-agents.ts | head -5`

Expected: line ~387 has `stallKilled: boolean;` inside an interface.

- [ ] **Step 2: Add the three new optional fields**

Open `build/orchestrator/sub-agents.ts` and find the interface block around line 385-395. Add after `stallKilled`:

```ts
  /**
   * Why the stall watchdog killed, when stallKilled is true. Absent
   * otherwise. See stall-watchdog.ts killReason() for the union.
   */
  killReason?: string;

  /**
   * Last classified tool at kill time. Null when never classified or
   * tool-aware path inactive.
   */
  lastTool?: string | null;

  /** Last classified bucket at kill time. */
  lastBucket?: "fast" | "slow" | null;
```

- [ ] **Step 3: Populate them in the `finish` function**

Look for where `stallKilled` is set on the returned result (around line 841 per the earlier grep). The block looks like:

```ts
          stallKilled,
```

inside a `resolve({...})` object. Add the three new fields right after:

```ts
          stallKilled,
          killReason: watchdog.killReason(),
          lastTool: watchdog.lastTool(),
          lastBucket: watchdog.lastBucket(),
```

- [ ] **Step 4: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep "sub-agents.ts" | head -20`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/sub-agents.ts
git commit -m "sub-agents: surface killReason/lastTool/lastBucket in result

Optional fields on SubAgentResult so the orchestrator can feed them
into halt-event emission. Backwards-compatible (optional)."
```

---

## Task 17: Wire watchdog kill info into halt-event emission

**Files:**

- Modify: `build/orchestrator/phase-runner.ts` (or wherever STALL_KILLED halt events are emitted)

The receiving sites need to copy the new optional fields from `SubAgentResult` into the `snapshot` of the emitted `HaltEvent`. Locate the emission sites and add the field copy.

- [ ] **Step 1: Find the STALL_KILLED emission sites**

Run: `grep -rn 'STALL_KILLED' build/orchestrator --include="*.ts" | grep -v test | grep -v halt-events.ts`

Expected: one or more sites that build a `HaltEvent` with `kind: "STALL_KILLED"`. Common location: `phase-runner.ts` and/or `sub-agents.ts`.

- [ ] **Step 2: Read each site and add the three fields**

For each site that constructs a `HaltEvent` with `kind: "STALL_KILLED"`, copy `result.killReason`, `result.lastTool`, `result.lastBucket` (where `result` is the `SubAgentResult` instance available at that site) into the `snapshot` block. Example:

```ts
const haltEvent: Omit<HaltEvent, "faultId" | "timestamp"> = {
  // ...existing fields...
  snapshot: {
    // ...existing snapshot fields...
    killReason: result.killReason,
    lastTool: result.lastTool ?? null,
    lastBucket: result.lastBucket ?? null,
  },
};
```

Do this for every emission site found in Step 1. If only one site emits `STALL_KILLED`, only one edit is needed.

- [ ] **Step 3: Typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep -E "phase-runner|sub-agents" | head -20`

Expected: no errors.

- [ ] **Step 4: Run a quick sanity sweep of the orchestrator test suite**

Run: `bun test build/orchestrator/__tests__/`

Expected: all pass. (No existing test asserts the absence of these new optional fields, so additive copy is safe.)

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/phase-runner.ts  # adjust paths to actual sites
git commit -m "halt-events: wire killReason/lastTool/lastBucket from watchdog

STALL_KILLED halt events now quote the last classified activity and
the kill reason. Investigator/escalation downstream can read these
directly from the snapshot."
```

---

## Task 18: Final integration check — full suite green, env-var kill switch verified

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`

Expected: all tests pass.

- [ ] **Step 2: Confirm the layering — tool-aware unit tests are env-var-independent**

Run: `GSTACK_TOOL_AWARE_WATCHDOG=0 bun test build/orchestrator/__tests__/stall-watchdog-tool-aware.test.ts`

Expected: tool-aware tests STILL pass — they construct `parseProgress` directly, bypassing the env-var-gated `pickParserForProvider`. The env-var gate is at the `sub-agents.ts` wiring layer, not inside the watchdog. This is the intended layering — the watchdog itself has no env-var dependency.

The direct verification that the env-var ACTUALLY disables the wiring is in Task 18b, not here.

- [ ] **Step 3: Run typecheck for the whole repo**

Run: `bun run tsc --noEmit 2>&1 | tail -20`

Expected: no new errors introduced by this branch. Pre-existing errors elsewhere in the codebase are out of scope.

- [ ] **Step 4: Commit (only if anything changed during verification — usually nothing)**

If steps above surfaced a fix, commit it with a `chore:` prefix. Otherwise no commit at this step.

---

## Task 18b: Env-var kill switch unit test

**Files:**

- Create: `build/orchestrator/__tests__/sub-agents-parser-pick.test.ts`

The env-var gate at the `sub-agents.ts` wiring layer is what actually disables the feature in production. Pin it with a direct unit test instead of leaving it as a deferred manual check.

- [ ] **Step 1: Write the test**

Create `build/orchestrator/__tests__/sub-agents-parser-pick.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { pickParserForProvider } from "../sub-agents";

describe("pickParserForProvider env-var kill switch", () => {
  const originalEnv = process.env.GSTACK_TOOL_AWARE_WATCHDOG;

  beforeEach(() => {
    delete process.env.GSTACK_TOOL_AWARE_WATCHDOG;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GSTACK_TOOL_AWARE_WATCHDOG;
    } else {
      process.env.GSTACK_TOOL_AWARE_WATCHDOG = originalEnv;
    }
  });

  it("returns a parser for known providers when env var is unset", () => {
    expect(pickParserForProvider("gemini")).not.toBeNull();
    expect(pickParserForProvider("codex")).not.toBeNull();
    expect(pickParserForProvider("kimi")).not.toBeNull();
    expect(pickParserForProvider("claude")).not.toBeNull();
  });

  it("returns null when GSTACK_TOOL_AWARE_WATCHDOG=0", () => {
    process.env.GSTACK_TOOL_AWARE_WATCHDOG = "0";
    expect(pickParserForProvider("gemini")).toBeNull();
    expect(pickParserForProvider("codex")).toBeNull();
    expect(pickParserForProvider("kimi")).toBeNull();
    expect(pickParserForProvider("claude")).toBeNull();
  });

  it("returns a parser when GSTACK_TOOL_AWARE_WATCHDOG=1 (explicit on)", () => {
    process.env.GSTACK_TOOL_AWARE_WATCHDOG = "1";
    expect(pickParserForProvider("gemini")).not.toBeNull();
  });

  it("returns null for the shell provider regardless of env var", () => {
    expect(pickParserForProvider("shell")).toBeNull();
    process.env.GSTACK_TOOL_AWARE_WATCHDOG = "1";
    expect(pickParserForProvider("shell")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test build/orchestrator/__tests__/sub-agents-parser-pick.test.ts`

Expected: PASS — the test exercises the env-var gate logic added in Task 15 directly.

- [ ] **Step 3: Commit**

```bash
git add build/orchestrator/__tests__/sub-agents-parser-pick.test.ts
git commit -m "test: pin GSTACK_TOOL_AWARE_WATCHDOG kill switch behavior

Direct unit test on the exported pickParserForProvider. Replaces the
deferred manual verification originally noted in Task 18."
```

---

## Task 19: Gate-tier E2E (deferred decision)

**Files:** Optionally extends an existing E2E in `test/`.

The spec's testing strategy §3 asks for a gate-tier E2E that:

1. Plants a slow operation in a Gemini phase prompt.
2. Asserts the phase completes on the new watchdog.
3. Asserts the phase is killed at the flat `stallMs` when `GSTACK_TOOL_AWARE_WATCHDOG=0`.

This is genuinely valuable but adds ~$3-4 per CI run and slows the gate tier by 2-5 minutes. Decision needed before implementing.

- [ ] **Step 1: Decide whether to implement**

Read the existing gate-tier E2E catalog in `test/helpers/touchfiles.ts` (the `E2E_TIERS` constant). If there's already a Gemini phase E2E that can be extended with one additional assertion (negligible incremental cost), implement Task 19 in full. If not, defer and document.

- [ ] **Step 2 (if implementing): Extend the existing E2E**

Identify the gate-tier Gemini E2E. Add a slow-tool scenario behind a flag (e.g., `EVALS_TOOL_AWARE_E2E=1`). Assert:

- Default run (`EVALS_TOOL_AWARE_E2E=1`) completes successfully even when the planted operation exceeds the legacy `stallMs`.
- A control run (`EVALS_TOOL_AWARE_E2E=1 GSTACK_TOOL_AWARE_WATCHDOG=0`) is killed at `stallMs`.

Both runs share the same touchfile dependency declaration in `touchfiles.ts`.

- [ ] **Step 2 (if deferring): Document the gap explicitly**

Add a note to the PR description: "Gate-tier E2E for tool-aware windowing deferred. Justification: parser unit tests + fake-clock watchdog tests pin the behavior at every level except the live CLI integration. The first real production run with the feature on is itself the integration signal — any false-positive kill or missed slow-tool case will surface immediately in halt events."

The decision should be made by the PR author based on current eval budget. Both paths are valid; the spec's "no new periodic test required at v1" note suggests deferral is acceptable.

- [ ] **Step 3: Commit (if implementing)**

```bash
git add test/helpers/touchfiles.ts test/skill-e2e-<file>.test.ts
git commit -m "test: gate-tier E2E for tool-aware watchdog windowing"
```

---

## Notes for the implementing engineer

- **Cyclic-import worry:** `subagent-progress-parser.ts` imports from `build-config.ts`. `stall-watchdog.ts` imports the `ProgressEvent` type from `subagent-progress-parser.ts`. `build-config.ts` does NOT import from either. This is a one-way fan-in — no cycle. If you accidentally introduce one (e.g., by importing the parser into `build-config.ts`), Bun will surface it as `undefined` at runtime, not a compile error.
- **TOOL_END inference:** the spec mentions that Gemini's parser only emits `TOOL_START` (the prose `Tool finished.` line carries no name). The watchdog handles this gracefully: when a new `TOOL_START` arrives, it overwrites the bucket. When no new `TOOL_START` arrives for `progressGapMs`, the gap arm fires. So TOOL_END being best-effort is structurally fine.
- **Don't add a default "shell" bucket.** The spec is explicit: unknown tools are absent from `TOOL_BUCKET` and route through legacy `stallMs`. Adding a fallback bucket breaks the "every failure mode degrades to today's behavior" invariant.
- **Don't widen the test fixtures into real CLI capture scripts.** Capturing real output drift over time and bloats the repo. Hand-curated fixtures are the contract — when a CLI changes, update the fixture.
- **PR description should call out:** (a) the `BUILD_DEFAULTS` deviation (constants live as module exports, not in the JSON schema); (b) the deferred kill-switch sanity check from Task 18 Step 2.
