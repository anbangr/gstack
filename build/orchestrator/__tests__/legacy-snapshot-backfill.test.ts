import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "gstack-upgrade",
  "scripts",
  "backfill-halt-snapshots.ts",
);

// Best-effort backfill: rows in ~/.gstack/skill-faults/pending-investigations/
// (or processed/) that were filed BEFORE this PR carry empty stdoutTail.
// The backfill walks each row, and if its pointers.stdoutLog points to an
// existing file, reads the last 200 lines and writes them into
// snapshot.stdoutTail. Idempotent: rows that already carry a non-empty
// stdoutTail are left alone.

describe("legacy snapshot backfill", () => {
  let tmp: string;
  let pendingDir: string;
  let logPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsb-"));
    pendingDir = path.join(tmp, "skill-faults", "pending-investigations");
    fs.mkdirSync(pendingDir, { recursive: true });
    // Create a real stdout log we can backfill from.
    logPath = path.join(tmp, "agent-stdout.log");
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(`line ${i}: orchestrator output`);
    fs.writeFileSync(logPath, lines.join("\n"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeRow = (name: string, content: object) => {
    fs.writeFileSync(path.join(pendingDir, name), JSON.stringify(content, null, 2));
  };

  const runBackfill = (): { status: number; stdout: string; stderr: string } => {
    const res = spawnSync("bun", [SCRIPT_PATH], {
      env: { ...process.env, GSTACK_HOME: tmp },
      encoding: "utf8",
    });
    return {
      status: res.status ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  };

  test("T_LBF1: empty stdoutTail with findable stdoutLog gets backfilled", () => {
    writeRow("agnt2-prototype-SOFT_HALT_WARN:all:abcd1234.json", {
      faultId: "SOFT_HALT_WARN:all:abcd1234",
      runId: "agnt2-prototype",
      stateSlug: "agnt2-prototype",
      kind: "SOFT_HALT_WARN",
      severity: "LOW",
      timestamp: "2026-05-19T00:00:00.000Z",
      message: "test warning",
      pointers: {
        stateFile: "",
        stdoutLog: logPath,
        livingPlan: "",
        worktreePath: tmp,
      },
      snapshot: { stdoutTail: "" },
    });
    const res = runBackfill();
    expect(res.status).toBe(0);
    const updated = JSON.parse(
      fs.readFileSync(
        path.join(pendingDir, "agnt2-prototype-SOFT_HALT_WARN:all:abcd1234.json"),
        "utf8",
      ),
    );
    expect(updated.snapshot.stdoutTail).not.toBe("");
    expect(updated.snapshot.stdoutTail).toContain("line 249");
    // Should NOT contain head lines (only the tail).
    expect(updated.snapshot.stdoutTail).not.toContain("line 0:");
  });

  test("T_LBF2: missing stdoutLog file leaves row untouched, no crash", () => {
    writeRow("missing-SOFT_HALT_WARN:all:missing.json", {
      faultId: "SOFT_HALT_WARN:all:missing",
      runId: "missing-run",
      stateSlug: "missing-run",
      kind: "SOFT_HALT_WARN",
      severity: "LOW",
      timestamp: "2026-05-19T00:00:00.000Z",
      message: "missing log",
      pointers: {
        stateFile: "",
        stdoutLog: "/nonexistent/path/agent-stdout.log",
        livingPlan: "",
        worktreePath: tmp,
      },
      snapshot: { stdoutTail: "" },
    });
    const res = runBackfill();
    expect(res.status).toBe(0);
    const updated = JSON.parse(
      fs.readFileSync(
        path.join(pendingDir, "missing-SOFT_HALT_WARN:all:missing.json"),
        "utf8",
      ),
    );
    expect(updated.snapshot.stdoutTail).toBe("");
  });

  test("T_LBF3: row with non-empty stdoutTail is left alone (idempotent)", () => {
    writeRow("already-SOFT_HALT_WARN:all:already.json", {
      faultId: "SOFT_HALT_WARN:all:already",
      runId: "already-run",
      stateSlug: "already-run",
      kind: "SOFT_HALT_WARN",
      severity: "LOW",
      timestamp: "2026-05-19T00:00:00.000Z",
      message: "already populated",
      pointers: {
        stateFile: "",
        stdoutLog: logPath,
        livingPlan: "",
        worktreePath: tmp,
      },
      snapshot: { stdoutTail: "pre-existing content — must not overwrite" },
    });
    const res = runBackfill();
    expect(res.status).toBe(0);
    const updated = JSON.parse(
      fs.readFileSync(
        path.join(pendingDir, "already-SOFT_HALT_WARN:all:already.json"),
        "utf8",
      ),
    );
    expect(updated.snapshot.stdoutTail).toBe(
      "pre-existing content — must not overwrite",
    );
  });

  test("T_LBF4: RESOLVED-shape rows in the dir are skipped (no snapshot field)", () => {
    fs.writeFileSync(
      path.join(pendingDir, "x-RESOLVED-y.json"),
      JSON.stringify({
        event: "SKILL_FAULT_RESOLVED",
        timestamp: "2026-05-20T00:00:00.000Z",
        runId: "x",
        faultId: "y",
      }),
    );
    const res = runBackfill();
    expect(res.status).toBe(0);
    // Resolved row unchanged
    const r = JSON.parse(
      fs.readFileSync(path.join(pendingDir, "x-RESOLVED-y.json"), "utf8"),
    );
    expect(r.event).toBe("SKILL_FAULT_RESOLVED");
    expect(r.snapshot).toBeUndefined();
  });
});
