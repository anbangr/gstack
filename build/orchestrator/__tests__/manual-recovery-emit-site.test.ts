import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emitManualRecoveryInvoked } from "../halt-event-helpers";
import { loadPendingInvestigations } from "../halt-events";

describe("emitManualRecoveryInvoked helper", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mri-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("T5: helper always sets investigate:false on the emitted event", () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitManualRecoveryInvoked({
      runId: "drain-faults",
      stateSlug: "drain-faults-no-plan",
      message: "drain-faults subcommand invoked (queue)",
      pointers: {
        stateFile: "",
        stdoutLog: "",
        livingPlan: "",
        worktreePath: tmp,
      },
      queueDir: skillFaults,
    });
    const events = loadPendingInvestigations({ queueDir: skillFaults });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("MANUAL_RECOVERY_INVOKED");
    expect(events[0].investigate).toBe(false);
    expect(events[0].severity).toBe("HIGH");
  });

  test("T6: helper preserves runId / stateSlug / message / pointers", () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitManualRecoveryInvoked({
      runId: "mark-shipped",
      stateSlug: "build-x",
      message: "mark-shipped subcommand invoked for feature 3 (PR #42)",
      pointers: {
        stateFile: "/abs/state.json",
        stdoutLog: "/abs/stdout.log",
        livingPlan: "/abs/plan.md",
        worktreePath: "/abs/worktree",
      },
      queueDir: skillFaults,
    });
    const events = loadPendingInvestigations({ queueDir: skillFaults });
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.runId).toBe("mark-shipped");
    expect(ev.stateSlug).toBe("build-x");
    expect(ev.message).toContain("mark-shipped subcommand invoked");
    expect(ev.pointers.livingPlan).toBe("/abs/plan.md");
  });

  test("T7: all three manual-recovery cli sites route through the helper (static check)", () => {
    // Goal: cli.ts must not contain any raw `kind: "MANUAL_RECOVERY_INVOKED"`
    // emit blocks after Phase 2 — every site must go through the helper so the
    // investigate:false flag is set in exactly one place. This guards against
    // future contributors adding a new manual-recovery site and forgetting the
    // flag.
    const cliPath = path.resolve(__dirname, "..", "cli.ts");
    const cli = fs.readFileSync(cliPath, "utf8");

    // Three known manual-recovery emit messages must exist (this confirms the
    // sites weren't accidentally deleted during the refactor).
    expect(cli).toContain("drain-faults subcommand invoked");
    expect(cli).toContain("mark-shipped subcommand invoked");
    expect(cli).toContain("--mark-phase-committed invoked");

    // No raw emitHaltEvent block in cli.ts should have kind: "MANUAL_RECOVERY_INVOKED".
    // The helper is the single source of truth. severityFor("MANUAL_RECOVERY_INVOKED")
    // calls inside the helper file are fine; this check is scoped to cli.ts.
    expect(cli).not.toContain('kind: "MANUAL_RECOVERY_INVOKED"');
  });
});
