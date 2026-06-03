/**
 * F2 — halt faultId: distinct occurrences must be preserved across a long run.
 *
 * Group F (halt/drain). See docs/designs/BUILD_ROBUSTNESS_SUITE.md §F2 and
 * ./README.md for the PIN/RED protocol.
 *
 * THE GAP (confirmed by reading build/orchestrator/halt-events.ts:111-167):
 *   `computeFaultId` keys the on-disk filename on `kind:idx:sha256(kind:idx:message)`
 *   only. Two halts with identical kind + phase index + message but DIFFERENT
 *   `snapshot.stdoutTail` (a different forensic snapshot of the SAME recurring
 *   failure, captured minutes apart on a long autonomous run) compute the SAME
 *   faultId, write the SAME `<runId>-<faultId>.json` filename, and the second
 *   `fs.renameSync` in `emitHaltEvent` silently clobbers the first. The first
 *   occurrence's stdoutTail and timestamp are destroyed with no record that a
 *   collapse happened.
 *
 * DESIRED INVARIANT (this [RED] block, currently failing):
 *   When the same logical fault recurs with a materially different snapshot,
 *   the queue must NOT silently lose the earlier forensic snapshot. Either:
 *     (a) two distinct files survive in pending-investigations/ (the faultId
 *         carries an occurrence discriminator), OR
 *     (b) exactly one file survives PLUS a documented overwrite-counter /
 *         analytics row records the collapse (so the loss is observable).
 *   Today neither holds: one file survives, it carries ONLY the second
 *   occurrence, and nothing on disk records that the first was overwritten.
 *
 * UNSKIP when F2 is fixed (faultId discriminator OR collapse-recording added).
 *
 * No LLM, no network, no spawn. Pure temp-dir disk via emitHaltEvent's
 * `{ queueDir, now }` seam (halt-events.ts:150-153).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  emitHaltEvent,
  computeFaultId,
  type HaltEvent,
} from "../../halt-events";
import { mkTmp } from "./helpers";

/**
 * Build a halt event omitting the fields emitHaltEvent computes
 * (faultId, timestamp). The phase object only needs `.index` for
 * computeFaultId — mirrors the `as any` phase shape used in the
 * reference halt-events.test.ts.
 */
function makeEvent(
  stdoutTail: string,
): Omit<HaltEvent, "faultId" | "timestamp"> {
  return {
    kind: "PHASE_FAILED",
    runId: "run-long-build",
    stateSlug: "slug-1",
    severity: "CRITICAL",
    message: "phase 2 spec-flip failed",
    pointers: {
      stateFile: "/x/state.json",
      stdoutLog: "/x/stdout.log",
      livingPlan: "/x/plan.md",
      worktreePath: "/x/wt",
    },
    snapshot: {
      // Same kind, same phase index, same message across both emits —
      // only stdoutTail (the forensic capture) differs.
      phase: { index: 2, status: "failed" } as any,
      stdoutTail,
    },
  };
}

