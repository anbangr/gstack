/**
 * End-to-end tests for backfill-checkboxes.ts.
 *
 * The script is invoked as a process so we exercise the actual CLI exit
 * codes, lock acquisition, file mutation, and stderr messages a user would
 * observe. Each test sets up an isolated tempdir to keep state files
 * mutually invisible across cases.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock, deriveSlug, lockPath, releaseLock } from "../state";

const SCRIPT = path.resolve(__dirname, "..", "backfill-checkboxes.ts");

function setupFixture(opts?: {
  planContent?: string;
  stateOverride?: any;
  /** When true, omit `state.planFile` to test the legacy-state path. */
  omitStatePlanFile?: boolean;
}): {
  dir: string;
  planFile: string;
  stateFile: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-test-"));
  const planFile = path.join(dir, "plan.md");
  const planContent =
    opts?.planContent ??
    `# Plan\n\n### Phase 1: Foo\n- [ ] **Implementation**: do\n- [ ] **Review**: rev\n\n### Phase 2: Bar\n- [ ] **Implementation**: do\n- [ ] **Review**: rev\n`;
  fs.writeFileSync(planFile, planContent);

  const stateFile = path.join(dir, "state.json");
  const baseState = opts?.stateOverride ?? {
    phases: [
      { index: 0, number: "1", name: "Foo", status: "committed" },
      { index: 1, number: "2", name: "Bar", status: "pending" },
    ],
  };
  if (!opts?.omitStatePlanFile && baseState.planFile === undefined) {
    baseState.planFile = planFile;
  }
  fs.writeFileSync(stateFile, JSON.stringify(baseState, null, 2));

  const slug = deriveSlug(planFile);
  return {
    dir,
    planFile,
    stateFile,
    cleanup: () => {
      // Belt-and-suspenders: release any lock the test may have left if
      // the script crashed before reaching its finally block.
      try {
        fs.unlinkSync(lockPath(slug));
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function run(planFile: string, stateFile: string) {
  return spawnSync("bun", ["run", SCRIPT, planFile, stateFile], {
    encoding: "utf8",
  });
}

describe("backfill-checkboxes script", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("flips checkboxes for committed phases and leaves others alone", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    const after = fs.readFileSync(f.planFile, "utf8");
    expect(after).toContain("- [x] **Implementation**: do");
    expect(after).toContain("- [x] **Review**: rev");
    // Phase 2 is pending → its boxes stay unchecked.
    const lines = after.split(/\r?\n/);
    // Phase 2 starts after Phase 1 block — verify the second pair stayed.
    const p2impl = lines.findIndex(
      (l) => l.includes("**Implementation") && l.includes("[ ]"),
    );
    expect(p2impl).toBeGreaterThan(0);
  });

  it("refuses to run when gstack-build holds the lock (acquireLock not just readLockInfo)", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    const slug = deriveSlug(f.planFile);
    expect(acquireLock(slug)).toBe(true); // simulate orchestrator holding it
    try {
      const r = run(f.planFile, f.stateFile);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/holds the lock/);
      // Plan must be untouched while we held the lock.
      const after = fs.readFileSync(f.planFile, "utf8");
      expect(after).toContain("- [ ] **Implementation**: do");
    } finally {
      releaseLock(slug);
    }
  });

  it("releases the lock after success so a follow-up run is not blocked", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    const slug = deriveSlug(f.planFile);
    const r1 = run(f.planFile, f.stateFile);
    expect(r1.status).toBe(0);
    expect(fs.existsSync(lockPath(slug))).toBe(false);
    // Idempotent rerun on already-flipped boxes succeeds with 0 flips.
    const r2 = run(f.planFile, f.stateFile);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/0 checkboxes flipped/);
  });

  it("releases the lock after success (no leaked lock file on the happy path)", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    const slug = deriveSlug(f.planFile);
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    // Crucial guarantee: the script's `try { … } finally { releaseLock }`
    // structure ensures even an unexpected throw inside the loop releases
    // the lock — without it, the orchestrator would be permanently
    // blocked from running on this plan.
    expect(fs.existsSync(lockPath(slug))).toBe(false);
  });

  it("skips phases whose number disagrees with state (plan reordered between runs)", () => {
    // State says phase index 0 has number '99', but the plan parses index 0 as number '1'.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "99",
            name: "Reordered Old",
            status: "committed",
          },
          { index: 1, number: "2", name: "Bar", status: "committed" },
        ],
      },
    });
    cleanup = f.cleanup;
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/mismatch.*phase 1.*state has phase 99/);
    const after = fs.readFileSync(f.planFile, "utf8");
    // Index 0 (Phase 1: Foo) was NOT flipped because of the guard.
    expect(after).toContain("### Phase 1: Foo\n- [ ] **Implementation**");
    // Index 1 (Phase 2: Bar) WAS flipped — its number matches.
    expect(after).toContain("### Phase 2: Bar\n- [x] **Implementation**");
  });

  it("refuses when state.planFile points to a different plan", () => {
    const f = setupFixture({
      stateOverride: {
        planFile: "/some/other/path/plan.md",
        phases: [{ index: 0, number: "1", name: "Foo", status: "committed" }],
      },
    });
    cleanup = f.cleanup;
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/different plan/);
    expect(r.stderr).toMatch(/argv plan/);
    expect(r.stderr).toMatch(/state\.planFile/);
    const after = fs.readFileSync(f.planFile, "utf8");
    // Mutation refused.
    expect(after).toContain("- [ ] **Implementation**: do");
  });

  it("accepts state files without planFile field (legacy state, no validation possible)", () => {
    const f = setupFixture({
      omitStatePlanFile: true,
      stateOverride: {
        phases: [{ index: 0, number: "1", name: "Foo", status: "committed" }],
      },
    });
    cleanup = f.cleanup;
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    const after = fs.readFileSync(f.planFile, "utf8");
    expect(after).toContain("- [x] **Implementation**: do");
  });

  it("exits 1 with a clear message when state.json is malformed (not opaque V8 trace)", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    fs.writeFileSync(f.stateFile, "{ this is: not valid json,,, }");
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Failed to read or parse state file/);
    expect(r.stderr).toMatch(/Hint:.*crash mid-write/);
  });

  it("exits 1 with a clear message when plan file does not exist", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    fs.unlinkSync(f.planFile);
    const r = run(f.planFile, f.stateFile);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Failed to read plan file/);
  });

  it("rejects invocation with missing arguments", () => {
    const r = spawnSync("bun", ["run", SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Usage:/);
  });
});

