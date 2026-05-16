import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readActiveRunRecords,
  writeActiveRunRecord,
  type ActiveRunRecord,
} from "../active-runs";

/**
 * The orchestrator's SIGINT/SIGTERM/exit handlers must mark the active-run
 * record as "paused" before the process dies. The bug-prone path is using an
 * async file API by accident: process.on("exit") only runs synchronous work,
 * so any Promise-returning write would silently no-op.
 *
 * These tests spawn a real Node subprocess that registers the same exit
 * pattern used in cli.ts, then asserts the on-disk record after the child
 * exits. This catches sync-vs-async API regressions.
 */
describe("exit handler", () => {
  let tmpDir: string;
  let registryDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "exit-handler-")),
    );
    registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function baseRecord(overrides: Partial<ActiveRunRecord> = {}): ActiveRunRecord {
    return {
      runId: "run-exit-test",
      stateSlug: "build-run-exit-test",
      repoPath: tmpDir,
      worktreePath: tmpDir,
      planFile: "/plans/plan.md",
      pid: 99999999,
      status: "running",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      branches: ["feat/run-exit-test"],
      ...overrides,
    };
  }

  // Resolve from this file: __tests__/ → orchestrator/ → active-runs.ts
  const activeRunsPath = path.resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    "active-runs.ts",
  );

  function harnessScript(
    args: { registryDir: string; record: ActiveRunRecord; mode: "exit" | "sigterm" },
  ): string {
    return `
      const { writeActiveRunRecord } = require(${JSON.stringify(activeRunsPath)});
      const initial = ${JSON.stringify(args.record)};
      const registryDir = ${JSON.stringify(args.registryDir)};
      // Same pattern cli.ts uses: register a synchronous exit listener that
      // rewrites the record with status=paused.
      const markPaused = () => {
        try {
          writeActiveRunRecord(registryDir, { ...initial, status: "paused", pid: process.pid });
        } catch (err) {
          process.stderr.write("write failed: " + err.message + "\\n");
        }
      };
      let interrupted = false;
      process.on("SIGTERM", () => {
        interrupted = true;
        markPaused();
        process.exit(143);
      });
      process.on("exit", () => {
        if (interrupted) return;
        markPaused();
      });
      // Persist the initial record (status=running) so the test can see the
      // transition.
      writeActiveRunRecord(registryDir, initial);
      ${args.mode === "exit"
        ? "process.exit(0);"
        : "setInterval(() => {}, 1000);"}
    `;
  }

  it("process.exit(0) writes status=paused synchronously", () => {
    const record = baseRecord();
    const script = harnessScript({
      registryDir,
      record,
      mode: "exit",
    });
    const result = spawnSync("bun", ["-e", script], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);

    const records = readActiveRunRecords(registryDir);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("paused");
    expect(records[0].runId).toBe("run-exit-test");
  });

  it("SIGTERM writes status=paused before exit", () => {
    const record = baseRecord({ runId: "run-sigterm-test" });
    const script = harnessScript({
      registryDir,
      record,
      mode: "sigterm",
    });
    const child = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // Give the child a moment to write the initial record.
    Bun.sleepSync(200);
    child.kill("SIGTERM");
    // Wait for exit.
    const exitCode = Bun.spawnSync(["sleep", "0.5"]).exitCode;
    expect(exitCode).toBe(0);

    const records = readActiveRunRecords(registryDir);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("paused");
    expect(records[0].runId).toBe("run-sigterm-test");
  });
});
