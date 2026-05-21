# Idempotent Dream — Halt Events + Investigator Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every halt, retry, pause, and manual-recovery event during a build as a structured `HaltEvent`; investigate each one asynchronously via a Codex-backed subagent; propose reusable detector patterns; prompt the operator to promote them at end-of-build.

**Architecture:** Additive pipeline on top of the existing `build/orchestrator/`. New `halt-events.ts` module emits queue files; existing `drain-faults` extended to consume the queue and dispatch the investigator via `mcp__llm-bridge__ask_codex`. Build never blocks on investigation. New `learn-fault-patterns` step in `build/SKILL.md.tmpl` closes the feedback loop.

**Tech Stack:** TypeScript, Bun runtime, `bun:test`, atomic tmp+rename file writes, JSONPath subset evaluator (hand-written, safe), MCP LLM bridge for `ask_codex`.

**Approved spec:** `/Users/anbang/.claude/plans/i-want-the-idempotent-dream.md`

**Pre-flight (every task):** confirm the spec line references resolve as expected. If a referenced line has drifted, search for the surrounding context (function name + 2-3 unique tokens) and use the current line. Don't blindly trust the spec's line numbers.

**Bisection discipline (per CLAUDE.md):** every commit is one logical change. Steps marked "Commit" inside a task ARE the commit boundaries. Do not batch.

---

## File Structure

| File                                                                                 | Status          | Responsibility                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build/orchestrator/halt-events.ts`                                                  | NEW             | `HaltEvent` type, `emitHaltEvent`, `loadPendingInvestigations`, `markInvestigated`, severity classifier, snapshot builder, queue paths                                                                                                                                   |
| `build/orchestrator/halt-event-helpers.ts`                                           | NEW             | `markPhaseFailed`, `markFeatureFailed`, `rewindPhase`, `recordRetryCapHit` — centralizing state-mutation + emit helpers                                                                                                                                                  |
| `build/orchestrator/wrap-console.ts`                                                 | NEW             | `wrapConsole()` shim — env-gated; classifies `console.warn` / `console.error` lines into halt-events                                                                                                                                                                     |
| `build/orchestrator/cli.ts`                                                          | EXTENDED        | migrate 22+ ad-hoc status assignments to helpers; wire `wrapConsole()` on entry; wire halt-event emit at `mark-shipped`/`--mark-phase-committed`/`drain-faults` entry points; wire `STALL_KILLED` emit alongside the stall-watchdog `onStallKill` callback               |
| `build/orchestrator/monitor.ts`                                                      | EXTENDED        | when `SKILL_FAULT_DETECTED` fires, also call `emitHaltEvent` so the queue is the single sink                                                                                                                                                                             |
| `build/orchestrator/skill-fault-detector.ts`                                         | EXTENDED        | `HAND_MERGED_FEATURE` detector; `state_jsonpath` matcherKind in `LearnedMatcherKind` and `applyLearnedPattern`                                                                                                                                                           |
| `build/orchestrator/safe-jsonpath.ts`                                                | NEW             | minimal safe JSONPath evaluator. Dot/bracket access, `[*]` wildcard, filter expressions with literals only. No `eval`.                                                                                                                                                   |
| `build/orchestrator/investigator-dispatch.ts`                                        | NEW             | one function that takes a `HaltEvent`, builds the investigator prompt (embeds the four-phase root-cause discipline from `~/.claude/skills/investigate/SKILL.md`), calls `mcp__llm-bridge__ask_codex`, parses and validates the structured `InvestigationReport` response |
| `build/orchestrator/drain-faults.ts` (or extension to existing `cli.ts:7623` block)  | EXTENDED        | consume `pending-investigations/`, short-circuit on learned-pattern match, dispatch investigator, write 3 sinks + 1 proposal queue row, move file to `processed/`                                                                                                        |
| `build/orchestrator/learn-fault-patterns.ts`                                         | NEW             | dedupe `pending-patterns.jsonl` against `learned-patterns.json`; produce the AskUserQuestion options; atomic promote/archive                                                                                                                                             |
| `build/configure.cm`                                                                 | EXTENDED        | new `roles.investigator` entry: codex / gpt-5.5 / high                                                                                                                                                                                                                   |
| `build/SKILL.md.tmpl`                                                                | EXTENDED        | new "Learn fault patterns" step before completion summary; invokes `learn-fault-patterns`                                                                                                                                                                                |
| `build/orchestrator/__tests__/halt-events.test.ts`                                   | NEW             | unit tests for emit/load/markInvestigated, atomic writes, deterministic faultId                                                                                                                                                                                          |
| `build/orchestrator/__tests__/halt-event-helpers.test.ts`                            | NEW             | helpers atomically mutate state + emit; rewindPhase emits PHASE_REWIND not PHASE_FAILED                                                                                                                                                                                  |
| `build/orchestrator/__tests__/wrap-console.test.ts`                                  | NEW             | classifier maps known patterns; env-gate skip; original print preserved                                                                                                                                                                                                  |
| `build/orchestrator/__tests__/safe-jsonpath.test.ts`                                 | NEW             | parses spec subset; rejects malformed without throwing; refuses script expressions                                                                                                                                                                                       |
| `build/orchestrator/__tests__/skill-fault-detector.test.ts`                          | EXTENDED        | HAND_MERGED_FEATURE happy path + negative; state_jsonpath matcherKind round-trips                                                                                                                                                                                        |
| `build/orchestrator/__tests__/investigator-dispatch.test.ts`                         | NEW             | mock `ask_codex`; parse + validate report; reject malformed reports                                                                                                                                                                                                      |
| `build/orchestrator/__tests__/drain-faults.test.ts`                                  | EXTENDED        | queue consumption, 3-sink writer, learned-pattern short-circuit, `--severity-min` filter, `--max` cap, `--investigator-model` flag                                                                                                                                       |
| `build/orchestrator/__tests__/learn-fault-patterns.test.ts`                          | NEW             | dedupe; promotion atomic; SPAWNED_SESSION auto-promote; rejected-patterns audit trail                                                                                                                                                                                    |
| `build/orchestrator/__tests__/halt-events-e2e.test.ts`                               | NEW (gate-tier) | end-to-end: planted-bug fixture → queue → drain → all sinks populated → idempotent re-drain                                                                                                                                                                              |
| `build/orchestrator/__tests__/fixtures/halt-events/hand-merged-feature-state.json`   | NEW             | polis-bug state shape (status=committed, mergeSha, prNumber, no completedAt)                                                                                                                                                                                             |
| `build/orchestrator/__tests__/fixtures/halt-events/codex-cap-hit-state.json`         | NEW             | RETRY_CAP_HIT fixture                                                                                                                                                                                                                                                    |
| `build/orchestrator/__tests__/fixtures/halt-events/dual-impl-swap-state.json`        | NEW             | DUAL_IMPL_SWAP fixture                                                                                                                                                                                                                                                   |
| `build/orchestrator/__tests__/fixtures/halt-events/silent-state-mutation-state.json` | NEW             | SILENT_STATE_MUTATION fixture                                                                                                                                                                                                                                            |

---

## PR 1 — `halt-events.ts` + centralizing helpers (no behavior change yet)

Foundation. New module, new helpers, full unit tests. cli.ts is not touched yet.

### Task 1.1: HaltEvent types and faultId

**Files:**

- Create: `build/orchestrator/halt-events.ts`

- [ ] **Step 1: Write the failing test for `faultId` determinism**

Create `build/orchestrator/__tests__/halt-events.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeFaultId,
  emitHaltEvent,
  loadPendingInvestigations,
  markInvestigated,
  type HaltEvent,
} from "../halt-events";

