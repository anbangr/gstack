import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInvestigateMode } from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-auto-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");

let stdoutBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
  fs.mkdirSync(path.join(faultsDir, "pending-investigations"), { recursive: true });
  stdoutBuf = "";
  process.stdout.write = ((chunk: any) => {
    stdoutBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stdout.write = origStdout;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("auto-detect picks most recent active run with a pending halt event", async () => {
  fs.writeFileSync(
    path.join(activeRunsDir, "run-old.json"),
    JSON.stringify({
      runId: "run-old", stateSlug: "s", repoPath: "/r", planFile: "/p",
      pid: process.pid, status: "running",
      startedAt: "2026-05-22T08:00:00.000Z",
      lastUpdatedAt: "2026-05-22T08:00:00.000Z",
      branches: [],
    }),
  );
  fs.writeFileSync(
    path.join(faultsDir, "pending-investigations", "run-old-CAT:p0:old.json"),
    JSON.stringify({
      faultId: "CAT:p0:old", runId: "run-old", stateSlug: "s",
      kind: "PHASE_FAILED", severity: "HIGH",
      timestamp: "2026-05-22T08:30:00.000Z", message: "old",
      pointers: { stateFile: "/s", stdoutLog: "/o", livingPlan: "/p", worktreePath: "/wt" },
      snapshot: { stdoutTail: "" },
    }),
  );
  fs.writeFileSync(
    path.join(activeRunsDir, "run-new.json"),
    JSON.stringify({
      runId: "run-new", stateSlug: "s", repoPath: "/r", planFile: "/p",
      pid: process.pid, status: "running",
      startedAt: "2026-05-22T10:00:00.000Z",
      lastUpdatedAt: "2026-05-22T10:00:00.000Z",
      branches: [],
    }),
  );
  fs.writeFileSync(
    path.join(faultsDir, "pending-investigations", "run-new-CAT:p1:new.json"),
    JSON.stringify({
      faultId: "CAT:p1:new", runId: "run-new", stateSlug: "s",
      kind: "PHASE_FAILED", severity: "HIGH",
      timestamp: "2026-05-22T10:15:00.000Z", message: "new",
      pointers: { stateFile: "/s", stdoutLog: "/o", livingPlan: "/p", worktreePath: "/wt" },
      snapshot: { stdoutTail: "" },
    }),
  );

  const code = await runInvestigateMode({
    faultsDir, activeRunsRegistryDir: activeRunsDir,
  });
  expect(code).toBe(0);
  const briefing = JSON.parse(
    stdoutBuf.match(/<<<GSTACK_INVESTIGATE_BRIEFING>>>\n([\s\S]+?)\n<<<END>>>/)![1],
  );
  expect(briefing.runId).toBe("run-new");
  expect(briefing.faultId).toBe("CAT:p1:new");
});