/**
 * --from-artifacts mode: recover codexReview from on-disk artifacts when
 * the JSON field was nulled (e.g. by a manual jq reset during workaround
 * relaunch). The artifacts are the ground truth; the JSON field is the
 * cached view. This pass reads ground truth back into the JSON.
 */
function runWithArtifacts(planFile: string, stateFile: string) {
  return spawnSync(
    "bun",
    ["run", SCRIPT, planFile, stateFile, "--from-artifacts"],
    { encoding: "utf8" },
  );
}

/**
 * Lay out a per-slug log dir next to the state.json. The CLI falls back
 * to the sibling-of-state-file path when the global ~/.gstack path
 * doesn't exist — this lets us test without touching $HOME.
 */
function plantArtifacts(
  stateFile: string,
  phaseNumber: string,
  opts: {
    reviewIters?: number[];
    qaIters?: number[];
    mergedVerdicts?: Record<number, string>;
  },
): string {
  const slugDir = path.join(
    path.dirname(stateFile),
    path.basename(stateFile, ".json"),
  );
  fs.mkdirSync(slugDir, { recursive: true });
  for (const k of opts.reviewIters ?? []) {
    fs.writeFileSync(
      path.join(slugDir, `phase-${phaseNumber}-review-${k}-output.md`),
      `# Codex Review iteration ${k} for phase ${phaseNumber}\n`,
    );
  }
  for (const k of opts.qaIters ?? []) {
    fs.writeFileSync(
      path.join(slugDir, `phase-${phaseNumber}-qa-${k}-output.md`),
      `# Codex QA iteration ${k} for phase ${phaseNumber}\n`,
    );
  }
  for (const [kStr, body] of Object.entries(opts.mergedVerdicts ?? {})) {
    const k = parseInt(kStr, 10);
    fs.writeFileSync(
      path.join(slugDir, `phase-${phaseNumber}-review-merged-${k}.md`),
      body,
    );
  }
  return slugDir;
}