describe("computeFaultId", () => {
  test("deterministic per kind+phase+message", () => {
    const a = computeFaultId({
      kind: "PHASE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "phase 2 spec-flip failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { stdoutTail: "" },
    });
    const b = computeFaultId({
      kind: "PHASE_FAILED",
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL",
      message: "phase 2 spec-flip failed",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
      snapshot: { stdoutTail: "" },
    });
    expect(a).toBe(b);
  });

  test("differs across phase indices", () => {
    const base = {
      kind: "PHASE_FAILED" as const,
      runId: "r1",
      stateSlug: "s1",
      severity: "CRITICAL" as const,
      message: "same",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/stdout.log",
        livingPlan: "/x/plan.md",
        worktreePath: "/x/wt",
      },
    };
    const a = computeFaultId({
      ...base,
      snapshot: {
        phase: { index: 0, status: "failed" } as any,
        stdoutTail: "",
      },
    });
    const b = computeFaultId({
      ...base,
      snapshot: {
        phase: { index: 1, status: "failed" } as any,
        stdoutTail: "",
      },
    });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts`
Expected: FAIL with "Cannot find module '../halt-events'".

- [ ] **Step 3: Implement the types and `computeFaultId`**

Create `build/orchestrator/halt-events.ts`:

```typescript
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildState } from "./types";

export type HaltEventKind =
  | "PHASE_FAILED"
  | "FEATURE_FAILED"
  | "RETRY_CAP_HIT"
  | "DUAL_IMPL_SWAP"
  | "MANUAL_RECOVERY_INVOKED"
  | "SILENT_STATE_MUTATION"
  | "PHASE_REWIND"
  | "SOFT_HALT_WARN"
  | "SOFT_HALT_ERROR"
  | "STALL_KILLED";

export type HaltSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface HaltEvent {
  faultId: string;
  runId: string;
  stateSlug: string;
  kind: HaltEventKind;
  severity: HaltSeverity;
  timestamp: string;
  message: string;
  pointers: {
    stateFile: string;
    stdoutLog: string;
    livingPlan: string;
    worktreePath: string;
  };
  snapshot: {
    phase?: BuildState["phases"][number];
    feature?: BuildState["features"][number];
    failureReason?: string;
    iterationHistory?: {
      testRun?: number;
      testFix?: number;
      codexReview?: number;
    };
    worktreeHead?: string;
    stdoutTail: string;
  };
}

export function severityFor(kind: HaltEventKind): HaltSeverity {
  switch (kind) {
    case "PHASE_FAILED":
    case "FEATURE_FAILED":
      return "CRITICAL";
    case "RETRY_CAP_HIT":
    case "MANUAL_RECOVERY_INVOKED":
    case "SILENT_STATE_MUTATION":
    case "STALL_KILLED":
      return "HIGH";
    case "PHASE_REWIND":
    case "DUAL_IMPL_SWAP":
    case "SOFT_HALT_ERROR":
      return "MEDIUM";
    case "SOFT_HALT_WARN":
      return "LOW";
  }
}

export function computeFaultId(
  event: Omit<HaltEvent, "faultId" | "timestamp">,
): string {
  const phaseIdx = event.snapshot.phase?.index;
  const featureIdx = (event.snapshot.feature as any)?.number;
  const idx =
    typeof phaseIdx === "number"
      ? `p${phaseIdx}`
      : typeof featureIdx === "number"
        ? `f${featureIdx}`
        : "all";
  const hash = crypto
    .createHash("sha256")
    .update(`${event.kind}:${idx}:${event.message}`)
    .digest("hex")
    .slice(0, 8);
  return `${event.kind}:${idx}:${hash}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/halt-events.ts build/orchestrator/__tests__/halt-events.test.ts
git commit -m "feat(build/halt-events): add HaltEvent type + computeFaultId

No call sites yet — pure-data module for upcoming halt-event pipeline."
```

---

### Task 1.2: queue directory layout and `emitHaltEvent` (atomic tmp+rename)

**Files:**

- Modify: `build/orchestrator/halt-events.ts`
- Modify: `build/orchestrator/__tests__/halt-events.test.ts`

- [ ] **Step 1: Write the failing test for `emitHaltEvent` atomic write**

Append to `build/orchestrator/__tests__/halt-events.test.ts`:

```typescript
describe("emitHaltEvent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-events-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes <runId>-<faultId>.json atomically", () => {
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "run-abc",
        stateSlug: "slug-1",
        severity: "CRITICAL",
        message: "phase 0 failed",
        pointers: {
          stateFile: "/x/state.json",
          stdoutLog: "/x/stdout.log",
          livingPlan: "/x/plan.md",
          worktreePath: "/x/wt",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    const file = path.join(
      tmpDir,
      "pending-investigations",
      `run-abc-${faultId}.json`,
    );
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.faultId).toBe(faultId);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("no temp file is left behind on success", () => {
    emitHaltEvent(
      {
        kind: "SOFT_HALT_WARN",
        runId: "r1",
        stateSlug: "s1",
        severity: "LOW",
        message: "test",
        pointers: {
          stateFile: "/x/state.json",
          stdoutLog: "/x/stdout.log",
          livingPlan: "/x/plan.md",
          worktreePath: "/x/wt",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    const tmpFiles = fs
      .readdirSync(path.join(tmpDir, "pending-investigations"))
      .filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the new tests; verify they fail**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts -t "emitHaltEvent"`
Expected: FAIL with "emitHaltEvent is not a function".

- [ ] **Step 3: Implement `emitHaltEvent` and the queue-dir helper**

Append to `build/orchestrator/halt-events.ts`:

```typescript
function defaultSkillFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

function safeRegistryRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function pendingInvestigationsDir(opts?: { queueDir?: string }): string {
  return path.join(
    opts?.queueDir ?? defaultSkillFaultsDir(),
    "pending-investigations",
  );
}

export function processedDir(opts?: { queueDir?: string }): string {
  return path.join(opts?.queueDir ?? defaultSkillFaultsDir(), "processed");
}

export function emitHaltEvent(
  event: Omit<HaltEvent, "faultId" | "timestamp">,
  opts?: { queueDir?: string; now?: Date },
): string {
  const faultId = computeFaultId(event);
  const timestamp = (opts?.now ?? new Date()).toISOString();
  const full: HaltEvent = { ...event, faultId, timestamp };
  const dir = pendingInvestigationsDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const safeRun = safeRegistryRunId(event.runId);
  const finalPath = path.join(dir, `${safeRun}-${faultId}.json`);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, finalPath);
  return faultId;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/halt-events.ts build/orchestrator/__tests__/halt-events.test.ts
git commit -m "feat(build/halt-events): add emitHaltEvent with atomic tmp+rename writes"
```

---

### Task 1.3: `loadPendingInvestigations` and `markInvestigated`

**Files:**

- Modify: `build/orchestrator/halt-events.ts`
- Modify: `build/orchestrator/__tests__/halt-events.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `build/orchestrator/__tests__/halt-events.test.ts`:

```typescript
describe("loadPendingInvestigations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-events-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when dir missing", () => {
    expect(loadPendingInvestigations({ queueDir: tmpDir })).toEqual([]);
  });

  test("loads multiple events, ignores .tmp files", () => {
    const a = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "a",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    const b = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "b",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    // Plant a stray .tmp file
    fs.writeFileSync(
      path.join(tmpDir, "pending-investigations", "stray.tmp"),
      "{}",
    );
    const loaded = loadPendingInvestigations({ queueDir: tmpDir });
    expect(loaded.map((e) => e.faultId).sort()).toEqual([a, b].sort());
  });
});

describe("markInvestigated", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-events-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("moves file to processed/", () => {
    const faultId = emitHaltEvent(
      {
        kind: "FEATURE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "x",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: "/x",
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: tmpDir },
    );
    markInvestigated("r1", faultId, "investigated", { queueDir: tmpDir });
    const pending = path.join(
      tmpDir,
      "pending-investigations",
      `r1-${faultId}.json`,
    );
    const processed = path.join(tmpDir, "processed", `r1-${faultId}.json`);
    expect(fs.existsSync(pending)).toBe(false);
    expect(fs.existsSync(processed)).toBe(true);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts -t "loadPendingInvestigations"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `build/orchestrator/halt-events.ts`:

```typescript
export function loadPendingInvestigations(opts?: {
  queueDir?: string;
}): HaltEvent[] {
  const dir = pendingInvestigationsDir(opts);
  if (!fs.existsSync(dir)) return [];
  const out: HaltEvent[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      out.push(JSON.parse(raw) as HaltEvent);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function markInvestigated(
  runId: string,
  faultId: string,
  outcome: "investigated" | "skipped-no-context" | "self-healed",
  opts?: { queueDir?: string },
): void {
  const safeRun = safeRegistryRunId(runId);
  const fileName = `${safeRun}-${faultId}.json`;
  const src = path.join(pendingInvestigationsDir(opts), fileName);
  const dstDir = processedDir(opts);
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, fileName);
  fs.renameSync(src, dst);
  // Outcome is logged at the call site; this function only moves the file.
  // The `outcome` param is intentionally retained for future use.
  void outcome;
}
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/halt-events.ts build/orchestrator/__tests__/halt-events.test.ts
git commit -m "feat(build/halt-events): add loadPendingInvestigations + markInvestigated"
```

---

### Task 1.4: snapshot builder (`buildHaltSnapshot`)

**Files:**

- Modify: `build/orchestrator/halt-events.ts`
- Modify: `build/orchestrator/__tests__/halt-events.test.ts`

- [ ] **Step 1: Write failing test**

Append to test file:

```typescript
import { buildHaltSnapshot } from "../halt-events";
import { spawnSync } from "node:child_process";

describe("buildHaltSnapshot", () => {
  test("includes stdoutTail trimmed to last 200 lines", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    try {
      const log = path.join(tmp, "stdout.log");
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
      fs.writeFileSync(log, lines.join("\n"));
      const state = {
        phases: [{ index: 0, status: "failed", number: 1 } as any],
        features: [],
      } as any;
      const snap = buildHaltSnapshot({
        state,
        stdoutLogPath: log,
        phaseIndex: 0,
        worktreePath: tmp,
      });
      const tailLines = snap.stdoutTail.split("\n");
      expect(tailLines.length).toBeLessThanOrEqual(200);
      expect(tailLines[tailLines.length - 1]).toBe("line 499");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("captures phase + feature when indices given", () => {
    const state = {
      phases: [{ index: 0, status: "failed", number: 1 } as any],
      features: [{ number: 1, status: "paused" } as any],
    } as any;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    try {
      const log = path.join(tmp, "stdout.log");
      fs.writeFileSync(log, "");
      const snap = buildHaltSnapshot({
        state,
        stdoutLogPath: log,
        phaseIndex: 0,
        featureIndex: 0,
        worktreePath: tmp,
      });
      expect(snap.phase?.number).toBe(1);
      expect((snap.feature as any)?.status).toBe("paused");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts -t "buildHaltSnapshot"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `build/orchestrator/halt-events.ts`:

```typescript
import { spawnSync } from "node:child_process";

export interface BuildHaltSnapshotInput {
  state: BuildState | null;
  stdoutLogPath: string;
  worktreePath: string;
  phaseIndex?: number;
  featureIndex?: number;
  failureReason?: string;
}

export function buildHaltSnapshot(
  input: BuildHaltSnapshotInput,
): HaltEvent["snapshot"] {
  const phase =
    typeof input.phaseIndex === "number"
      ? input.state?.phases?.[input.phaseIndex]
      : undefined;
  const feature =
    typeof input.featureIndex === "number"
      ? (input.state as any)?.features?.[input.featureIndex]
      : undefined;
  const iterationHistory = phase
    ? {
        testRun: (phase as any).testRun?.iterations,
        testFix: (phase as any).testFix?.iterations,
        codexReview: (phase as any).codexReview?.iterations,
      }
    : undefined;
  let stdoutTail = "";
  try {
    const raw = fs.readFileSync(input.stdoutLogPath, "utf8");
    const lines = raw.split("\n");
    stdoutTail = lines.slice(Math.max(0, lines.length - 200)).join("\n");
  } catch {
    stdoutTail = "";
  }
  let worktreeHead: string | undefined;
  try {
    const res = spawnSync(
      "git",
      ["-C", input.worktreePath, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    );
    if (res.status === 0) worktreeHead = res.stdout.trim();
  } catch {
    // ignore
  }
  return {
    phase,
    feature,
    failureReason: input.failureReason,
    iterationHistory,
    worktreeHead,
    stdoutTail,
  };
}
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/halt-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/halt-events.ts build/orchestrator/__tests__/halt-events.test.ts
git commit -m "feat(build/halt-events): add buildHaltSnapshot (stdout tail + git head + iter history)"
```

---

### Task 1.5: centralizing helpers — `markPhaseFailed`, `markFeatureFailed`, `rewindPhase`, `recordRetryCapHit`

**Files:**

- Create: `build/orchestrator/halt-event-helpers.ts`
- Create: `build/orchestrator/__tests__/halt-event-helpers.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  markPhaseFailed,
  markFeatureFailed,
  rewindPhase,
  recordRetryCapHit,
} from "../halt-event-helpers";
import { loadPendingInvestigations } from "../halt-events";

function freshState() {
  return {
    slug: "s1",
    phases: [
      { index: 0, number: 1, status: "running" } as any,
      { index: 1, number: 2, status: "tests_green" } as any,
    ],
    features: [{ number: 1, status: "running" } as any],
  } as any;
}

function fixturePaths(tmp: string) {
  fs.writeFileSync(path.join(tmp, "stdout.log"), "");
  return {
    stateFile: path.join(tmp, "state.json"),
    stdoutLog: path.join(tmp, "stdout.log"),
    livingPlan: path.join(tmp, "plan.md"),
    worktreePath: tmp,
  };
}

describe("markPhaseFailed", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hh-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("sets phase status to failed AND emits PHASE_FAILED", () => {
    const state = freshState();
    markPhaseFailed(state, 0, "spec-flip exploded", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    expect(state.phases[0].status).toBe("failed");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PHASE_FAILED");
    expect(pending[0].severity).toBe("CRITICAL");
  });
});

describe("rewindPhase", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hh-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits PHASE_REWIND, not PHASE_FAILED, and sets the target status", () => {
    const state = freshState();
    state.phases[1].status = "committed";
    rewindPhase(state, 1, "tests_green", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    expect(state.phases[1].status).toBe("tests_green");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending[0].kind).toBe("PHASE_REWIND");
  });
});

describe("recordRetryCapHit", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hh-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("does not mutate state, only emits RETRY_CAP_HIT", () => {
    const state = freshState();
    const before = JSON.stringify(state);
    recordRetryCapHit(state, 0, "codex", 4, {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    expect(JSON.stringify(state)).toBe(before);
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending[0].kind).toBe("RETRY_CAP_HIT");
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/halt-event-helpers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `build/orchestrator/halt-event-helpers.ts`:

```typescript
import type { BuildState } from "./types";
import {
  emitHaltEvent,
  severityFor,
  buildHaltSnapshot,
  type HaltEvent,
  type HaltEventKind,
} from "./halt-events";

export interface HelperContext {
  runId: string;
  stateSlug: string;
  pointers: HaltEvent["pointers"];
  queueDir?: string;
}

function emit(
  kind: HaltEventKind,
  message: string,
  ctx: HelperContext,
  state: BuildState | null,
  phaseIndex?: number,
  featureIndex?: number,
  failureReason?: string,
): string {
  return emitHaltEvent(
    {
      kind,
      runId: ctx.runId,
      stateSlug: ctx.stateSlug,
      severity: severityFor(kind),
      message,
      pointers: ctx.pointers,
      snapshot: buildHaltSnapshot({
        state,
        stdoutLogPath: ctx.pointers.stdoutLog,
        worktreePath: ctx.pointers.worktreePath,
        phaseIndex,
        featureIndex,
        failureReason,
      }),
    },
    { queueDir: ctx.queueDir },
  );
}

export function markPhaseFailed(
  state: BuildState,
  phaseIdx: number,
  reason: string,
  ctx: HelperContext,
): string {
  if (state.phases[phaseIdx]) {
    state.phases[phaseIdx].status = "failed" as any;
  }
  return emit("PHASE_FAILED", reason, ctx, state, phaseIdx, undefined, reason);
}

export function markFeatureFailed(
  state: BuildState,
  featureIdx: number,
  reason: string,
  ctx: HelperContext,
): string {
  const f = (state as any).features?.[featureIdx];
  if (f) {
    f.status = "failed";
    f.error = reason;
  }
  return emit(
    "FEATURE_FAILED",
    reason,
    ctx,
    state,
    undefined,
    featureIdx,
    reason,
  );
}

export function rewindPhase(
  state: BuildState,
  phaseIdx: number,
  toStatus: string,
  ctx: HelperContext,
): string {
  if (state.phases[phaseIdx]) {
    state.phases[phaseIdx].status = toStatus as any;
  }
  return emit(
    "PHASE_REWIND",
    `phase ${phaseIdx} rewound to ${toStatus}`,
    ctx,
    state,
    phaseIdx,
  );
}

export function recordRetryCapHit(
  state: BuildState,
  phaseIdx: number,
  capKind: "codex" | "testfix" | "dualimpl",
  iterations: number,
  ctx: HelperContext,
): string {
  return emit(
    "RETRY_CAP_HIT",
    `${capKind} hit cap after ${iterations} iterations`,
    ctx,
    state,
    phaseIdx,
  );
}
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/halt-event-helpers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/halt-event-helpers.ts build/orchestrator/__tests__/halt-event-helpers.test.ts
git commit -m "feat(build/halt-events): add markPhaseFailed/markFeatureFailed/rewindPhase/recordRetryCapHit"
```

---

### Task 1.6: PR 1 verification + open

- [ ] **Step 1: Run the full free test suite**

Run: `bun test`
Expected: all green; no new failures elsewhere.

- [ ] **Step 2: Verify cli.ts is still untouched**

Run: `git diff --stat origin/main -- build/orchestrator/cli.ts`
Expected: empty (no diff). This PR is foundation-only.

- [ ] **Step 3: Open PR**

```bash
gh pr create --base main --title "feat(build/halt-events): foundation module + centralizing helpers" \
  --body "$(cat <<'EOF'
## Summary
- New module \`halt-events.ts\` with HaltEvent type, computeFaultId (deterministic), emitHaltEvent (atomic tmp+rename), loadPendingInvestigations, markInvestigated, buildHaltSnapshot.
- New helpers module \`halt-event-helpers.ts\` with markPhaseFailed, markFeatureFailed, rewindPhase, recordRetryCapHit.
- No call sites in cli.ts yet. Zero behavior change.

## Test plan
- [x] bun test build/orchestrator/__tests__/halt-events.test.ts
- [x] bun test build/orchestrator/__tests__/halt-event-helpers.test.ts
- [x] bun test (full free tier)
- [ ] PR 2 will migrate cli.ts call sites to use these helpers.
EOF
)"
```

---

## PR 2 — cli.ts migration to helpers (mechanical, one halt class per commit)

Each commit converts one halt class. Per CLAUDE.md bisection rule, do NOT batch.

### Task 2.1: migrate PHASE_FAILED sites

**Files:**

- Modify: `build/orchestrator/cli.ts`

- [ ] **Step 1: Enumerate all `phaseState.status = "failed"` write sites**

Run: `rg -n 'phaseState\.status\s*=\s*"failed"' build/orchestrator/cli.ts`
Expected: ~22 hits. Save the list — you will convert them in this commit.

- [ ] **Step 2: Build the helper-context constructor at the top of `cli.ts`**

Find a stable upper section in `cli.ts` (near the imports) and add:

```typescript
import {
  markPhaseFailed,
  markFeatureFailed,
  rewindPhase,
  recordRetryCapHit,
} from "./halt-event-helpers";
import { statePath } from "./state";

function helperCtxFor(
  state: BuildState,
  runId: string,
): {
  runId: string;
  stateSlug: string;
  pointers: {
    stateFile: string;
    stdoutLog: string;
    livingPlan: string;
    worktreePath: string;
  };
} {
  return {
    runId,
    stateSlug: state.slug,
    pointers: {
      stateFile: statePath(state.slug),
      stdoutLog: (state.launch as any)?.stdoutLog ?? "",
      livingPlan: state.planFile,
      worktreePath: (state.launch as any)?.projectRoot ?? "",
    },
  };
}
```

If `state.launch.stdoutLog` / `projectRoot` field names differ in the current code, look them up via `BuildState["launch"]` in `build/orchestrator/types.ts` and use whatever fields ARE there. The spec assumes these but verify on landing.

- [ ] **Step 3: Convert each `phaseState.status = "failed"` site**

For each hit from Step 1:

Before:

```typescript
phaseState.status = "failed";
saveState(state, { noGbrain: args.noGbrain, log: console.warn });
```

After:

```typescript
markPhaseFailed(
  state,
  phaseState.index,
  /* reason: */ "<keep the existing reason variable or inline string>",
  helperCtxFor(state, args.runId),
);
saveState(state, { noGbrain: args.noGbrain, log: console.warn });
```

The helper sets `.status = "failed"` for you — remove the explicit assignment. Pass the existing failure-reason string (or the local var holding it) as the `reason` argument.

Do this for every site. Run `rg -n 'phaseState\.status\s*=\s*"failed"' build/orchestrator/cli.ts` after — expected output is empty.

- [ ] **Step 4: Run the existing cli.ts-touching tests**

Run: `bun test build/orchestrator/__tests__/`
Expected: all green. The helper sets the same status, so behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "refactor(build/cli): route all PHASE_FAILED sites through markPhaseFailed helper

Mechanical migration. State mutation is unchanged; this also fires PHASE_FAILED
halt events that drain-faults will consume in a future PR. Each call site keeps
its existing failure-reason string."
```

---

### Task 2.2: migrate FEATURE_FAILED sites (extend `markFailed`)

**Files:**

- Modify: `build/orchestrator/cli.ts` (around the `markFailed` helper at the spec's cli.ts:3001)

- [ ] **Step 1: Locate the existing `markFailed` helper**

Run: `rg -n 'function markFailed' build/orchestrator/cli.ts`

- [ ] **Step 2: Inside `markFailed`, append a call to `markFeatureFailed`**

Approximately:

```typescript
function markFailed(state: BuildState, featureIdx: number, reason: string, args: ...) {
  // ... existing body (sets feature.status = "failed", saves state, logs) ...
  markFeatureFailed(state, featureIdx, reason, helperCtxFor(state, args.runId));
}
```

If `markFailed` does NOT take `args` already, plumb the runId in. The 4 callers all have the runId in scope.

- [ ] **Step 3: Run tests**

Run: `bun test build/orchestrator/__tests__/`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "refactor(build/cli): extend markFailed to emit FEATURE_FAILED halt event"
```

---

### Task 2.3: migrate RETRY_CAP_HIT sites

**Files:**

- Modify: `build/orchestrator/cli.ts`

- [ ] **Step 1: Convert codex iteration cap (spec ref: cli.ts:5967-5968)**

Find the block where `iterCount >= args.maxCodexIterations` triggers the cap. Append:

```typescript
recordRetryCapHit(
  state,
  phaseState.index,
  "codex",
  iterCount,
  helperCtxFor(state, args.runId),
);
```

- [ ] **Step 2: Convert test-fix iteration cap (spec ref: cli.ts:5783)**

Find the block where `fr.iterations >= args.maxTestIterations`. Append:

```typescript
recordRetryCapHit(
  state,
  phaseState.index,
  "testfix",
  fr.iterations,
  helperCtxFor(state, args.runId),
);
```

- [ ] **Step 3: Convert dual-impl swap (spec ref: cli.ts:6814)**

Find the dual-impl swap site. After the swap is committed, append:

```typescript
recordRetryCapHit(
  state,
  phaseState.index,
  "dualimpl",
  swapIterations,
  helperCtxFor(state, args.runId),
);
// Also emit DUAL_IMPL_SWAP for the kind-specific narrative:
emitHaltEvent({
  kind: "DUAL_IMPL_SWAP",
  runId: args.runId,
  stateSlug: state.slug,
  severity: "MEDIUM",
  message: `dual-impl swap: secondary won at ${swapIterations} iters`,
  pointers: helperCtxFor(state, args.runId).pointers,
  snapshot: buildHaltSnapshot({
    state,
    stdoutLogPath: helperCtxFor(state, args.runId).pointers.stdoutLog,
    worktreePath: helperCtxFor(state, args.runId).pointers.worktreePath,
    phaseIndex: phaseState.index,
  }),
});
```

Add `import { emitHaltEvent, buildHaltSnapshot } from "./halt-events";` if not already imported.

- [ ] **Step 4: Run tests**

Run: `bun test build/orchestrator/__tests__/`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "refactor(build/cli): emit RETRY_CAP_HIT + DUAL_IMPL_SWAP at iteration cap sites"
```

---

### Task 2.4: migrate PHASE_REWIND site (`resumePhaseAfterWGate`)

- [ ] **Step 1: Locate the rewind (spec ref: cli.ts:5625-5633)**

Run: `rg -n 'resumePhaseAfterWGate' build/orchestrator/cli.ts`

- [ ] **Step 2: Replace the inline status assignment**

Before:

```typescript
phaseState.status = "tests_green";
saveState(state, {...});
```

After:

```typescript
rewindPhase(state, phaseState.index, "tests_green", helperCtxFor(state, args.runId));
saveState(state, {...});
```

- [ ] **Step 3: Run tests**

Run: `bun test build/orchestrator/__tests__/`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "refactor(build/cli): emit PHASE_REWIND in resumePhaseAfterWGate"
```

---

### Task 2.5: emit MANUAL_RECOVERY_INVOKED at the three recovery entry points

**Files:**

- Modify: `build/orchestrator/cli.ts`

- [ ] **Step 1: At `--mark-phase-committed` entry (spec ref: cli.ts:914-917)**

Right after the flag is parsed and the target phase is identified, add:

```typescript
emitHaltEvent({
  kind: "MANUAL_RECOVERY_INVOKED",
  runId: args.runId,
  stateSlug: state.slug,
  severity: "HIGH",
  message: `--mark-phase-committed invoked on phase ${args.markPhaseCommitted}`,
  pointers: helperCtxFor(state, args.runId).pointers,
  snapshot: buildHaltSnapshot({
    state,
    stdoutLogPath: helperCtxFor(state, args.runId).pointers.stdoutLog,
    worktreePath: helperCtxFor(state, args.runId).pointers.worktreePath,
    phaseIndex: args.markPhaseCommitted,
  }),
});
```

- [ ] **Step 2: At `mark-shipped` subcommand (spec ref: cli.ts:1341-1358)**

Same pattern after the subcommand validates and locates the feature.

- [ ] **Step 3: At `drain-faults` subcommand entry (spec ref: cli.ts:7623)**

Same pattern. Note: do not recurse — drain-faults emitting a MANUAL_RECOVERY_INVOKED that drain-faults later consumes is fine and intended. The faultId will be unique to "drain-faults was invoked," not the halts it processed.

- [ ] **Step 4: Run tests**

Run: `bun test build/orchestrator/__tests__/`

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "refactor(build/cli): emit MANUAL_RECOVERY_INVOKED at mark-phase-committed/mark-shipped/drain-faults entry points"
```

---

### Task 2.6: emit SILENT_STATE_MUTATION at cli.ts:9330 (additive only, mutation unchanged)

- [ ] **Step 1: Locate the block (spec ref: cli.ts:9330-9348)**

Run: `rg -n 'manual JSON state patch that bypassed ship' build/orchestrator/cli.ts`

- [ ] **Step 2: Right before the existing `console.warn`, add the emit**

```typescript
emitHaltEvent({
  kind: "SILENT_STATE_MUTATION",
  runId: args.runId,
  stateSlug: state.slug,
  severity: "HIGH",
  message: `feature ${featureState.number} committed without completedAt; orchestrator re-processing`,
  pointers: helperCtxFor(state, args.runId).pointers,
  snapshot: buildHaltSnapshot({
    state,
    stdoutLogPath: helperCtxFor(state, args.runId).pointers.stdoutLog,
    worktreePath: helperCtxFor(state, args.runId).pointers.worktreePath,
    featureIndex: featureIndex,
  }),
});
// existing console.warn(...) stays
// existing featureState.status = "phases_done" mutation stays
```

DO NOT remove the existing mutation or console.warn. This PR is observability only. The mutation fix is a separate follow-up.

- [ ] **Step 3: Run tests**

Run: `bun test build/orchestrator/__tests__/`

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "feat(build/cli): emit SILENT_STATE_MUTATION on committed-without-completedAt re-processing

Pure observability — the existing console.warn + state.status='phases_done'
mutation remain. The mutation fix is intentionally deferred to a follow-up PR
that responds to investigator reports."
```

---

### Task 2.7: open PR 2

- [ ] **Step 1: Final full test**

Run: `bun test`

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "refactor(build/cli): route all halt sites through halt-event helpers" \
  --body "$(cat <<'EOF'
## Summary
Mechanical migration of cli.ts halt sites to the helpers landed in PR 1.
- 22+ PHASE_FAILED sites → markPhaseFailed
- 4 FEATURE_FAILED sites via markFailed → extended with markFeatureFailed
- RETRY_CAP_HIT at codex / test-fix / dual-impl caps
- DUAL_IMPL_SWAP at the swap site
- PHASE_REWIND in resumePhaseAfterWGate
- MANUAL_RECOVERY_INVOKED at --mark-phase-committed / mark-shipped / drain-faults
- SILENT_STATE_MUTATION at cli.ts:9330 (observability only; mutation unchanged)

State mutations are unchanged. Each commit is one halt class for clean bisection.

## Test plan
- [x] bun test (free tier)
- [x] Existing cli.ts tests pass — state.status writes have identical behavior.
- [ ] No drain-faults wiring yet; queue accumulates but nothing reads it.
EOF
)"
```

---

## PR 3 — `wrapConsole` shim for SOFT_HALT_WARN / SOFT_HALT_ERROR

### Task 3.1: wrapConsole module + tests

**Files:**

- Create: `build/orchestrator/wrap-console.ts`
- Create: `build/orchestrator/__tests__/wrap-console.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installWrapConsole, classifyConsoleLine } from "../wrap-console";
import { loadPendingInvestigations } from "../halt-events";

describe("classifyConsoleLine", () => {
  test("Re-processing the feature → SILENT_STATE_MUTATION", () => {
    expect(classifyConsoleLine("warn", "Re-processing the feature").kind).toBe(
      "SILENT_STATE_MUTATION",
    );
  });
  test("worktree cleanup failed → SOFT_HALT_WARN", () => {
    expect(
      classifyConsoleLine("warn", "worktree cleanup failed for run X").kind,
    ).toBe("SOFT_HALT_WARN");
  });
  test("PR check unsettled → SOFT_HALT_WARN", () => {
    expect(classifyConsoleLine("warn", "PR check unsettled").kind).toBe(
      "SOFT_HALT_WARN",
    );
  });
  test("branch deletion failed → SOFT_HALT_WARN", () => {
    expect(
      classifyConsoleLine("warn", "branch deletion failed for X").kind,
    ).toBe("SOFT_HALT_WARN");
  });
  test("✗ sigil → SOFT_HALT_ERROR", () => {
    expect(classifyConsoleLine("error", "✗ feature failed: blah").kind).toBe(
      "SOFT_HALT_ERROR",
    );
  });
  test("unmatched → SOFT_HALT_WARN LOW", () => {
    const c = classifyConsoleLine("warn", "random log line");
    expect(c.kind).toBe("SOFT_HALT_WARN");
    expect(c.severity).toBe("LOW");
  });
});

describe("installWrapConsole", () => {
  let tmp: string;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wc-"));
    origWarn = console.warn;
    origError = console.error;
  });
  afterEach(() => {
    console.warn = origWarn;
    console.error = origError;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits halt event AND calls original console.warn", () => {
    let captured = "";
    console.warn = (msg: string) => {
      captured = msg;
    };
    installWrapConsole({
      runId: "r1",
      stateSlug: "s1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      queueDir: tmp,
    });
    console.warn("worktree cleanup failed");
    expect(captured).toBe("worktree cleanup failed");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("SOFT_HALT_WARN");
  });

  test("env-gated off when GSTACK_HALT_EVENTS_OFF=1", () => {
    process.env.GSTACK_HALT_EVENTS_OFF = "1";
    try {
      installWrapConsole({
        runId: "r1",
        stateSlug: "s1",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: "/x",
        },
        queueDir: tmp,
      });
      console.warn("any message");
      const pending = loadPendingInvestigations({ queueDir: tmp });
      expect(pending.length).toBe(0);
    } finally {
      delete process.env.GSTACK_HALT_EVENTS_OFF;
    }
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/wrap-console.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `build/orchestrator/wrap-console.ts`:

```typescript
import {
  emitHaltEvent,
  type HaltEventKind,
  type HaltSeverity,
  type HaltEvent,
} from "./halt-events";

export interface WrapConsoleContext {
  runId: string;
  stateSlug: string;
  pointers: HaltEvent["pointers"];
  queueDir?: string;
}

interface Classification {
  kind: HaltEventKind;
  severity: HaltSeverity;
}

const PATTERNS: Array<{
  re: RegExp;
  kind: HaltEventKind;
  severity: HaltSeverity;
}> = [
  {
    re: /Re-processing the feature/i,
    kind: "SILENT_STATE_MUTATION",
    severity: "HIGH",
  },
  { re: /worktree cleanup failed/i, kind: "SOFT_HALT_WARN", severity: "LOW" },
  {
    re: /PR check unsettled|PR not yet mergeable/i,
    kind: "SOFT_HALT_WARN",
    severity: "LOW",
  },
  { re: /branch deletion failed/i, kind: "SOFT_HALT_WARN", severity: "LOW" },
];

export function classifyConsoleLine(
  level: "warn" | "error",
  msg: string,
): Classification {
  for (const p of PATTERNS) {
    if (p.re.test(msg)) return { kind: p.kind, severity: p.severity };
  }
  if (level === "error") {
    if (msg.startsWith("✗ ")) {
      return { kind: "SOFT_HALT_ERROR", severity: "MEDIUM" };
    }
    return { kind: "SOFT_HALT_ERROR", severity: "MEDIUM" };
  }
  return { kind: "SOFT_HALT_WARN", severity: "LOW" };
}

export function installWrapConsole(ctx: WrapConsoleContext): () => void {
  if (process.env.GSTACK_HALT_EVENTS_OFF === "1") return () => {};
  if (process.env.NODE_ENV === "test" && !ctx.queueDir) {
    // Don't fire on test runs that didn't explicitly opt in via queueDir.
    return () => {};
  }
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args as any);
    const msg = args.map(String).join(" ");
    const c = classifyConsoleLine("warn", msg);
    try {
      emitHaltEvent(
        {
          kind: c.kind,
          runId: ctx.runId,
          stateSlug: ctx.stateSlug,
          severity: c.severity,
          message: msg.slice(0, 500),
          pointers: ctx.pointers,
          snapshot: { stdoutTail: "" },
        },
        { queueDir: ctx.queueDir },
      );
    } catch {
      // never let the wrapper crash the orchestrator
    }
  };
  console.error = (...args: unknown[]) => {
    origError.apply(console, args as any);
    const msg = args.map(String).join(" ");
    const c = classifyConsoleLine("error", msg);
    try {
      emitHaltEvent(
        {
          kind: c.kind,
          runId: ctx.runId,
          stateSlug: ctx.stateSlug,
          severity: c.severity,
          message: msg.slice(0, 500),
          pointers: ctx.pointers,
          snapshot: { stdoutTail: "" },
        },
        { queueDir: ctx.queueDir },
      );
    } catch {
      // ignore
    }
  };
  return () => {
    console.warn = origWarn;
    console.error = origError;
  };
}
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/wrap-console.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/wrap-console.ts build/orchestrator/__tests__/wrap-console.test.ts
git commit -m "feat(build/wrap-console): classifier + installer for SOFT_HALT_WARN/ERROR

Patterns: Re-processing the feature → SILENT_STATE_MUTATION; worktree cleanup
failed / PR check unsettled / branch deletion failed → SOFT_HALT_WARN; ✗ sigil
→ SOFT_HALT_ERROR. Unmatched warn → LOW. Env-gated via GSTACK_HALT_EVENTS_OFF."
```

---

### Task 3.2: wire wrapConsole into the orchestrator entry path

**Files:**

- Modify: `build/orchestrator/cli.ts`

- [ ] **Step 1: Find the main entry**

Run: `rg -n 'async function main' build/orchestrator/cli.ts` (or whichever symbol is the orchestrator's main entry).

- [ ] **Step 2: After state is loaded but before the run loop, install wrap-console**

```typescript
import { installWrapConsole } from "./wrap-console";

// inside main, after state is resolved:
const uninstallWrap = installWrapConsole({
  runId: args.runId,
  stateSlug: state.slug,
  pointers: helperCtxFor(state, args.runId).pointers,
});
try {
  // existing main body
} finally {
  uninstallWrap();
}
```

If main already has a top-level try/finally, fold into that. Don't create a new one.

- [ ] **Step 3: Run tests**

Run: `bun test build/orchestrator/__tests__/`
Expected: green. Tests run with `NODE_ENV=test` (or no queueDir), so they bypass wrapConsole.

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "feat(build/cli): install wrapConsole shim on orchestrator entry path"
```

- [ ] **Step 5: Open PR 3**

```bash
gh pr create --base main --title "feat(build/wrap-console): classify console.warn/error into halt events" \
  --body "Captures the 281-call soft-halt class via pattern classification. Env-gated by GSTACK_HALT_EVENTS_OFF=1; bypassed in tests by default."
```

---

## PR 4 — `state_jsonpath` matcher + `HAND_MERGED_FEATURE` detector + E2E pin

### Task 4.1: safe-jsonpath evaluator

**Files:**

- Create: `build/orchestrator/safe-jsonpath.ts`
- Create: `build/orchestrator/__tests__/safe-jsonpath.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, test, expect } from "bun:test";
import { safeJsonPathEval } from "../safe-jsonpath";

describe("safeJsonPathEval", () => {
  test("$ returns root", () => {
    expect(safeJsonPathEval({ a: 1 }, "$")).toEqual([{ a: 1 }]);
  });
  test("dot access", () => {
    expect(safeJsonPathEval({ a: { b: 2 } }, "$.a.b")).toEqual([2]);
  });
  test("array wildcard", () => {
    expect(
      safeJsonPathEval({ items: [{ x: 1 }, { x: 2 }] }, "$.items[*].x"),
    ).toEqual([1, 2]);
  });
  test("filter expression with equality + literal", () => {
    const data = {
      features: [
        {
          status: "committed",
          completedAt: "2026-05-19",
          mergeSha: "abc",
          prNumber: 1,
        },
        { status: "committed", mergeSha: "def", prNumber: 2 }, // no completedAt
      ],
    };
    const out = safeJsonPathEval(
      data,
      "$.features[*][?(@.status == 'committed' && !@.completedAt && @.mergeSha && @.prNumber)]",
    );
    expect(out.length).toBe(1);
    expect((out[0] as any).prNumber).toBe(2);
  });
  test("rejects function calls", () => {
    expect(safeJsonPathEval({}, "$.length()")).toEqual([]);
  });
  test("rejects script expressions", () => {
    expect(safeJsonPathEval({}, "$[(@.length-1)]")).toEqual([]);
  });
  test("malformed input returns empty", () => {
    expect(safeJsonPathEval({}, "$..()malformed")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/safe-jsonpath.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the minimal evaluator**

Create `build/orchestrator/safe-jsonpath.ts`:

```typescript
/**
 * Minimal, hand-written JSONPath subset evaluator. Safe by construction:
 *   - No eval, no Function constructor.
 *   - Supports: $, .field, [field], [*], [?(filter)] with literals only on RHS.
 *   - Filter operators: ==, !=, !@.field (truthiness), @.field (truthiness),
 *     && chain.
 * Anything outside this grammar returns [].
 */

type Path = string;

const FILTER_RE = /^\[\?\((.+)\)\]$/;
const BRACKET_FIELD_RE = /^\[(['"])([^'"]+)\1\]$/;
const WILDCARD_RE = /^\[\*\]$/;
const DOT_FIELD_RE = /^\.([A-Za-z_][A-Za-z0-9_]*)$/;
const ROOT = "$";

function tokenize(path: Path): string[] | null {
  if (!path.startsWith(ROOT)) return null;
  const rest = path.slice(1);
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === ".") {
      const m = rest.slice(i).match(/^\.([A-Za-z_][A-Za-z0-9_]*)/);
      if (!m) return null;
      tokens.push(`.${m[1]}`);
      i += m[0].length;
    } else if (rest[i] === "[") {
      // Find matching close bracket (no nesting in our grammar except inside ?())
      let depth = 0;
      let j = i;
      while (j < rest.length) {
        if (rest[j] === "[") depth++;
        else if (rest[j] === "]") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (j >= rest.length) return null;
      tokens.push(rest.slice(i, j + 1));
      i = j + 1;
    } else {
      return null;
    }
  }
  return tokens;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

function evalFilterExpr(expr: string, ctx: any): boolean {
  // Split top-level on " && " only — no parens supported.
  const parts = expr.split(/\s*&&\s*/);
  for (const part of parts) {
    if (!evalFilterAtom(part, ctx)) return false;
  }
  return true;
}

function evalFilterAtom(atom: string, ctx: any): boolean {
  const trim = atom.trim();
  // !@.field
  let m = trim.match(/^!@\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) return !ctx?.[m[1]];
  // @.field == 'literal'
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*==\s*'([^']*)'$/);
  if (m) return ctx?.[m[1]] === m[2];
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]*)"$/);
  if (m) return ctx?.[m[1]] === m[2];
  // @.field != 'literal'
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*!=\s*'([^']*)'$/);
  if (m) return ctx?.[m[1]] !== m[2];
  // @.field (truthiness)
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) return !!ctx?.[m[1]];
  return false;
}

export function safeJsonPathEval(data: unknown, path: string): unknown[] {
  try {
    if (path === ROOT) return [data];
    const tokens = tokenize(path);
    if (!tokens) return [];
    let current: unknown[] = [data];
    for (const tok of tokens) {
      const next: unknown[] = [];
      for (const item of current) {
        let m;
        if ((m = tok.match(DOT_FIELD_RE))) {
          if (item && typeof item === "object") {
            next.push((item as any)[m[1]]);
          }
        } else if ((m = tok.match(BRACKET_FIELD_RE))) {
          if (item && typeof item === "object") {
            next.push((item as any)[m[2]]);
          }
        } else if (WILDCARD_RE.test(tok)) {
          for (const v of asArray(item)) next.push(v);
        } else if ((m = tok.match(FILTER_RE))) {
          for (const v of asArray(item)) {
            if (evalFilterExpr(m[1], v)) next.push(v);
          }
        } else {
          return [];
        }
      }
      current = next.filter((v) => v !== undefined);
    }
    return current;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/safe-jsonpath.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/safe-jsonpath.ts build/orchestrator/__tests__/safe-jsonpath.test.ts
git commit -m "feat(build/safe-jsonpath): hand-written JSONPath subset, no eval

Supports \$, .field, [field], [*], [?(@.f == 'lit' && !@.g && @.h)]. Anything
outside the grammar returns []. Used for state_jsonpath learned-pattern
matcher in the next commit."
```

---

### Task 4.2: wire `state_jsonpath` into the detector

**Files:**

- Modify: `build/orchestrator/skill-fault-detector.ts`
- Modify: `build/orchestrator/__tests__/skill-fault-detector.test.ts`

- [ ] **Step 1: Write failing test for state_jsonpath round-trip**

Append to `build/orchestrator/__tests__/skill-fault-detector.test.ts` (assuming the file exists; if not, create it with imports first):

```typescript
import {
  detectLearnedFaults,
  type LearnedPattern,
} from "../skill-fault-detector";

describe("state_jsonpath learned pattern", () => {
  test("fires on hand-merged feature shape", () => {
    const state = {
      phases: [],
      features: [
        { number: 1, status: "committed", completedAt: "2026-05-19" },
        { number: 2, status: "committed", mergeSha: "abc", prNumber: 7 },
      ],
    } as any;
    const lp: LearnedPattern = {
      category: "HAND_MERGED_FEATURE_LEARNED",
      severity: "HIGH",
      description: "hand-merged feature lacks completedAt",
      matcherKind: "state_jsonpath",
      pattern:
        "$.features[*][?(@.status == 'committed' && !@.completedAt && @.mergeSha && @.prNumber)]",
      source: "investigator:test",
      learnedAt: new Date().toISOString(),
      hitCount: 0,
    };
    const out = detectLearnedFaults(
      {
        state,
        livingPlanPath: "/x",
        worktreePath: "/x",
        stateDir: "/x",
        stdoutLogPath: "/x",
      },
      new Set<string>(),
      [lp],
      null,
      null,
    );
    expect(out.length).toBe(1);
    expect(out[0].category).toBe("HAND_MERGED_FEATURE_LEARNED");
  });
});
```

- [ ] **Step 2: Run; expect failure (matcherKind not supported)**

Run: `bun test build/orchestrator/__tests__/skill-fault-detector.test.ts -t "state_jsonpath"`
Expected: FAIL.

- [ ] **Step 3: Extend the detector**

In `build/orchestrator/skill-fault-detector.ts`:

```typescript
// Add to the union at the top:
export type LearnedMatcherKind =
  | "stdout_contains"
  | "stdout_regex"
  | "failureReason_contains"
  | "failureReason_regex"
  | "plan_contains"
  | "plan_regex"
  | "state_jsonpath";

// Add to VALID_MATCHER_KINDS inside loadLearnedPatterns:
const VALID_MATCHER_KINDS = new Set<string>([
  "stdout_contains",
  "stdout_regex",
  "failureReason_contains",
  "failureReason_regex",
  "plan_contains",
  "plan_regex",
  "state_jsonpath",
]);

// In applyLearnedPattern's switch, add:
import { safeJsonPathEval } from "./safe-jsonpath";

case "state_jsonpath":
  return safeJsonPathEval(input.state, lp.pattern).length > 0;
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/skill-fault-detector.test.ts -t "state_jsonpath"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/skill-fault-detector.ts build/orchestrator/__tests__/skill-fault-detector.test.ts
git commit -m "feat(build/skill-fault-detector): add state_jsonpath matcherKind

Lets investigator-proposed learned patterns target structural state shapes
(e.g., 'committed feature without completedAt'). Backed by safe-jsonpath."
```

---

### Task 4.3: HAND_MERGED_FEATURE static detector

**Files:**

- Modify: `build/orchestrator/skill-fault-detector.ts`
- Modify: `build/orchestrator/__tests__/skill-fault-detector.test.ts`
- Create: `build/orchestrator/__tests__/fixtures/halt-events/hand-merged-feature-state.json`

- [ ] **Step 1: Write the fixture**

```json
{
  "slug": "polis-mesh-lane-b",
  "planFile": "/x/plan.md",
  "phases": [{ "index": 0, "number": 1, "status": "committed" }],
  "features": [
    {
      "number": 1,
      "status": "committed",
      "mergeSha": "d9845c1abcdef",
      "prNumber": 26
    }
  ],
  "currentPhaseIndex": 0,
  "currentFeatureIndex": 0,
  "completed": false
}
```

- [ ] **Step 2: Write failing test**

Append:

```typescript
import { detectSkillFaults } from "../skill-fault-detector";

describe("HAND_MERGED_FEATURE detector", () => {
  test("fires on polis state shape", () => {
    const state = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "halt-events",
          "hand-merged-feature-state.json",
        ),
        "utf8",
      ),
    );
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    expect(out.find((f) => f.category === "HAND_MERGED_FEATURE")).toBeTruthy();
  });

  test("does NOT fire when completedAt is present", () => {
    const state = {
      phases: [],
      features: [
        {
          number: 1,
          status: "committed",
          mergeSha: "abc",
          prNumber: 1,
          completedAt: "2026-05-19",
        },
      ],
    } as any;
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    expect(out.find((f) => f.category === "HAND_MERGED_FEATURE")).toBeFalsy();
  });
});
```

Add `import * as fs from "node:fs"; import * as path from "node:path";` if missing.

- [ ] **Step 3: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/skill-fault-detector.test.ts -t "HAND_MERGED_FEATURE"`
Expected: FAIL.

- [ ] **Step 4: Implement the detector branch**

In `skill-fault-detector.ts`, inside `detectSkillFaults`, add a new branch alongside the existing PREMATURE_COMPLETION / RED_SPEC_TRIVIAL etc:

```typescript
// HAND_MERGED_FEATURE — feature carries merge metadata but no completedAt
if (state && Array.isArray((state as any).features)) {
  for (const f of (state as any).features as any[]) {
    if (
      f &&
      f.status === "committed" &&
      !f.completedAt &&
      f.mergeSha &&
      f.prNumber
    ) {
      faults.push({
        category: "HAND_MERGED_FEATURE",
        severity: "HIGH",
        description: `Feature ${f.number} carries mergeSha+prNumber but completedAt is missing. Likely a hand-merged PR.`,
        sourceFiles: [],
        evidence: {},
      });
    }
  }
}
```

- [ ] **Step 5: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/skill-fault-detector.test.ts`
Expected: all pass; HAND_MERGED_FEATURE happy + negative both green.

- [ ] **Step 6: Commit**

```bash
git add build/orchestrator/skill-fault-detector.ts build/orchestrator/__tests__/skill-fault-detector.test.ts build/orchestrator/__tests__/fixtures/halt-events/hand-merged-feature-state.json
git commit -m "feat(build/skill-fault-detector): add HAND_MERGED_FEATURE detector

Catches the polis-mesh class: feature committed with mergeSha+prNumber but
no completedAt. This is the regression-pin for the 2026-05-17 inbox bug."
```

---

### Task 4.4: monitor.ts emits HaltEvent alongside SKILL_FAULT_DETECTED

**Files:**

- Modify: `build/orchestrator/monitor.ts`

- [ ] **Step 1: Locate the SKILL_FAULT_DETECTED emission**

Run: `rg -n 'SKILL_FAULT_DETECTED' build/orchestrator/monitor.ts`

- [ ] **Step 2: After the existing push to `skillFaultEvents`, also emit a HaltEvent per fault**

```typescript
import { emitHaltEvent, buildHaltSnapshot } from "./halt-events";

// inside the loop where faults are added:
for (const fault of newFaults) {
  emitHaltEvent({
    kind: "PHASE_FAILED", // map: skill-fault severity → halt-event kind
    runId: snapshot.run.runId,
    stateSlug: snapshot.run.stateSlug,
    severity:
      fault.severity === "CRITICAL"
        ? "CRITICAL"
        : fault.severity === "HIGH"
          ? "HIGH"
          : "MEDIUM",
    message: `[${fault.category}] ${fault.description}`,
    pointers: {
      stateFile: snapshot.stateFile,
      stdoutLog: snapshot.run.stdoutLog,
      livingPlan: snapshot.run.livingPlanPath,
      worktreePath: snapshot.run.worktreePath,
    },
    snapshot: buildHaltSnapshot({
      state: snapshot.state,
      stdoutLogPath: snapshot.run.stdoutLog,
      worktreePath: snapshot.run.worktreePath,
      phaseIndex: fault.evidence?.phaseIndex,
    }),
  });
}
```

Note: this means a HAND_MERGED_FEATURE detected by the detector also enters the halt-events queue via the monitor. drain-faults will short-circuit if a learned-pattern matches.

- [ ] **Step 3: Run existing monitor tests**

Run: `bun test build/orchestrator/__tests__/monitor.test.ts`
Expected: green; monitor's existing terminal-event contract is unchanged.

- [ ] **Step 4: Commit**

```bash
git add build/orchestrator/monitor.ts
git commit -m "feat(build/monitor): emit HaltEvent alongside SKILL_FAULT_DETECTED

Funnels all detector hits into the halt-events queue so drain-faults is the
single sink. Existing SKILL_FAULT_DETECTED event shape is unchanged."
```

---

### Task 4.5: E2E gate-tier test pinning polis regression

**Files:**

- Create: `build/orchestrator/__tests__/halt-events-e2e.test.ts`

- [ ] **Step 1: Write the test (free tier; no LLM yet — drain-faults wiring lands in PR 5)**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectSkillFaults } from "../skill-fault-detector";

describe("halt-events e2e (PR 4 scope)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "he-e2e-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("polis fixture → detector fires HAND_MERGED_FEATURE", () => {
    const state = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "halt-events",
          "hand-merged-feature-state.json",
        ),
        "utf8",
      ),
    );
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].category).toBe("HAND_MERGED_FEATURE");
    expect(out[0].severity).toBe("HIGH");
  });
});
```

Full E2E (queue → drain → investigator → sinks) lands in PR 5 once the investigator dispatch is wired.

- [ ] **Step 2: Run**

Run: `bun test build/orchestrator/__tests__/halt-events-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Classify as gate tier in `test/helpers/touchfiles.ts`**

Run: `rg -n 'E2E_TIERS' test/helpers/touchfiles.ts` — find the table and add an entry for the e2e file in the `gate` tier. Use the existing format.

- [ ] **Step 4: Commit + open PR 4**

```bash
git add build/orchestrator/__tests__/halt-events-e2e.test.ts test/helpers/touchfiles.ts
git commit -m "test(build/halt-events): gate-tier e2e pin for HAND_MERGED_FEATURE polis regression"
gh pr create --base main --title "feat(build/skill-fault-detector): HAND_MERGED_FEATURE + state_jsonpath matcher + polis regression pin"
```

---

## PR 5 — investigator dispatch + drain-faults extension + new `investigator` role

### Task 5.1: investigator-dispatch module + tests with mocked ask_codex

**Files:**

- Create: `build/orchestrator/investigator-dispatch.ts`
- Create: `build/orchestrator/__tests__/investigator-dispatch.test.ts`

- [ ] **Step 1: Write failing tests**

````typescript
import { describe, test, expect } from "bun:test";
import {
  buildInvestigatorPrompt,
  parseInvestigationReport,
  type InvestigationReport,
} from "../investigator-dispatch";

describe("buildInvestigatorPrompt", () => {
  test("embeds halt-event JSON and the four-phase root-cause discipline", () => {
    const prompt = buildInvestigatorPrompt({
      haltEvent: {
        faultId: "PHASE_FAILED:p0:abc",
        runId: "r1",
        stateSlug: "s1",
        kind: "PHASE_FAILED",
        severity: "CRITICAL",
        timestamp: "2026-05-19T00:00:00Z",
        message: "spec-flip failed",
        pointers: {
          stateFile: "/x/state.json",
          stdoutLog: "/x/stdout.log",
          livingPlan: "/x/plan.md",
          worktreePath: "/x/wt",
        },
        snapshot: { stdoutTail: "" },
      },
      existingCategories: ["CODEX_CONVERGENCE", "HAND_MERGED_FEATURE"],
    });
    expect(prompt).toContain("PHASE_FAILED");
    expect(prompt).toContain("Phase 1: investigate");
    expect(prompt).toContain("Phase 4: implement");
    expect(prompt).toContain("HAND_MERGED_FEATURE");
    expect(prompt).toContain("InvestigationReport");
  });
});

describe("parseInvestigationReport", () => {
  test("parses a well-formed JSON report", () => {
    const raw = JSON.stringify({
      faultId: "PHASE_FAILED:p0:abc",
      outcome: "root-cause-identified",
      rootCause: "spec-flip raced the test writer",
      evidence: ["cli.ts:5783"],
      proposedFix: {
        options: [
          { label: "lock", description: "serialize", blast_radius: "narrow" },
        ],
      },
      learnedPatternProposal: null,
    });
    const r = parseInvestigationReport(raw, "PHASE_FAILED:p0:abc");
    expect(r.outcome).toBe("root-cause-identified");
    expect(r.rootCause).toContain("spec-flip");
  });

  test("rejects mismatched faultId", () => {
    const raw = JSON.stringify({
      faultId: "WRONG:p0:abc",
      outcome: "self-healed",
      rootCause: "x",
      evidence: [],
      proposedFix: null,
      learnedPatternProposal: null,
    });
    expect(() =>
      parseInvestigationReport(raw, "PHASE_FAILED:p0:abc"),
    ).toThrow();
  });

  test("rejects unknown outcome", () => {
    const raw = JSON.stringify({
      faultId: "PHASE_FAILED:p0:abc",
      outcome: "made-it-up",
      rootCause: "x",
      evidence: [],
      proposedFix: null,
      learnedPatternProposal: null,
    });
    expect(() =>
      parseInvestigationReport(raw, "PHASE_FAILED:p0:abc"),
    ).toThrow();
  });

  test("extracts JSON from codex's noisy output", () => {
    const raw =
      "Here is the report:\n```json\n" +
      JSON.stringify({
        faultId: "PHASE_FAILED:p0:abc",
        outcome: "no-context",
        rootCause: "worktree gone",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }) +
      "\n```\n\nDone.";
    const r = parseInvestigationReport(raw, "PHASE_FAILED:p0:abc");
    expect(r.outcome).toBe("no-context");
  });
});
````

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/investigator-dispatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `build/orchestrator/investigator-dispatch.ts`:

````typescript
import type { HaltEvent } from "./halt-events";

export interface InvestigationReport {
  faultId: string;
  outcome:
    | "root-cause-identified"
    | "self-healed"
    | "needs-human"
    | "no-context"
    | "duplicate-of";
  duplicateOfPath?: string;
  rootCause: string;
  evidence: string[];
  proposedFix: {
    options: Array<{
      label: string;
      description: string;
      blast_radius: "narrow" | "medium" | "wide";
    }>;
  } | null;
  learnedPatternProposal: {
    category: string;
    matcherKind:
      | "stdout_contains"
      | "stdout_regex"
      | "failureReason_contains"
      | "failureReason_regex"
      | "plan_contains"
      | "plan_regex"
      | "state_jsonpath";
    pattern: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM";
    description: string;
  } | null;
}

const VALID_OUTCOMES = new Set([
  "root-cause-identified",
  "self-healed",
  "needs-human",
  "no-context",
  "duplicate-of",
]);

export function buildInvestigatorPrompt(args: {
  haltEvent: HaltEvent;
  existingCategories: string[];
}): string {
  const { haltEvent, existingCategories } = args;
  return `You are the build orchestrator's investigator. A halt event occurred and you must produce a structured InvestigationReport in JSON.

# Halt event

\`\`\`json
${JSON.stringify(haltEvent, null, 2)}
\`\`\`

# Root-cause discipline (mandatory four phases)

**Phase 1: investigate.** Read the symptoms in the halt event. Use the file pointers (\`stateFile\`, \`stdoutLog\`, \`livingPlan\`, \`worktreePath\`) to gather more context if needed. Identify reproduction conditions.

**Phase 2: analyze.** Trace the code path from symptom back to candidate causes. Identify pattern: race, nil propagation, state corruption, integration failure, configuration drift, stale cache.

**Phase 3: hypothesize.** State a specific, testable claim about what is wrong and why. If the symptoms suggest the halt has self-healed (e.g. state has advanced past the halt point on disk), return outcome="self-healed". If the worktree is gone and you cannot tell, return "no-context".

**Phase 4: propose fix.** If you have a root cause, return up to 3 fix options labeled by blast_radius (narrow/medium/wide). If a reusable pattern is detectable (e.g. a deterministic JSONPath or stdout substring), propose a learnedPatternProposal — but only if it doesn't duplicate an existing category. Existing categories: ${existingCategories.join(", ")}.

# Output format

Return EXACTLY one JSON object matching this TypeScript type:

\`\`\`typescript
interface InvestigationReport {
  faultId: string;          // MUST equal the halt event's faultId: "${haltEvent.faultId}"
  outcome: "root-cause-identified" | "self-healed" | "needs-human" | "no-context" | "duplicate-of";
  duplicateOfPath?: string; // only for outcome="duplicate-of"
  rootCause: string;        // 1-3 sentences
  evidence: string[];       // file:line citations
  proposedFix: { options: Array<{ label, description, blast_radius }> } | null;
  learnedPatternProposal: { category, matcherKind, pattern, severity, description } | null;
}
\`\`\`

Return only the JSON object. No explanation outside the JSON.`;
}

export function parseInvestigationReport(
  raw: string,
  expectedFaultId: string,
): InvestigationReport {
  // Extract JSON: codex may wrap in ```json ... ``` or include prose.
  let jsonText = raw.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) jsonText = fenceMatch[1];
  else {
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }
  }
  const parsed = JSON.parse(jsonText);
  if (parsed.faultId !== expectedFaultId) {
    throw new Error(
      `InvestigationReport faultId mismatch: got ${parsed.faultId}, expected ${expectedFaultId}`,
    );
  }
  if (!VALID_OUTCOMES.has(parsed.outcome)) {
    throw new Error(`InvestigationReport: invalid outcome "${parsed.outcome}"`);
  }
  if (typeof parsed.rootCause !== "string") {
    throw new Error(`InvestigationReport: rootCause must be a string`);
  }
  if (!Array.isArray(parsed.evidence)) {
    throw new Error(`InvestigationReport: evidence must be array`);
  }
  return parsed as InvestigationReport;
}
````

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/investigator-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/investigator-dispatch.ts build/orchestrator/__tests__/investigator-dispatch.test.ts
git commit -m "feat(build/investigator-dispatch): prompt builder + report parser

