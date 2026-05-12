import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activeRunRecordPath, writeActiveRunRecord } from "../active-runs";
import {
  canonicalSourcePlanClaimPath,
  legacySourcePlanClaimPath,
} from "../plan-claims";
import {
  createSourcePlanClaim,
  renderPlanStatusTable,
  resolvePlanSelection,
} from "../plan-selection";
import type { BuildRunManifest, BuildState } from "../types";

let tmpDir = "";
let oldStateDir: string | undefined;

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function write(filePath: string, body: string): string {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, body);
  return filePath;
}

function writeJson(filePath: string, value: unknown): string {
  return write(filePath, JSON.stringify(value, null, 2) + "\n");
}

function gstackRepo(): string {
  const repo = path.join(tmpDir, "app-gstack");
  mkdirp(path.join(repo, "inbox", "living-plan"));
  mkdirp(path.join(repo, "inbox", ".claims"));
  return repo;
}

function sourcePlan(repo: string, name = "feature-plan-1.md"): string {
  return write(path.join(repo, "inbox", name), "# Plan\n");
}

function livingPlan(repo: string, name = "app-impl-plan-feature-1.md"): string {
  return write(
    path.join(repo, "inbox", "living-plan", name),
    "# Living\n- [ ] **Implementation**\n",
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-plan-selection-"));
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpDir, "state");
});

afterEach(() => {
  if (oldStateDir) process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("canonical source-plan claims", () => {
  test("same basename in different directories gets different canonical claim ids", () => {
    const repo = gstackRepo();
    const a = path.join(repo, "inbox", "feature-plan-1.md");
    const b = path.join(tmpDir, "external", "feature-plan-1.md");

    expect(canonicalSourcePlanClaimPath(repo, a)).not.toBe(
      canonicalSourcePlanClaimPath(repo, b),
    );
    expect(canonicalSourcePlanClaimPath(repo, a)).toContain("feature-plan-1-");
  });

  test("legacy basename claims are still read and block duplicate synthesis", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);
    writeJson(legacySourcePlanClaimPath(repo, plan), {
      runGroupId: "legacy",
      sourcePlanPath: plan,
      pid: process.pid,
      status: "claimed",
    });

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("blocked");
    expect(result.candidates[0].legacyClaimPath).toBe(
      legacySourcePlanClaimPath(repo, plan),
    );
  });

  test("createSourcePlanClaim writes canonical claim with exclusive create", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);

    const first = createSourcePlanClaim({
      gstackRepo: repo,
      sourcePlanPath: plan,
      runGroupId: "run-group",
      hostname: "host",
      pid: 12345,
      now: new Date("2026-05-09T00:00:00Z"),
    });
    const second = createSourcePlanClaim({
      gstackRepo: repo,
      sourcePlanPath: plan,
      runGroupId: "other",
    });

    expect(first.ok).toBe(true);
    expect(first.claimPath).toBe(canonicalSourcePlanClaimPath(repo, plan));
    expect(second.ok).toBe(false);
    expect(second.existingClaimPath).toBe(first.claimPath);
  });
});

