import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readActiveRunRecords } from "../active-runs";
import { sweepOrphans } from "../cli";

// The build/SKILL.md.tmpl preflight block writes an ActiveRunRecord-shaped
// JSON via a jq snippet so a concurrent gstack-build sweep can't reap the
// freshly-created worktree as a "Shape Z" orphan. Schema drift in
// active-runs.ts would silently invalidate those records — this test pins
// the round-trip.

function whichJq(): string | null {
  const r = spawnSync("which", ["jq"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

const JQ = whichJq();

function runPreflightJq(opts: {
  runId: string;
  stateSlug: string;
  repoPath: string;
  worktreePath: string;
  planFile: string;
  branchPrefix: string;
  firstBranch: string;
  pid: number;
  iso: string;
}): string {
  // Mirror of the jq -n snippet in build/SKILL.md.tmpl.
  const r = spawnSync(
    "jq",
    [
      "-n",
      "--arg",
      "runId",
      opts.runId,
      "--arg",
      "stateSlug",
      opts.stateSlug,
      "--arg",
      "repoPath",
      opts.repoPath,
      "--arg",
      "worktreePath",
      opts.worktreePath,
      "--arg",
      "planFile",
      opts.planFile,
      "--arg",
      "branchPrefix",
      opts.branchPrefix,
      "--arg",
      "firstBranch",
      opts.firstBranch,
      "--argjson",
      "pid",
      String(opts.pid),
      "--arg",
      "startedAt",
      opts.iso,
      "--arg",
      "lastUpdatedAt",
      opts.iso,
      `{
         runId: $runId,
         stateSlug: $stateSlug,
         repoPath: $repoPath,
         worktreePath: $worktreePath,
         baseProjectRoot: $repoPath,
         planFile: $planFile,
         branchPrefix: $branchPrefix,
         pid: $pid,
         status: "running",
         startedAt: $startedAt,
         lastUpdatedAt: $lastUpdatedAt,
         branches: [ $firstBranch ]
       }`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`jq failed: ${r.stderr}`);
  }
  return r.stdout;
}

describe("preflight active-run record (build/SKILL.md.tmpl)", () => {
  it.skipIf(!JQ)("produces a record that readActiveRunRecords accepts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-rec-"));
    const registry = path.join(tmp, "active-runs");
    fs.mkdirSync(registry, { recursive: true });

    const iso = new Date().toISOString();
    const json = runPreflightJq({
      runId: "demo-12345-abc",
      stateSlug: "build-demo-12345-abc",
      repoPath: "/repo",
      worktreePath: path.join(tmp, "worktree"),
      planFile: "/plans/x.md",
      branchPrefix: "demo-12345-abc",
      firstBranch: "feat/demo-12345-abc-bootstrap",
      pid: process.pid,
      iso,
    });

    fs.writeFileSync(path.join(registry, "demo-12345-abc.json"), json);
    const records = readActiveRunRecords(registry);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.runId).toBe("demo-12345-abc");
    expect(r.stateSlug).toBe("build-demo-12345-abc");
    expect(r.status).toBe("running");
    expect(r.branches).toEqual(["feat/demo-12345-abc-bootstrap"]);
    expect(r.worktreePath).toBe(path.join(tmp, "worktree"));
    expect(r.pid).toBe(process.pid);
  });

  it.skipIf(!JQ)(
    "sweepOrphans treats the preflight record as live and does not reap the worktree",
    () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-home-"));
      const registry = path.join(
        homeDir,
        ".gstack",
        "build-state",
        "active-runs",
      );
      const worktreeRoot = path.join(homeDir, ".gstack", "build-worktrees");
      const worktreePath = path.join(worktreeRoot, "demo-67890-xyz");
      fs.mkdirSync(registry, { recursive: true });
      fs.mkdirSync(worktreePath, { recursive: true });

      const iso = new Date().toISOString();
      const json = runPreflightJq({
        runId: "demo-67890-xyz",
        stateSlug: "build-demo-67890-xyz",
        repoPath: "/repo",
        worktreePath,
        planFile: "/plans/x.md",
        branchPrefix: "demo-67890-xyz",
        firstBranch: "feat/demo-67890-xyz-bootstrap",
        pid: process.pid, // live PID — sweep must treat as live
        iso,
      });
      fs.writeFileSync(path.join(registry, "demo-67890-xyz.json"), json);

      const stats = sweepOrphans(registry, { homeDir });
      // The worktree must NOT be reaped (no shapeZ removal),
      // and the record must NOT be pruned (no shapeY removal).
      expect(stats.shapeY).toBe(0);
      expect(stats.shapeZ).toBe(0);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(fs.existsSync(path.join(registry, "demo-67890-xyz.json"))).toBe(
        true,
      );
      // skippedLive OR protectedOnDisk — depends on whether the harness
      // PID is alive at sweep time. Both outcomes are "no reap, no prune."
      expect(stats.skippedLive + stats.protectedOnDisk).toBeGreaterThan(0);
    },
  );
});