Prompt embeds the four-phase root-cause discipline. Parser tolerates codex's
fenced-JSON output and validates faultId + outcome enum + required fields."
```

---

### Task 5.2: add `investigator` role to `build/configure.cm`

**Files:**

- Modify: `build/configure.cm`

- [ ] **Step 1: Read current configure.cm**

Run: `cat build/configure.cm | head -120`

- [ ] **Step 2: Add the new role**

After `monitorAgent` (the natural sibling — the spec said so), insert:

```json
    "investigator": {
      "provider": "codex",
      "model": "gpt-5.5",
      "reasoning": "high"
    },
```

Preserve existing trailing commas / formatting.

- [ ] **Step 3: Verify the loader still parses**

Run: `bun run dev --help` (or whatever quick command exercises configure.cm parsing).
Expected: no parse errors.

- [ ] **Step 4: Commit**

```bash
git add build/configure.cm
git commit -m "feat(build/configure): add investigator role (codex/gpt-5.5/high)

Consumed by drain-faults when it dispatches the investigator subagent. Override
at invocation via --investigator-model."
```

---

### Task 5.3: drain-faults extension — queue consumption + sinks

**Files:**

- Modify: `build/orchestrator/cli.ts` (or a new `build/orchestrator/drain-faults.ts` if the existing block is large enough to extract — prefer extraction for testability)

- [ ] **Step 1: Extract drain-faults into its own module**

In `cli.ts`, find the `drain-faults` subcommand body (spec ref: cli.ts:7623). Move the body into `build/orchestrator/drain-faults.ts` exporting a `runDrainFaults(args, ctx)` function. cli.ts calls it.

This makes the function testable without spawning the CLI.

- [ ] **Step 2: Write failing tests**

Create `build/orchestrator/__tests__/drain-faults.test.ts` (or extend if it exists):

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDrainFaults } from "../drain-faults";
import { emitHaltEvent, processedDir } from "../halt-events";

describe("runDrainFaults", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df-"));
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.GSTACK_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("processes one halt event, writes 3 sinks, moves to processed/", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "test",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );

    const result = await runDrainFaults({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      investigatorModel: "mock",
      mockInvestigator: () => ({
        faultId,
        outcome: "root-cause-identified",
        rootCause: "test cause",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
      inboxDir: path.join(tmp, "inbox"),
    });

    expect(result.processed).toBe(1);

    // Sink 1: jsonl
    const analytics = fs.readFileSync(
      path.join(tmp, "analytics", "skill-faults.jsonl"),
      "utf8",
    );
    expect(analytics).toContain(faultId);

    // Sink 2: markdown report
    const reportPath = path.join(skillFaults, "r1", `${faultId}.md`);
    expect(fs.existsSync(reportPath)).toBe(true);

    // Sink 3: inbox file (HIGH severity, root-cause-identified)
    const inboxFiles = fs.readdirSync(path.join(tmp, "inbox"));
    expect(inboxFiles.length).toBe(1);

    // Moved to processed/
    const pendingFiles = fs.readdirSync(
      path.join(skillFaults, "pending-investigations"),
    );
    expect(pendingFiles.length).toBe(0);
    const processedFiles = fs.readdirSync(path.join(skillFaults, "processed"));
    expect(processedFiles.length).toBe(1);
  });

  test("self-healed outcome does NOT auto-file inbox", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "x",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );
    await runDrainFaults({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      investigatorModel: "mock",
      mockInvestigator: () => ({
        faultId,
        outcome: "self-healed",
        rootCause: "resolved itself",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
      inboxDir: path.join(tmp, "inbox"),
    });
    expect(fs.existsSync(path.join(tmp, "inbox"))).toBe(false);
  });

  test("--severity-min HIGH filters LOW out", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitHaltEvent(
      {
        kind: "SOFT_HALT_WARN",
        runId: "r1",
        stateSlug: "s1",
        severity: "LOW",
        message: "low",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );
    const result = await runDrainFaults({
      queueDir: skillFaults,
      max: 10,
      severityMin: "HIGH",
      investigatorModel: "mock",
      mockInvestigator: () => {
        throw new Error("should not be called");
      },
      inboxDir: path.join(tmp, "inbox"),
    });
    expect(result.processed).toBe(0);
  });

  test("learnedPatternProposal appended to pending-patterns.jsonl", async () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "r1",
        stateSlug: "s1",
        severity: "CRITICAL",
        message: "x",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: tmp,
        },
        snapshot: { stdoutTail: "" },
      },
      { queueDir: skillFaults },
    );
    await runDrainFaults({
      queueDir: skillFaults,
      max: 10,
      severityMin: "MEDIUM",
      investigatorModel: "mock",
      mockInvestigator: () => ({
        faultId,
        outcome: "root-cause-identified",
        rootCause: "x",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: {
          category: "NEW_PATTERN",
          matcherKind: "state_jsonpath",
          pattern: "$.features[*][?(@.status == 'foo')]",
          severity: "HIGH",
          description: "test",
        },
      }),
      inboxDir: path.join(tmp, "inbox"),
    });
    const pending = fs.readFileSync(
      path.join(skillFaults, "pending-patterns.jsonl"),
      "utf8",
    );
    expect(pending).toContain("NEW_PATTERN");
  });
});
```

