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
    features: [{ number: "1", status: "running" } as any],
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
    expect(state.phases[0].error).toBe("spec-flip exploded");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("PHASE_FAILED");
    expect(pending[0].severity).toBe("CRITICAL");
  });
});

describe("markFeatureFailed", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hh-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("sets feature status to failed AND emits FEATURE_FAILED", () => {
    const state = freshState();
    markFeatureFailed(state, 0, "ship+land+verify failed", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    expect(state.features[0].status).toBe("failed");
    expect(state.features[0].error).toBe("ship+land+verify failed");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending[0].kind).toBe("FEATURE_FAILED");
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
