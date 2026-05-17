import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runMarkShipped } from "../mark-shipped";
import { saveState, deriveStateSlug } from "../state";
import { writeActiveRunRecord } from "../active-runs";
import type { BuildState, FeatureState, PhaseState } from "../types";

// Test fixtures ---------------------------------------------------------------

function makeFeature(overrides: Partial<FeatureState> = {}): FeatureState {
  return {
    index: 0,
    number: "1",
    name: "Test Feature",
    phaseIndexes: [0],
    status: "shipping",
    branch: "feat/test-branch",
    ...overrides,
  };
}

function makePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "Test Phase",
    status: "review_clean",
    ...overrides,
  };
}

function makeState(args: {
  planFile: string;
  features: FeatureState[];
  phases?: PhaseState[];
}): BuildState {
  const slug = deriveStateSlug(args.planFile);
  return {
    planFile: args.planFile,
    planBasename: path.basename(args.planFile),
    slug,
    branch: "main",
    startedAt: "2026-05-17T00:00:00.000Z",
    lastUpdatedAt: "2026-05-17T00:00:00.000Z",
    currentPhaseIndex: 0,
    currentFeatureIndex: 0,
    phases: args.phases ?? [makePhase()],
    features: args.features,
    completed: false,
  } as unknown as BuildState;
}

// In-memory loggers so we can assert on output. ------------------------------

function makeLoggers(): {
  logs: string[];
  errs: string[];
  log: (m: string) => void;
  err: (m: string) => void;
} {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    logs,
    errs,
    log: (m) => logs.push(m),
    err: (m) => errs.push(m),
  };
}

// gh stubs --------------------------------------------------------------------

function ghMergedPRStub(prByBranch: Record<string, number | null>) {
  return (_cwd: string, branch: string) => prByBranch[branch] ?? null;
}

function ghReadInfoStub(
  infoByPr: Record<number, { mergeSha: string; mergedAt: string } | null>,
) {
  return (_cwd: string, pr: number) => infoByPr[pr] ?? null;
}

// Suite -----------------------------------------------------------------------