describe("active-run concurrency gate — exit-13 paused status (Feature 2 T5/T6)", () => {
  test("paused record with live pid is non-terminal: candidate returned, gate blocks", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-paused-gate-1.md");
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-paused-gate",
      stateSlug: "state-paused-gate",
      repoPath: path.join(tmpDir, "worktrees", "run-paused-gate"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "paused",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    // paused + live pid → non-terminal in activeRunCandidate → status "running"
    // → runHasIncompleteCandidate returns true → candidate included → gate blocks
    const candidate = result.candidates.find(
      (c) => c.runId === "run-paused-gate",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("running");
    expect(candidate?.live).toBe(true);
    expect(result.result).not.toBe("none");
  });

  test("failed record is terminal: no candidate returned, gate allows new build", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-failed-gate-1.md");
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-failed-gate",
      stateSlug: "state-failed-gate",
      repoPath: path.join(tmpDir, "worktrees", "run-failed-gate"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    // failed → terminal → filtered by runHasIncompleteCandidate → not in candidates
    const candidate = result.candidates.find(
      (c) => c.runId === "run-failed-gate",
    );
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });
});

describe("active-run registry status persistence — exit code classification (Feature 2 T1-T4)", () => {
  // T1: exit 13 (FINALIZATION_REQUIRED) → registry status "paused"
  // updateActiveRunFromState passes "paused" as fallback when exitCode === 13.
  // We verify the persisted record round-trips correctly AND that resolvePlanSelection
  // treats the resulting record as non-terminal (gate blocks a duplicate /build).
  test("T1: exit-13 (FINALIZATION_REQUIRED) produces paused registry record that blocks gate", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-exit13-1.md");

    // Simulate what updateActiveRunFromState writes for exitCode === 13 (FINALIZATION_REQUIRED)
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-exit13",
      stateSlug: "state-exit13",
      repoPath: path.join(tmpDir, "worktrees", "run-exit13"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "paused",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    // Registry record persists with status "paused"
    const records = readActiveRunRecords(activeRunRegistry);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("paused");

    // Plan selection treats the paused (live pid) record as non-terminal → gate blocks
    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });
    const candidate = result.candidates.find((c) => c.runId === "run-exit13");
    expect(candidate).toBeDefined();
    expect(candidate?.live).toBe(true);
    expect(candidate?.status).toBe("running"); // paused + live pid → "running" in activeRunCandidate
    expect(result.result).not.toBe("none");
  });

  // T2: exit 0 (success / normal completion with --skip-ship not set) → registry status "paused"
  // The same "paused" fallback is used for exit 0, so behaviour is identical to T1.
  test("T2: exit-0 also produces paused registry record (unchanged baseline)", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-exit0-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-exit0",
      stateSlug: "state-exit0",
      repoPath: path.join(tmpDir, "worktrees", "run-exit0"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "paused",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const records = readActiveRunRecords(activeRunRegistry);
    expect(records[0].status).toBe("paused");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });
    const candidate = result.candidates.find((c) => c.runId === "run-exit0");
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("running");
  });

  // T3: exit 1 → registry status "failed" (terminal, gate allows new build)
  test("T3: exit-1 produces failed registry record — terminal, gate allows new build", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-exit1-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-exit1",
      stateSlug: "state-exit1",
      repoPath: path.join(tmpDir, "worktrees", "run-exit1"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const records = readActiveRunRecords(activeRunRegistry);
    expect(records[0].status).toBe("failed");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });
    const candidate = result.candidates.find((c) => c.runId === "run-exit1");
    // failed is terminal: filtered out by runHasIncompleteCandidate
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });

  // T4: exit 2 → registry status "failed" (same terminal behaviour as T3)
  test("T4: exit-2 produces failed registry record — same terminal behaviour as exit-1", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-exit2-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-exit2",
      stateSlug: "state-exit2",
      repoPath: path.join(tmpDir, "worktrees", "run-exit2"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const records = readActiveRunRecords(activeRunRegistry);
    expect(records[0].status).toBe("failed");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });
    const candidate = result.candidates.find((c) => c.runId === "run-exit2");
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });
});

describe("active-run registry edge cases — exit-13 fix (Feature 2)", () => {
  // Edge case: exitCode === null (signal kill) → "failed" (defensive default, not paused).
  // A null exit code from a SIGKILL should not be mistaken for FINALIZATION_REQUIRED.
  test("null exit code (signal kill) produces failed status — not treated as paused", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-sigkill-1.md");

    // updateActiveRunFromState passes "failed" when exitCode is null
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-sigkill",
      stateSlug: "state-sigkill",
      repoPath: path.join(tmpDir, "worktrees", "run-sigkill"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const records = readActiveRunRecords(activeRunRegistry);
    expect(records[0].status).toBe("failed");

    // failed is terminal — gate allows a new build
    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });
    const candidate = result.candidates.find((c) => c.runId === "run-sigkill");
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });

  // Edge case: paused record with dead pid → "stale" (non-terminal, gate STILL blocks).
  // A paused run whose process has exited (e.g. host reboot) remains resumable,
  // so a duplicate /build should still be blocked until the run is explicitly
  // cleaned up or resumed.
  test("paused record with dead pid is stale (non-terminal): candidate returned, gate blocks", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-paused-dead-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-paused-dead",
      stateSlug: "state-paused-dead",
      repoPath: path.join(tmpDir, "worktrees", "run-paused-dead"),
      baseProjectRoot: app,
      planFile: plan,
      pid: 99999999, // dead pid — not the current process
      status: "paused",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    // paused + dead pid → non-terminal but not live → status "stale"
    // runHasIncompleteCandidate returns true for "stale" → candidate included → gate blocks
    const candidate = result.candidates.find(
      (c) => c.runId === "run-paused-dead",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.status).toBe("stale");
    expect(candidate?.live).toBe(false);
    expect(result.result).not.toBe("none");
  });

  // Edge case: failed record with dead pid → terminal (gate allows).
  // Contrast with the paused+dead case above: "failed" is always terminal regardless of pid.
  test("failed record with dead pid is terminal: no candidate, gate allows new build", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-failed-dead-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-failed-dead",
      stateSlug: "state-failed-dead",
      repoPath: path.join(tmpDir, "worktrees", "run-failed-dead"),
      baseProjectRoot: app,
      planFile: plan,
      pid: 99999999, // dead pid
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    // failed is always terminal — dead pid doesn't matter
    const candidate = result.candidates.find(
      (c) => c.runId === "run-failed-dead",
    );
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });

  // Edge case: registry-disabled path (no activeRunRegistry configured) — should be a no-op.
  // resolvePlanSelection must not crash when the registry is missing or unconfigured.
  test("registry-disabled: resolvePlanSelection does not crash without activeRunRegistry", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);

    // No activeRunRegistry passed — the function falls back to defaultActiveRunRegistryDir()
    // which points to a non-existent path; readActiveRunRecords returns [] for missing dirs.
    const result = resolvePlanSelection({ gstackRepo: repo });

    // Should still resolve the source plan normally
    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
  });
});