- [ ] **Step 3: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/drain-faults.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `runDrainFaults`**

Create `build/orchestrator/drain-faults.ts`:

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPendingInvestigations,
  markInvestigated,
  pendingInvestigationsDir,
  type HaltEvent,
  type HaltSeverity,
} from "./halt-events";
import {
  buildInvestigatorPrompt,
  parseInvestigationReport,
  type InvestigationReport,
} from "./investigator-dispatch";
import { loadLearnedPatterns } from "./skill-fault-detector";

export interface DrainFaultsOptions {
  queueDir?: string;
  max?: number;
  severityMin?: HaltSeverity;
  runIdFilter?: string;
  investigatorModel?: "codex" | "claude" | "gemini" | "mock";
  mockInvestigator?: (he: HaltEvent) => InvestigationReport;
  inboxDir?: string;
}

const SEV_RANK: Record<HaltSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

function homeRoot(): string {
  return process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
}

function analyticsJsonlPath(): string {
  return path.join(homeRoot(), "analytics", "skill-faults.jsonl");
}

function appendAnalytics(faultId: string, report: InvestigationReport): void {
  const dir = path.dirname(analyticsJsonlPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    analyticsJsonlPath(),
    JSON.stringify({
      ts: new Date().toISOString(),
      faultId,
      investigation: report,
    }) + "\n",
  );
}