describe.skip("[RED] F2 halt-faultid-distinct-occurrences-preserved — UNSKIP WHEN F2 IS FIXED", () => {
  let queueDir: string;
  // Five minutes apart, the long-run recurrence pattern from the design.
  const T0 = new Date("2026-06-03T10:00:00.000Z");
  const T1 = new Date("2026-06-03T10:05:00.000Z");
  const FIRST_TAIL = "FIRST occurrence: assertion X failed at line 10";
  const SECOND_TAIL =
    "SECOND occurrence: DIFFERENT failure mode, assertion Y failed at line 99";

  beforeEach(() => {
    queueDir = mkTmp("f2-halt-faultid-");
  });

  afterEach(() => {
    fs.rmSync(queueDir, { recursive: true, force: true });
  });

  it("preserves both forensic snapshots, or records the collapse on disk", () => {
    // Emit the SAME logical fault twice. Identical kind/phase/message,
    // different stdoutTail, 5 minutes apart.
    const id1 = emitHaltEvent(makeEvent(FIRST_TAIL), {
      queueDir,
      now: T0,
    });
    const id2 = emitHaltEvent(makeEvent(SECOND_TAIL), {
      queueDir,
      now: T1,
    });

    const pendingDir = path.join(queueDir, "pending-investigations");
    const files = fs
      .readdirSync(pendingDir)
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
    const bodies = files.map(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")) as Record<
          string,
          any
        >,
    );

    // Set of stdoutTails actually surviving on disk in pending-investigations/.
    const survivingTails = new Set<string>(
      bodies
        .filter((b) => typeof b?.snapshot?.stdoutTail === "string")
        .map((b) => b.snapshot.stdoutTail as string),
    );

    // Path (a): two distinct files survive — the faultId carries an
    // occurrence discriminator so the second emit does not collide.
    const pathA =
      files.length >= 2 &&
      id1 !== id2 &&
      survivingTails.has(FIRST_TAIL) &&
      survivingTails.has(SECOND_TAIL);

    // Path (b): exactly one file survives, but the collapse is recorded
    // somewhere observable on disk under the queueDir — either an explicit
    // overwrite-counter field on the surviving event, OR an analytics row
    // that references the clobbered occurrence. We look for any artifact
    // under queueDir whose content names the destroyed FIRST_TAIL, plus a
    // counter/collapse signal. The exact shape is the implementer's choice;
    // what the invariant forbids is a SILENT loss.
    const collapseRecorded = (() => {
      // (b.i) a counter / occurrence-count field on the surviving event
      const survivor = bodies[0];
      const hasCounter =
        survivor != null &&
        (typeof survivor.occurrences === "number" ||
          typeof survivor.overwriteCount === "number" ||
          (survivor.snapshot != null &&
            typeof survivor.snapshot.occurrences === "number")) &&
        ((survivor.occurrences ?? survivor.overwriteCount ?? 0) >= 2 ||
          (survivor.snapshot?.occurrences ?? 0) >= 2);
      if (files.length === 1 && hasCounter) return true;

      // (b.ii) an analytics / overwrite-log artifact anywhere under queueDir
      // that captures the clobbered occurrence's distinguishing tail.
      const allFilesUnderQueue: string[] = [];
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (fs.statSync(p).isDirectory()) walk(p);
          else allFilesUnderQueue.push(p);
        }
      };
      walk(queueDir);
      const recordsFirst = allFilesUnderQueue.some((p) => {
        // The surviving pending event must not be what we count here —
        // it only carries SECOND_TAIL. Look for an artifact that still
        // references the destroyed FIRST_TAIL.
        if (p === path.join(pendingDir, files[0] ?? "")) return false;
        const txt = fs.readFileSync(p, "utf8");
        return txt.includes(FIRST_TAIL);
      });
      return files.length === 1 && recordsFirst;
    })();

    // The invariant: at least one of the two acceptable contracts holds.
    // Today neither does — id1 === id2, files.length === 1, the survivor
    // carries only SECOND_TAIL, and no collapse record exists — so this fails.
    expect(pathA || collapseRecorded).toBe(true);
  });

  it("does not silently destroy the earlier occurrence's snapshot", () => {
    // A tighter restatement of the core forensic loss: after two distinct
    // recurrences, the FIRST occurrence's stdoutTail must still be
    // recoverable from the queue directory tree (not clobbered into oblivion).
    emitHaltEvent(makeEvent(FIRST_TAIL), { queueDir, now: T0 });
    emitHaltEvent(makeEvent(SECOND_TAIL), { queueDir, now: T1 });

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else found.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(queueDir);

    const firstStillRecoverable = found.some((txt) => txt.includes(FIRST_TAIL));
    expect(firstStillRecoverable).toBe(true);
  });

  it("faultId carries an occurrence discriminator for materially different snapshots", () => {
    // Sanity anchor for path (a): the design's preferred fix is a discriminator
    // in the faultId itself. Two emits with different forensic snapshots should
    // not collide on the same computed id. Today computeFaultId ignores
    // stdoutTail entirely, so this is the currently-failing assertion.
    const id1 = computeFaultId(makeEvent(FIRST_TAIL));
    const id2 = computeFaultId(makeEvent(SECOND_TAIL));
    expect(id1).not.toBe(id2);
  });
});
