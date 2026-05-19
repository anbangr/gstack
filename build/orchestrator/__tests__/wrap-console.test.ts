import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installWrapConsole, classifyConsoleLine } from "../wrap-console";
import { loadPendingInvestigations } from "../halt-events";

describe("classifyConsoleLine", () => {
  test("'Re-processing the feature' → SILENT_STATE_MUTATION (HIGH)", () => {
    const c = classifyConsoleLine("warn", "Re-processing the feature");
    expect(c.kind).toBe("SILENT_STATE_MUTATION");
    expect(c.severity).toBe("HIGH");
  });
  test("'worktree cleanup failed' → SOFT_HALT_WARN (LOW)", () => {
    const c = classifyConsoleLine("warn", "worktree cleanup failed for run X");
    expect(c.kind).toBe("SOFT_HALT_WARN");
    expect(c.severity).toBe("LOW");
  });
  test("'PR check unsettled' → SOFT_HALT_WARN", () => {
    expect(classifyConsoleLine("warn", "PR check unsettled").kind).toBe(
      "SOFT_HALT_WARN",
    );
  });
  test("'PR not yet mergeable' → SOFT_HALT_WARN", () => {
    expect(classifyConsoleLine("warn", "PR not yet mergeable").kind).toBe(
      "SOFT_HALT_WARN",
    );
  });
  test("'branch deletion failed' → SOFT_HALT_WARN", () => {
    expect(
      classifyConsoleLine("warn", "branch deletion failed for X").kind,
    ).toBe("SOFT_HALT_WARN");
  });
  test("'✗ ' error sigil → SOFT_HALT_ERROR (MEDIUM)", () => {
    const c = classifyConsoleLine("error", "✗ feature failed: blah");
    expect(c.kind).toBe("SOFT_HALT_ERROR");
    expect(c.severity).toBe("MEDIUM");
  });
  test("unmatched warn → SOFT_HALT_WARN LOW", () => {
    const c = classifyConsoleLine("warn", "random log line");
    expect(c.kind).toBe("SOFT_HALT_WARN");
    expect(c.severity).toBe("LOW");
  });
  test("unmatched error → SOFT_HALT_ERROR MEDIUM", () => {
    const c = classifyConsoleLine("error", "random error line");
    expect(c.kind).toBe("SOFT_HALT_ERROR");
    expect(c.severity).toBe("MEDIUM");
  });
});

describe("installWrapConsole", () => {
  let tmp: string;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wc-"));
    origWarn = console.warn;
    origError = console.error;
  });
  afterEach(() => {
    console.warn = origWarn;
    console.error = origError;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits halt event AND calls original console.warn", () => {
    let captured = "";
    console.warn = (msg: string) => {
      captured = msg;
    };
    const uninstall = installWrapConsole({
      runId: "r1",
      stateSlug: "s1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      queueDir: tmp,
    });
    console.warn("worktree cleanup failed");
    expect(captured).toBe("worktree cleanup failed");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("SOFT_HALT_WARN");
    uninstall();
  });

  test("error path emits and calls through", () => {
    let captured = "";
    console.error = (msg: string) => {
      captured = msg;
    };
    const uninstall = installWrapConsole({
      runId: "r1",
      stateSlug: "s1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      queueDir: tmp,
    });
    console.error("✗ feature failed: blah");
    expect(captured).toBe("✗ feature failed: blah");
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("SOFT_HALT_ERROR");
    expect(pending[0].severity).toBe("MEDIUM");
    uninstall();
  });

  test("env-gated off when GSTACK_HALT_EVENTS_OFF=1", () => {
    const orig = process.env.GSTACK_HALT_EVENTS_OFF;
    process.env.GSTACK_HALT_EVENTS_OFF = "1";
    try {
      const uninstall = installWrapConsole({
        runId: "r1",
        stateSlug: "s1",
        pointers: {
          stateFile: "/x",
          stdoutLog: "/x",
          livingPlan: "/x",
          worktreePath: "/x",
        },
        queueDir: tmp,
      });
      console.warn("any message");
      const pending = loadPendingInvestigations({ queueDir: tmp });
      expect(pending.length).toBe(0);
      uninstall();
    } finally {
      if (orig === undefined) delete process.env.GSTACK_HALT_EVENTS_OFF;
      else process.env.GSTACK_HALT_EVENTS_OFF = orig;
    }
  });

  test("uninstall restores original console functions", () => {
    const beforeWarn = console.warn;
    const beforeError = console.error;
    const uninstall = installWrapConsole({
      runId: "r1",
      stateSlug: "s1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      queueDir: tmp,
    });
    // After install, console.warn should be wrapped (not equal)
    expect(console.warn).not.toBe(beforeWarn);
    uninstall();
    // After uninstall, original is restored
    expect(console.warn).toBe(beforeWarn);
    expect(console.error).toBe(beforeError);
  });

  test("Re-processing dedupes with SILENT_STATE_MUTATION kind (not SOFT_HALT_WARN)", () => {
    console.warn = () => {}; // silence test output
    const uninstall = installWrapConsole({
      runId: "r1",
      stateSlug: "s1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      queueDir: tmp,
    });
    console.warn(
      '⚠ Feature 3 status is "committed" — Re-processing the feature so the pipeline runs.',
    );
    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("SILENT_STATE_MUTATION");
    uninstall();
  });

  test("survives emitHaltEvent errors without crashing console.warn", () => {
    // Force a write failure by pointing at a path that can't be a dir
    fs.writeFileSync(path.join(tmp, "blocker"), "");
    let captured = "";
    console.warn = (msg: string) => {
      captured = msg;
    };
    const uninstall = installWrapConsole({
      runId: "r1",
      stateSlug: "s1",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      queueDir: path.join(tmp, "blocker"), // a file, not a dir — mkdir will fail
    });
    // Should NOT throw even though emit will fail internally
    console.warn("anything");
    expect(captured).toBe("anything");
    uninstall();
  });
});