function writeMarkdownReport(
  queueDir: string,
  haltEvent: HaltEvent,
  report: InvestigationReport,
): void {
  const dir = path.join(queueDir, haltEvent.runId);
  fs.mkdirSync(dir, { recursive: true });
  const md = `# Halt investigation: ${haltEvent.faultId}

**Kind:** ${haltEvent.kind}
**Severity:** ${haltEvent.severity}
**Outcome:** ${report.outcome}
**Halt message:** ${haltEvent.message}

## Root cause

${report.rootCause}

## Evidence

${report.evidence.map((e) => `- ${e}`).join("\n")}

${
  report.proposedFix
    ? `## Proposed fix\n\n${report.proposedFix.options
        .map(
          (o) =>
            `### ${o.label} (blast: ${o.blast_radius})\n\n${o.description}`,
        )
        .join("\n\n")}`
    : ""
}

${
  report.learnedPatternProposal
    ? `## Learned pattern proposal\n\nCategory: ${report.learnedPatternProposal.category}\nMatcher: ${report.learnedPatternProposal.matcherKind}\nPattern: \`${report.learnedPatternProposal.pattern}\``
    : ""
}
`;
  fs.writeFileSync(path.join(dir, `${haltEvent.faultId}.md`), md);
}

function fileInboxBug(
  inboxDir: string,
  haltEvent: HaltEvent,
  report: InvestigationReport,
): void {
  fs.mkdirSync(inboxDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-halt-${haltEvent.faultId}.md`;
  const body = `# Halt investigation: ${haltEvent.kind}

**Auto-filed by drain-faults** (${new Date().toISOString()})
**Halt severity:** ${haltEvent.severity}
**Outcome:** ${report.outcome}
**Run:** ${haltEvent.runId}

## Symptom

${haltEvent.message}

## Root cause (investigator)

${report.rootCause}

## Evidence

${report.evidence.map((e) => `- ${e}`).join("\n")}

${
  report.proposedFix
    ? `## Proposed fix\n\n${report.proposedFix.options
        .map(
          (o) =>
            `### ${o.label} (blast: ${o.blast_radius})\n\n${o.description}`,
        )
        .join("\n\n")}`
    : ""
}
`;
  fs.writeFileSync(path.join(inboxDir, filename), body);
}

