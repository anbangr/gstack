/**
 * F3 — inbox auto-file must not silently clobber a prior same-UTC-day triage
 * signal.
 *
 * Group F (halt/drain), smoke tier. See ./README.md for the PIN/RED protocol
 * and docs/designs/BUILD_ROBUSTNESS_SUITE.md §F3 for the design context.
 *
 * THE GAP (confirmed by reading drain-faults.ts Sink 3, lines ~1653-1672):
 * the inbox auto-file path builds its filename as
 *   `${isoDateUtc(now)}-halt-${he.faultId}.md`
 * and writes it with a bare `fs.writeFileSync` + `result.inboxFiled += 1` —
 * NO collision-avoidance suffix loop (unlike writeBugReport() in
 * investigate-report-writer.ts, which walks `-2`, `-3`, ... on existing
 * files). So when the SAME faultId is re-emitted and drained again on the
 * SAME UTC calendar day, the second drain writes to the identical path,
 * silently overwriting the first triage report, yet STILL bumps `inboxFiled`.
 * The cumulative `inboxFiled` across both drains is 2, but only 1 distinct
 * file survives on disk — the first day-of triage signal is destroyed.
 *
 * DESIRED INVARIANT (this is what the [RED] block asserts, and what currently
 * fails): the total `inboxFiled` count reported across drains equals the
 * number of distinct files actually present in `inboxDir`. The fix can take
 * either shape — a `-2` suffix loop so both signals survive, or a documented
 * counter that does not over-report — but it must close the gap between
 * "claimed filed" and "actually on disk".
 *
 * Injection seams used (all already exist on the production entry point):
 *   - GSTACK_HOME → temp dir (isolates analytics + default inbox).
 *   - emitHaltEvent({ queueDir }) → enqueue the DETECTED row deterministically.
 *   - drainFaultsFromHaltEventsQueue({ queueDir, inboxDir, severityMin,
 *     mockInvestigator }) → drive the drain SYNCHRONOUSLY with a mock that
 *     returns a root-cause-identified report (no LLM, no network, no spawn).
 *
 * On the "fixed now" in the design: drainFaultsFromHaltEventsQueue computes
 * its inbox date from an internal `const now = new Date()` with no override
 * argument. Both drains run inside one test within milliseconds, so they share
 * the same real UTC calendar day — the same-day filename collision reproduces
 * naturally without an injected clock. (The only escape hatch is a UTC midnight
 * rollover landing between the two synchronous drains; vanishingly improbable.)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainFaultsFromHaltEventsQueue } from "../../drain-faults";
import { emitHaltEvent } from "../../halt-events";
import type { HaltEvent } from "../../halt-events";
import type { InvestigationReport } from "../../investigator-dispatch";

describe("[RED→FIXED] F3 inbox-autofile-no-same-day-clobber", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origInbox: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f3-inbox-clobber-"));
    origHome = process.env.GSTACK_HOME;
    origInbox = process.env.GSTACK_INBOX_DIR;
    process.env.GSTACK_HOME = tmp;
    // Pin the inbox explicitly too, so the assertion never reads a developer's
    // real ~/.gstack inbox regardless of how defaultInboxDir resolves.
    delete process.env.GSTACK_INBOX_DIR;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    if (origInbox === undefined) delete process.env.GSTACK_INBOX_DIR;
    else process.env.GSTACK_INBOX_DIR = origInbox;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports inboxFiled equal to the number of distinct files on disk after a same-day re-emit", async () => {
    const queueDir = path.join(tmp, "skill-faults");
    const inboxDir = path.join(tmp, "inbox");

    // A HIGH PHASE_FAILED so the severity gate (>= HIGH) lets the inbox sink
    // fire, and a root-cause-identified outcome so the sink's "actionable"
    // predicate is satisfied. PHASE_FAILED is CRITICAL per severityFor(), which
    // is >= HIGH, so the gate passes.
    const baseEvent: Omit<HaltEvent, "faultId" | "timestamp"> = {
      kind: "PHASE_FAILED",
      runId: "run-f3",
      stateSlug: "slug-f3",
      severity: "CRITICAL",
      message: "phase 0 failed: tests stayed red after cap",
      pointers: {
        stateFile: "/x/state.json",
        stdoutLog: "/x/out.log",
        livingPlan: "/x/plan.md",
        worktreePath: tmp,
      },
      snapshot: { stdoutTail: "" },
    };

    // First emit + drain. Capture the deterministic faultId so the re-emit
    // collides on the same (kind:idx:message) -> same faultId -> same inbox
    // filename for the same UTC day.
    const faultId = emitHaltEvent(baseEvent, { queueDir });

    const mockInvestigator = (he: HaltEvent): InvestigationReport => ({
      faultId: he.faultId,
      outcome: "root-cause-identified",
      rootCause: "Acceptance criteria missing; phase loops to the retry cap.",
      evidence: ["build/orchestrator/phase-runner.ts:1"],
      proposedFix: null,
      learnedPatternProposal: null,
    });

    const drainOpts = {
      queueDir,
      severityMin: "MEDIUM" as const,
      inboxDir,
      mockInvestigator,
    };

    const first = await drainFaultsFromHaltEventsQueue(drainOpts);
    expect(first.processed).toBe(1);
    expect(first.inboxFiled).toBe(1);

    // Re-emit the SAME fault (the first drain already moved the pending file
    // to processed/). computeFaultId is deterministic on kind+phase+message,
    // so the second emit produces an identical faultId.
    const reFaultId = emitHaltEvent(baseEvent, { queueDir });
    expect(reFaultId).toBe(faultId);

    const second = await drainFaultsFromHaltEventsQueue(drainOpts);
    expect(second.processed).toBe(1);

    // Count distinct files actually written to the inbox on disk.
    const onDisk = fs
      .readdirSync(inboxDir)
      .filter((name) => name.endsWith(".md"));
    const totalInboxFiled = first.inboxFiled + second.inboxFiled;

    // DESIRED: the count of triage signals the drain claims to have filed must
    // match the number of distinct files that actually survive. Today the
    // second same-day drain overwrites the first (identical filename, no suffix
    // loop) yet still increments inboxFiled, so totalInboxFiled === 2 while
    // onDisk.length === 1. This assertion fails pre-fix.
    expect(totalInboxFiled).toBe(onDisk.length);
  });
});
