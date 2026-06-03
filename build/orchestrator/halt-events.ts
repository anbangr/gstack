import { spawnSync } from "./child-registry";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildState } from "./types";

const STDOUT_TAIL_LINES = 200;

export type HaltEventKind =
  | "PHASE_FAILED"
  | "FEATURE_FAILED"
  | "RETRY_CAP_HIT"
  | "DUAL_IMPL_SWAP"
  | "RECOVERY_BOUNDARY"
  | "SILENT_STATE_MUTATION"
  | "PHASE_REWIND"
  | "SOFT_HALT_WARN"
  | "SOFT_HALT_ERROR"
  | "STALL_KILLED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_OVERLOADED"
  | "PROVIDER_TRANSPORT_ERROR"
  | "PROVIDER_AUTH_REQUIRED"
  | "RED_GATE_ZERO_TESTS_COLLECTED"
  | "HYGIENE_FAIL"
  | "RED_SPEC_EXHAUSTED";

export type HaltSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface HaltEvent {
  faultId: string;
  runId: string;
  stateSlug: string;
  kind: HaltEventKind;
  severity: HaltSeverity;
  timestamp: string;
  message: string;
  /**
   * When false, drainFaultsFromHaltEventsQueue short-circuits this event:
   * the file moves to processed/ without dispatching the codex investigator,
   * and analytics records outcome: "audit-skipped". Used for manual-recovery
   * sites (drain-faults / mark-shipped / --mark-phase-committed) that are
   * audit signals, not investigation requests. Absent OR true means dispatch
   * normally — preserves back-compat for rows filed before this field existed.
   */
  investigate?: boolean;
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
    /**
     * Why the watchdog killed. Absent for non-watchdog halts. New in
     * v1.40.x — see docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md.
     * `startup_hang` added in v1.45 — see docs/superpowers/specs/2026-05-25-cpu-aware-startup-hang-watchdog-design.md.
     */
    killReason?:
      | "silence"
      | "progress_gap"
      | "stall"
      | "auth_required"
      | "startup_hang";
    /** Last classified tool at kill time. Null when never classified. */
    lastTool?: string | null;
    /** Last classified bucket at kill time. Null when never classified. */
    lastBucket?: "fast" | "slow" | null;
    /**
     * Machine-readable provider quota reset time, surfaced as a structured
     * field (not just interpolated into `message`) so a supervisor / sleep-
     * until-reset policy can read it without re-parsing prose. Present only on
     * PROVIDER_QUOTA_EXHAUSTED halts that carried a parseable reset time (A4).
     */
    resetAt?: string;
    /**
     * How many times this logical fault (stable faultId) has been emitted with
     * a MATERIALLY DIFFERENT snapshot. Set (>= 2) only on such a recurrence; the
     * prior occurrence's full capture is archived under `<queueDir>/collapsed/`
     * so an earlier forensic snapshot is never silently clobbered (F2). Absent
     * on a first/only occurrence and on identical re-emits.
     */
    occurrences?: number;
  };
}

