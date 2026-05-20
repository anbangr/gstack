import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installWrapConsole } from "../wrap-console";
import { loadPendingInvestigations } from "../halt-events";

describe("wrap-console snapshot + KNOWN_BENIGN_WARN_PATTERNS", () => {
  let tmp: string;
  let stdoutLogPath: string;
  let origHome: string | undefined;
  let uninstall: () => void;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wcs-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;

    // Build a real stdout log file so wrap-console can read its tail.
    stdoutLogPath = path.join(tmp, "agent-stdout.log");
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(`line ${i}: orchestrator output`);
    }
    fs.writeFileSync(stdoutLogPath, lines.join("\n"));

    uninstall = installWrapConsole({
      runId: "test-run",
      stateSlug: "test-slug",
      pointers: {
        stateFile: path.join(tmp, "state.json"),
        stdoutLog: stdoutLogPath,
        livingPlan: path.join(tmp, "plan.md"),
        worktreePath: tmp,
      },
      queueDir: path.join(tmp, "skill-faults"),
    });
  });
  afterEach(() => {
    uninstall();
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("T1: emitted halt event carries populated stdoutTail from configured stdoutLog", () => {
    console.warn("worktree cleanup failed for build-XYZ");
    const events = loadPendingInvestigations({
      queueDir: path.join(tmp, "skill-faults"),
    });
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.kind).toBe("SOFT_HALT_WARN");
    expect(ev.snapshot.stdoutTail).not.toBe("");
    // Should contain tail lines from the log file, not header lines
    expect(ev.snapshot.stdoutTail).toContain("line 249");
    expect(ev.snapshot.stdoutTail).not.toContain("line 0:");
  });

  test("T2: KNOWN_BENIGN_WARN_PATTERNS suppresses 'local JSON is canonical' emits", () => {
    console.warn(
      'warning: gbrain put for "build-mitosis" failed; local JSON is canonical',
    );
    const events = loadPendingInvestigations({
      queueDir: path.join(tmp, "skill-faults"),
    });
    expect(events.length).toBe(0); // suppressed
  });

  test("T3: non-matching warn pattern still emits normally", () => {
    console.warn("some unrelated warning that is not in benign patterns");
    const events = loadPendingInvestigations({
      queueDir: path.join(tmp, "skill-faults"),
    });
    expect(events.length).toBe(1);
    expect(events[0].snapshot.stdoutTail).not.toBe("");
  });
});
