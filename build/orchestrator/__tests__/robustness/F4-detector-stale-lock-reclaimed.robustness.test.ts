/**
 * F4 — detector stale-lock reclaimed (build-robustness suite)
 *
 * Group F (halt/drain). See ./README.md for the PIN/RED protocol and
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §F4 for the full design context.
 *
 * Scenario: a resumed build run finds a `learned-patterns.json.lock` left
 * behind by a process that crashed mid-write. The lock file holds that dead
 * process's PID. The detector's hit-count persister (`persistHitCounts` in
 * skill-fault-detector.ts) acquires this lock before incrementing hitCount.
 *
 * Desired invariant (F4): the persister recognises the lock is stale — the
 * PID inside it is not a live process — reclaims it, increments the hit count,
 * and returns well under the 5s acquire `maxWait`. An orphaned lock after a
 * crash must NOT inject a 5s event-loop freeze on every detector tick of a
 * resumed run.
 *
 * Intended mode was PIN. Flipped to RED: the production `acquireLock`
 * (skill-fault-detector.ts:409-424) has NO stale-lock reclaim — it spins with
 * `fs.writeFileSync(..., { flag: "wx" })` for the full 5000ms `maxWait`, then
 * throws, and the throw is swallowed by persistHitCounts's catch. A dead-PID
 * lock therefore freezes the call for ~5s AND leaves hitCount at 0 (the
 * increment write is never reached). Verified by direct probe:
 *   elapsed_ms: 5010  fault_fired: true  hitCount_after: 0  lock_still_exists: true
 * So the claimed PIN behavior does not exist today. The body below asserts the
 * DESIRED behavior and is committed `describe.skip`; unskip when F4 is fixed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectSkillFaults,
  type LearnedPattern,
  type DetectorInput,
} from "../../skill-fault-detector";

const LEARNED_PATTERN: LearnedPattern = {
  category: "F4_STALE_LOCK_PROBE",
  severity: "HIGH",
  description: "F4 stale-lock reclaim probe",
  matcherKind: "failureReason_contains",
  pattern: "f4-boom",
  source: "investigator:F4-robustness-test",
  learnedAt: "2026-06-03T00:00:00.000Z",
  hitCount: 0,
};

/** A fault-triggering state: failureReason contains the learned pattern. */
function faultTriggeringInput(stateDir: string): DetectorInput {
  return {
    state: { phases: [], failureReason: "f4-boom happened" } as any,
    livingPlanPath: path.join(stateDir, "no-such-plan.md"),
    worktreePath: path.join(stateDir, "no-such-worktree"),
    stateDir,
    stdoutLogPath: path.join(stateDir, "no-such-stdout.log"),
  };
}

describe("[RED→FIXED] F4 detector-stale-lock-reclaimed", () => {
  let tmpDir = "";
  let savedHome: string | undefined;
  let learnedPatternsPath = "";
  let lockPath = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f4-stale-lock-"));
    savedHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmpDir;

    // Valid learned-patterns.json with a single matching pattern, hitCount 0.
    const skillFaultsDir = path.join(tmpDir, "skill-faults");
    fs.mkdirSync(skillFaultsDir, { recursive: true });
    learnedPatternsPath = path.join(skillFaultsDir, "learned-patterns.json");
    fs.writeFileSync(
      learnedPatternsPath,
      JSON.stringify([LEARNED_PATTERN], null, 2) + "\n",
    );

    // Pre-create the lock holding a DEAD pid (no process owns 999999). This is
    // the orphaned-after-crash lock. A reclaim-aware persister must notice the
    // owner is dead and take the lock.
    lockPath = `${learnedPatternsPath}.lock`;
    fs.writeFileSync(lockPath, String(999999));
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.GSTACK_HOME = savedHome;
    else delete process.env.GSTACK_HOME;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort; tmpdir cleanup is non-fatal.
    }
  });

  it("reclaims the dead-PID lock fast and still increments hitCount", () => {
    const input = faultTriggeringInput(tmpDir);

    const t0 = Date.now();
    const faults = detectSkillFaults(input, [LEARNED_PATTERN]);
    const elapsedMs = Date.now() - t0;

    // The fault fired (sanity: we drove a real detection so persistHitCounts ran).
    expect(faults.some((f) => f.category === "F4_STALE_LOCK_PROBE")).toBe(true);

    // Desired: reclaim, not timeout. The acquire maxWait is 5000ms; a healthy
    // reclaim is near-instant. Well under 5s — generous bound to stay robust
    // on a loaded CI box while still proving the 5s freeze is gone.
    expect(elapsedMs).toBeLessThan(2000);

    // Desired: the stale lock was reclaimed and the increment write actually
    // landed. The timed-out-and-swallowed path leaves this at 0.
    const after = JSON.parse(
      fs.readFileSync(learnedPatternsPath, "utf8"),
    ) as LearnedPattern[];
    const entry = after.find((e) => e.category === "F4_STALE_LOCK_PROBE");
    expect(entry).toBeTruthy();
    expect(entry!.hitCount).toBe(1);
  });
});