export function severityFor(kind: HaltEventKind): HaltSeverity {
  switch (kind) {
    case "PHASE_FAILED":
    case "FEATURE_FAILED":
      return "CRITICAL";
    case "RETRY_CAP_HIT":
    case "RECOVERY_BOUNDARY":
    case "SILENT_STATE_MUTATION":
    case "STALL_KILLED":
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_QUOTA_EXHAUSTED":
    case "PROVIDER_OVERLOADED":
    case "PROVIDER_TRANSPORT_ERROR":
    case "PROVIDER_AUTH_REQUIRED":
    case "RED_GATE_ZERO_TESTS_COLLECTED":
    case "HYGIENE_FAIL":
    case "RED_SPEC_EXHAUSTED":
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
  const featureIdx = event.snapshot.feature?.number;
  const idx =
    typeof phaseIdx === "number"
      ? `p${phaseIdx}`
      : typeof featureIdx === "string" && featureIdx.length > 0
        ? `f${featureIdx}`
        : "all";
  const hash = crypto
    .createHash("sha256")
    .update(`${event.kind}:${idx}:${event.message}`)
    .digest("hex")
    .slice(0, 8);
  return `${event.kind}:${idx}:${hash}`;
}

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
  const dir = pendingInvestigationsDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const safeRun = safeRegistryRunId(event.runId);
  const finalPath = path.join(dir, `${safeRun}-${faultId}.json`);

  // F2: faultId is intentionally STABLE (it's the dedup + DETECTED/RESOLVED
  // pairing key), so a recurrence of the same logical fault writes the same
  // filename. If that recurrence carries a MATERIALLY DIFFERENT forensic
  // snapshot (a different stdoutTail captured minutes apart on a long run), a
  // bare overwrite would silently destroy the earlier evidence. Archive the
  // prior capture to a sibling `collapsed/` dir (NOT under pending-investigations,
  // so the drain queue never re-investigates it) and carry an occurrences
  // count. Identical re-emits stay a pure overwrite (today's behavior).
  let snapshot = event.snapshot;
  if (fs.existsSync(finalPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(finalPath, "utf8")) as HaltEvent;
      if (prior?.snapshot?.stdoutTail !== event.snapshot?.stdoutTail) {
        const priorOcc =
          typeof prior?.snapshot?.occurrences === "number"
            ? prior.snapshot.occurrences
            : 1;
        const collapsedDir = path.join(path.dirname(dir), "collapsed");
        fs.mkdirSync(collapsedDir, { recursive: true });
        fs.writeFileSync(
          path.join(collapsedDir, `${safeRun}-${faultId}-${priorOcc}.json`),
          JSON.stringify(prior, null, 2) + "\n",
          { mode: 0o600 },
        );
        snapshot = { ...event.snapshot, occurrences: priorOcc + 1 };
      }
    } catch {
      // Prior file unreadable — proceed with a plain write rather than block
      // the emit; the new capture still lands.
    }
  }

  const full: HaltEvent = { ...event, faultId, timestamp, snapshot };
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, finalPath);
  return faultId;
}

/**
 * Minimal "this fault recovered" marker. Written to the same
 * pending-investigations/ queue as DETECTED rows so the queue consumer
 * (drainFaultsFromHaltEventsQueue) can collapse DETECTED+RESOLVED pairs
 * by (runId, faultId) before dispatching codex. The on-disk filename
 * pattern `<safeRunId>-RESOLVED-<faultId>.json` distinguishes resolution
 * rows from emit rows so the consumer can classify each file in one pass.
 *
 * Returns true on successful write, false on failure (with stderr warn).
 * Callers SHOULD check the return value so a missing RESOLVED row never
 * silently leaves a DETECTED row in the queue.
 */
