import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordHygieneFailure,
  recordRedSpecExhausted,
  recordStallKilled,
} from "../halt-event-helpers";
import { loadPendingInvestigations, severityFor } from "../halt-events";

function freshState() {
  return {
    slug: "s1",
    phases: [
      { index: 0, number: 1, status: "running" } as any,
      { index: 1, number: 2, status: "running" } as any,
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

describe("severityFor — new kinds", () => {
  test("HYGIENE_FAIL is HIGH", () => {
    expect(severityFor("HYGIENE_FAIL")).toBe("HIGH");
  });
  test("RED_SPEC_EXHAUSTED is HIGH", () => {
    expect(severityFor("RED_SPEC_EXHAUSTED")).toBe("HIGH");
  });
});

describe("recordHygieneFailure", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hf-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits HYGIENE_FAIL with role + evidence in message", () => {
    const state = freshState();
    recordHygieneFailure(
      state,
      0,
      "primary-impl",
      "did not create a new commit",
      {
        runId: "r1",
        stateSlug: "s1",
        pointers: fixturePaths(tmp),
        queueDir: tmp,
      },
    );
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("HYGIENE_FAIL");
    expect(pending[0].severity).toBe("HIGH");
    expect(pending[0].message).toContain("primary-impl");
    expect(pending[0].message).toContain("did not create a new commit");
  });

  test("HYGIENE_FAIL is distinct from RETRY_CAP_HIT in faultId", () => {
    const state = freshState();
    recordHygieneFailure(state, 0, "primary-impl", "hygiene failed", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending[0].faultId.startsWith("HYGIENE_FAIL:")).toBe(true);
  });
});

describe("recordRedSpecExhausted", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rse-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits RED_SPEC_EXHAUSTED with attempts + testCmd in message", () => {
    const state = freshState();
    recordRedSpecExhausted(state, 0, 3, "npm test", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("RED_SPEC_EXHAUSTED");
    expect(pending[0].severity).toBe("HIGH");
    expect(pending[0].message).toContain("after 3 attempts");
    expect(pending[0].message).toContain("npm test");
    // Remediation hint surfaces the testCmd annotation path.
    expect(pending[0].message).toContain("<!-- testCmd: -->");
  });
});

describe("recordStallKilled", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits STALL_KILLED with role + silenceMs + killReason on snapshot", () => {
    const state = freshState();
    recordStallKilled(state, 0, "primary-impl", 750247, 0, "stall", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("STALL_KILLED");
    expect(pending[0].severity).toBe("HIGH");
    expect(pending[0].message).toContain("primary-impl");
    expect(pending[0].message).toContain("750247ms silence");
    expect(pending[0].message).toContain("0 stdout bytes");
    // killReason propagates into snapshot for the watchdog discriminator.
    expect(pending[0].snapshot.killReason).toBe("stall");
  });

  test("startup_hang killReason flows through unchanged", () => {
    const state = freshState();
    recordStallKilled(state, 1, "test-spec", 120000, 0, "startup_hang", {
      runId: "r1",
      stateSlug: "s1",
      pointers: fixturePaths(tmp),
      queueDir: tmp,
    });
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending[0].snapshot.killReason).toBe("startup_hang");
  });
});
