/**
 * F1 — learned-pattern ReDoS must be wall-clock bounded.  [RED]
 *
 * Group F (halt events / fault drain / replay), smoke tier. See
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §"Group F — F1
 * learned-pattern-redos-bounded".
 *
 * The drain hot path evaluates *untrusted* LLM-proposed `stdout_regex`
 * patterns (curated from the investigator into `learned-patterns.json`)
 * against `snapshot.stdoutTail`. The only exported matcher entry that runs
 * that branch is `detectLearnedFaults(input, staticCategories, patterns,
 * planContent, stdoutContent)` in `skill-fault-detector.ts`; internally it
 * does `new RegExp(lp.pattern).test(stdoutContent ?? "")` for the
 * `stdout_regex` kind with NO input cap, NO regex timeout, and NO load-time
 * rejection of catastrophic-backtracking shapes.
 *
 * A backtracking regex matched against a long tail spins the event loop past
 * the 60s `Promise.race` deadline in the drain path — the heartbeat freezes
 * and the monitor may stall-kill the build. The DESIRED invariant: the
 * matcher returns within a hard wall-clock bound (~500ms) via an input cap, a
 * regex timeout, or load-time rejection of the pattern.
 *
 * Today there is none of that, so this is committed `describe.skip` (RED). The
 * fix PR (input cap / re2-style timeout / pattern validation) removes `.skip`
 * and this goes green. See ./README.md for the PIN/RED protocol.
 *
 * Calibration note (deviation): the design names `(a+)+$` over a ~5000-char
 * "a" tail. On this repo's regex engine (Bun / JavaScriptCore) `(a+)+$` is
 * linearized by the engine and returns in ~400ms, so it would NOT defeat a
 * 500ms bound and would make the RED assertion a false-negative. `(a*)*$` is
 * the equivalent untrusted backtracking shape that the engine does NOT
 * optimize: it spins ~1500ms (verified, stable across runs) regardless of the
 * tail length, which is comfortably past the 500ms deadline yet bounded enough
 * that an unskipped pre-fix run fails fast rather than hanging. The pinned
 * invariant — an untrusted `stdout_regex` against a long tail must be
 * wall-clock-bounded — is unchanged. The ~5000-char tail from the design is
 * kept.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectLearnedFaults,
  type LearnedPattern,
  type DetectorInput,
} from "../../skill-fault-detector";
import { mkTmp } from "./helpers";

// Hard wall-clock bound the matcher must respect once F1 is fixed. The 60s
// drain deadline is the failure boundary; 500ms is the target this RED spec
// pins against. A bounded matcher (input cap / regex timeout / load-time
// rejection) returns well under this.
const DEADLINE_MS = 500;

describe("[RED→FIXED] F1 learned-pattern-redos-bounded", () => {
  let tmpHome: string;
  let oldGstackHome: string | undefined;

  beforeEach(() => {
    // detectLearnedFaults' inner persistHitCounts/appendAnalytics write under
    // ${GSTACK_HOME}; isolate so we never touch the developer's real ~/.gstack.
    tmpHome = mkTmp("gstack-robustness-F1-");
    oldGstackHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmpHome;
  });

  afterEach(() => {
    if (oldGstackHome !== undefined) process.env.GSTACK_HOME = oldGstackHome;
    else delete process.env.GSTACK_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns within the wall-clock deadline for a catastrophic stdout_regex over a long tail", () => {
    // One LLM-proposed learned pattern: an untrusted backtracking regex of the
    // exact shape the curator promotes into learned-patterns.json.
    const learnedPatternsPath = path.join(
      tmpHome,
      "skill-faults",
      "learned-patterns.json",
    );
    const redosPattern: LearnedPattern = {
      category: "REDOS_LEARNED",
      severity: "MEDIUM",
      description: "untrusted backtracking stdout_regex",
      matcherKind: "stdout_regex",
      pattern: "(a*)*$",
      source: "investigator:redos-fixture",
      learnedAt: "2026-01-01T00:00:00.000Z",
      hitCount: 0,
    };
    // Persist it on disk too, so the load-time-rejection fix variant (rejecting
    // the pattern in loadLearnedPatterns) is also exercisable from this fixture.
    fs.mkdirSync(path.dirname(learnedPatternsPath), { recursive: true });
    fs.writeFileSync(
      learnedPatternsPath,
      JSON.stringify([redosPattern], null, 2) + "\n",
      { mode: 0o600 },
    );

    // The halt snapshot tail: ~5000 chars of "a" then a non-matching "!" so the
    // regex must exhaust every backtracking path before failing the `$` anchor.
    const stdoutTail = "a".repeat(5000) + "!";

    const input: DetectorInput = {
      state: { phases: [] } as unknown as DetectorInput["state"],
      livingPlanPath: path.join(tmpHome, "no-plan.md"),
      worktreePath: path.join(tmpHome, "no-worktree"),
      stateDir: path.join(tmpHome, "no-state"),
      stdoutLogPath: path.join(tmpHome, "no-stdout.log"),
    };

    // Drive the narrowest exported matcher entry that runs the stdout_regex
    // branch directly. staticCategories is empty so the learned pattern is not
    // shadowed; planContent null, stdoutContent is the long tail.
    const start = performance.now();
    detectLearnedFaults(
      input,
      new Set<string>(),
      [redosPattern],
      null,
      stdoutTail,
    );
    const elapsedMs = performance.now() - start;

    // DESIRED invariant (fails today: the unbounded regex spins ~1500ms).
    expect(elapsedMs).toBeLessThan(DEADLINE_MS);
  });
});
