/**
 * Regression tests for the empty-summary wedge — `applyMutableAgentHygiene`
 * must NOT fail a phase when the agent did correct, tracked work but emitted
 * an empty output summary and didn't commit.
 *
 * Symptom (from the /build "honest read"): Codex returns an empty summary and
 * doesn't commit, though its impl is correct; the phase wedges at the
 * impl-hygiene gate. Two coupled gates fired on the blank summary:
 *   1. recoverMutableAgentCommit refused to commit when `summary.trim() === ""`
 *      (old test T-F5), so the correct tracked work was never committed.
 *   2. validatePostAgentHygiene(requireNonEmptyOutput) failed independently on
 *      the empty output file.
 *
 * Fix (build-empty-summary-recovery): when meaningful TRACKED work exists,
 * recovery commits it and synthesizes a summary from the recovery commit,
 * which satisfies the requireNonEmptyOutput gate. Untracked-only scratch still
 * fails (nothing safe to recover).
 *
 * Discriminator: a wedge returns `hygieneFailureResult` → `{ exitCode: 1,
 * hygieneFailure: true }`. A successful exit-0 recovery returns the original
 * result unchanged → `{ exitCode: 0 }` with no `hygieneFailure`.
 *
 * Coverage:
 *   - T-EMPTY-1: empty output + dirty TRACKED change + exit 0 → no wedge
 *                (recovers, commits, synthesizes a non-empty summary)
 *   - T-EMPTY-2: empty output + UNTRACKED-only dirty + exit 0 → still wedges
 *                (no scratch commit; relaxation did not over-reach)
 *   - T-EMPTY-3 (static-grep): cli.ts contains the empty-summary recovery wiring
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyMutableAgentHygiene,
  captureGitSnapshot,
  recoverMutableAgentCommit,
} from "../cli";
import type { SubAgentResult } from "../sub-agents";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

let tmpRoot: string;
let cwd: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "besr-"));
  cwd = path.join(tmpRoot, "wt");
  fs.mkdirSync(cwd);
  spawnSync("git", ["init", "-b", "main"], { cwd });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd });
  spawnSync("git", ["config", "user.name", "t"], { cwd });
  fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 1;\n");
  spawnSync("git", ["add", "src.ts"], { cwd });
  spawnSync("git", ["commit", "-m", "seed"], { cwd });
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function mkResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stallKilled: false,
    logPath: path.join(tmpRoot, "agent.log"),
    durationMs: 100,
    retries: 0,
    ...overrides,
  } as SubAgentResult;
}

describe("empty-summary recovery — applyMutableAgentHygiene no-wedge", () => {
  it("T-EMPTY-1: empty output + dirty TRACKED change + exit 0 → recovers, no wedge", async () => {
    const before = captureGitSnapshot(cwd);
    // The agent did correct work but left it uncommitted and wrote no summary.
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 42;\n");
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(outputFilePath, "   \n\n"); // blank summary
    fs.writeFileSync(path.join(tmpRoot, "agent.log"), "agent ran\n");

    const after = await applyMutableAgentHygiene({
      result: mkResult({ exitCode: 0 }),
      before,
      cwd,
      label: "primary implementor",
      roleId: "primary-impl",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
    });

    // NOT a hygiene failure: the phase no longer wedges.
    expect(after.exitCode).toBe(0);
    expect((after as { hygieneFailure?: boolean }).hygieneFailure).toBeFalsy();
    // HEAD advanced — the correct work was committed host-side.
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(head.stdout.trim()).not.toBe(before.head);
    const log = spawnSync("git", ["log", "-1", "--name-only", "--format="], {
      cwd,
      encoding: "utf8",
    });
    expect(log.stdout).toContain("src.ts");
    // The blank output file was replaced by a synthesized, non-empty summary
    // — exactly what requireNonEmptyOutput reads.
    const synthesized = fs.readFileSync(outputFilePath, "utf8");
    expect(synthesized.trim()).not.toBe("");
    expect(synthesized).toContain("Recovered summary");
    expect(synthesized).toContain("src.ts");
    // The synthesized summary must actually embed the `git show --stat` block
    // (not just the file list) so downstream review sees the real diffstat.
    expect(synthesized).toContain("## Recovery commit");
    expect(synthesized).toMatch(/src\.ts\s*\|\s*\d+/);
    // The recovery commit carries an attribution trailer in git log.
    const body = spawnSync("git", ["log", "-1", "--format=%B"], {
      cwd,
      encoding: "utf8",
    });
    expect(body.stdout).toContain("Recovery-Reason: empty agent summary");
  });

  it("T-EMPTY-2: empty output + UNTRACKED-only dirty + exit 0 → still wedges (no scratch commit)", async () => {
    const before = captureGitSnapshot(cwd);
    // Only untracked scratch — nothing safe to recover. The phase MUST still
    // fail (dirty tree), and HEAD must not move.
    fs.writeFileSync(path.join(cwd, "stray.txt"), "scratch\n");
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(outputFilePath, "   \n\n");
    fs.writeFileSync(path.join(tmpRoot, "agent.log"), "agent ran\n");

    const after = await applyMutableAgentHygiene({
      result: mkResult({ exitCode: 0 }),
      before,
      cwd,
      label: "primary implementor",
      roleId: "primary-impl",
      outputFilePath,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
    });

    expect((after as { hygieneFailure?: boolean }).hygieneFailure).toBe(true);
    expect(after.exitCode).toBe(1);
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(head.stdout.trim()).toBe(before.head);
  });

  it("T-EMPTY-5: empty summary + PRE-EXISTING dirt + agent did nothing → dirt NOT committed", async () => {
    // Critical cross-model finding: a blank-summary run must not launder
    // pre-existing dirty tracked files into a recovery commit. Here the file
    // is dirty BEFORE `before` is captured and the agent makes no further
    // change. contentHashDelta sees the same bytes in before and after
    // (idempotent) → no agent-attributable change → recovery no-ops, HEAD
    // does not move, and the pre-existing edit stays uncommitted.
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const x = 999;\n"); // pre-existing dirt
    const before = captureGitSnapshot(cwd); // dirt is already present in `before`
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(outputFilePath, "   \n\n");

    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "primary implementor",
      roleId: "primary-impl",
    });

    expect(result.recovered).toBe(false);
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(head.stdout.trim()).toBe(before.head); // HEAD did not move
    // The pre-existing edit is still dirty/uncommitted — not laundered.
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    });
    expect(status.stdout).toContain("src.ts");
  });

  it("T-EMPTY-6: empty summary + DELETION of a tracked file → recovers and commits the deletion", async () => {
    // Deletion gap (cross-model review): deleted tracked files don't exist on
    // disk, but they're legitimate agent work. contentHashDelta counts the
    // deletion and the fallback admits `D`-status paths so `git add` stages
    // the removal instead of dropping it.
    const before = captureGitSnapshot(cwd);
    fs.unlinkSync(path.join(cwd, "src.ts")); // tracked deletion (` D src.ts`)
    const outputFilePath = path.join(tmpRoot, "agent-output.md");
    fs.writeFileSync(outputFilePath, "   \n\n");

    const result = await recoverMutableAgentCommit({
      cwd,
      before,
      outputFilePath,
      label: "primary implementor",
      roleId: "primary-impl",
    });

    expect(result.recovered).toBe(true);
    expect(result.commit).toBeDefined();
    // The recovery commit records the deletion, and the tree is clean after.
    const show = spawnSync("git", ["show", "--stat", "--format=", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    expect(show.stdout).toContain("src.ts");
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    });
    expect(status.stdout.trim()).toBe("");
  });
});

describe("empty-summary recovery — static-grep wiring guards", () => {
  it("T-EMPTY-3: cli.ts has the empty-summary recovery gate + synthesized-summary writeback", () => {
    // A refactor that drops these would silently re-introduce the wedge.
    expect(cliContent).toContain('const summaryEmpty = summary.trim() === "";');
    // The gate must be agent-attributable (contentHashDelta), never raw dirt —
    // see the critical cross-model finding. agentTrackedChangePaths is built
    // from contentHashDelta and the no-op fires when it is empty.
    expect(cliContent).toMatch(/agentTrackedChangePaths\.size\s*===\s*0/);
    expect(cliContent).toContain("Recovered summary (agent emitted no output)");
    // Empty-summary recovery commits get an attribution trailer in git log.
    expect(cliContent).toContain('"empty agent summary"');
  });
});