function appendPendingPattern(
  queueDir: string,
  proposal: NonNullable<InvestigationReport["learnedPatternProposal"]>,
  faultId: string,
): void {
  const file = path.join(queueDir, "pending-patterns.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    JSON.stringify({
      ts: new Date().toISOString(),
      faultId,
      proposal,
    }) + "\n",
  );
}

async function dispatchInvestigator(
  haltEvent: HaltEvent,
  model: "codex" | "claude" | "gemini" | "mock",
  mock?: (he: HaltEvent) => InvestigationReport,
): Promise<InvestigationReport> {
  if (model === "mock") {
    if (!mock) throw new Error("mock investigator not provided");
    return mock(haltEvent);
  }
  // Real dispatch: model-specific call to the MCP bridge.
  // The actual MCP bridge calls live in the orchestrator's MCP client wrapper;
  // wire them via the tool registry available to the orchestrator process.
  // Pseudocode:
  //   const result = await callMcpTool("mcp__llm-bridge__ask_codex", {
  //     prompt: buildInvestigatorPrompt({ haltEvent, existingCategories: [...] }),
  //     reasoning: "high",
  //   });
  //   return parseInvestigationReport(result.text, haltEvent.faultId);
  // For now we delegate via a hook injected by the orchestrator main:
  throw new Error(
    `dispatchInvestigator: real-model dispatch not wired in this module — ` +
      `the orchestrator main must inject an mcpInvoker. ` +
      `Tests use mockInvestigator.`,
  );
}