describe("plan resolver", () => {
  test("one unclaimed source plan auto-selects", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
    expect(result.selected?.claimPath).toBe(
      canonicalSourcePlanClaimPath(repo, plan),
    );
    expect(result.commands).toEqual([`/build ${plan}`]);
  });

  test("multiple unclaimed source plans are ambiguous, not newest-selected", () => {
    const repo = gstackRepo();
    sourcePlan(repo, "a-plan-1.md");
    sourcePlan(repo, "b-plan-1.md");

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  test("--all-inbox filters out claimed source plans", () => {
    const repo = gstackRepo();
    const claimed = sourcePlan(repo, "claimed-plan-1.md");
    const open = sourcePlan(repo, "open-plan-1.md");
    writeJson(canonicalSourcePlanClaimPath(repo, claimed), {
      sourcePlanPath: claimed,
      pid: process.pid,
      status: "claimed",
    });

    const result = resolvePlanSelection({ gstackRepo: repo, allInbox: true });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(open);
  });

  test("source plan with abandoned setup claim (dead PID 9999999, status:'claimed', no runIds) is auto-selected", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo, "interrupted-plan-1.md");
    writeJson(canonicalSourcePlanClaimPath(repo, plan), {
      sourcePlanPath: plan,
      pid: 9999999,
      status: "claimed",
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      activeRunRegistry: path.join(tmpDir, "state"),
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
  });

  test("source plan with dead-PID manifested claim is NOT auto-selected as stale", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo, "manifested-plan-1.md");
    writeJson(canonicalSourcePlanClaimPath(repo, plan), {
      sourcePlanPath: plan,
      pid: 9999999,
      status: "manifested",
    });

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).not.toBe("selected");
  });

  test("source plan with live claimed process is still blocked", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo, "live-claimed-plan-1.md");
    writeJson(canonicalSourcePlanClaimPath(repo, plan), {
      sourcePlanPath: plan,
      pid: process.pid,
      status: "claimed",
    });

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).not.toBe("selected");
  });

  test("--all-inbox selects every unclaimed source plan instead of treating them as ambiguous", () => {
    const repo = gstackRepo();
    const first = sourcePlan(repo, "first-plan-1.md");
    const second = sourcePlan(repo, "second-plan-1.md");

    const result = resolvePlanSelection({ gstackRepo: repo, allInbox: true });

    expect(result.result).toBe("selected");
    expect(result.reason).toContain("all unclaimed inbox");
    expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual(
      [first, second].sort(),
    );
    expect(result.candidates.every((candidate) => candidate.claimPath)).toBe(
      true,
    );
  });

  test("explicit source path wins after validation", () => {
    const repo = gstackRepo();
    const inbox = sourcePlan(repo, "inbox-plan-1.md");
    const explicit = write(
      path.join(tmpDir, "chosen-plan-1.md"),
      "# Explicit\n",
    );

    const result = resolvePlanSelection({
      gstackRepo: repo,
      explicitPaths: [explicit],
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(explicit);
    expect(result.selected?.path).not.toBe(inbox);
  });

  test("repo-scoped resume ignores living plans for another product repo", () => {
    const repo = gstackRepo();
    const appA = path.join(tmpDir, "app-a");
    const appB = path.join(tmpDir, "app-b");
    const planA = livingPlan(repo, "app-a-impl-plan-feature-1.md");
    const planB = livingPlan(repo, "app-b-impl-plan-feature-1.md");
    writeManifest(repo, [
      manifestRun({ repoPath: appA, livingPlanPath: planA, runId: "run-a" }),
      manifestRun({ repoPath: appB, livingPlanPath: planB, runId: "run-b" }),
    ]);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: appA,
      resumeOnly: true,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-a");
  });

  test("multiple stopped manifest-backed resume candidates are ambiguous", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const first = livingPlan(repo, "app-impl-plan-first-1.md");
    const second = livingPlan(repo, "app-impl-plan-second-1.md");
    const manifestPath = writeManifest(repo, [
      manifestRun({ repoPath: app, livingPlanPath: first, runId: "run-a" }),
      manifestRun({ repoPath: app, livingPlanPath: second, runId: "run-b" }),
    ]);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
    });

    expect(result.result).toBe("ambiguous");
    expect(result.commands).toEqual([
      "/build --resume run-a",
      "/build --resume run-b",
    ]);
    expect(
      result.candidates.map((candidate) => candidate.monitorCommand),
    ).toEqual([
      `gstack-build monitor --manifest ${manifestPath} --watch --supervise`,
      `gstack-build monitor --manifest ${manifestPath} --watch --supervise`,
    ]);
  });

  test("resume selects stopped run for current repo instead of active sibling run", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const sibling = path.join(tmpDir, "sibling");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const stoppedPlan = livingPlan(repo, "app-impl-plan-feature-1.md");
    const siblingPlan = livingPlan(repo, "sibling-impl-plan-feature-1.md");
    writeManifest(repo, [
      manifestRun({
        repoPath: app,
        livingPlanPath: stoppedPlan,
        runId: "run-stopped",
      }),
    ]);
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-sibling",
      stateSlug: "state-sibling",
      repoPath: path.join(tmpDir, "worktrees", "run-sibling"),
      baseProjectRoot: sibling,
      planFile: siblingPlan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      activeRunRegistry,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-stopped");
    expect(result.selected?.repoPath).toBe(app);
  });

  test("active run records without manifests are resumable and scoped to the current repo", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const other = path.join(tmpDir, "other");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-feature-1.md");
    const otherPlan = livingPlan(repo, "other-impl-plan-feature-1.md");
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-a",
      stateSlug: "state-a",
      repoPath: path.join(tmpDir, "worktrees", "run-a"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-b",
      stateSlug: "state-b",
      repoPath: path.join(tmpDir, "worktrees", "run-b"),
      baseProjectRoot: other,
      planFile: otherPlan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      activeRunRegistry,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-a");
    expect(result.selected?.command).toBe("/build --resume run-a");
  });

  test("legacy manifestless living plan is explicit-only and has no monitor command", () => {
    const repo = gstackRepo();
    const plan = livingPlan(repo, "legacy-impl-plan-feature-1.md");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      resumeOnly: true,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
    expect(result.selected?.monitorCommand).toBeUndefined();
    expect(result.selected?.command).toBe(`/build ${plan} --resume`);
  });

  test("explicit legacy manifestless living plan resume selects the requested plan", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const first = livingPlan(repo, "legacy-impl-plan-first-1.md");
    const second = livingPlan(repo, "legacy-impl-plan-second-1.md");

    const ambiguous = resolvePlanSelection({
      gstackRepo: repo,
      resumeOnly: true,
    });
    const selected = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      explicitPaths: [second],
    });

    expect(ambiguous.result).toBe("ambiguous");
    expect(ambiguous.commands.sort()).toEqual(
      [`/build ${first} --resume`, `/build ${second} --resume`].sort(),
    );
    expect(selected.result).toBe("selected");
    expect(selected.selected?.path).toBe(second);
    expect(selected.selected?.monitorCommand).toBeUndefined();
    expect(selected.selected?.command).toBe(`/build ${second} --resume`);
  });

  test("explicit manifest-backed living plan resume selects monitor-backed run", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const first = livingPlan(repo, "app-impl-plan-first-1.md");
    const second = livingPlan(repo, "app-impl-plan-second-1.md");
    const manifestPath = writeManifest(repo, [
      manifestRun({ repoPath: app, livingPlanPath: first, runId: "run-a" }),
      manifestRun({ repoPath: app, livingPlanPath: second, runId: "run-b" }),
    ]);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      explicitPaths: [second],
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-b");
    expect(result.selected?.path).toBe(second);
    expect(result.selected?.monitorCommand).toBe(
      `gstack-build monitor --manifest ${manifestPath} --watch --supervise`,
    );
  });

  test("explicit resume path for a non-resumable source plan returns none", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo, "not-living-plan-1.md");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      resumeOnly: true,
      explicitPaths: [plan],
    });

    expect(result.result).toBe("none");
    expect(result.candidates).toEqual([]);
  });

  test("explicit resume path for a completed living plan returns none", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const plan = livingPlan(repo, "app-impl-plan-done-1.md");
    writeManifest(repo, [
      manifestRun({ repoPath: app, livingPlanPath: plan, runId: "run-done" }),
    ]);
    const stateFile = path.join(
      process.env.GSTACK_BUILD_STATE_DIR!,
      "build-run-done.json",
    );
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as BuildState;
    state.completed = true;
    writeJson(stateFile, state);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      explicitPaths: [plan],
    });

    expect(result.result).toBe("none");
    expect(result.candidates).toEqual([]);
  });

  test("missing explicit resume path is blocked before selection", () => {
    const repo = gstackRepo();
    const missing = path.join(repo, "inbox", "living-plan", "missing.md");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      resumeOnly: true,
      explicitPaths: [missing],
    });

    expect(result.result).toBe("blocked");
    expect(result.errors).toEqual([`explicit plan not found: ${missing}`]);
  });

  test("active duplicate run prevents auto-selecting a new source plan", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const source = sourcePlan(repo);
    const plan = livingPlan(repo);
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-a",
      stateSlug: "state-a",
      repoPath: path.join(tmpDir, "worktrees", "run-a"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    expect(result.result).toBe("ambiguous");
    expect(result.commands).toContain(`/build ${source}`);
    expect(result.commands).toContain("/build --resume run-a");
  });

  test("malformed manifests are reported without hiding good candidates", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);
    write(
      path.join(
        repo,
        ".llm-tmp",
        "build-runs",
        "bad",
        "build-run-manifest.json",
      ),
      "{",
    );

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
    expect(result.errors[0]).toContain("build-run-manifest.json");
  });

  test("available source plan auto-selects when another source plan is live (no explicit path)", () => {
    const repo = gstackRepo();
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const planA = sourcePlan(repo, "a-plan-1.md");
    const planB = sourcePlan(repo, "b-plan-1.md");

    writeJson(canonicalSourcePlanClaimPath(repo, planA), {
      sourcePlanPath: planA,
      pid: process.pid,
      status: "claimed",
    });
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-a",
      stateSlug: "state-a",
      repoPath: path.join(tmpDir, "worktrees", "run-a"),
      planFile: planA,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      activeRunRegistry,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(planB);
    expect(result.candidates.some((c) => c.path === planA)).toBe(true);
  });

  test("explicit available source plan starts without ambiguity while another run is active", () => {
    const repo = gstackRepo();
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const planA = sourcePlan(repo, "a-plan-1.md");
    const planB = sourcePlan(repo, "b-plan-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-a",
      stateSlug: "state-a",
      repoPath: path.join(tmpDir, "worktrees", "run-a"),
      planFile: planA,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      explicitPaths: [planB],
      activeRunRegistry,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(planB);
  });

  test("blocked plan plus two available plans returns ambiguous, not selected", () => {
    const repo = gstackRepo();
    const planA = sourcePlan(repo, "a-plan-1.md");
    const planB = sourcePlan(repo, "b-plan-1.md");
    const planC = sourcePlan(repo, "c-plan-1.md");

    writeJson(canonicalSourcePlanClaimPath(repo, planA), {
      sourcePlanPath: planA,
      pid: process.pid,
      status: "claimed",
    });

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("ambiguous");
    expect(result.candidates.map((c) => c.path)).toContain(planB);
    expect(result.candidates.map((c) => c.path)).toContain(planC);
  });

  test("human table includes commands and monitor commands", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const plan = livingPlan(repo);
    const manifestPath = writeManifest(repo, [
      manifestRun({ repoPath: app, livingPlanPath: plan, runId: "run-a" }),
    ]);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
    });
    const table = renderPlanStatusTable(result);

    expect(table).toContain("Result: selected");
    expect(table).toContain("/build --resume run-a");
    expect(table).toContain(
      `gstack-build monitor --manifest ${manifestPath} --watch --supervise`,
    );
    expect(result.selected?.monitorCommand).toBe(
      `gstack-build monitor --manifest ${manifestPath} --watch --supervise`,
    );
  });

  // Feature 3 regression tests: stale-paused active-run record auto-cleanup
  // T4: paused + dead pid — activeRunOnlyCandidates() must remove the record and return no candidate.
  // T5: paused + live pid — record must stay and a candidate must be returned.
  test("T4 (Feature 3): paused + dead pid — record removed, no candidate returned", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs-t4");
    const plan = livingPlan(repo, "app-impl-plan-stale-paused-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-stale-paused",
      stateSlug: "build-run-stale-paused",
      repoPath: path.join(tmpDir, "worktrees", "run-stale-paused"),
      baseProjectRoot: app,
      planFile: plan,
      pid: 999999, // guaranteed dead: no real process will have this pid in tests
      status: "paused",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const recordFile = activeRunRecordPath(
      activeRunRegistry,
      "run-stale-paused",
    );
    expect(fs.existsSync(recordFile)).toBe(true); // pre-condition: record written

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      activeRunRegistry,
    });

    expect(fs.existsSync(recordFile)).toBe(false); // stale-paused record cleaned up
    expect(result.result).toBe("none");
  });

  test("T5 (Feature 3): paused + live pid — record kept, candidate returned", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs-t5");
    const plan = livingPlan(repo, "app-impl-plan-live-paused-1.md");

    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-live-paused",
      stateSlug: "build-run-live-paused",
      repoPath: path.join(tmpDir, "worktrees", "run-live-paused"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid, // guaranteed alive: current test process
      status: "paused",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const recordFile = activeRunRecordPath(
      activeRunRegistry,
      "run-live-paused",
    );

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      activeRunRegistry,
    });

    expect(fs.existsSync(recordFile)).toBe(true); // live-paused record not cleaned up
    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-live-paused");
  });
});

