# /build investigate subcommand — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual-trigger `gstack-build investigate` subcommand that runs the four-phase `/investigate` methodology in the current Claude session against a build fault and writes both a machine report and (for HIGH/CRITICAL) a human bug report.

**Architecture:** A new `runInvestigateMode` orchestrator in the gstack-build CLI resolves context (auto-detect active run / explicit faultId / `--state` / `--symptoms`), acquires a local file lock, and emits a structured `<<<GSTACK_INVESTIGATE_BRIEFING>>>` JSON block to stdout. The Claude session reads that block, performs the four investigation phases, writes a JSON report to a tmp path, and shells out to a sister `gstack-build investigate-finalize` subcommand that validates the report (via the existing `parseInvestigationReport`) and writes the dual artifacts: `~/.gstack/skill-faults/<runId>/<faultId>.md` (machine) and `inbox/BUGREPORT-<date>-<slug>.md` (human, HIGH/CRITICAL only).

**Tech Stack:** TypeScript (Bun runtime), node:fs / node:path / node:crypto, `bun:test`. Reuses existing modules: `investigator-dispatch.ts` (`parseInvestigationReport`, `InvestigationReport` type), `halt-events.ts` (`HaltEvent`, `pendingInvestigationsDir`, `processedDir`), `active-runs.ts` (`readActiveRunRecords`, `defaultActiveRunRegistryDir`), `skill-fault-detector.ts` (severity constants).

**Spec:** [docs/superpowers/specs/2026-05-22-build-investigate-subcommand-design.md](../specs/2026-05-22-build-investigate-subcommand-design.md)

---

## File structure

**New files:**

- `build/orchestrator/investigate-mode.ts` — Entry points `runInvestigateMode(args)` and `runInvestigateFinalize(args)`. Briefing emission, lock acquisition, artifact orchestration.
- `build/orchestrator/investigate-context.ts` — Pure functions: `resolveInvestigationContext(args)`, `tailStdoutLog(path, state, opts)`, `loadHaltEventByFaultId(faultId, opts)`, `pickMostRecentActiveRun(opts)`.
- `build/orchestrator/investigate-report-writer.ts` — Pure functions: `writeMachineReport(report, ctx)`, `writeBugReport(report, ctx)`, `bugReportSlug(report, ctx)`, `renderBugReportMarkdown(report, ctx)`.
- `build/orchestrator/investigate-lock.ts` — Local file lock with PID + ISO timestamp payload, stale-age reclamation. `acquireFaultLock(runId, faultId)`, `releaseFaultLock(handle)`, `isLockStale(payload, nowMs, maxAgeMs)`.
- `build/orchestrator/__tests__/investigate-context.test.ts`
- `build/orchestrator/__tests__/investigate-context-tail.test.ts`
- `build/orchestrator/__tests__/investigate-report-writer.test.ts`
- `build/orchestrator/__tests__/investigate-report-writer-severity.test.ts`
- `build/orchestrator/__tests__/investigate-finalize-validation.test.ts`
- `build/orchestrator/__tests__/investigate-mode-exit-codes.test.ts`
- `build/orchestrator/__tests__/investigate-lock.test.ts`
- `build/orchestrator/__tests__/investigate-end-to-end.test.ts`
- `build/orchestrator/__tests__/investigate-auto-detect.test.ts`
- `build/orchestrator/__tests__/investigate-no-context-fallback.test.ts`
- `test/fixtures/investigate/halt-event-codex-convergence.json`
- `test/fixtures/investigate/state-with-recent-errors.json`
- `test/fixtures/investigate/stdout-log.txt`
- `test/fixtures/investigate/canned-report-success.json`
- `test/fixtures/investigate/canned-report-bad-faultid.json`
- `test/skill-e2e-build-investigate.test.ts` (paid, periodic tier)

**Modified files:**

- `build/orchestrator/cli.ts` — Add `investigate` and `investigate-finalize` to `parseArgs` dispatch (lines ~1638) and `main()` dispatch (lines ~10383). Extend `Args` interface (~line 750) with new fields. Add help text entries (~line 2877).
- `build/SKILL.md.tmpl` — Add a new "Investigation methodology" block (~30 lines) instructing the Claude session how to react to a `<<<GSTACK_INVESTIGATE_BRIEFING>>>` block.
- `test/helpers/touchfiles.ts` — Register the E2E test's touchfile dependencies.

---

## Task 1: Investigate-lock primitive (TDD foundation)

**Files:**

- Create: `build/orchestrator/investigate-lock.ts`
- Test: `build/orchestrator/__tests__/investigate-lock.test.ts`

This is the lowest-level primitive. Everything else depends on it for concurrency correctness.

- [ ] **Step 1.1: Write the lock-acquire test**

Create `build/orchestrator/__tests__/investigate-lock.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireFaultLock,
  releaseFaultLock,
  isLockStale,
  type FaultLockHandle,
} from "../investigate-lock";

const tmpRoot = path.join(
  os.tmpdir(),
  `gstack-investigate-lock-${process.pid}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireFaultLock", () => {
  test("acquires lock when none exists", () => {
    const handle = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    });
    expect(handle).not.toBeNull();
    expect(handle!.lockPath).toBe(
      path.join(tmpRoot, "run-1", ".CAT:p0:abc123.lock"),
    );
    expect(fs.existsSync(handle!.lockPath)).toBe(true);
  });

  test("returns null when fresh lock already exists", () => {
    const first = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    });
    expect(first).not.toBeNull();
    const second = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    });
    expect(second).toBeNull();
  });

  test("reclaims stale lock older than maxAgeMs", () => {
    const lockPath = path.join(tmpRoot, "run-1", ".CAT:p0:abc123.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const oldPayload = {
      pid: 999999,
      acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(oldPayload));
    const handle = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
      maxAgeMs: 60 * 60 * 1000,
    });
    expect(handle).not.toBeNull();
  });
});

describe("releaseFaultLock", () => {
  test("removes the lockfile", () => {
    const handle = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    })!;
    releaseFaultLock(handle);
    expect(fs.existsSync(handle.lockPath)).toBe(false);
  });

  test("is idempotent when lockfile already gone", () => {
    const handle: FaultLockHandle = {
      lockPath: path.join(tmpRoot, "nonexistent.lock"),
      acquiredAt: new Date().toISOString(),
    };
    expect(() => releaseFaultLock(handle)).not.toThrow();
  });
});