describe("runMarkShipped", () => {
  let tmpStateDir: string;
  let tmpRegistry: string;
  let tmpPlanDir: string;
  let planFile: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-state-"));
    tmpRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "ms-registry-"));
    tmpPlanDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-plan-"));
    planFile = path.join(tmpPlanDir, "test-plan.md");
    fs.writeFileSync(planFile, "# Test plan\n");
    savedStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
  });

  afterEach(() => {
    if (savedStateDir !== undefined) {
      process.env.GSTACK_BUILD_STATE_DIR = savedStateDir;
    } else {
      delete process.env.GSTACK_BUILD_STATE_DIR;
    }
    for (const d of [tmpStateDir, tmpRegistry, tmpPlanDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("happy path: writes canonical terminal shape and saves state", async () => {
    const state = makeState({
      planFile,
      features: [makeFeature({ status: "shipping" })],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        findMergedPRForBranch: ghMergedPRStub({ "feat/test-branch": 42 }),
        readMergedPRInfo: ghReadInfoStub({
          42: { mergeSha: "abc1234567890def", mergedAt: "2026-05-17T01:00:00Z" },
        }),
        now: () => new Date("2026-05-17T02:00:00.000Z"),
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.featureIndex).toBe(0);
    expect(result.noop).toBe(false);

    const slug = deriveStateSlug(planFile);
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, `${slug}.json`), "utf8"),
    ) as BuildState;
    const f = written.features![0];
    expect(f.status).toBe("committed");
    expect(f.completedAt).toBe("2026-05-17T02:00:00.000Z");
    expect(f.shippedAt).toBe("2026-05-17T02:00:00.000Z");
    expect(f.prNumber).toBe(42);
    expect(f.mergeSha).toBe("abc1234567890def");

    // Phase should also be terminal.
    expect(written.phases![0].status).toBe("committed");

    // No errors should have fired.
    expect(loggers.errs.length).toBe(0);
    // Success message should reference the PR + shortened sha.
    expect(loggers.logs.some((m) => m.includes("PR #42"))).toBe(true);
  });

  it("refuses when an active orchestrator owns this plan", async () => {
    const state = makeState({
      planFile,
      features: [makeFeature({ status: "shipping" })],
    });
    saveState(state, { noGbrain: true });

    // Plant a live active-run record pointing at our own PID (always alive).
    const slug = deriveStateSlug(planFile);
    writeActiveRunRecord(tmpRegistry, {
      runId: "live-run-1",
      stateSlug: slug,
      repoPath: tmpPlanDir,
      planFile,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-17T00:00:00Z",
      lastUpdatedAt: "2026-05-17T00:00:00Z",
      branches: ["feat/test-branch"],
    });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        findMergedPRForBranch: () => 42,
        readMergedPRInfo: () => ({
          mergeSha: "abc",
          mergedAt: "2026-05-17T01:00:00Z",
        }),
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(3);
    expect(result.featureIndex).toBe(-1);
    expect(loggers.errs.some((m) => m.includes(String(process.pid)))).toBe(true);
    expect(loggers.errs.some((m) => m.includes("live-run-1"))).toBe(true);

    // State must NOT have been mutated.
    const after = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, `${slug}.json`), "utf8"),
    ) as BuildState;
    expect(after.features![0].status).toBe("shipping");
  });

  it("refuses when PR is not merged", async () => {
    const state = makeState({
      planFile,
      features: [makeFeature({ status: "shipping" })],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        pr: 42,
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        // gh pr view returns null (state != MERGED) → resolver returns null.
        readMergedPRInfo: () => null,
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(4);
    expect(loggers.errs.some((m) => m.includes("not merged"))).toBe(true);

    const slug = deriveStateSlug(planFile);
    const after = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, `${slug}.json`), "utf8"),
    ) as BuildState;
    expect(after.features![0].status).toBe("shipping");
  });

  it("auto-resolves --pr from gh pr list when omitted", async () => {
    const state = makeState({
      planFile,
      features: [makeFeature({ status: "shipping" })],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        findMergedPRForBranch: ghMergedPRStub({ "feat/test-branch": 99 }),
        readMergedPRInfo: ghReadInfoStub({
          99: { mergeSha: "deadbeef", mergedAt: "2026-05-17T01:00:00Z" },
        }),
        now: () => new Date("2026-05-17T02:00:00.000Z"),
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(loggers.logs.some((m) => m.includes("PR #99"))).toBe(true);

    const slug = deriveStateSlug(planFile);
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, `${slug}.json`), "utf8"),
    ) as BuildState;
    expect(written.features![0].prNumber).toBe(99);
  });

  it("refuses on --merge-sha mismatch", async () => {
    const state = makeState({
      planFile,
      features: [makeFeature({ status: "shipping" })],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        pr: 42,
        mergeSha: "operator-typo-sha",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        readMergedPRInfo: ghReadInfoStub({
          42: { mergeSha: "real-merge-sha", mergedAt: "2026-05-17T01:00:00Z" },
        }),
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(5);
    expect(
      loggers.errs.some((m) => m.includes("operator-typo-sha")),
    ).toBe(true);
    expect(loggers.errs.some((m) => m.includes("real-merge-sha"))).toBe(true);

    const slug = deriveStateSlug(planFile);
    const after = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, `${slug}.json`), "utf8"),
    ) as BuildState;
    expect(after.features![0].status).toBe("shipping");
  });

  it("no-op when feature is already terminal (committed + completedAt)", async () => {
    const state = makeState({
      planFile,
      features: [
        makeFeature({
          status: "committed",
          completedAt: "2026-05-17T00:00:00Z",
          prNumber: 7,
          mergeSha: "earlier-sha",
        }),
      ],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    let infoCalls = 0;
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        findMergedPRForBranch: () => {
          throw new Error("should not call gh when already terminal");
        },
        readMergedPRInfo: () => {
          infoCalls++;
          return null;
        },
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.noop).toBe(true);
    expect(infoCalls).toBe(0);
    expect(
      loggers.logs.some((m) => m.includes("already marked shipped")),
    ).toBe(true);
  });

  it("regression: screenshot scenario — shipping + prNumber but no completedAt", async () => {
    // Reproduces the exact state shape from the user's screenshot:
    // status="shipping", prNumber set (manual hand-edit), no completedAt
    // and no shippedAt. Before this fix, the orchestrator's manual-edit
    // detector flipped it back to phases_done and re-shipped F1.
    const state = makeState({
      planFile,
      features: [
        makeFeature({
          status: "shipping",
          prNumber: 100,
          // shippedAt missing, completedAt missing → manual hand-edit
          branch: "feat/polis-mesh-lane-b",
        }),
        makeFeature({
          index: 1,
          number: "2",
          name: "Feature 2",
          status: "pending",
          phaseIndexes: [1],
          branch: "feat/polis-mesh-lane-d",
        }),
      ],
      phases: [
        makePhase({ index: 0, status: "review_clean" }),
        makePhase({ index: 1, number: "2", status: "pending" }),
      ],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        findMergedPRForBranch: ghMergedPRStub({
          "feat/polis-mesh-lane-b": 100,
        }),
        readMergedPRInfo: ghReadInfoStub({
          100: {
            mergeSha: "9b0b65aef00d",
            mergedAt: "2026-05-17T10:00:00Z",
          },
        }),
        now: () => new Date("2026-05-17T11:00:00.000Z"),
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(0);
    const slug = deriveStateSlug(planFile);
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, `${slug}.json`), "utf8"),
    ) as BuildState;
    const f1 = written.features![0];

    // The canonical shape that isFeatureTerminal trusts:
    expect(f1.status).toBe("committed");
    expect(f1.completedAt).toBe("2026-05-17T11:00:00.000Z");
    expect(f1.shippedAt).toBe("2026-05-17T11:00:00.000Z");
    expect(f1.prNumber).toBe(100);
    expect(f1.mergeSha).toBe("9b0b65aef00d");

    // F2 must NOT have been touched.
    expect(written.features![1].status).toBe("pending");

    // currentFeatureIndex MUST NOT have been advanced — that's the
    // orchestrator's job. We just normalize state.
    expect(written.currentFeatureIndex).toBe(0);

    // Now exercise the actual anti-tamper assertion: the detector at
    // cli.ts:7697 fires when status==="committed" but completedAt missing.
    // Since we set both, the detector should NOT fire — replicated here
    // as the inverse check.
    expect(
      f1.status === "committed" && !f1.completedAt,
    ).toBe(false);
  });

  it("errors clearly when feature number is not in the plan", async () => {
    const state = makeState({
      planFile,
      features: [makeFeature({ status: "shipping" })],
    });
    saveState(state, { noGbrain: true });

    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "99",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(loggers.errs.some((m) => m.includes('"99"'))).toBe(true);
    expect(loggers.errs.some((m) => m.includes("Known feature numbers"))).toBe(
      true,
    );
  });

  it("errors clearly when state file is missing entirely", async () => {
    // Don't save state — runMarkShipped should refuse cleanly.
    const loggers = makeLoggers();
    const result = await runMarkShipped(
      {
        planFile,
        feature: "1",
        noGbrain: true,
        activeRunRegistry: tmpRegistry,
      },
      {
        log: loggers.log,
        err: loggers.err,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(loggers.errs.some((m) => m.includes("no build state"))).toBe(true);
  });
});