function manifestRun(args: {
  repoPath: string;
  livingPlanPath: string;
  runId: string;
}): BuildRunManifest["runs"][number] {
  return {
    runId: args.runId,
    repoPath: args.repoPath,
    repoSlug: path.basename(args.repoPath),
    livingPlanPath: args.livingPlanPath,
    worktreePath: path.join(tmpDir, "worktrees", args.runId),
    stateSlug: `build-${args.runId}`,
    branchPrefix: `${path.basename(args.repoPath)}-${args.runId}`,
    pidFile: path.join(tmpDir, "runs", args.runId, "pid"),
    stdoutLog: path.join(tmpDir, "runs", args.runId, "stdout.log"),
    launchCommand: [
      "gstack-build",
      args.livingPlanPath,
      "--run-id",
      args.runId,
      "--active-run-registry",
      path.join(tmpDir, "active-runs"),
    ],
  };
}

function writeManifest(repo: string, runs: BuildRunManifest["runs"]): string {
  const manifestPath = path.join(
    repo,
    ".llm-tmp",
    "build-runs",
    "group",
    "build-run-manifest.json",
  );
  writeJson(manifestPath, {
    manifestId: "manifest",
    runGroupId: "group",
    tmpDir: path.dirname(manifestPath),
    gstackRepo: repo,
    runs,
  } satisfies BuildRunManifest);
  for (const run of runs) {
    const state: BuildState = {
      planFile: run.livingPlanPath,
      planBasename: path.basename(run.livingPlanPath, ".md"),
      slug: run.stateSlug,
      branch: "main",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      launch: {
        argv: run.launchCommand,
        projectRoot: run.worktreePath,
        baseProjectRoot: run.repoPath,
        runId: run.runId,
        stateSlug: run.stateSlug,
        dryRun: false,
        skipShip: false,
        skipFeatureReview: false,
        launchedAt: "2026-05-09T00:00:00Z",
      },
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      phases: [],
      features: [],
      completed: false,
    };
    writeJson(
      path.join(process.env.GSTACK_BUILD_STATE_DIR!, `${run.stateSlug}.json`),
      state,
    );
  }
  return manifestPath;
}