describe("backfill-checkboxes --from-artifacts", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("derives codexReview from on-disk artifacts when state.codexReview is null", () => {
    // Phase 1 is committed with codexReview=null (the F2 investigation
    // signature). Plant a review + qa artifact pair on disk. After
    // --from-artifacts, state.phases[0].codexReview must be populated
    // with derivedFromArtifacts=true and the review-row checkbox must
    // flip in the plan.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: null,
          },
        ],
      },
    });
    cleanup = f.cleanup;
    plantArtifacts(f.stateFile, "1", {
      reviewIters: [1],
      qaIters: [1],
      mergedVerdicts: { 1: "Decision: GATE PASS\n" },
    });

    const r = runWithArtifacts(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Phase 1.*codexReview derived/);
    expect(r.stdout).toMatch(/1 codexReview field\(s\) derived from artifacts/);

    const afterState = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    expect(afterState.phases[0].codexReview).toBeDefined();
    expect(afterState.phases[0].codexReview.derivedFromArtifacts).toBe(true);
    expect(afterState.phases[0].codexReview.iterations).toBe(1);
    expect(afterState.phases[0].codexReview.finalVerdict).toBe("GATE PASS");
    expect(afterState.phases[0].codexReview.outputFilePaths).toHaveLength(2); // review + qa

    const afterPlan = fs.readFileSync(f.planFile, "utf8");
    expect(afterPlan).toContain("- [x] **Implementation**: do");
    expect(afterPlan).toContain("- [x] **Review**: rev");
  });

  it("does NOT clobber a populated codexReview (live data wins over derived data)", () => {
    // Phase 1 already has codexReview from a real loop run. Even if
    // artifacts also exist on disk, we must not overwrite the live data.
    const livePopulatedReview = {
      iterations: 3,
      finalVerdict: "GATE FAIL" as const,
      outputLogPaths: ["/live/log-1.md", "/live/log-2.md", "/live/log-3.md"],
      outputFilePaths: ["/live/out-1.md", "/live/out-2.md", "/live/out-3.md"],
    };
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: livePopulatedReview,
          },
        ],
      },
    });
    cleanup = f.cleanup;
    plantArtifacts(f.stateFile, "1", {
      reviewIters: [1],
      mergedVerdicts: { 1: "GATE PASS\n" },
    });

    const r = runWithArtifacts(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/codexReview derived/);

    const afterState = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    // Untouched: every field matches the live record.
    expect(afterState.phases[0].codexReview.iterations).toBe(3);
    expect(afterState.phases[0].codexReview.finalVerdict).toBe("GATE FAIL");
    expect(afterState.phases[0].codexReview.outputFilePaths).toHaveLength(3);
    expect(
      afterState.phases[0].codexReview.derivedFromArtifacts,
    ).toBeUndefined();
  });

  it("no-ops cleanly when codexReview is null but no artifacts exist on disk", () => {
    // The F1 investigation signature: legitimate codexReview=null
    // (the loop bailed at coverage gate before review). No artifacts on
    // disk → leave it alone.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: null,
          },
        ],
      },
    });
    cleanup = f.cleanup;
    // Deliberately do NOT plant artifacts.

    const r = runWithArtifacts(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 codexReview field\(s\) derived from artifacts/);

    const afterState = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    expect(afterState.phases[0].codexReview).toBeNull();
  });

  it("picks the LAST verdict in merged-K.md (reviewers quote prior verdicts before stating their own)", () => {
    // The realistic case: a reviewer writes "Last run was GATE FAIL,
    // this run is GATE PASS" and we must take the latter.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: null,
          },
        ],
      },
    });
    cleanup = f.cleanup;
    plantArtifacts(f.stateFile, "1", {
      reviewIters: [1],
      mergedVerdicts: {
        1: [
          "## Codex Review Merged",
          "",
          "Quoting last iteration: that ended in GATE FAIL.",
          "Now: this iteration's verdict is GATE PASS.",
          "",
        ].join("\n"),
      },
    });

    const r = runWithArtifacts(f.planFile, f.stateFile);
    expect(r.status).toBe(0);

    const afterState = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    expect(afterState.phases[0].codexReview.finalVerdict).toBe("GATE PASS");
  });

  it("sets derivedFromArtifacts=true even when no recognizable verdict appears (presence-of-review-work is the signal)", () => {
    // The merged file exists but has no GATE PASS/FAIL/TIMEOUT line.
    // We still know the review work ran. finalVerdict stays undefined,
    // but the flag is the load-bearing signal.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: null,
          },
        ],
      },
    });
    cleanup = f.cleanup;
    plantArtifacts(f.stateFile, "1", {
      reviewIters: [1],
      mergedVerdicts: {
        1: "## Merged review\n\nNo verdict line in this file.\n",
      },
    });

    const r = runWithArtifacts(f.planFile, f.stateFile);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Phase 1.*verdict-unknown/);

    const afterState = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    expect(afterState.phases[0].codexReview.derivedFromArtifacts).toBe(true);
    expect(afterState.phases[0].codexReview.finalVerdict).toBeUndefined();
    expect(afterState.phases[0].codexReview.iterations).toBe(1);
  });
});