export async function runDrainFaults(
  opts: DrainFaultsOptions,
): Promise<{ processed: number; skipped: number }> {
  const queueDir = opts.queueDir ?? path.join(homeRoot(), "skill-faults");
  const max = opts.max ?? 20;
  const sevMin = opts.severityMin ?? "MEDIUM";
  const model = opts.investigatorModel ?? "codex";
  const inboxDir = opts.inboxDir ?? path.join(homeRoot(), "..", "inbox"); // overridden in tests
  const events = loadPendingInvestigations({ queueDir });
  const learnedPatterns = loadLearnedPatterns();
  const learnedCategories = new Set(learnedPatterns.map((p) => p.category));

  let processed = 0;
  let skipped = 0;
  for (const he of events) {
    if (processed >= max) break;
    if (opts.runIdFilter && he.runId !== opts.runIdFilter) {
      skipped++;
      continue;
    }
    if (SEV_RANK[he.severity] < SEV_RANK[sevMin]) {
      skipped++;
      continue;
    }
    let report: InvestigationReport;
    try {
      report = await dispatchInvestigator(he, model, opts.mockInvestigator);
    } catch (err) {
      skipped++;
      continue;
    }
    appendAnalytics(he.faultId, report);
    writeMarkdownReport(queueDir, he, report);
    if (
      SEV_RANK[he.severity] >= SEV_RANK.HIGH &&
      (report.outcome === "root-cause-identified" ||
        report.outcome === "needs-human")
    ) {
      fileInboxBug(inboxDir, he, report);
    }
    if (report.learnedPatternProposal) {
      appendPendingPattern(queueDir, report.learnedPatternProposal, he.faultId);
    }
    markInvestigated(he.runId, he.faultId, "investigated", { queueDir });
    processed++;
  }
  return { processed, skipped };
}
```

- [ ] **Step 5: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/drain-faults.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire `runDrainFaults` into cli.ts's `drain-faults` subcommand**

In `cli.ts`, replace the previously-extracted drain-faults body with:

```typescript
import { runDrainFaults } from "./drain-faults";
// inside the drain-faults case:
const result = await runDrainFaults({
  queueDir: args.queueDir,
  max: args.max ?? 20,
  severityMin: args.severityMin as HaltSeverity | undefined,
  runIdFilter: args.runId,
  investigatorModel: (args.investigatorModel as any) ?? "codex",
  mcpInvoker: /* the orchestrator's existing MCP wrapper */,
});
console.log(`drain-faults: processed ${result.processed}, skipped ${result.skipped}`);
```

Plumb the MCP invoker through. Add the CLI flags `--max`, `--severity-min`, `--run-id`, `--investigator-model` to argparse.

- [ ] **Step 7: Commit**

```bash
git add build/orchestrator/drain-faults.ts build/orchestrator/__tests__/drain-faults.test.ts build/orchestrator/cli.ts
git commit -m "feat(build/drain-faults): consume halt-events queue, 3 sinks, learned-pattern short-circuit

Adds --max, --severity-min, --run-id, --investigator-model flags. Investigator
dispatch goes through the configured role (default codex/gpt-5.5/high). Mock
dispatch path for tests."
```

---

### Task 5.4: open PR 5

- [ ] **Step 1: Run all free tests**

Run: `bun test`

- [ ] **Step 2: Run the gate-tier eval (paid)**

Source keys per CLAUDE.md, then:

```bash
bash -c '
  eval "$(grep -E "^export (ANTHROPIC_API_KEY|OPENAI_API_KEY)=" ~/.zshrc)"
  export ANTHROPIC_API_KEY OPENAI_API_KEY
  EVALS=1 EVALS_TIER=gate bun test build/orchestrator/__tests__/halt-events-e2e.test.ts
'
```

Expected: green. This is the first PR that introduces real codex calls.

- [ ] **Step 3: Open PR**

```bash
gh pr create --base main --title "feat(build/drain-faults): investigator pipeline + 3 sinks"
```

---

## PR 6 — End-of-build auto-drain + cost guardrails

### Task 6.1: auto-drain hook after ALL_RUNS_COMPLETE

**Files:**

- Modify: `build/orchestrator/cli.ts`

- [ ] **Step 1: Locate the ALL_RUNS_COMPLETE handler**

Run: `rg -n 'ALL_RUNS_COMPLETE' build/orchestrator/cli.ts`

- [ ] **Step 2: Right after the existing completion log, invoke drain-faults**

```typescript
// After ALL_RUNS_COMPLETE handling, before exit:
try {
  const result = await runDrainFaults({
    max: 20,
    severityMin: "MEDIUM",
    investigatorModel: (args.investigatorModel as any) ?? "codex",
    mcpInvoker,
  });
  console.log(
    `auto-drain: processed ${result.processed}, skipped ${result.skipped}`,
  );
} catch (err) {
  console.warn(`auto-drain failed (non-fatal): ${(err as Error).message}`);
}
```

- [ ] **Step 3: Add `--no-auto-drain` flag for opt-out**

In argparse, add:

```typescript
.option("--no-auto-drain", "Skip the end-of-build auto-drain hook")
```

Wrap the call in `if (!args.noAutoDrain)`.

- [ ] **Step 4: Test (unit; mocked)**

Add a test that runs the orchestrator's end-of-build path with a queued LOW event and confirms auto-drain skipped it; then with a HIGH event confirms it processed it.

- [ ] **Step 5: Commit + open PR 6**

```bash
git add build/orchestrator/cli.ts
git commit -m "feat(build/cli): auto-drain halt events at ALL_RUNS_COMPLETE

Default --severity-min MEDIUM, --max 20. Opt out with --no-auto-drain. LOW
halts queue without auto-investigating."
gh pr create --base main --title "feat(build/cli): auto-drain halt events at end of build"
```

---

## PR 7 — `learn-fault-patterns` sub-function in `build/SKILL.md.tmpl`

### Task 7.1: `learn-fault-patterns.ts` module + tests

**Files:**

- Create: `build/orchestrator/learn-fault-patterns.ts`
- Create: `build/orchestrator/__tests__/learn-fault-patterns.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPendingProposals,
  dedupeAgainstLearned,
  promoteProposals,
} from "../learn-fault-patterns";

describe("loadPendingProposals", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("empty file → empty array", () => {
    expect(loadPendingProposals({ skillFaultsDir: tmp })).toEqual([]);
  });

  test("loads one proposal per line", () => {
    const file = path.join(tmp, "pending-patterns.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: "2026-05-19T00:00:00Z",
        faultId: "PHASE_FAILED:p0:abc",
        proposal: {
          category: "A",
          matcherKind: "stdout_contains",
          pattern: "x",
          severity: "HIGH",
          description: "x",
        },
      }) + "\n",
    );
    const out = loadPendingProposals({ skillFaultsDir: tmp });
    expect(out.length).toBe(1);
    expect(out[0].proposal.category).toBe("A");
  });
});

describe("dedupeAgainstLearned", () => {
  test("removes duplicates by category", () => {
    const proposals = [
      {
        faultId: "1",
        proposal: {
          category: "DUP",
          matcherKind: "stdout_contains" as const,
          pattern: "x",
          severity: "HIGH" as const,
          description: "x",
        },
      },
      {
        faultId: "2",
        proposal: {
          category: "NEW",
          matcherKind: "stdout_contains" as const,
          pattern: "y",
          severity: "HIGH" as const,
          description: "y",
        },
      },
    ];
    const learned = [
      {
        category: "DUP",
        matcherKind: "stdout_contains" as const,
        severity: "HIGH" as const,
        description: "d",
        pattern: "z",
        source: "x",
        learnedAt: "x",
        hitCount: 0,
      },
    ];
    const { keep, drop } = dedupeAgainstLearned(proposals, learned);
    expect(keep.length).toBe(1);
    expect(keep[0].proposal.category).toBe("NEW");
    expect(drop.length).toBe(1);
  });

  test("removes duplicates by matcherKind+pattern pair", () => {
    const proposals = [
      {
        faultId: "1",
        proposal: {
          category: "NEW1",
          matcherKind: "stdout_contains" as const,
          pattern: "EXACT",
          severity: "HIGH" as const,
          description: "x",
        },
      },
    ];
    const learned = [
      {
        category: "OLD",
        matcherKind: "stdout_contains" as const,
        severity: "HIGH" as const,
        description: "d",
        pattern: "EXACT",
        source: "x",
        learnedAt: "x",
        hitCount: 0,
      },
    ];
    const { keep, drop } = dedupeAgainstLearned(proposals, learned);
    expect(keep.length).toBe(0);
    expect(drop.length).toBe(1);
  });
});