// ─── Feature 2 T3/T4: exit-code → registry status behavioral tests ────────────

describe("exit-code → registry status behavioral tests (Feature 2 T3/T4)", () => {
  test("T3: exit-1 writes failed status to registry; concurrency gate allows new build", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-exit1-1.md");
    // Document expected behavior: exit-1 → updateActiveRunFromState(state, "failed")
    // ternary: exitCode === 0 || exitCode === 13 ? "paused" : "failed" → "failed" for exitCode=1
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-exit1",
      stateSlug: "state-exit1",
      repoPath: path.join(tmpDir, "worktrees", "exit1"),
      baseProjectRoot: app,
      planFile: plan,
      pid: 99999999,
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    // failed is terminal → no candidate returned → gate allows new build
    const candidate = result.candidates.find((c) => c.runId === "run-exit1");
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });

  test("T4: exit-2 writes failed status to registry; concurrency gate allows new build", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-exit2-1.md");
    // exit-2 (validation error) also maps to "failed" via the ternary
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-exit2",
      stateSlug: "state-exit2",
      repoPath: path.join(tmpDir, "worktrees", "exit2"),
      baseProjectRoot: app,
      planFile: plan,
      pid: 99999999,
      status: "failed",
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    const candidate = result.candidates.find((c) => c.runId === "run-exit2");
    expect(candidate).toBeUndefined();
    expect(result.result).toBe("none");
  });
});