export function emitHaltEventResolved(
  faultId: string,
  runId: string,
  opts?: { queueDir?: string; now?: Date },
): boolean {
  try {
    const timestamp = (opts?.now ?? new Date()).toISOString();
    const dir = pendingInvestigationsDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    const safeRun = safeRegistryRunId(runId);
    const finalPath = path.join(dir, `${safeRun}-RESOLVED-${faultId}.json`);
    const tmpPath = `${finalPath}.tmp.${process.pid}`;
    const body = {
      event: "SKILL_FAULT_RESOLVED" as const,
      timestamp,
      runId,
      faultId,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(body, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch (err) {
    process.stderr.write(
      `[emitHaltEventResolved] failed to write RESOLVED for faultId=${faultId} runId=${runId}: ${(err as Error).message}\n`,
    );
    return false;
  }
}

/**
 * Discriminated-union view of a single pending-investigations/ entry.
 * `detected` rows are full HaltEvent JSON (what emitHaltEvent writes);
 * `resolved` rows are minimal-shape pairs (what emitHaltEventResolved
 * writes). The queue consumer uses `kind` to route each entry.
 */
export type PendingEntry =
  | { kind: "detected"; file: string; event: HaltEvent }
  | { kind: "resolved"; file: string; runId: string; faultId: string };

/**
 * Surface every JSON row under pending-investigations/, classifying each
 * by event field. Detected (HaltEvent) rows have no `event` field at
 * the top level; resolved rows have `event: "SKILL_FAULT_RESOLVED"`.
 * Malformed JSON is silently skipped.
 *
 * Use this in the queue consumer when you need to see RESOLVED markers
 * (e.g., for DETECTED+RESOLVED pair collapse). Use the back-compat
 * loadPendingInvestigations() when callers only want detected events.
 */
export function loadPendingEntries(opts?: {
  queueDir?: string;
}): PendingEntry[] {
  const dir = pendingInvestigationsDir(opts);
  if (!fs.existsSync(dir)) return [];
  const out: PendingEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.event === "SKILL_FAULT_RESOLVED") {
        if (
          typeof parsed.runId === "string" &&
          typeof parsed.faultId === "string"
        ) {
          out.push({
            kind: "resolved",
            file: name,
            runId: parsed.runId,
            faultId: parsed.faultId,
          });
        }
      } else {
        out.push({
          kind: "detected",
          file: name,
          event: parsed as unknown as HaltEvent,
        });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Back-compat wrapper: returns only the HaltEvent rows from the queue,
 * filtering out RESOLVED markers. Callers that need to see RESOLVED
 * rows for pair-collapse should use loadPendingEntries() instead.
 */
export function loadPendingInvestigations(opts?: {
  queueDir?: string;
}): HaltEvent[] {
  return loadPendingEntries(opts)
    .filter(
      (e): e is Extract<PendingEntry, { kind: "detected" }> =>
        e.kind === "detected",
    )
    .map((e) => e.event);
}

export function markInvestigated(
  runId: string,
  faultId: string,
  // _outcome is reserved for future use; logging happens at the call site.
  _outcome:
    | "investigated"
    | "skipped-no-context"
    | "self-healed"
    | "audit-skipped",
  opts?: { queueDir?: string },
): void {
  const safeRun = safeRegistryRunId(runId);
  const fileName = `${safeRun}-${faultId}.json`;
  const src = path.join(pendingInvestigationsDir(opts), fileName);
  const dstDir = processedDir(opts);
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, fileName);
  fs.renameSync(src, dst);
}

export interface BuildHaltSnapshotInput {
  state: BuildState | null;
  stdoutLogPath: string;
  worktreePath: string;
  phaseIndex?: number;
  featureIndex?: number;
  failureReason?: string;
  /**
   * Watchdog kill info. Forwarded from a SubAgentResult through the
   * halt-event-helpers when the halt was triggered by a stall-kill.
   * Absent for non-watchdog halts.
   */
  killReason?:
    | "silence"
    | "progress_gap"
    | "stall"
    | "auth_required"
    | "startup_hang";
  lastTool?: string | null;
  lastBucket?: "fast" | "slow" | null;
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
      ? input.state?.features?.[input.featureIndex]
      : undefined;
  const iterationHistory = phase
    ? {
        testRun: phase.testRun?.iterations,
        testFix: phase.testFix?.iterations,
        codexReview: phase.codexReview?.iterations,
      }
    : undefined;
  let stdoutTail = "";
  try {
    const raw = fs.readFileSync(input.stdoutLogPath, "utf8");
    const lines = raw.split("\n");
    stdoutTail = lines
      .slice(Math.max(0, lines.length - STDOUT_TAIL_LINES))
      .join("\n");
  } catch {
    stdoutTail = "";
  }
  let worktreeHead: string | undefined;
  try {
    const res = spawnSync(
      "git",
      ["-C", input.worktreePath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
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
    killReason: input.killReason,
    lastTool: input.lastTool,
    lastBucket: input.lastBucket,
  };
}