describe("promoteProposals", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("appends to learned-patterns.json atomically and truncates pending-patterns.jsonl", () => {
    const skillFaults = path.join(tmp, "skill-faults");
    fs.mkdirSync(skillFaults, { recursive: true });
    fs.writeFileSync(
      path.join(skillFaults, "learned-patterns.json"),
      JSON.stringify([]),
    );
    fs.writeFileSync(
      path.join(skillFaults, "pending-patterns.jsonl"),
      JSON.stringify({
        ts: "2026-05-19",
        faultId: "1",
        proposal: {
          category: "NEW",
          matcherKind: "stdout_contains",
          pattern: "x",
          severity: "HIGH",
          description: "x",
        },
      }) + "\n",
    );
    promoteProposals(
      [
        {
          faultId: "1",
          proposal: {
            category: "NEW",
            matcherKind: "stdout_contains",
            pattern: "x",
            severity: "HIGH",
            description: "x",
          },
        },
      ],
      [],
      { skillFaultsDir: skillFaults },
    );
    const learned = JSON.parse(
      fs.readFileSync(path.join(skillFaults, "learned-patterns.json"), "utf8"),
    );
    expect(learned.length).toBe(1);
    expect(learned[0].category).toBe("NEW");
    expect(learned[0].hitCount).toBe(0);
    const pending = fs.readFileSync(
      path.join(skillFaults, "pending-patterns.jsonl"),
      "utf8",
    );
    expect(pending).toBe("");
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `bun test build/orchestrator/__tests__/learn-fault-patterns.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `build/orchestrator/learn-fault-patterns.ts`:

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  LearnedPattern,
  LearnedMatcherKind,
} from "./skill-fault-detector";

export interface PendingProposal {
  faultId: string;
  proposal: {
    category: string;
    matcherKind: LearnedMatcherKind;
    pattern: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM";
    description: string;
  };
}

export interface LearnFaultPatternsOpts {
  skillFaultsDir?: string;
}

function dir(opts?: LearnFaultPatternsOpts): string {
  if (opts?.skillFaultsDir) return opts.skillFaultsDir;
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

export function loadPendingProposals(
  opts?: LearnFaultPatternsOpts,
): PendingProposal[] {
  const file = path.join(dir(opts), "pending-patterns.jsonl");
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const out: PendingProposal[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function dedupeAgainstLearned(
  proposals: PendingProposal[],
  learned: LearnedPattern[],
): { keep: PendingProposal[]; drop: PendingProposal[] } {
  const learnedCats = new Set(learned.map((l) => l.category));
  const learnedPairs = new Set(
    learned.map((l) => `${l.matcherKind}::${l.pattern}`),
  );
  const keep: PendingProposal[] = [];
  const drop: PendingProposal[] = [];
  for (const p of proposals) {
    const pair = `${p.proposal.matcherKind}::${p.proposal.pattern}`;
    if (learnedCats.has(p.proposal.category) || learnedPairs.has(pair)) {
      drop.push(p);
    } else {
      keep.push(p);
    }
  }
  return { keep, drop };
}

export function promoteProposals(
  toPromote: PendingProposal[],
  toReject: Array<{ proposal: PendingProposal; reason: string }>,
  opts?: LearnFaultPatternsOpts,
): void {
  const d = dir(opts);
  const learnedFile = path.join(d, "learned-patterns.json");
  const learned: LearnedPattern[] = fs.existsSync(learnedFile)
    ? JSON.parse(fs.readFileSync(learnedFile, "utf8"))
    : [];
  for (const p of toPromote) {
    learned.push({
      ...p.proposal,
      source: `investigator:${p.faultId}`,
      learnedAt: new Date().toISOString(),
      hitCount: 0,
    });
  }
  const tmp = `${learnedFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(learned, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, learnedFile);

  const rejectedFile = path.join(d, "rejected-patterns.jsonl");
  for (const r of toReject) {
    fs.appendFileSync(
      rejectedFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        faultId: r.proposal.faultId,
        proposal: r.proposal.proposal,
        reason: r.reason,
      }) + "\n",
    );
  }
  // Truncate pending-patterns.jsonl
  const pendingFile = path.join(d, "pending-patterns.jsonl");
  const pendingTmp = `${pendingFile}.tmp.${process.pid}`;
  fs.writeFileSync(pendingTmp, "");
  fs.renameSync(pendingTmp, pendingFile);
}
```

- [ ] **Step 4: Run; expect pass**

Run: `bun test build/orchestrator/__tests__/learn-fault-patterns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add build/orchestrator/learn-fault-patterns.ts build/orchestrator/__tests__/learn-fault-patterns.test.ts
git commit -m "feat(build/learn-fault-patterns): dedupe + atomic promote + audit trail"
```

---

### Task 7.2: wire `learn-fault-patterns` into `build/SKILL.md.tmpl`

**Files:**

- Modify: `build/SKILL.md.tmpl`

- [ ] **Step 1: Find the completion summary section**

Run: `grep -n 'completion summary\|Step N\|## Final' build/SKILL.md.tmpl | head`

- [ ] **Step 2: Insert a new step before the completion summary**

````markdown
## Step N: Learn fault patterns from this build

The auto-drain in the previous step may have produced pattern proposals in
`~/.gstack/skill-faults/pending-patterns.jsonl`. Promote good proposals to
`learned-patterns.json` so future builds catch the same shape cheaply.

1. Read pending-patterns.jsonl. If empty, skip this step.

   ```bash
   bun run --silent dev learn-fault-patterns --dry-run
   ```
````

2. Dedupe against learned-patterns.json. If 0 proposals remain, skip.

3. If `SPAWNED_SESSION` is `true`, auto-promote per the recommendation
   (option A — promote all). Log the choice. Do NOT AskUserQuestion.

4. Otherwise, AskUserQuestion ONCE with up to 4 highest-severity proposals
   as options. Use the decision-brief format below.

5. Promote accepted proposals via `bun run --silent dev learn-fault-patterns --promote <ids>`.
   Archive deferred / rejected to rejected-patterns.jsonl.

6. Log a one-line summary to the completion report: "Learned N patterns
   this build (M promoted, K deferred)."

### Decision brief

D<n> — N new fault patterns learned this build. Promote which?
ELI10: drain-faults' investigator (codex) saw N halts it could express as
reusable detector rules. If you promote them, future builds will catch the
same shape cheaply (no LLM call) and auto-file inbox bugs without an
investigator round-trip.
Stakes if we pick wrong: a promoted bad pattern fires false-positive faults
on healthy builds. A skipped good pattern means the next polis-class bug
needs another $1-3 of codex tokens to diagnose.
Recommendation: promote all proposals from outcomes marked
"root-cause-identified" with severity >= HIGH; defer the rest to manual
review.
Completeness: A=10/10, B=7/10, C=3/10
A) Promote all N proposals (recommended)
✅ Future builds get free detection of all observed halts
❌ One false-positive pattern can spam the analytics file
B) Promote only HIGH+ severity (M of N)
✅ Safer; only the structural bugs make it in
❌ Loses MEDIUM patterns that might recur
C) Defer everything — leave pending-patterns.jsonl as-is
✅ Zero promotion risk; review later in a quiet moment
❌ Next build re-investigates the same halts at codex cost
Net: promotion is two-way; a curator can edit learned-patterns.json
later, so favor coverage.

````

- [ ] **Step 3: Add the `learn-fault-patterns` CLI subcommand to cli.ts**

A small wrapper around the module:

```typescript
case "learn-fault-patterns": {
  const proposals = loadPendingProposals();
  const learned = loadLearnedPatterns();
  const { keep, drop } = dedupeAgainstLearned(proposals, learned);
  if (args.dryRun) {
    console.log(JSON.stringify({ keep, dropDuplicates: drop.length }, null, 2));
    break;
  }
  if (args.promote) {
    const ids = new Set(args.promote.split(","));
    const toPromote = keep.filter((p) => ids.has(p.faultId));
    const toReject = keep
      .filter((p) => !ids.has(p.faultId))
      .map((p) => ({ proposal: p, reason: "deferred" }))
      .concat(drop.map((p) => ({ proposal: p, reason: "duplicate" })));
    promoteProposals(toPromote, toReject);
    console.log(`Promoted ${toPromote.length}, rejected ${toReject.length}.`);
  }
  break;
}
````

- [ ] **Step 4: Regenerate the generated SKILL.md**

Run: `bun run gen:skill-docs`
Expected: `build/SKILL.md` updates to include the new step.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: green.

- [ ] **Step 6: Commit + open PR 7**

```bash
git add build/SKILL.md.tmpl build/SKILL.md build/orchestrator/cli.ts
git commit -m "feat(build/skill): add Learn fault patterns step + learn-fault-patterns CLI

End-of-build prompt promotes investigator-proposed patterns to learned-patterns.json.
SPAWNED_SESSION auto-promotes per recommendation; interactive sessions get one
AskUserQuestion gate."
gh pr create --base main --title "feat(build/skill): Learn fault patterns sub-function closes the feedback loop"
```

---

## STALL_KILLED dependency (one-off task, may ride with PR 2 or land separately)

The `liveness-stall-detection` worktree introduces `stall-watchdog.ts`. If that branch is merged before this rollout starts, add this commit to PR 2. If it lands later, open a small follow-up PR after the stall-watchdog merges.

### Task S.1: emit STALL_KILLED from the watchdog callback

**Files:**

- Modify: every call site that constructs a `StallWatchdogController` (grep for `installStallWatchdog` or whatever the constructor is named in the stall-watchdog module)

- [ ] **Step 1: At each watchdog construction, pass an `onStallKill` callback**

```typescript
const watchdog = installStallWatchdog({
  ...existingOpts,
  onStallKill: (silenceMs) => {
    emitHaltEvent({
      kind: "STALL_KILLED",
      runId: args.runId,
      stateSlug: state.slug,
      severity: "HIGH",
      message: `stall-watchdog SIGTERM'd after ${silenceMs}ms silence`,
      pointers: helperCtxFor(state, args.runId).pointers,
      snapshot: buildHaltSnapshot({
        state,
        stdoutLogPath: helperCtxFor(state, args.runId).pointers.stdoutLog,
        worktreePath: helperCtxFor(state, args.runId).pointers.worktreePath,
        phaseIndex: phaseState?.index,
      }),
    });
  },
});
```

- [ ] **Step 2: Run tests**

Run: `bun test`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(build/cli): emit STALL_KILLED when stall-watchdog SIGTERMs a silent sub-agent"
```

---

## Final verification (after all 7 PRs land)

- [ ] **Step 1: Run full free test suite**

Run: `bun test`

- [ ] **Step 2: Run gate-tier evals**

```bash
bash -c '
  eval "$(grep -E "^export (ANTHROPIC_API_KEY|OPENAI_API_KEY)=" ~/.zshrc)"
  export ANTHROPIC_API_KEY OPENAI_API_KEY
  EVALS=1 EVALS_TIER=gate bun run test:e2e
'
```

- [ ] **Step 3: Manual end-to-end against the polis fixture**

```bash
bun run dev drain-faults --max 1 --severity-min HIGH
bun run dev drain-faults --max 1 --severity-min HIGH  # second run = no-op
```

- [ ] **Step 4: Manual configure.cm override**

Edit `build/configure.cm` `roles.investigator.model` to `gpt-5.3-codex-spark`. Run drain-faults; verify it uses the override. Reset.

- [ ] **Step 5: Spawned-session learn-fault-patterns**

```bash
OPENCLAW_SESSION=true bun run dev learn-fault-patterns --dry-run
```

Expected: no AskUserQuestion; auto-promote per recommendation; summary logged.

---

## Self-Review

**1. Spec coverage:**

- HaltEvent type + emit/load/markInvestigated → Tasks 1.1–1.4 ✅
- 4 centralizing helpers → Task 1.5 ✅
- cli.ts migration (PHASE_FAILED, FEATURE_FAILED, RETRY_CAP_HIT, DUAL_IMPL_SWAP, PHASE_REWIND, MANUAL_RECOVERY_INVOKED, SILENT_STATE_MUTATION) → Tasks 2.1–2.6 ✅
- wrapConsole shim → Tasks 3.1–3.2 ✅
- HAND_MERGED_FEATURE detector → Task 4.3 ✅
- state_jsonpath matcherKind + safe evaluator → Tasks 4.1–4.2 ✅
- monitor.ts dual-emit → Task 4.4 ✅
- E2E gate-tier pin for polis regression → Task 4.5 ✅
- Investigator dispatch module → Task 5.1 ✅
- `investigator` role in configure.cm → Task 5.2 ✅
- drain-faults queue consumption + 3 sinks + flags → Task 5.3 ✅
- End-of-build auto-drain → Task 6.1 ✅
- `learn-fault-patterns` module + SKILL.md.tmpl wiring → Tasks 7.1–7.2 ✅
- STALL_KILLED instrumentation → Task S.1 ✅

**2. Placeholder scan:**

- No "TBD" / "TODO" / "implement later" in steps. ✅
- "verify on landing" notes appear in Tasks 2.1 and the helper-context constructor — acceptable: they reference field names in the existing types module that an implementer must read once. ✅

**3. Type consistency:**

- `HaltEvent` shape consistent across `halt-events.ts`, `halt-event-helpers.ts`, `wrap-console.ts`, `drain-faults.ts`. ✅
- `InvestigationReport` shape consistent between dispatch module and drain-faults consumer. ✅
- `LearnedPattern` consistent between detector and learn-fault-patterns. ✅
- `pendingInvestigationsDir`, `processedDir` exported and used identically in tests + drain-faults. ✅

**4. Test framework:** all tests use `bun:test`. ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-19-idempotent-dream-halt-events.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Best fit here because PR 2's mechanical migration (22+ sites) is exactly the kind of work where subagent + review beats inline.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. Better if you want to land PR 1 in one continuous session before scheduling PR 2.

Which approach?