describe("isLockStale", () => {
  test("returns true when acquiredAt older than maxAgeMs", () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(
      isLockStale({ pid: 1, acquiredAt: old }, Date.now(), 60 * 60 * 1000),
    ).toBe(true);
  });

  test("returns false when acquiredAt is fresh", () => {
    const fresh = new Date().toISOString();
    expect(
      isLockStale({ pid: 1, acquiredAt: fresh }, Date.now(), 60 * 60 * 1000),
    ).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `bun test build/orchestrator/__tests__/investigate-lock.test.ts`
Expected: FAIL — module `../investigate-lock` not found.

- [ ] **Step 1.3: Implement `investigate-lock.ts`**

Create `build/orchestrator/investigate-lock.ts`:

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FaultLockPayload {
  pid: number;
  acquiredAt: string;
}

export interface FaultLockHandle {
  lockPath: string;
  acquiredAt: string;
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

function defaultFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

export function isLockStale(
  payload: FaultLockPayload,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const acquiredMs = Date.parse(payload.acquiredAt);
  if (Number.isNaN(acquiredMs)) return true;
  return nowMs - acquiredMs > maxAgeMs;
}

export function acquireFaultLock(args: {
  runId: string;
  faultId: string;
  faultsDir?: string;
  maxAgeMs?: number;
}): FaultLockHandle | null {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const maxAgeMs = args.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const runDir = path.join(faultsDir, args.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, `.${args.faultId}.lock`);
  const acquiredAt = new Date().toISOString();
  const payload: FaultLockPayload = { pid: process.pid, acquiredAt };

  if (fs.existsSync(lockPath)) {
    let existing: FaultLockPayload | null = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // Corrupt lockfile — treat as stale.
      existing = null;
    }
    if (existing && !isLockStale(existing, Date.now(), maxAgeMs)) {
      return null;
    }
    // Reclaim stale or corrupt lock.
    try {
      fs.unlinkSync(lockPath);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  const tmpPath = `${lockPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmpPath, lockPath);
  return { lockPath, acquiredAt };
}

export function releaseFaultLock(handle: FaultLockHandle): void {
  try {
    fs.unlinkSync(handle.lockPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    throw err;
  }
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `bun test build/orchestrator/__tests__/investigate-lock.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 1.5: Commit**

```bash
git add build/orchestrator/investigate-lock.ts build/orchestrator/__tests__/investigate-lock.test.ts
git commit -m "feat(build): fault lock primitive for investigate subcommand

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fixtures (shared test data)

**Files:**

- Create: `test/fixtures/investigate/halt-event-codex-convergence.json`
- Create: `test/fixtures/investigate/state-with-recent-errors.json`
- Create: `test/fixtures/investigate/stdout-log.txt`
- Create: `test/fixtures/investigate/canned-report-success.json`
- Create: `test/fixtures/investigate/canned-report-bad-faultid.json`

These fixtures get reused by every test from Task 3 onward. Define once.

- [ ] **Step 2.1: Create the halt-event fixture**

Create `test/fixtures/investigate/halt-event-codex-convergence.json` (a realistic `HaltEvent` matching the type in `build/orchestrator/halt-events.ts:30-74`):

```json
{
  "faultId": "PHASE_FAILED:p3:a4f2b1c8",
  "runId": "test-run-investigate-001",
  "stateSlug": "feat-investigate-subcommand",
  "kind": "PHASE_FAILED",
  "severity": "HIGH",
  "timestamp": "2026-05-22T10:15:00.000Z",
  "message": "Phase 3 codex review never converged after 7 iterations",
  "investigate": true,
  "pointers": {
    "stateFile": "/tmp/gstack-investigate-test/state.json",
    "stdoutLog": "/tmp/gstack-investigate-test/stdout.log",
    "livingPlan": "/tmp/gstack-investigate-test/living-plan.md",
    "worktreePath": "/tmp/gstack-investigate-test/worktree"
  },
  "snapshot": {
    "phase": { "index": 3, "title": "Wire up the CLI", "status": "failed" },
    "failureReason": "codexReview iteration cap (7) exhausted; last verdict: changes-requested",
    "iterationHistory": { "testRun": 4, "testFix": 2, "codexReview": 7 },
    "worktreeHead": "deadbeef1234",
    "stdoutTail": "[2026-05-22T10:14:55Z] codex review round 7: changes-requested\n[2026-05-22T10:14:58Z] iteration cap reached, halting phase"
  }
}
```

- [ ] **Step 2.2: Create the state fixture**

Create `test/fixtures/investigate/state-with-recent-errors.json`:

```json
{
  "runId": "test-run-investigate-001",
  "stateSlug": "feat-investigate-subcommand",
  "phases": [
    { "index": 0, "title": "Plan", "status": "complete" },
    { "index": 1, "title": "Scaffold", "status": "complete" },
    { "index": 2, "title": "Tests", "status": "complete" },
    { "index": 3, "title": "Wire up the CLI", "status": "failed" }
  ],
  "features": [],
  "recentErrors": [
    {
      "timestamp": "2026-05-22T10:12:30.000Z",
      "summary": "codex round 5 changes-requested"
    },
    {
      "timestamp": "2026-05-22T10:13:45.000Z",
      "summary": "codex round 6 changes-requested"
    },
    {
      "timestamp": "2026-05-22T10:14:55.000Z",
      "summary": "codex round 7 changes-requested; cap reached"
    }
  ]
}
```

- [ ] **Step 2.3: Create the stdout log fixture**

Create `test/fixtures/investigate/stdout-log.txt` (~2000 lines with planted error sections). Generate it programmatically in one shot:

Run:

```bash
node -e '
const fs = require("fs");
const lines = [];
for (let i = 0; i < 2000; i++) {
  const t = new Date(Date.parse("2026-05-22T10:00:00Z") + i * 1000).toISOString();
  if (i === 750) lines.push(`[${t}] codex review round 5 changes-requested`);
  else if (i === 825) lines.push(`[${t}] codex review round 6 changes-requested`);
  else if (i === 895) lines.push(`[${t}] codex review round 7 changes-requested`);
  else if (i === 896) lines.push(`[${t}] iteration cap reached, halting phase`);
  else lines.push(`[${t}] heartbeat ${i}`);
}
fs.writeFileSync("test/fixtures/investigate/stdout-log.txt", lines.join("\n") + "\n");
'
```

- [ ] **Step 2.4: Create the canned-report fixtures**

Create `test/fixtures/investigate/canned-report-success.json` (matches `InvestigationReport` from `build/orchestrator/investigator-dispatch.ts:24-56`):

```json
{
  "faultId": "PHASE_FAILED:p3:a4f2b1c8",
  "outcome": "root-cause-identified",
  "rootCause": "The phase's plan does not specify a stop condition the codex reviewer accepts; each round adds new feedback because the acceptance bar is missing.",
  "evidence": [
    "test/fixtures/investigate/state-with-recent-errors.json:9",
    "test/fixtures/investigate/stdout-log.txt:896"
  ],
  "proposedFix": {
    "options": [
      {
        "label": "Add an explicit acceptance checklist to the phase plan",
        "description": "Prepend an 'Acceptance' section listing test commands + lint checks; codex stops requesting changes once all items are check-marked.",
        "blast_radius": "narrow"
      },
      {
        "label": "Lower codex review iteration cap to 3 and escalate to plan-mutator",
        "description": "On cap-hit, mutate the plan via plan-mutator rather than retrying the same review loop.",
        "blast_radius": "medium"
      }
    ]
  },
  "learnedPatternProposal": {
    "category": "PLAN_REVIEW_STALEMATE_NO_ACCEPTANCE",
    "matcherKind": "stdout_regex",
    "pattern": "codex review round \\d+ changes-requested\\n.*iteration cap reached",
    "severity": "HIGH",
    "description": "Codex reviewer never converges because the plan has no explicit acceptance criteria."
  }
}
```

Create `test/fixtures/investigate/canned-report-bad-faultid.json`:

```json
{
  "faultId": "WRONG_FAULT_ID:p0:00000000",
  "outcome": "root-cause-identified",
  "rootCause": "irrelevant",
  "evidence": [],
  "proposedFix": null,
  "learnedPatternProposal": null
}
```

- [ ] **Step 2.5: Commit fixtures**

```bash
git add test/fixtures/investigate/
git commit -m "test(build): fixtures for /build investigate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Context resolver — stdout tail

**Files:**

- Create: `build/orchestrator/investigate-context.ts` (partial — `tailStdoutLog` only)
- Test: `build/orchestrator/__tests__/investigate-context-tail.test.ts`

Start narrow: tail extraction is a pure function with clear inputs/outputs.

- [ ] **Step 3.1: Write the tail test**

Create `build/orchestrator/__tests__/investigate-context-tail.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { tailStdoutLog } from "../investigate-context";

const FIXTURE_LOG = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/stdout-log.txt",
);
const FIXTURE_STATE = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/state-with-recent-errors.json",
);

describe("tailStdoutLog", () => {
  test("returns last 500 lines when state has no recentErrors", () => {
    const result = tailStdoutLog({
      stdoutPath: FIXTURE_LOG,
      recentErrors: [],
      tailLines: 500,
      windowLines: 50,
    });
    const lines = result.trim().split("\n");
    expect(lines.length).toBe(500);
    // Last line should be heartbeat 1999.
    expect(lines[lines.length - 1]).toContain("heartbeat 1999");
  });

  test("includes ±50 lines around each recentErrors timestamp", () => {
    const recentErrors = [
      { timestamp: "2026-05-22T10:12:30.000Z", summary: "round 5" },
    ];
    const result = tailStdoutLog({
      stdoutPath: FIXTURE_LOG,
      recentErrors,
      tailLines: 500,
      windowLines: 50,
    });
    // Line 750 (codex round 5) corresponds to T+750s = 10:12:30Z.
    expect(result).toContain("codex review round 5 changes-requested");
  });

  test("merges overlapping windows and dedupes lines", () => {
    const recentErrors = [
      { timestamp: "2026-05-22T10:14:55.000Z", summary: "round 7" },
      { timestamp: "2026-05-22T10:14:56.000Z", summary: "cap reached" },
    ];
    const result = tailStdoutLog({
      stdoutPath: FIXTURE_LOG,
      recentErrors,
      tailLines: 0,
      windowLines: 50,
    });
    const round7Count = (result.match(/codex review round 7/g) ?? []).length;
    expect(round7Count).toBe(1);
  });

  test("returns empty string when stdoutPath does not exist", () => {
    expect(
      tailStdoutLog({
        stdoutPath: "/nonexistent/path/to/log.txt",
        recentErrors: [],
        tailLines: 500,
        windowLines: 50,
      }),
    ).toBe("");
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `bun test build/orchestrator/__tests__/investigate-context-tail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `tailStdoutLog` in `investigate-context.ts`**

Create `build/orchestrator/investigate-context.ts` with just this function (other functions added in later tasks):

```typescript
import * as fs from "node:fs";

export interface RecentErrorRef {
  timestamp: string;
  summary?: string;
}

export interface TailStdoutLogArgs {
  stdoutPath: string;
  recentErrors: RecentErrorRef[];
  tailLines: number;
  windowLines: number;
}

/**
 * Tail stdout log: last `tailLines` lines + ±`windowLines` around each
 * recentErrors timestamp. Returns the merged unique slice in original order.
 * Returns empty string if the log file does not exist (worktree may be cleaned up).
 *
 * Timestamp matching: looks for an ISO-8601-like prefix `[YYYY-MM-DDTHH:MM:SS...Z]`
 * on each line. The first line whose parsed timestamp is >= the error timestamp
 * is the anchor for that error.
 */
export function tailStdoutLog(args: TailStdoutLogArgs): string {
  const { stdoutPath, recentErrors, tailLines, windowLines } = args;
  if (!fs.existsSync(stdoutPath)) return "";
  const content = fs.readFileSync(stdoutPath, "utf8");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;
  const include = new Set<number>();

  // Tail window.
  for (let i = Math.max(0, total - tailLines); i < total; i++) include.add(i);

  // Per-error windows.
  const lineTimestamps = lines.map((line) => parseLineTimestamp(line));
  for (const err of recentErrors) {
    const errMs = Date.parse(err.timestamp);
    if (Number.isNaN(errMs)) continue;
    let anchor = -1;
    for (let i = 0; i < total; i++) {
      const t = lineTimestamps[i];
      if (t !== null && t >= errMs) {
        anchor = i;
        break;
      }
    }
    if (anchor < 0) continue;
    for (
      let i = Math.max(0, anchor - windowLines);
      i < Math.min(total, anchor + windowLines + 1);
      i++
    ) {
      include.add(i);
    }
  }

  const sorted = [...include].sort((a, b) => a - b);
  return sorted.map((i) => lines[i]).join("\n");
}

function parseLineTimestamp(line: string): number | null {
  const match = line.match(/^\[([^\]]+)\]/);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? null : ms;
}
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `bun test build/orchestrator/__tests__/investigate-context-tail.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 3.5: Commit**

```bash
git add build/orchestrator/investigate-context.ts build/orchestrator/__tests__/investigate-context-tail.test.ts
git commit -m "feat(build): stdout tail extractor for investigate context

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Context resolver — halt event lookup + active run detection

**Files:**

- Modify: `build/orchestrator/investigate-context.ts` (add functions)
- Test: `build/orchestrator/__tests__/investigate-context.test.ts`

- [ ] **Step 4.1: Write the resolver test**

Create `build/orchestrator/__tests__/investigate-context.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadHaltEventByFaultId,
  pickMostRecentActiveRun,
  resolveInvestigationContext,
} from "../investigate-context";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-ctx-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeHaltEvent(
  subdir: "pending-investigations" | "processed",
  runId: string,
  faultId: string,
): void {
  const dir = path.join(faultsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const event = {
    faultId,
    runId,
    stateSlug: "slug",
    kind: "PHASE_FAILED",
    severity: "HIGH",
    timestamp: "2026-05-22T10:00:00.000Z",
    message: "test",
    pointers: {
      stateFile: "/tmp/state.json",
      stdoutLog: "/tmp/stdout.log",
      livingPlan: "/tmp/plan.md",
      worktreePath: "/tmp/wt",
    },
    snapshot: { stdoutTail: "" },
  };
  fs.writeFileSync(
    path.join(dir, `${runId}-${faultId}.json`),
    JSON.stringify(event),
  );
}

function writeActiveRun(runId: string, lastUpdatedAt: string): void {
  const record = {
    runId,
    stateSlug: "slug",
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/wt",
    planFile: "/tmp/plan.md",
    pid: process.pid,
    status: "running",
    startedAt: lastUpdatedAt,
    lastUpdatedAt,
    branches: ["feat/x"],
  };
  fs.writeFileSync(
    path.join(activeRunsDir, `${runId}.json`),
    JSON.stringify(record),
  );
}

describe("loadHaltEventByFaultId", () => {
  test("finds event in pending-investigations", () => {
    writeHaltEvent("pending-investigations", "run-A", "CAT:p0:abc");
    const found = loadHaltEventByFaultId({ faultId: "CAT:p0:abc", faultsDir });
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("run-A");
  });

  test("finds event in processed/ if not in pending", () => {
    writeHaltEvent("processed", "run-B", "CAT:p1:def");
    const found = loadHaltEventByFaultId({ faultId: "CAT:p1:def", faultsDir });
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("run-B");
  });

  test("returns null when fault id not found anywhere", () => {
    const found = loadHaltEventByFaultId({
      faultId: "MISSING:p0:xxx",
      faultsDir,
    });
    expect(found).toBeNull();
  });
});

describe("pickMostRecentActiveRun", () => {
  test("returns the run with the latest lastUpdatedAt", () => {
    writeActiveRun("run-old", "2026-05-22T08:00:00.000Z");
    writeActiveRun("run-new", "2026-05-22T10:00:00.000Z");
    const picked = pickMostRecentActiveRun({ registryDir: activeRunsDir });
    expect(picked).not.toBeNull();
    expect(picked!.runId).toBe("run-new");
  });

  test("returns null when no records exist", () => {
    expect(pickMostRecentActiveRun({ registryDir: activeRunsDir })).toBeNull();
  });
});

describe("resolveInvestigationContext", () => {
  test("explicit --state flag wins over auto-detect", async () => {
    writeActiveRun("run-detected", "2026-05-22T10:00:00.000Z");
    const stateFile = path.join(tmpRoot, "explicit-state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runId: "run-explicit",
        stateSlug: "slug",
        recentErrors: [],
      }),
    );
    const ctx = await resolveInvestigationContext({
      statePath: stateFile,
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    });
    expect(ctx.runId).toBe("run-explicit");
    expect(ctx.source).toBe("explicit-state");
  });

  test("positional faultId resolves the stored halt event", async () => {
    writeHaltEvent("pending-investigations", "run-FF", "CAT:p2:fff");
    const ctx = await resolveInvestigationContext({
      faultId: "CAT:p2:fff",
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    });
    expect(ctx.runId).toBe("run-FF");
    expect(ctx.faultId).toBe("CAT:p2:fff");
    expect(ctx.source).toBe("explicit-fault-id");
  });

  test("symptoms-only synthesizes a manual fault id", async () => {
    const ctx = await resolveInvestigationContext({
      symptoms: "build halts on phase 3 codex review every time",
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    });
    expect(ctx.runId).toMatch(/^manual-/);
    expect(ctx.faultId).toMatch(/^MANUAL_INVESTIGATION:0:/);
    expect(ctx.severity).toBe("MEDIUM");
    expect(ctx.source).toBe("symptoms");
  });

  test("auto-detect picks most recent active run when no flags given", async () => {
    writeActiveRun("run-auto", "2026-05-22T10:00:00.000Z");
    writeHaltEvent("pending-investigations", "run-auto", "CAT:p0:aaa");
    const ctx = await resolveInvestigationContext({
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    });
    expect(ctx.runId).toBe("run-auto");
    expect(ctx.faultId).toBe("CAT:p0:aaa");
    expect(ctx.source).toBe("auto-detect");
  });

  test("returns null context when nothing found and non-TTY", async () => {
    const ctx = await resolveInvestigationContext({
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    });
    expect(ctx).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `bun test build/orchestrator/__tests__/investigate-context.test.ts`
Expected: FAIL — `loadHaltEventByFaultId`, `pickMostRecentActiveRun`, `resolveInvestigationContext` not exported.

- [ ] **Step 4.3: Extend `investigate-context.ts`**

Add the following to `build/orchestrator/investigate-context.ts` (keep `tailStdoutLog` from Task 3):

```typescript
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { HaltEvent } from "./halt-events";
import {
  defaultActiveRunRegistryDir,
  readActiveRunRecords,
  type ActiveRunRecord,
} from "./active-runs";

export type ContextSource =
  | "auto-detect"
  | "explicit-fault-id"
  | "explicit-state"
  | "explicit-run-id"
  | "symptoms"
  | "user-picked";

export interface InvestigationContext {
  runId: string;
  faultId: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  source: ContextSource;
  haltEvent: HaltEvent | null;
  statePath: string | null;
  stdoutLogPath: string | null;
  livingPlanPath: string | null;
  worktreePath: string | null;
  symptoms: string | null;
}

function defaultFaultsDir(): string {
  const home =
    process.env.GSTACK_HOME ??
    path.join(require("node:os").homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

export function loadHaltEventByFaultId(args: {
  faultId: string;
  faultsDir?: string;
}): HaltEvent | null {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const dirs = [
    path.join(faultsDir, "pending-investigations"),
    path.join(faultsDir, "processed"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      if (!entry.includes(args.faultId)) continue;
      try {
        const event = JSON.parse(
          fs.readFileSync(path.join(dir, entry), "utf8"),
        ) as HaltEvent;
        if (event.faultId === args.faultId) return event;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function pickMostRecentActiveRun(args: {
  registryDir?: string;
}): ActiveRunRecord | null {
  const registryDir = args.registryDir ?? defaultActiveRunRegistryDir();
  const records = readActiveRunRecords(registryDir);
  if (records.length === 0) return null;
  return records
    .slice()
    .sort(
      (a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt),
    )[0];
}

function synthesizeManualFaultId(symptoms: string): {
  runId: string;
  faultId: string;
} {
  const ts = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(symptoms)
    .digest("hex")
    .slice(0, 8);
  return {
    runId: `manual-${ts}`,
    faultId: `MANUAL_INVESTIGATION:0:${hash}`,
  };
}

export interface ResolveContextArgs {
  faultId?: string;
  runId?: string;
  statePath?: string;
  runDir?: string;
  symptoms?: string;
  severityOverride?: "CRITICAL" | "HIGH" | "MEDIUM";
  faultsDir?: string;
  activeRunsRegistryDir?: string;
  ttyAvailable: boolean;
}

export async function resolveInvestigationContext(
  args: ResolveContextArgs,
): Promise<InvestigationContext | null> {
  // 1. Explicit --state wins.
  if (args.statePath) {
    if (!fs.existsSync(args.statePath)) {
      throw new Error(`state file not found: ${args.statePath}`);
    }
    const state = JSON.parse(fs.readFileSync(args.statePath, "utf8"));
    const runId = String(state.runId ?? "unknown-run");
    return {
      runId,
      faultId: args.faultId ?? `EXPLICIT_STATE:0:${runId}`,
      severity: args.severityOverride ?? "MEDIUM",
      source: "explicit-state",
      haltEvent: null,
      statePath: args.statePath,
      stdoutLogPath: null,
      livingPlanPath: null,
      worktreePath: null,
      symptoms: args.symptoms ?? null,
    };
  }

  // 2. Positional <faultId>.
  if (args.faultId) {
    const event = loadHaltEventByFaultId({
      faultId: args.faultId,
      faultsDir: args.faultsDir,
    });
    if (!event) return null;
    return contextFromHaltEvent(event, "explicit-fault-id", args);
  }

  // 3. Symptoms-only.
  if (args.symptoms) {
    const { runId, faultId } = synthesizeManualFaultId(args.symptoms);
    return {
      runId,
      faultId,
      severity: args.severityOverride ?? "MEDIUM",
      source: "symptoms",
      haltEvent: null,
      statePath: null,
      stdoutLogPath: null,
      livingPlanPath: null,
      worktreePath: null,
      symptoms: args.symptoms,
    };
  }

  // 4. Auto-detect.
  const run = pickMostRecentActiveRun({
    registryDir: args.activeRunsRegistryDir,
  });
  if (!run) return null;
  // Find a pending halt event for this run.
  const pendingDir = path.join(
    args.faultsDir ?? defaultFaultsDir(),
    "pending-investigations",
  );
  if (!fs.existsSync(pendingDir)) return null;
  const candidates = fs
    .readdirSync(pendingDir)
    .filter((n) => n.startsWith(`${run.runId}-`) && n.endsWith(".json"))
    .filter((n) => !n.includes("-RESOLVED-"));
  if (candidates.length === 0) return null;
  // Pick the most recent by mtime.
  const sorted = candidates
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(pendingDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  const event = JSON.parse(
    fs.readFileSync(path.join(pendingDir, sorted[0].name), "utf8"),
  ) as HaltEvent;
  return contextFromHaltEvent(event, "auto-detect", args);
}

function contextFromHaltEvent(
  event: HaltEvent,
  source: ContextSource,
  args: ResolveContextArgs,
): InvestigationContext {
  const severity =
    args.severityOverride ??
    (event.severity === "LOW" ? "MEDIUM" : event.severity);
  return {
    runId: event.runId,
    faultId: event.faultId,
    severity,
    source,
    haltEvent: event,
    statePath: event.pointers.stateFile,
    stdoutLogPath: event.pointers.stdoutLog,
    livingPlanPath: event.pointers.livingPlan,
    worktreePath: event.pointers.worktreePath,
    symptoms: args.symptoms ?? null,
  };
}
```

Also add this import at the top of the file (if not already present from Task 3):

```typescript
import * as fs from "node:fs";
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `bun test build/orchestrator/__tests__/investigate-context.test.ts build/orchestrator/__tests__/investigate-context-tail.test.ts`
Expected: PASS (all 12 tests).

- [ ] **Step 4.5: Commit**

```bash
git add build/orchestrator/investigate-context.ts build/orchestrator/__tests__/investigate-context.test.ts
git commit -m "feat(build): resolve investigation context (halt event, active run, symptoms)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Report writer — machine report

**Files:**

- Create: `build/orchestrator/investigate-report-writer.ts` (machine report only)
- Test: `build/orchestrator/__tests__/investigate-report-writer.test.ts`

- [ ] **Step 5.1: Write the machine-report test**

Create `build/orchestrator/__tests__/investigate-report-writer.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeMachineReport,
  bugReportSlug,
} from "../investigate-report-writer";
import type { InvestigationContext } from "../investigate-context";
import type { InvestigationReport } from "../investigator-dispatch";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-rw-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");

const ctx: InvestigationContext = {
  runId: "run-X",
  faultId: "CAT:p0:abc",
  severity: "HIGH",
  source: "auto-detect",
  haltEvent: null,
  statePath: "/tmp/s.json",
  stdoutLogPath: "/tmp/o.log",
  livingPlanPath: "/tmp/p.md",
  worktreePath: "/tmp/wt",
  symptoms: null,
};

const report: InvestigationReport = {
  faultId: "CAT:p0:abc",
  outcome: "root-cause-identified",
  rootCause: "Plan lacks acceptance criteria; codex loops forever.",
  evidence: ["build/orchestrator/cli.ts:123"],
  proposedFix: {
    options: [
      {
        label: "Add acceptance checklist",
        description: "Prepend an Acceptance section",
        blast_radius: "narrow",
      },
    ],
  },
  learnedPatternProposal: null,
};

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeMachineReport", () => {
  test("writes to <faultsDir>/<runId>/<faultId>.md", () => {
    const written = writeMachineReport({ report, ctx, faultsDir });
    expect(written).toBe(path.join(faultsDir, "run-X", "CAT:p0:abc.md"));
    expect(fs.existsSync(written)).toBe(true);
  });

  test("overwrites on second call (latest investigation wins)", () => {
    writeMachineReport({ report, ctx, faultsDir });
    const second: InvestigationReport = { ...report, rootCause: "DIFFERENT" };
    const written = writeMachineReport({ report: second, ctx, faultsDir });
    const content = fs.readFileSync(written, "utf8");
    expect(content).toContain("DIFFERENT");
    expect(content).not.toContain("Plan lacks acceptance");
  });

  test("includes runId, faultId, outcome, rootCause, evidence in markdown", () => {
    const written = writeMachineReport({ report, ctx, faultsDir });
    const content = fs.readFileSync(written, "utf8");
    expect(content).toContain("run-X");
    expect(content).toContain("CAT:p0:abc");
    expect(content).toContain("root-cause-identified");
    expect(content).toContain("Plan lacks acceptance criteria");
    expect(content).toContain("build/orchestrator/cli.ts:123");
  });

  test("writes duplicate-of stub when outcome is duplicate-of", () => {
    const dup: InvestigationReport = {
      ...report,
      outcome: "duplicate-of",
      duplicateOfPath: "~/.gstack/skill-faults/run-Y/CAT:p0:def.md",
    };
    const written = writeMachineReport({ report: dup, ctx, faultsDir });
    const content = fs.readFileSync(written, "utf8");
    expect(content).toContain("Duplicate of");
    expect(content).toContain("~/.gstack/skill-faults/run-Y/CAT:p0:def.md");
  });
});

describe("bugReportSlug", () => {
  test("derives slug from fault category + hash of rootCause", () => {
    const slug = bugReportSlug({ report, ctx });
    expect(slug).toMatch(/^build-cat-[a-f0-9]{6}$/);
  });

  test("symptoms-only context uses MANUAL prefix", () => {
    const manualCtx: InvestigationContext = {
      ...ctx,
      faultId: "MANUAL_INVESTIGATION:0:abc12345",
      source: "symptoms",
    };
    const slug = bugReportSlug({ report, ctx: manualCtx });
    expect(slug).toMatch(/^build-manual-investigation-[a-f0-9]{6}$/);
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `bun test build/orchestrator/__tests__/investigate-report-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `writeMachineReport` and `bugReportSlug`**

Create `build/orchestrator/investigate-report-writer.ts`:

````typescript
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InvestigationContext } from "./investigate-context";
import type { InvestigationReport } from "./investigator-dispatch";

export function bugReportSlug(args: {
  report: InvestigationReport;
  ctx: InvestigationContext;
}): string {
  const category = args.ctx.faultId
    .split(":")[0]
    .toLowerCase()
    .replace(/_/g, "-");
  const hash = crypto
    .createHash("sha256")
    .update(args.report.rootCause)
    .digest("hex")
    .slice(0, 6);
  return `build-${category}-${hash}`;
}

export function writeMachineReport(args: {
  report: InvestigationReport;
  ctx: InvestigationContext;
  faultsDir?: string;
}): string {
  const faultsDir =
    args.faultsDir ??
    path.join(
      process.env.GSTACK_HOME ??
        path.join(require("node:os").homedir(), ".gstack"),
      "skill-faults",
    );
  const runDir = path.join(faultsDir, args.ctx.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, `${args.ctx.faultId}.md`);
  const content = renderMachineReportMarkdown(args.report, args.ctx);
  const tmpPath = `${reportPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, reportPath);
  return reportPath;
}

function renderMachineReportMarkdown(
  report: InvestigationReport,
  ctx: InvestigationContext,
): string {
  if (report.outcome === "duplicate-of") {
    return `# Investigation: ${ctx.faultId}\n\n**Outcome:** duplicate-of\n\nDuplicate of: ${report.duplicateOfPath ?? "(path not provided)"}\n`;
  }
  const lines: string[] = [];
  lines.push(`# Investigation: ${ctx.faultId}`);
  lines.push("");
  lines.push(`- **Run id:** ${ctx.runId}`);
  lines.push(`- **Fault id:** ${ctx.faultId}`);
  lines.push(`- **Severity:** ${ctx.severity}`);
  lines.push(`- **Source:** ${ctx.source}`);
  lines.push(`- **Outcome:** ${report.outcome}`);
  lines.push("");
  lines.push("## Root cause");
  lines.push("");
  lines.push(report.rootCause);
  lines.push("");
  if (report.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const e of report.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  if (report.proposedFix && report.proposedFix.options.length > 0) {
    lines.push("## Proposed fix");
    lines.push("");
    let i = 1;
    for (const opt of report.proposedFix.options) {
      lines.push(
        `### Option ${i}: ${opt.label} (blast_radius: ${opt.blast_radius})`,
      );
      lines.push("");
      lines.push(opt.description);
      lines.push("");
      i++;
    }
  }
  if (report.learnedPatternProposal) {
    const lp = report.learnedPatternProposal;
    lines.push("## Learned pattern proposal");
    lines.push("");
    lines.push(`- **Category:** ${lp.category}`);
    lines.push(`- **Matcher kind:** ${lp.matcherKind}`);
    lines.push(`- **Severity:** ${lp.severity}`);
    lines.push("");
    lines.push("```");
    lines.push(lp.pattern);
    lines.push("```");
    lines.push("");
    lines.push(lp.description);
    lines.push("");
  }
  return lines.join("\n");
}

export { renderMachineReportMarkdown };
````

- [ ] **Step 5.4: Run test to verify it passes**

Run: `bun test build/orchestrator/__tests__/investigate-report-writer.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5.5: Commit**

```bash
git add build/orchestrator/investigate-report-writer.ts build/orchestrator/__tests__/investigate-report-writer.test.ts
git commit -m "feat(build): machine-report writer for investigate subcommand

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Report writer — human bug report + severity gating

**Files:**

- Modify: `build/orchestrator/investigate-report-writer.ts` (add `writeBugReport`)
- Test: `build/orchestrator/__tests__/investigate-report-writer-severity.test.ts`

- [ ] **Step 6.1: Write the bug-report + severity test**

Create `build/orchestrator/__tests__/investigate-report-writer-severity.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeBugReport } from "../investigate-report-writer";
import type { InvestigationContext } from "../investigate-context";
import type { InvestigationReport } from "../investigator-dispatch";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-bug-${process.pid}`);
const inboxDir = path.join(tmpRoot, "inbox");

function makeCtx(
  severity: InvestigationContext["severity"],
  source: InvestigationContext["source"] = "auto-detect",
): InvestigationContext {
  return {
    runId: "run-X",
    faultId: "CAT:p0:abc",
    severity,
    source,
    haltEvent: null,
    statePath: "/tmp/s.json",
    stdoutLogPath: "/tmp/o.log",
    livingPlanPath: "/tmp/p.md",
    worktreePath: "/tmp/wt",
    symptoms: null,
  };
}

const report: InvestigationReport = {
  faultId: "CAT:p0:abc",
  outcome: "root-cause-identified",
  rootCause: "Plan lacks acceptance criteria; codex loops forever.",
  evidence: ["build/orchestrator/cli.ts:123"],
  proposedFix: {
    options: [
      {
        label: "Add checklist",
        description: "Prepend it",
        blast_radius: "narrow",
      },
    ],
  },
  learnedPatternProposal: null,
};

beforeEach(() => {
  fs.mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeBugReport severity gating", () => {
  test("HIGH writes the bug report", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
    expect(result.path).not.toBeNull();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(result.path).toContain("BUGREPORT-2026-05-22-build-cat-");
  });

  test("CRITICAL writes the bug report", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("CRITICAL"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
  });

  test("MEDIUM skips bug report (returns skipped=true)", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("MEDIUM"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(true);
    expect(result.path).toBeNull();
  });

  test("symptoms-only context skips even when severity HIGH", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH", "symptoms"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(true);
  });

  test("noInbox=true skips even for CRITICAL", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("CRITICAL"),
      inboxDir,
      noInbox: true,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(true);
  });

  test("collision: second write gets -2 suffix", () => {
    const first = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    const second = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(first.path).not.toBe(second.path);
    expect(second.path).toMatch(/-2\.md$/);
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `bun test build/orchestrator/__tests__/investigate-report-writer-severity.test.ts`
Expected: FAIL — `writeBugReport` not exported.

- [ ] **Step 6.3: Extend `investigate-report-writer.ts`**

Append to `build/orchestrator/investigate-report-writer.ts`:

```typescript
export interface WriteBugReportResult {
  skipped: boolean;
  path: string | null;
  reason?: string;
}

export function writeBugReport(args: {
  report: InvestigationReport;
  ctx: InvestigationContext;
  inboxDir?: string;
  noInbox?: boolean;
  dateOverride?: string;
}): WriteBugReportResult {
  const inboxDir = args.inboxDir ?? path.resolve(process.cwd(), "inbox");
  if (args.noInbox) {
    return { skipped: true, path: null, reason: "noInbox=true" };
  }
  if (args.ctx.source === "symptoms") {
    return { skipped: true, path: null, reason: "symptoms-only fault" };
  }
  if (args.ctx.severity !== "HIGH" && args.ctx.severity !== "CRITICAL") {
    return {
      skipped: true,
      path: null,
      reason: `severity=${args.ctx.severity}`,
    };
  }
  if (args.report.outcome === "duplicate-of") {
    return { skipped: true, path: null, reason: "duplicate-of outcome" };
  }

  fs.mkdirSync(inboxDir, { recursive: true });
  const date = args.dateOverride ?? new Date().toISOString().slice(0, 10);
  const slug = bugReportSlug({ report: args.report, ctx: args.ctx });
  let basename = `BUGREPORT-${date}-${slug}.md`;
  let candidatePath = path.join(inboxDir, basename);
  let suffix = 2;
  while (fs.existsSync(candidatePath)) {
    basename = `BUGREPORT-${date}-${slug}-${suffix}.md`;
    candidatePath = path.join(inboxDir, basename);
    suffix++;
  }

  const content = renderBugReportMarkdown(args.report, args.ctx, date);
  const tmpPath = `${candidatePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, candidatePath);
  return { skipped: false, path: candidatePath };
}

function renderBugReportMarkdown(
  report: InvestigationReport,
  ctx: InvestigationContext,
  date: string,
): string {
  const title =
    report.rootCause
      .split(/[.!?\n]/, 1)[0]
      .trim()
      .slice(0, 80) || ctx.faultId;
  const lines: string[] = [];
  lines.push(`# Bug: ${title}`);
  lines.push("");
  lines.push(
    `**Severity:** ${ctx.severity} — ${shortImpact(ctx.severity, report)}`,
  );
  lines.push(`**Discovered:** ${date}`);
  lines.push(`**Reporter:** /build investigate (manual, run ${ctx.runId})`);
  lines.push(`**Repro from:** fault ${ctx.faultId}`);
  lines.push("");
  lines.push("## Symptom");
  lines.push("");
  lines.push(
    ctx.haltEvent?.message ??
      ctx.symptoms ??
      "(see machine report for details)",
  );
  lines.push("");
  if (ctx.statePath || ctx.stdoutLogPath || ctx.livingPlanPath) {
    lines.push("## Repro from field");
    lines.push("");
    if (ctx.statePath) lines.push(`- state: \`${ctx.statePath}\``);
    if (ctx.stdoutLogPath) lines.push(`- stdout: \`${ctx.stdoutLogPath}\``);
    if (ctx.livingPlanPath)
      lines.push(`- living plan: \`${ctx.livingPlanPath}\``);
    if (ctx.worktreePath) lines.push(`- worktree: \`${ctx.worktreePath}\``);
    lines.push("");
  }
  lines.push("## Root cause (hypothesis)");
  lines.push("");
  lines.push(report.rootCause);
  lines.push("");
  if (report.evidence.length > 0) {
    for (const e of report.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  lines.push(`## Why ${ctx.severity}`);
  lines.push("");
  lines.push(shortImpact(ctx.severity, report));
  lines.push("");
  if (report.proposedFix && report.proposedFix.options.length > 0) {
    lines.push("## Fix sketch");
    lines.push("");
    let i = 1;
    for (const opt of report.proposedFix.options) {
      lines.push(
        `### Option ${i}: ${opt.label} (blast_radius: ${opt.blast_radius})`,
      );
      lines.push("");
      lines.push(opt.description);
      lines.push("");
      i++;
    }
  }
  lines.push("## Status");
  lines.push("");
  lines.push(
    "Filed by `/build investigate`. Not implementing — see fix options above.",
  );
  lines.push("");
  return lines.join("\n");
}

function shortImpact(
  severity: InvestigationContext["severity"],
  report: InvestigationReport,
): string {
  if (severity === "CRITICAL")
    return "Blocks the build run from making forward progress.";
  if (severity === "HIGH")
    return "Halts the run loop and requires manual recovery.";
  return "Degrades the run; recovery is possible without manual intervention.";
}

export { renderBugReportMarkdown };
```

- [ ] **Step 6.4: Run test to verify it passes**

Run: `bun test build/orchestrator/__tests__/investigate-report-writer-severity.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6.5: Commit**

```bash
git add build/orchestrator/investigate-report-writer.ts build/orchestrator/__tests__/investigate-report-writer-severity.test.ts
git commit -m "feat(build): human bug-report writer with severity gating

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: investigate-mode — entry points

**Files:**

- Create: `build/orchestrator/investigate-mode.ts`
- Test: `build/orchestrator/__tests__/investigate-mode-exit-codes.test.ts`

This pulls Tasks 1-6 together. `runInvestigateMode` emits the briefing block; `runInvestigateFinalize` validates the report and writes artifacts.

- [ ] **Step 7.1: Write the exit-code test**

Create `build/orchestrator/__tests__/investigate-mode-exit-codes.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInvestigateMode,
  runInvestigateFinalize,
  type InvestigateModeArgs,
  type InvestigateFinalizeArgs,
} from "../investigate-mode";

const tmpRoot = path.join(
  os.tmpdir(),
  `gstack-investigate-mode-${process.pid}`,
);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");
const inboxDir = path.join(tmpRoot, "inbox");

let stdoutBuf = "";
let stderrBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  stdoutBuf = "";
  stderrBuf = "";
  process.stdout.write = ((chunk: any) => {
    stdoutBuf += chunk.toString();
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    stderrBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runInvestigateMode exit codes", () => {
  test("exit 2 when --state path does not exist", async () => {
    const args: InvestigateModeArgs = {
      statePath: "/nonexistent/state.json",
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("state file not found");
  });

  test("exit 2 when --fault-id given but not found", async () => {
    const args: InvestigateModeArgs = {
      faultId: "MISSING:p0:notthere",
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("fault not found");
  });

  test("exit 3 when nothing auto-detects and non-TTY", async () => {
    const args: InvestigateModeArgs = {
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(3);
    expect(stderrBuf).toContain("no context auto-detected");
  });

  test("exit 0 and emits briefing block when symptoms given", async () => {
    const args: InvestigateModeArgs = {
      symptoms: "build halts on phase 3 every time",
      faultsDir,
      activeRunsRegistryDir: activeRunsDir,
      ttyAvailable: false,
    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("<<<GSTACK_INVESTIGATE_BRIEFING>>>");
    expect(stdoutBuf).toContain("<<<END>>>");
    const jsonMatch = stdoutBuf.match(
      /<<<GSTACK_INVESTIGATE_BRIEFING>>>\n([\s\S]+?)\n<<<END>>>/,
    );
    expect(jsonMatch).not.toBeNull();
    const briefing = JSON.parse(jsonMatch![1]);
    expect(briefing.symptoms).toContain("phase 3");
    expect(briefing.faultId).toMatch(/^MANUAL_INVESTIGATION:/);
  });
});

describe("runInvestigateFinalize exit codes", () => {
  test("exit 2 when report file missing", async () => {
    const args: InvestigateFinalizeArgs = {
      runId: "run-X",
      faultId: "CAT:p0:abc",
      reportPath: "/nonexistent/report.json",
      faultsDir,
      inboxDir,
    };
    const code = await runInvestigateFinalize(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("report file not found");
  });

  test("exit 2 when report faultId does not match --fault-id", async () => {
    const reportPath = path.join(tmpRoot, "bad.json");
    fs.writeFileSync(
      reportPath,
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../test/fixtures/investigate/canned-report-bad-faultid.json",
        ),
        "utf8",
      ),
    );
    const args: InvestigateFinalizeArgs = {
      runId: "run-X",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir,
      inboxDir,
    };
    const code = await runInvestigateFinalize(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("faultId mismatch");
  });

  test("exit 0 and writes both artifacts on valid HIGH report", async () => {
    const reportPath = path.join(tmpRoot, "good.json");
    const canned = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../test/fixtures/investigate/canned-report-success.json",
        ),
        "utf8",
      ),
    );
    fs.writeFileSync(reportPath, JSON.stringify(canned));
    // Pre-acquire lock so finalize can release it.
    const { acquireFaultLock } = await import("../investigate-lock");
    acquireFaultLock({
      runId: "test-run-investigate-001",
      faultId: canned.faultId,
      faultsDir,
    });
    const args: InvestigateFinalizeArgs = {
      runId: "test-run-investigate-001",
      faultId: canned.faultId,
      reportPath,
      severity: "HIGH",
      faultsDir,
      inboxDir,
    };
    const code = await runInvestigateFinalize(args);
    expect(code).toBe(0);
    // Machine report exists
    expect(
      fs.existsSync(
        path.join(
          faultsDir,
          "test-run-investigate-001",
          `${canned.faultId}.md`,
        ),
      ),
    ).toBe(true);
    // Bug report exists
    const inboxFiles = fs.readdirSync(inboxDir);
    expect(inboxFiles.some((n) => n.startsWith("BUGREPORT-"))).toBe(true);
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `bun test build/orchestrator/__tests__/investigate-mode-exit-codes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement `investigate-mode.ts`**

Create `build/orchestrator/investigate-mode.ts`:

```typescript
import * as fs from "node:fs";
import {
  resolveInvestigationContext,
  tailStdoutLog,
  type InvestigationContext,
} from "./investigate-context";
import { parseInvestigationReport } from "./investigator-dispatch";
import {
  acquireFaultLock,
  releaseFaultLock,
  type FaultLockHandle,
} from "./investigate-lock";
import {
  writeMachineReport,
  writeBugReport,
} from "./investigate-report-writer";

export interface InvestigateModeArgs {
  faultId?: string;
  runId?: string;
  statePath?: string;
  runDir?: string;
  symptoms?: string;
  severityOverride?: "CRITICAL" | "HIGH" | "MEDIUM";
  noInbox?: boolean;
  emitJson?: boolean;
  faultsDir?: string;
  activeRunsRegistryDir?: string;
  ttyAvailable: boolean;
}

export interface InvestigateFinalizeArgs {
  runId: string;
  faultId: string;
  reportPath: string;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM";
  noInbox?: boolean;
  faultsDir?: string;
  inboxDir?: string;
}

export async function runInvestigateMode(
  args: InvestigateModeArgs,
): Promise<number> {
  let ctx: InvestigationContext | null;
  try {
    ctx = await resolveInvestigationContext({
      faultId: args.faultId,
      runId: args.runId,
      statePath: args.statePath,
      runDir: args.runDir,
      symptoms: args.symptoms,
      severityOverride: args.severityOverride,
      faultsDir: args.faultsDir,
      activeRunsRegistryDir: args.activeRunsRegistryDir,
      ttyAvailable: args.ttyAvailable,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("state file not found")) {
      process.stderr.write(`error: ${msg}\n`);
      return 2;
    }
    process.stderr.write(`error: ${msg}\n`);
    return 2;
  }

  if (!ctx) {
    if (args.faultId) {
      process.stderr.write(`error: fault not found: ${args.faultId}\n`);
      return 2;
    }
    process.stderr.write(
      "error: no context auto-detected and stdin is not a TTY. Pass --state, --run-id, --fault-id, or --symptoms explicitly.\n",
    );
    return 3;
  }

  const lock = acquireFaultLock({
    runId: ctx.runId,
    faultId: ctx.faultId,
    faultsDir: args.faultsDir,
  });
  if (!lock) {
    process.stderr.write(
      `error: another investigation is already in progress for ${ctx.faultId}\n`,
    );
    return 2;
  }

  let stdoutTail = "";
  if (ctx.stdoutLogPath) {
    let recentErrors: { timestamp: string; summary?: string }[] = [];
    if (ctx.statePath && fs.existsSync(ctx.statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(ctx.statePath, "utf8"));
        if (Array.isArray(state.recentErrors))
          recentErrors = state.recentErrors;
      } catch {
        // ignore — state file may be partial
      }
    }
    stdoutTail = tailStdoutLog({
      stdoutPath: ctx.stdoutLogPath,
      recentErrors,
      tailLines: 500,
      windowLines: 50,
    });
  }

  const briefing = {
    runId: ctx.runId,
    faultId: ctx.faultId,
    severity: ctx.severity,
    source: ctx.source,
    statePath: ctx.statePath,
    stdoutLogPath: ctx.stdoutLogPath,
    stdoutTail,
    livingPlanPath: ctx.livingPlanPath,
    worktreePath: ctx.worktreePath,
    haltEvent: ctx.haltEvent,
    symptoms: ctx.symptoms,
    finalizeHint:
      `When your investigation is complete, write the InvestigationReport JSON to a tmp file and run: ` +
      `gstack-build investigate-finalize --run-id ${ctx.runId} --fault-id ${ctx.faultId} --report <path>${args.noInbox ? " --no-inbox" : ""}`,
  };

  process.stdout.write("<<<GSTACK_INVESTIGATE_BRIEFING>>>\n");
  process.stdout.write(JSON.stringify(briefing, null, 2) + "\n");
  process.stdout.write("<<<END>>>\n");
  // Lock stays held; finalize releases it.
  // (Stored on disk; in-process handle is discarded but the file persists.)
  void lock;
  return 0;
}

export async function runInvestigateFinalize(
  args: InvestigateFinalizeArgs,
): Promise<number> {
  if (!fs.existsSync(args.reportPath)) {
    process.stderr.write(`error: report file not found: ${args.reportPath}\n`);
    return 2;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(args.reportPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: cannot read report file: ${(err as Error).message}\n`,
    );
    return 2;
  }

  let report: ReturnType<typeof parseInvestigationReport>;
  try {
    report = parseInvestigationReport(raw, args.faultId);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    releaseLockByPath(args);
    return 2;
  }

  const ctx: InvestigationContext = {
    runId: args.runId,
    faultId: args.faultId,
    severity: args.severity ?? "HIGH",
    source: "auto-detect",
    haltEvent: null,
    statePath: null,
    stdoutLogPath: null,
    livingPlanPath: null,
    worktreePath: null,
    symptoms: null,
  };

  const machinePath = writeMachineReport({
    report,
    ctx,
    faultsDir: args.faultsDir,
  });

  let bugPath: string | null = null;
  try {
    const bugResult = writeBugReport({
      report,
      ctx,
      inboxDir: args.inboxDir,
      noInbox: args.noInbox,
    });
    if (!bugResult.skipped) bugPath = bugResult.path;
  } catch (err) {
    process.stderr.write(
      `warning: bug report write failed: ${(err as Error).message}\n`,
    );
  }

  releaseLockByPath(args);

  const lines = [
    `investigation finalized for ${args.faultId} (${report.outcome})`,
    `  machine report: ${machinePath}`,
  ];
  if (bugPath) lines.push(`  bug report:     ${bugPath}`);
  if (report.learnedPatternProposal) {
    lines.push(
      `  pattern proposal present — run \`gstack-build learn-fault-patterns\` to absorb it`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");

  if (report.outcome === "needs-human" || report.outcome === "no-context") {
    return 1;
  }
  return 0;
}

function releaseLockByPath(args: InvestigateFinalizeArgs): void {
  const home =
    process.env.GSTACK_HOME ??
    require("node:path").join(require("node:os").homedir(), ".gstack");
  const faultsDir =
    args.faultsDir ?? require("node:path").join(home, "skill-faults");
  const lockPath = require("node:path").join(
    faultsDir,
    args.runId,
    `.${args.faultId}.lock`,
  );
  const handle: FaultLockHandle = { lockPath, acquiredAt: "" };
  releaseFaultLock(handle);
}
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `bun test build/orchestrator/__tests__/investigate-mode-exit-codes.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 7.5: Commit**

```bash
git add build/orchestrator/investigate-mode.ts build/orchestrator/__tests__/investigate-mode-exit-codes.test.ts
git commit -m "feat(build): investigate-mode + investigate-finalize entry points

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Finalize report-parse validation tests

**Files:**

- Test: `build/orchestrator/__tests__/investigate-finalize-validation.test.ts`

Adds dedicated coverage of the failure paths in `parseInvestigationReport` via the finalize entry point.

- [ ] **Step 8.1: Write the validation tests**

Create `build/orchestrator/__tests__/investigate-finalize-validation.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInvestigateFinalize,
  type InvestigateFinalizeArgs,
} from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-finalize-val-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const inboxDir = path.join(tmpRoot, "inbox");

let stderrBuf = "";
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  stderrBuf = "";
  process.stderr.write = ((chunk: any) => {
    stderrBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stderr.write = origStderr;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("investigate-finalize JSON validation", () => {
  test("invalid JSON → exit 2, no artifacts written", async () => {
    const reportPath = path.join(tmpRoot, "bad.json");
    fs.writeFileSync(reportPath, "{not valid json");
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir,
      inboxDir,
    });
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(faultsDir, "run-Z"))).toBe(false);
  });

  test("missing rootCause field → exit 2", async () => {
    const reportPath = path.join(tmpRoot, "missing.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        faultId: "CAT:p0:abc",
        outcome: "root-cause-identified",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    );
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir,
      inboxDir,
    });
    expect(code).toBe(2);
    expect(stderrBuf).toContain("rootCause");
  });

  test("invalid outcome value → exit 2", async () => {
    const reportPath = path.join(tmpRoot, "bad-outcome.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        faultId: "CAT:p0:abc",
        outcome: "not-a-real-outcome",
        rootCause: "x",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    );
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir,
      inboxDir,
    });
    expect(code).toBe(2);
    expect(stderrBuf).toContain("invalid outcome");
  });

  test("needs-human outcome → exit 1, artifacts still written", async () => {
    const reportPath = path.join(tmpRoot, "human.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        faultId: "CAT:p0:abc",
        outcome: "needs-human",
        rootCause: "cannot determine without more context",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    );
    // Pre-acquire lock so finalize can release it.
    const { acquireFaultLock } = await import("../investigate-lock");
    acquireFaultLock({ runId: "run-Z", faultId: "CAT:p0:abc", faultsDir });
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      severity: "HIGH",
      faultsDir,
      inboxDir,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(faultsDir, "run-Z", "CAT:p0:abc.md"))).toBe(
      true,
    );
  });
});
```

- [ ] **Step 8.2: Run test to verify pass**

Run: `bun test build/orchestrator/__tests__/investigate-finalize-validation.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 8.3: Commit**

```bash
git add build/orchestrator/__tests__/investigate-finalize-validation.test.ts
git commit -m "test(build): investigate-finalize JSON validation paths

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire CLI dispatch

**Files:**

- Modify: `build/orchestrator/cli.ts` (Args interface, parseArgs, main dispatch, HELP_TEXT)

The exact line numbers below are from the spec exploration; if cli.ts has shifted, anchor by content match.

- [ ] **Step 9.1: Add new fields to the `Args` interface**

Locate the `Args` interface in `build/orchestrator/cli.ts` (around line 750 — search for `interface Args` if line drifted). Add these optional fields alongside existing mode-specific fields:

```typescript
// In Args interface — added for /build investigate
investigateFaultId?: string;
investigateRunId?: string;
investigateStatePath?: string;
investigateRunDir?: string;
investigateSymptoms?: string;
investigateSeverityOverride?: "CRITICAL" | "HIGH" | "MEDIUM";
investigateNoInbox?: boolean;
investigateEmitJson?: boolean;
investigateReportPath?: string;
```

- [ ] **Step 9.2: Add parseArgs cases**

Locate the parseArgs dispatch chain (around lines 1451-1645 — search for `else if (positional[0] === "drain-faults")` as an anchor). After the last `else if` (`learn-fault-patterns`), add two new cases:

```typescript
} else if (positional[0] === "investigate") {
  args.mode = "investigate";
  args.investigateFaultId = positional[1];
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (a === "--run-id") args.investigateRunId = rawArgv[++i];
    else if (a === "--state") args.investigateStatePath = rawArgv[++i];
    else if (a === "--run-dir") args.investigateRunDir = rawArgv[++i];
    else if (a === "--symptoms") args.investigateSymptoms = rawArgv[++i];
    else if (a === "--severity-override") {
      const v = rawArgv[++i];
      if (v === "CRITICAL" || v === "HIGH" || v === "MEDIUM") {
        args.investigateSeverityOverride = v;
      }
    } else if (a === "--no-inbox") args.investigateNoInbox = true;
    else if (a === "--json") args.investigateEmitJson = true;
  }
} else if (positional[0] === "investigate-finalize") {
  args.mode = "investigate-finalize";
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (a === "--run-id") args.investigateRunId = rawArgv[++i];
    else if (a === "--fault-id") args.investigateFaultId = rawArgv[++i];
    else if (a === "--report") args.investigateReportPath = rawArgv[++i];
    else if (a === "--severity-override") {
      const v = rawArgv[++i];
      if (v === "CRITICAL" || v === "HIGH" || v === "MEDIUM") {
        args.investigateSeverityOverride = v;
      }
    } else if (a === "--no-inbox") args.investigateNoInbox = true;
  }
}
```

- [ ] **Step 9.3: Add main dispatch cases**

Locate the main-dispatch chain (around lines 10297-10383 — search for `else if (args.mode === "drain-faults")` as anchor). After the last `else if`, add:

```typescript
} else if (args.mode === "investigate") {
  const { runInvestigateMode } = await import("./investigate-mode");
  const exitCode = await runInvestigateMode({
    faultId: args.investigateFaultId,
    runId: args.investigateRunId,
    statePath: args.investigateStatePath,
    runDir: args.investigateRunDir,
    symptoms: args.investigateSymptoms,
    severityOverride: args.investigateSeverityOverride,
    noInbox: args.investigateNoInbox,
    emitJson: args.investigateEmitJson,
    ttyAvailable: Boolean(process.stdin.isTTY),
  });
  process.exit(exitCode);
} else if (args.mode === "investigate-finalize") {
  if (!args.investigateRunId || !args.investigateFaultId || !args.investigateReportPath) {
    process.stderr.write(
      "usage: gstack-build investigate-finalize --run-id <id> --fault-id <id> --report <path> [--no-inbox]\n",
    );
    process.exit(2);
  }
  const { runInvestigateFinalize } = await import("./investigate-mode");
  const exitCode = await runInvestigateFinalize({
    runId: args.investigateRunId,
    faultId: args.investigateFaultId,
    reportPath: args.investigateReportPath,
    severity: args.investigateSeverityOverride,
    noInbox: args.investigateNoInbox,
  });
  process.exit(exitCode);
}
```

- [ ] **Step 9.4: Add help text**

Locate `HELP_TEXT` (around line 2877). Inside the multi-line string, add entries:

```
  investigate [<faultId>] [flags]
                       Manually investigate a build fault using the four-phase
                       /investigate methodology in the current Claude session.
                       Auto-detects the latest active run when no args given.
                       Flags: --run-id, --state, --run-dir, --symptoms,
                       --severity-override, --no-inbox, --json.

  investigate-finalize --run-id <id> --fault-id <id> --report <path> [--no-inbox]
                       Validate the report file written by the Claude session
                       and persist both the machine report and (for HIGH/CRITICAL)
                       the human bug report. Called by the Claude session.
```

- [ ] **Step 9.5: Smoke-test the CLI**

Run:

```bash
bun run build/orchestrator/cli.ts investigate --help 2>&1 || true
bun run build/orchestrator/cli.ts investigate 2>&1 | tail -3
```

Expected (second command, since there's no active run in this dev env): `error: no context auto-detected and stdin is not a TTY...` and exit code 3.

- [ ] **Step 9.6: Run the full existing build test suite to catch regressions**

Run: `bun test build/orchestrator/__tests__/cli-guardrails.test.ts build/orchestrator/__tests__/cli-plan-review-flags.test.ts`
Expected: PASS — no regressions from the new dispatch arms.

- [ ] **Step 9.7: Commit**

```bash
git add build/orchestrator/cli.ts
git commit -m "feat(build): wire /build investigate + investigate-finalize CLI dispatch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Integration tests — end-to-end, auto-detect, no-context fallback

**Files:**

- Test: `build/orchestrator/__tests__/investigate-end-to-end.test.ts`
- Test: `build/orchestrator/__tests__/investigate-auto-detect.test.ts`
- Test: `build/orchestrator/__tests__/investigate-no-context-fallback.test.ts`

- [ ] **Step 10.1: Write the end-to-end test**

Create `build/orchestrator/__tests__/investigate-end-to-end.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInvestigateMode,
  runInvestigateFinalize,
} from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-e2e-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const inboxDir = path.join(tmpRoot, "inbox");

const FIXTURE_HALT = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/halt-event-codex-convergence.json",
);
const FIXTURE_REPORT = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/canned-report-success.json",
);

let stdoutBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(path.join(faultsDir, "pending-investigations"), {
    recursive: true,
  });
  // Drop fixture halt event into pending-investigations.
  const event = JSON.parse(fs.readFileSync(FIXTURE_HALT, "utf8"));
  fs.writeFileSync(
    path.join(
      faultsDir,
      "pending-investigations",
      `${event.runId}-${event.faultId}.json`,
    ),
    JSON.stringify(event),
  );
  stdoutBuf = "";
  process.stdout.write = ((chunk: any) => {
    stdoutBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stdout.write = origStdout;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("end-to-end /build investigate flow", () => {
  test("briefing → finalize writes both artifacts", async () => {
    const event = JSON.parse(fs.readFileSync(FIXTURE_HALT, "utf8"));
    // Stage 1: emit briefing.
    const code1 = await runInvestigateMode({
      faultId: event.faultId,
      faultsDir,
      activeRunsRegistryDir: path.join(tmpRoot, "active-runs-empty"),
      ttyAvailable: false,
    });
    expect(code1).toBe(0);
    expect(stdoutBuf).toContain("<<<GSTACK_INVESTIGATE_BRIEFING>>>");
    const jsonMatch = stdoutBuf.match(
      /<<<GSTACK_INVESTIGATE_BRIEFING>>>\n([\s\S]+?)\n<<<END>>>/,
    );
    const briefing = JSON.parse(jsonMatch![1]);
    expect(briefing.faultId).toBe(event.faultId);
    expect(briefing.runId).toBe(event.runId);

    // Stage 2: pretend the Claude session wrote a report.
    const reportPath = path.join(tmpRoot, "report.json");
    fs.copyFileSync(FIXTURE_REPORT, reportPath);

    const code2 = await runInvestigateFinalize({
      runId: event.runId,
      faultId: event.faultId,
      reportPath,
      severity: "HIGH",
      faultsDir,
      inboxDir,
    });
    expect(code2).toBe(0);

    // Assert artifacts exist with expected content.
    const machineReportPath = path.join(
      faultsDir,
      event.runId,
      `${event.faultId}.md`,
    );
    expect(fs.existsSync(machineReportPath)).toBe(true);
    const machineContent = fs.readFileSync(machineReportPath, "utf8");
    expect(machineContent).toContain("Plan lacks acceptance criteria");
    expect(machineContent).toContain("root-cause-identified");

    const inboxFiles = fs.readdirSync(inboxDir);
    const bugReport = inboxFiles.find((n) => n.startsWith("BUGREPORT-"));
    expect(bugReport).toBeDefined();
    const bugContent = fs.readFileSync(path.join(inboxDir, bugReport!), "utf8");
    expect(bugContent).toContain("# Bug:");
    expect(bugContent).toContain("**Severity:** HIGH");
    expect(bugContent).toContain("Plan lacks acceptance criteria");
    expect(bugContent).toContain("Add an explicit acceptance checklist");
  });
});
```

- [ ] **Step 10.2: Run the end-to-end test**

Run: `bun test build/orchestrator/__tests__/investigate-end-to-end.test.ts`
Expected: PASS.

- [ ] **Step 10.3: Write the auto-detect test**

Create `build/orchestrator/__tests__/investigate-auto-detect.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInvestigateMode } from "../investigate-mode";

const tmpRoot = path.join(
  os.tmpdir(),
  `gstack-investigate-auto-${process.pid}`,
);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");

let stdoutBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
  fs.mkdirSync(path.join(faultsDir, "pending-investigations"), {
    recursive: true,
  });
  stdoutBuf = "";
  process.stdout.write = ((chunk: any) => {
    stdoutBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stdout.write = origStdout;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("auto-detect picks most recent active run with a pending halt event", async () => {
  // Older run, older halt event.
  fs.writeFileSync(
    path.join(activeRunsDir, "run-old.json"),
    JSON.stringify({
      runId: "run-old",
      stateSlug: "s",
      repoPath: "/r",
      planFile: "/p",
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-22T08:00:00.000Z",
      lastUpdatedAt: "2026-05-22T08:00:00.000Z",
      branches: [],
    }),
  );
  fs.writeFileSync(
    path.join(faultsDir, "pending-investigations", "run-old-CAT:p0:old.json"),
    JSON.stringify({
      faultId: "CAT:p0:old",
      runId: "run-old",
      stateSlug: "s",
      kind: "PHASE_FAILED",
      severity: "HIGH",
      timestamp: "2026-05-22T08:30:00.000Z",
      message: "old",
      pointers: {
        stateFile: "/s",
        stdoutLog: "/o",
        livingPlan: "/p",
        worktreePath: "/wt",
      },
      snapshot: { stdoutTail: "" },
    }),
  );
  // Newer run, newer halt event.
  fs.writeFileSync(
    path.join(activeRunsDir, "run-new.json"),
    JSON.stringify({
      runId: "run-new",
      stateSlug: "s",
      repoPath: "/r",
      planFile: "/p",
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-22T10:00:00.000Z",
      lastUpdatedAt: "2026-05-22T10:00:00.000Z",
      branches: [],
    }),
  );
  fs.writeFileSync(
    path.join(faultsDir, "pending-investigations", "run-new-CAT:p1:new.json"),
    JSON.stringify({
      faultId: "CAT:p1:new",
      runId: "run-new",
      stateSlug: "s",
      kind: "PHASE_FAILED",
      severity: "HIGH",
      timestamp: "2026-05-22T10:15:00.000Z",
      message: "new",
      pointers: {
        stateFile: "/s",
        stdoutLog: "/o",
        livingPlan: "/p",
        worktreePath: "/wt",
      },
      snapshot: { stdoutTail: "" },
    }),
  );

  const code = await runInvestigateMode({
    faultsDir,
    activeRunsRegistryDir: activeRunsDir,
    ttyAvailable: false,
  });
  expect(code).toBe(0);
  const briefing = JSON.parse(
    stdoutBuf.match(
      /<<<GSTACK_INVESTIGATE_BRIEFING>>>\n([\s\S]+?)\n<<<END>>>/,
    )![1],
  );
  expect(briefing.runId).toBe("run-new");
  expect(briefing.faultId).toBe("CAT:p1:new");
});
```

- [ ] **Step 10.4: Run auto-detect test**

Run: `bun test build/orchestrator/__tests__/investigate-auto-detect.test.ts`
Expected: PASS.

- [ ] **Step 10.5: Write the no-context fallback test**

Create `build/orchestrator/__tests__/investigate-no-context-fallback.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInvestigateMode } from "../investigate-mode";

const tmpRoot = path.join(
  os.tmpdir(),
  `gstack-investigate-fallback-${process.pid}`,
);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");

let stderrBuf = "";
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
  stderrBuf = "";
  process.stderr.write = ((chunk: any) => {
    stderrBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stderr.write = origStderr;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("no context, non-TTY → exit 3 with stderr explanation", async () => {
  const code = await runInvestigateMode({
    faultsDir,
    activeRunsRegistryDir: activeRunsDir,
    ttyAvailable: false,
  });
  expect(code).toBe(3);
  expect(stderrBuf).toContain("no context auto-detected");
  expect(stderrBuf).toContain("--state");
  expect(stderrBuf).toContain("--symptoms");
});
```

- [ ] **Step 10.6: Run fallback test**

Run: `bun test build/orchestrator/__tests__/investigate-no-context-fallback.test.ts`
Expected: PASS.

- [ ] **Step 10.7: Commit integration tests**

```bash
git add build/orchestrator/__tests__/investigate-end-to-end.test.ts \
        build/orchestrator/__tests__/investigate-auto-detect.test.ts \
        build/orchestrator/__tests__/investigate-no-context-fallback.test.ts
git commit -m "test(build): integration tests for /build investigate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: SKILL.md.tmpl — document the investigate subcommand

**Files:**

- Modify: `build/SKILL.md.tmpl`

The SKILL.md template is what the Claude session reads to know how to react to the briefing block.

- [ ] **Step 11.1: Open the template and locate the right insertion point**

Run: `grep -n "^## " build/SKILL.md.tmpl | head -20`
Find a section near the existing fault-handling discussion (likely "Halt recovery" or "Fault handling"). Add the new section immediately after, or near the end of the document if no clearly related section exists.

- [ ] **Step 11.2: Add the Investigation methodology section**

Append the following section to `build/SKILL.md.tmpl` (insert before the final closing `---` or at end of file, whichever matches existing template style):

````markdown
## /build investigate — manual fault investigation

When the user invokes `/build investigate` (with or without a fault id), follow this flow:

1. **Run the CLI to get a briefing.**

   ```bash
   gstack-build investigate [<faultId>] [--symptoms "..."] [--state <path>]
   ```
````

The CLI emits a JSON briefing block to stdout between `<<<GSTACK_INVESTIGATE_BRIEFING>>>` and `<<<END>>>` markers. Parse the JSON. If the CLI exits non-zero, read its stderr — the most common cases are exit 2 (bad args, fault not found) and exit 3 (no active run; ask the user to pass `--state`, `--run-id`, or `--symptoms`).

2. **Run the four-phase /investigate methodology** against the briefing's file pointers (`statePath`, `stdoutLogPath`, `livingPlanPath`, `worktreePath`) and the inlined `stdoutTail`. The four phases are mandatory:
   - **Investigate** — Read the symptoms. Use the file pointers to gather more context. Note when pointers reference files that no longer exist (worktree cleaned up, log rotated) — that's signal too.
   - **Analyze** — Trace the code path from symptom back to candidate causes. Name the pattern: race condition, nil propagation, state corruption, integration boundary failure, configuration drift, stale cache, swallowed error.
   - **Hypothesize** — State a specific, testable claim. If state has advanced past the halt point on disk, use `outcome: "self-healed"`. If you cannot make a confident call, use `outcome: "no-context"`. If this halt has been investigated before, use `outcome: "duplicate-of"` with a `duplicateOfPath`.
   - **Implement** — Propose 1-3 fix options labeled by blast_radius (narrow / medium / wide). If the halt shape is a reusable detector pattern, include a `learnedPatternProposal` — but only when the category is genuinely new.

3. **Write your report as JSON** to a tmp path. The schema is the `InvestigationReport` from `build/orchestrator/investigator-dispatch.ts:24-56`. The `faultId` field MUST equal the briefing's faultId.

4. **Call investigate-finalize** with that tmp path. The CLI prints the same `finalizeHint` string back to you in the briefing — use it verbatim:

   ```bash
   gstack-build investigate-finalize --run-id <id> --fault-id <id> --report <tmp-path>
   ```

   `investigate-finalize` validates the report, writes `~/.gstack/skill-faults/<runId>/<faultId>.md` (machine report) and — for HIGH/CRITICAL only — `inbox/BUGREPORT-<date>-<slug>.md` (human bug report). It returns exit 0 on success, 1 when the outcome is `needs-human` or `no-context`, and 2 on validation failure.

5. **Surface the paths to the user.** Print the machine report path and (if written) the bug report path. If the report includes a `learnedPatternProposal`, tell the user to run `gstack-build learn-fault-patterns` to absorb it.

````

- [ ] **Step 11.3: Regenerate SKILL.md from the template**

Run: `bun run gen:skill-docs`
Expected: regenerates `build/SKILL.md` and other generated skill files without errors. Confirm with `git diff build/SKILL.md` that the new section made it in.

- [ ] **Step 11.4: Run the skill-doc validators**

Run: `bun test test/skill-validation.test.ts test/gen-skill-docs.test.ts`
Expected: PASS — no token-ceiling warnings, no validation failures.

- [ ] **Step 11.5: Commit**

```bash
git add build/SKILL.md.tmpl build/SKILL.md
git commit -m "docs(build): document /build investigate methodology in SKILL.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
````

---

## Task 12: E2E test (paid, periodic tier)

**Files:**

- Create: `test/skill-e2e-build-investigate.test.ts`
- Modify: `test/helpers/touchfiles.ts` (touchfile registration)

This test costs real API tokens. Only runs when diff-based selection picks it OR when `EVALS_ALL=1`. Classified `periodic`.

- [ ] **Step 12.1: Inspect an existing periodic E2E test for the harness shape**

Run: `ls test/skill-e2e-*.test.ts | head -5 && head -40 test/skill-e2e-investigate.test.ts 2>/dev/null || head -40 test/skill-e2e-qa.test.ts 2>/dev/null || head -40 test/skill-e2e-ship.test.ts`

Note the imports (e.g. `runAgentSdkTest`, `extractSectionFromSkill`), the `EVALS` env gate, the touchfile-list constant, the periodic-tier classification, and the assertion style. Mirror those patterns.

- [ ] **Step 12.2: Write the E2E test**

Create `test/skill-e2e-build-investigate.test.ts`. Use the same harness as an existing `skill-e2e-*.test.ts` — copy its imports and bootstrap, then write a test like this:

```typescript
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentSdkTest } from "./helpers/session-runner";

const EVALS = process.env.EVALS === "1";
const TIER = process.env.EVALS_TIER ?? "gate";

const RUN_THIS =
  EVALS && (TIER === "periodic" || process.env.EVALS_ALL === "1");

describe.if(RUN_THIS)(
  "e2e: /build investigate produces a usable bug report",
  () => {
    test(
      "real Claude session investigates a planted fault and produces machine + bug reports",
      async () => {
        const tmpRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "gstack-e2e-investigate-"),
        );
        const faultsDir = path.join(tmpRoot, "skill-faults");
        const inboxDir = path.join(tmpRoot, "inbox");
        fs.mkdirSync(path.join(faultsDir, "pending-investigations"), {
          recursive: true,
        });
        fs.mkdirSync(inboxDir, { recursive: true });

        // Plant a halt event the Claude session will investigate.
        const haltEvent = JSON.parse(
          fs.readFileSync(
            path.resolve(
              __dirname,
              "fixtures/investigate/halt-event-codex-convergence.json",
            ),
            "utf8",
          ),
        );
        // Rewrite pointer paths to fixtures inside this temp env.
        const statePath = path.join(tmpRoot, "state.json");
        const stdoutPath = path.join(tmpRoot, "stdout.log");
        const planPath = path.join(tmpRoot, "living-plan.md");
        fs.copyFileSync(
          path.resolve(
            __dirname,
            "fixtures/investigate/state-with-recent-errors.json",
          ),
          statePath,
        );
        fs.copyFileSync(
          path.resolve(__dirname, "fixtures/investigate/stdout-log.txt"),
          stdoutPath,
        );
        fs.writeFileSync(
          planPath,
          "# Living plan\n\nPhase 3: Wire up the CLI (no acceptance criteria specified).\n",
        );
        haltEvent.pointers.stateFile = statePath;
        haltEvent.pointers.stdoutLog = stdoutPath;
        haltEvent.pointers.livingPlan = planPath;
        haltEvent.pointers.worktreePath = tmpRoot;
        fs.writeFileSync(
          path.join(
            faultsDir,
            "pending-investigations",
            `${haltEvent.runId}-${haltEvent.faultId}.json`,
          ),
          JSON.stringify(haltEvent),
        );

        // Tell the Claude session: invoke /build investigate <faultId>, with
        // env vars pointing at our isolated dirs. Extract relevant SKILL.md sections only.
        const buildSkill = fs.readFileSync(
          path.resolve(__dirname, "../build/SKILL.md"),
          "utf8",
        );
        const startIdx = buildSkill.indexOf(
          "## /build investigate — manual fault investigation",
        );
        const slice =
          startIdx >= 0
            ? buildSkill.slice(startIdx, startIdx + 4000)
            : buildSkill.slice(0, 4000);
        fs.writeFileSync(
          path.join(tmpRoot, "build-investigate-skill.md"),
          slice,
        );

        const prompt = `You are testing the /build investigate subcommand.

Read ${path.join(tmpRoot, "build-investigate-skill.md")} for the methodology.

Run: GSTACK_HOME=${tmpRoot} gstack-build investigate ${haltEvent.faultId}

Parse the briefing block from stdout. Run the four investigation phases against the file pointers in the briefing. Write your InvestigationReport JSON to ${path.join(tmpRoot, "report.json")}. Then run:

GSTACK_HOME=${tmpRoot} gstack-build investigate-finalize --run-id ${haltEvent.runId} --fault-id ${haltEvent.faultId} --report ${path.join(tmpRoot, "report.json")}

Report back the final paths and whether both artifacts exist.`;

        const result = await runAgentSdkTest({
          prompt,
          cwd: path.resolve(__dirname, ".."),
          maxTurns: 25,
        });

        const machineReport = path.join(
          faultsDir,
          haltEvent.runId,
          `${haltEvent.faultId}.md`,
        );
        expect(fs.existsSync(machineReport)).toBe(true);
        const machineContent = fs.readFileSync(machineReport, "utf8");
        // The planted fault is about a missing acceptance criterion in the plan.
        // The investigator should identify SOMETHING related to acceptance / convergence / loop.
        expect(
          /acceptance|convergence|loop|never converged|iteration cap/i.test(
            machineContent,
          ),
        ).toBe(true);

        const inboxFiles = fs.readdirSync(inboxDir);
        const bugReport = inboxFiles.find((n) => n.startsWith("BUGREPORT-"));
        expect(bugReport).toBeDefined();
        const bugContent = fs.readFileSync(
          path.join(inboxDir, bugReport!),
          "utf8",
        );
        expect(bugContent).toContain("# Bug:");
        // At least one fix option present.
        expect(bugContent).toContain("### Option 1:");

        fs.rmSync(tmpRoot, { recursive: true, force: true });
      },
      10 * 60 * 1000,
    );
  },
);
```

- [ ] **Step 12.3: Register touchfiles**

Open `test/helpers/touchfiles.ts`. Find the existing touchfile registry (look for `E2E_TIERS` or `touchfiles: {`). Add the new test to the registry, classifying it `periodic`:

```typescript
"test/skill-e2e-build-investigate.test.ts": {
  tier: "periodic",
  touchfiles: [
    "build/orchestrator/investigate-mode.ts",
    "build/orchestrator/investigate-context.ts",
    "build/orchestrator/investigate-report-writer.ts",
    "build/orchestrator/investigate-lock.ts",
    "build/orchestrator/investigator-dispatch.ts",
    "build/SKILL.md.tmpl",
    "build/SKILL.md",
  ],
},
```

Use the exact shape that adjacent entries use; if the registry uses arrays or a different key name, follow that pattern.

- [ ] **Step 12.4: Dry-run the eval selector**

Run: `bun run eval:select`
Expected: prints the list of selected tests. With the new files added, `skill-e2e-build-investigate.test.ts` should appear in the periodic-tier selection.

- [ ] **Step 12.5: Run the E2E (optional, paid)**

Per CLAUDE.md, before running paid evals, source the keys:

```bash
bash -c '
  eval "$(grep -E "^export (ANTHROPIC_API_KEY|OPENAI_API_KEY)=" ~/.zshrc)"
  export ANTHROPIC_API_KEY OPENAI_API_KEY
  EVALS=1 EVALS_TIER=periodic bun test test/skill-e2e-build-investigate.test.ts
'
```

Expected: PASS within ~5 minutes, ~$0.20-0.50 spent. If it fails, do not retry blindly — read the streamed turn-by-turn output, identify why the agent's report or finalize call failed, and fix the SKILL.md template or the briefing format. Do NOT pkill running test processes.

- [ ] **Step 12.6: Commit**

```bash
git add test/skill-e2e-build-investigate.test.ts test/helpers/touchfiles.ts
git commit -m "test(build): paid E2E for /build investigate (periodic tier)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Full free-test sweep + CHANGELOG

**Files:**

- Modify: `CHANGELOG.md`
- (Optional) Modify: `build/orchestrator/__tests__/investigate-*.test.ts` for any catch-ups surfaced by the sweep.

- [ ] **Step 13.1: Run all free tests**

Run: `bun test`
Expected: PASS — including all new investigate-\* tests, all existing build-orchestrator tests, all skill validation. No regressions.

- [ ] **Step 13.2: Run slop-scan on the changed files**

Run: `bun run slop:diff`
Expected: minimal new findings. If something is flagged, evaluate against the rules in CLAUDE.md (`## Slop-scan: AI code quality, not AI code hiding`):

- Empty catches around fs / process — use `safeUnlink` / `safeKill` from `browse/src/error-handling.ts` (note: that module lives in `browse/`; if you need similar helpers in `build/orchestrator/`, prefer string-matching only on ENOENT/ESRCH inline as the existing build-orchestrator code does).
- Linter gaming — don't fix.

- [ ] **Step 13.3: Add a CHANGELOG entry**

Open `CHANGELOG.md`. Add a new entry above the topmost existing entry. Bump VERSION per the spec's instructions in CLAUDE.md (`## Scale-aware bumps`):

- Scale of this branch: new CLI subcommand + new module set + new test suite + ~1500 LOC across implementation + tests. This is **MINOR** (substantial new capability).
- Read current `VERSION` (e.g. `cat VERSION`), bump the minor segment. If main is at `1.42.0.0`, this branch lands at `1.43.0.0`.

Add to CHANGELOG.md following the release-summary format from CLAUDE.md:

```markdown
## [<new-version>] — 2026-05-22

**You can now ask `/build investigate` to root-cause a build halt without waiting for the auto pipeline.**
The current Claude session runs the full four-phase methodology, writes a machine report next to the auto-investigation output, and files a human-readable bug report into `inbox/` for HIGH/CRITICAL faults.

The previous flow was: hit a halt, wait for `drain-faults` to fire, get a thin JSON report from the codex investigator, hope it surfaced something useful. The new flow puts the user back in the loop: run `/build investigate` against the latest active run (or any past fault by id) and the Claude session does the investigation in-context, with all the file-reading and code-tracing tools already authenticated.

### The numbers that matter

Source: planted-fault E2E in `test/skill-e2e-build-investigate.test.ts`.

| Metric                                 | Before (auto codex) | After (/build investigate) | Δ            |
| -------------------------------------- | ------------------- | -------------------------- | ------------ |
| Root-cause specificity (manual rating) | 1-2 sentences       | full discipline + evidence | +2 phases    |
| Files inspected per investigation      | briefing only       | briefing + traced code     | unbounded    |
| Inbox triageability                    | machine-only        | human bug report           | new artifact |

The manual path is the right tool when the auto investigator produced "no-context" or a thin verdict and you want to spend a few hundred tokens reading the actual code paths.

### What this means for build operators

When a build halts, you have two paths now: let `drain-faults` handle it (still works, unchanged), or invoke `/build investigate` in the same session and read a real bug report afterwards. The bug report follows the existing `inbox/BUGREPORT-*` format, so it slots into normal triage. Re-running on the same fault overwrites the machine report and appends a numeric suffix to the bug report — prior investigations aren't clobbered.

### Itemized changes

#### Added

- `gstack-build investigate [<faultId>] [flags]` — new subcommand. Auto-detects the most recent active run when no args; accepts `--state`, `--run-id`, `--run-dir`, `--symptoms`, `--severity-override`, `--no-inbox`, `--json`.
- `gstack-build investigate-finalize` — internal subcommand the Claude session calls after writing its report; validates the JSON and persists both artifacts.
- `build/orchestrator/investigate-mode.ts`, `investigate-context.ts`, `investigate-report-writer.ts`, `investigate-lock.ts` — new modules.
- Investigation methodology section in `build/SKILL.md` documenting the four-phase flow.

#### Changed

- Build orchestrator CLI now recognizes two new modes (`investigate`, `investigate-finalize`).

#### For contributors

- Eleven new tests added under `build/orchestrator/__tests__/investigate-*.test.ts` covering the lock primitive, context resolution, both report writers, severity gating, exit codes, JSON validation, the end-to-end flow, auto-detection, and the no-context fallback.
- One paid E2E test (`test/skill-e2e-build-investigate.test.ts`) added to the periodic tier.
- Five test fixtures under `test/fixtures/investigate/`.
```

- [ ] **Step 13.4: Bump VERSION**

Read the current VERSION file:

Run: `cat VERSION`

Compute the next version: if current is `X.Y.Z.W`, the new minor bump is `X.(Y+1).0.0`. Write that value to VERSION (overwrite the file with just the new version string, no trailing prose).

(If unsure whether this counts as MINOR vs PATCH, re-read CLAUDE.md's `## Scale-aware bumps` table. This branch adds a new user-facing CLI subcommand + new modules + ~1500 LOC. That is MINOR, not PATCH.)

- [ ] **Step 13.5: Verify CHANGELOG ordering**

Run: `grep "^## \[" CHANGELOG.md | head -5`
Expected: new entry is topmost; no duplicate versions; reverse-chronological order preserved.

- [ ] **Step 13.6: Final commit**

```bash
git add CHANGELOG.md VERSION
git commit -m "release: /build investigate subcommand (v<new-version>)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 13.7: Push and announce**

The implementing engineer should stop here and hand back to the user for `/ship`. Do NOT run `/ship` automatically — the user controls when the branch goes up.

---

## Self-review (post-write)

**Spec coverage check.** Each spec section maps to at least one task:

- Subcommand surface → Task 9 (CLI dispatch).
- Architecture / module boundaries → Tasks 1, 3, 4, 5, 6, 7 (each module gets its own task).
- Briefing block contract → Task 7 (`runInvestigateMode` emits it).
- Data flow (resolve → tail → lock → emit → finalize → write artifacts) → Tasks 3, 4, 7.
- Side-effect locations → Tasks 5, 6 (machine report path, bug report path, slug); Task 7 (lock path).
- Bug report format → Task 6 (renderBugReportMarkdown).
- Error handling (10 scenarios) → Tasks 7, 8, 10.
- Testing (unit / integration / E2E / fixtures / touchfile registration) → Tasks 1, 3-8, 10, 12.
- Acceptance criteria — all five covered by Tasks 7, 8, 10, 12.

**Placeholder scan.** No TBD, no "implement later", no "add appropriate error handling", no "similar to Task N", no naked code-less steps. Every code step has the full code.

**Type consistency.**

- `FaultLockHandle` shape (Task 1): `{ lockPath: string; acquiredAt: string }`. Used the same way in `releaseLockByPath` inside Task 7.
- `InvestigationContext` shape (Task 4): runId, faultId, severity, source, haltEvent, statePath, stdoutLogPath, livingPlanPath, worktreePath, symptoms. Used the same way in Tasks 5, 6, 7.
- `InvestigationReport` shape: reused from `investigator-dispatch.ts:24-56` — confirmed identical in canned-report fixture (Task 2), report writers (Tasks 5, 6), and finalize (Task 7).
- `writeBugReport` returns `{ skipped: boolean; path: string | null; reason?: string }` in Task 6; consumed correctly in Task 7's `runInvestigateFinalize`.
- Function names: `runInvestigateMode`, `runInvestigateFinalize`, `acquireFaultLock`, `releaseFaultLock`, `resolveInvestigationContext`, `tailStdoutLog`, `loadHaltEventByFaultId`, `pickMostRecentActiveRun`, `writeMachineReport`, `writeBugReport`, `bugReportSlug` — used identically in all referencing tasks.
- `releaseLockByPath` in Task 7 constructs a `FaultLockHandle` with empty `acquiredAt: ""` — that's fine because `releaseFaultLock` (Task 1) only uses `lockPath`. Consistent.

No issues found. Plan is ready.
