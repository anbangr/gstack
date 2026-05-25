import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultInboxDir, writeBugReport } from "../investigate-report-writer";
import type { InvestigationContext } from "../investigate-context";
import type { InvestigationReport } from "../investigator-dispatch";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-bug-${process.pid}`);
const inboxDir = path.join(tmpRoot, "inbox");

function makeCtx(
  severity: InvestigationContext["severity"],
  source: InvestigationContext["source"] = "auto-detect",
): InvestigationContext {
  return {
    runId: "run-X",
    faultId: "CAT:p0:abc",
    severity,
    source,
    haltEvent: null,
    statePath: "/tmp/s.json",
    stdoutLogPath: "/tmp/o.log",
    livingPlanPath: "/tmp/p.md",
    worktreePath: "/tmp/wt",
    symptoms: null,
  };
}

const report: InvestigationReport = {
  faultId: "CAT:p0:abc",
  outcome: "root-cause-identified",
  rootCause: "Plan lacks acceptance criteria; codex loops forever.",
  evidence: ["build/orchestrator/cli.ts:123"],
  proposedFix: {
    options: [
      {
        label: "Add checklist",
        description: "Prepend it",
        blast_radius: "narrow",
      },
    ],
  },
  learnedPatternProposal: null,
};

beforeEach(() => {
  fs.mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeBugReport severity gating", () => {
  test("HIGH writes the bug report", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
    expect(result.path).not.toBeNull();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(result.path).toContain("BUGREPORT-2026-05-22-build-cat-");
  });

  test("CRITICAL writes the bug report", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("CRITICAL"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
  });

  test("MEDIUM skips bug report (returns skipped=true)", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("MEDIUM"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(true);
    expect(result.path).toBeNull();
  });

  test("symptoms-only context skips even when severity HIGH", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH", "symptoms"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(true);
  });

  test("noInbox=true skips even for CRITICAL", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("CRITICAL"),
      inboxDir,
      noInbox: true,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(true);
  });

  test("collision: second write gets -2 suffix", () => {
    const first = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    const second = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir,
      dateOverride: "2026-05-22",
    });
    expect(first.path).not.toBe(second.path);
    expect(second.path).toMatch(/-2\.md$/);
  });
});

describe("writeBugReport inbox directory resolution", () => {
  const savedHome = process.env.GSTACK_HOME;
  const savedInbox = process.env.GSTACK_INBOX_DIR;
  const savedCwd = process.cwd();
  const fakeHome = path.join(tmpRoot, "fake-gstack-home");
  const cwdSandbox = path.join(tmpRoot, "cwd-sandbox");

  beforeEach(() => {
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(cwdSandbox, { recursive: true });
    process.env.GSTACK_HOME = fakeHome;
    delete process.env.GSTACK_INBOX_DIR;
    process.chdir(cwdSandbox);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = savedHome;
    if (savedInbox === undefined) delete process.env.GSTACK_INBOX_DIR;
    else process.env.GSTACK_INBOX_DIR = savedInbox;
  });

  test("defaultInboxDir() returns ${GSTACK_HOME}/skill-faults/inbox", () => {
    expect(defaultInboxDir()).toBe(
      path.join(fakeHome, "skill-faults", "inbox"),
    );
  });

  test("default never resolves to <cwd>/inbox", () => {
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
    expect(result.path).not.toBeNull();
    expect(result.path!.startsWith(cwdSandbox)).toBe(false);
    expect(fs.existsSync(path.join(cwdSandbox, "inbox"))).toBe(false);
    expect(
      result.path!.startsWith(path.join(fakeHome, "skill-faults", "inbox")),
    ).toBe(true);
  });

  test("GSTACK_INBOX_DIR overrides the GSTACK_HOME default", () => {
    const envInbox = path.join(tmpRoot, "env-override-inbox");
    process.env.GSTACK_INBOX_DIR = envInbox;
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
    expect(result.path!.startsWith(envInbox)).toBe(true);
  });

  test("args.inboxDir wins over GSTACK_INBOX_DIR and the default", () => {
    const envInbox = path.join(tmpRoot, "env-loses");
    const argInbox = path.join(tmpRoot, "arg-wins");
    process.env.GSTACK_INBOX_DIR = envInbox;
    const result = writeBugReport({
      report,
      ctx: makeCtx("HIGH"),
      inboxDir: argInbox,
      dateOverride: "2026-05-22",
    });
    expect(result.skipped).toBe(false);
    expect(result.path!.startsWith(argInbox)).toBe(true);
    expect(fs.existsSync(envInbox)).toBe(false);
  });
});