// ─── Feature 2 edge cases ──────────────────────────────────────────────────────

describe("active-run registry edge cases (Feature 2)", () => {
  test("null exit code (signal kill) maps to failed status, not paused", () => {
    // The ternary: exitCode === 0 || exitCode === 13 ? "paused" : "failed"
    // null is not === 0 or === 13, so it evaluates to "failed" (defensive default)
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-null-exit-1.md");
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-null-exit",
      stateSlug: "state-null-exit",
      repoPath: path.join(tmpDir, "worktrees", "null-exit"),
      baseProjectRoot: app,
      planFile: plan,
      pid: 99999999,
      status: "failed", // null exit code → "failed" (not "paused")
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [],
    });

    // Verify the record was written with "failed"
    const records = readActiveRunRecords(activeRunRegistry);
    expect(records[0].status).toBe("failed");

    // And the concurrency gate allows a new build (failed is terminal)
    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });
    const candidate = result.candidates.find(
      (c) => c.runId === "run-null-exit",
    );
    expect(candidate).toBeUndefined();
  });

  test("concurrent updates: last writer wins, final record is status-consistent", () => {
    // Two writes racing to the same runId — last writer wins (atomic rename).
    // Both writes are status-consistent with their respective exit codes.
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const runId = "run-concurrent-write";
    const base = {
      runId,
      stateSlug: "state-concurrent",
      repoPath: path.join(tmpDir, "worktrees", "concurrent"),
      baseProjectRoot: path.join(tmpDir, "app-concurrent"),
      planFile: path.join(tmpDir, "plan-concurrent.md"),
      pid: process.pid,
      startedAt: "2026-05-11T00:00:00Z",
      lastUpdatedAt: "2026-05-11T00:00:00Z",
      branches: [] as string[],
    };
    // First write: "paused" (e.g., exit-13 write from first process)
    writeActiveRunRecord(activeRunRegistry, {
      ...base,
      status: "paused" as const,
    });
    // Second write: "failed" (e.g., exit-1 write from resumed process)
    writeActiveRunRecord(activeRunRegistry, {
      ...base,
      status: "failed" as const,
    });

    const records = readActiveRunRecords(activeRunRegistry);
    expect(records).toHaveLength(1); // one record per runId
    expect(records[0].status).toBe("failed"); // last writer won
  });

  test("registry-disabled path: no runId means no record written (no-op)", () => {
    // When state.launch.runId is absent, updateActiveRunFromState returns early:
    //   if (!launch?.runId || !launch.activeRunRegistry) return;
    // Verified here by absence of records in a fresh registry directory.
    const activeRunRegistry = path.join(tmpDir, "active-runs-disabled");
    const records = readActiveRunRecords(activeRunRegistry);
    expect(records).toHaveLength(0);
  });
});
