/**
 * Regression tests for the worktree-content-hash hygiene delta (D5).
 *
 * Plan ref: inbox/build-implementor-hygiene-hardening-20260517.md Feature 3.
 *
 * Round-1 D3 was wrong: comparing against HEAD blob misreports the user's
 * pre-existing dirty work as agent-modified. Round-2 D5 captures pre-agent
 * worktree hashes in `GitSnapshot` itself and compares against those.
 *
 * Test fidelity (gpt-5.5 plan-review IMPORTANT #1): the idempotent-rewrite
 * test (T3.1.1) constructs a REAL pre-agent dirty state so `before.status`
 * contains the entry. A "clean before then identical rewrite" version is
 * unreliable because git's stat refresh often hides it as clean.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  captureGitSnapshot,
  contentHashDelta,
  validatePostAgentHygiene,
  type GitSnapshot,
} from "../cli";

let tmpDir: string;
let repo: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-hygiene-delta-"));
  repo = tmpDir;
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function initRepo(): void {
  expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
    0,
  );
  expect(
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    }).status,
  ).toBe(0);
  expect(
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
      .status,
  ).toBe(0);
}

function commit(file: string, content: string, message = "test commit"): void {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  expect(spawnSync("git", ["add", file], { cwd: repo }).status).toBe(0);
  expect(
    spawnSync("git", ["commit", "-m", message], { cwd: repo }).status,
  ).toBe(0);
}

describe("captureGitSnapshot with workTreeHashes", () => {
  it("populates workTreeHashes for tracked dirty files", () => {
    initRepo();
    commit("a.txt", "V1\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "V2\n");
    const snap = captureGitSnapshot(repo);
    expect(snap.workTreeHashes.has("a.txt")).toBe(true);
    expect(snap.workTreeHashes.get("a.txt")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("populates workTreeHashes for untracked files", () => {
    initRepo();
    commit("a.txt", "tracked\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n");
    const snap = captureGitSnapshot(repo);
    expect(snap.workTreeHashes.has("new.txt")).toBe(true);
  });

  it("omits deleted paths from workTreeHashes", () => {
    initRepo();
    commit("a.txt", "tracked\n");
    fs.unlinkSync(path.join(repo, "a.txt"));
    const snap = captureGitSnapshot(repo);
    // The deletion entry IS in status but the hash is absent (no file).
    expect(snap.workTreeHashes.has("a.txt")).toBe(false);
  });

  it("populates workTreeContents only when captureContents:true", () => {
    initRepo();
    commit("a.txt", "V1\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "V2\n");
    const snapDefault = captureGitSnapshot(repo);
    expect(snapDefault.workTreeContents).toBeUndefined();
    const snapWithContents = captureGitSnapshot(repo, {
      captureContents: true,
    });
    expect(snapWithContents.workTreeContents?.get("a.txt")?.toString()).toBe(
      "V2\n",
    );
  });
});

describe("contentHashDelta", () => {
  // T3.1.1 — Idempotent rewrite of PRE-EXISTING DIRTY file ignored (Foundry case).
  it("T3.1.1: drops idempotent rewrite of pre-existing dirty file", () => {
    initRepo();
    commit("foo.json", "V1\n");
    // Dirty the file before agent runs
    fs.writeFileSync(path.join(repo, "foo.json"), "V2\n");
    const before = captureGitSnapshot(repo);
    expect(before.workTreeHashes.get("foo.json")).toBeTruthy();

    // Simulate agent re-writing with IDENTICAL bytes (Foundry case)
    fs.writeFileSync(path.join(repo, "foo.json"), "V2\n");
    const after = captureGitSnapshot(repo);
    expect(before.workTreeHashes.get("foo.json")).toBe(
      after.workTreeHashes.get("foo.json"),
    );

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(0);
  });

  // T3.1.2 — Real agent-modified content fails.
  it("T3.1.2: counts real agent modification of pre-existing dirty file", () => {
    initRepo();
    commit("foo.json", "V1\n");
    fs.writeFileSync(path.join(repo, "foo.json"), "V2\n");
    const before = captureGitSnapshot(repo);

    fs.writeFileSync(path.join(repo, "foo.json"), "V3-AGENT\n");
    const after = captureGitSnapshot(repo);

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(1);
    expect(real[0]).toContain("foo.json");
  });

  // T3.1.3 — Untracked agent-created file counted.
  it("T3.1.3: counts agent-created untracked file", () => {
    initRepo();
    commit("a.txt", "x\n");
    const before = captureGitSnapshot(repo);
    fs.writeFileSync(path.join(repo, "agent-new.mjs"), "console.log('x')\n");
    const after = captureGitSnapshot(repo);

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(1);
    expect(real[0]).toContain("agent-new.mjs");
  });

  // T3.1.4 — Symmetric: untracked file with byte-identical content drops.
  it("T3.1.4: drops symmetric untracked rewrite (identical bytes)", () => {
    initRepo();
    commit("a.txt", "x\n");
    fs.writeFileSync(path.join(repo, "draft.mjs"), "X\n");
    const before = captureGitSnapshot(repo);
    // Agent overwrites with same bytes
    fs.writeFileSync(path.join(repo, "draft.mjs"), "X\n");
    const after = captureGitSnapshot(repo);

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(0);
  });

  // T3.1.5 — Deleted file always counted.
  it("T3.1.5: counts deleted file", () => {
    initRepo();
    commit("doomed.txt", "bye\n");
    const before = captureGitSnapshot(repo);
    fs.unlinkSync(path.join(repo, "doomed.txt"));
    const after = captureGitSnapshot(repo);

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(1);
    expect(real[0]).toContain("doomed.txt");
  });

  // T3.1.6 — File-read error conservatively counted (Unix-only).
  it("T3.1.6: conservatively counts paths missing after-hash", () => {
    initRepo();
    commit("a.txt", "x\n");
    // Construct an `after` snapshot manually with a missing workTreeHash entry
    const before: GitSnapshot = {
      head: "abc123",
      status: [],
      workTreeHashes: new Map(),
    };
    const after: GitSnapshot = {
      head: "abc123",
      status: [" M missing.txt"],
      workTreeHashes: new Map(), // hash absent — read error
    };

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(1);
    expect(real[0]).toContain("missing.txt");
  });

  // T3.1.7 — Clean → clean passes.
  it("T3.1.7: clean→clean has zero real changes", () => {
    initRepo();
    commit("a.txt", "x\n");
    const before = captureGitSnapshot(repo);
    const after = captureGitSnapshot(repo);
    expect(contentHashDelta(before, after, repo).length).toBe(0);
  });

  // T3.1.8 — Null-head conservative.
  it("T3.1.8: with null before.head, dirty entries always count (conservative)", () => {
    initRepo();
    // Don't commit anything. Create a tracked-but-uncommitted file.
    fs.writeFileSync(path.join(repo, "untracked.txt"), "x\n");
    spawnSync("git", ["add", "untracked.txt"], { cwd: repo });

    const before = captureGitSnapshot(repo); // head should be null
    expect(before.head).toBeNull();

    // Agent modifies it.
    fs.writeFileSync(path.join(repo, "untracked.txt"), "y\n");
    const after = captureGitSnapshot(repo);

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBeGreaterThan(0);
  });

  // T3.1.9 — Pre-existing dirty file UNCHANGED passes (gpt-5.5 CRITICAL #1 regression).
  it("T3.1.9: pre-existing dirty file untouched by agent → NO fault", () => {
    initRepo();
    commit("foo.json", "V1\n");
    fs.writeFileSync(path.join(repo, "foo.json"), "V2\n");
    const before = captureGitSnapshot(repo);

    // Agent does NOT touch foo.json. Capture `after`.
    const after = captureGitSnapshot(repo);

    // foo.json still in `after.status` AND hashes match `before`.
    expect(after.status.some((l) => l.includes("foo.json"))).toBe(true);
    expect(before.workTreeHashes.get("foo.json")).toBe(
      after.workTreeHashes.get("foo.json"),
    );

    const real = contentHashDelta(before, after, repo);
    expect(real.length).toBe(0); // user's pre-existing dirty NOT misattributed
  });

  // T3.1.10 — validatePostAgentHygiene end-to-end uses content-hash delta.
  it("T3.1.10: validatePostAgentHygiene passes when foo.json is unchanged across agent run", () => {
    initRepo();
    commit("foo.json", "V1\n");
    fs.writeFileSync(path.join(repo, "foo.json"), "V2\n"); // pre-existing dirty
    const before = captureGitSnapshot(repo);

    // Agent does nothing. (No commit, no file touch.)
    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "test",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  // T3.1.11 — validatePostAgentHygiene fails when agent dirties a clean file.
  it("T3.1.11: validatePostAgentHygiene fails when agent modifies a clean file", () => {
    initRepo();
    commit("foo.txt", "clean\n");
    const before = captureGitSnapshot(repo);

    fs.writeFileSync(path.join(repo, "foo.txt"), "AGENT-MOD\n");
    const verdict = validatePostAgentHygiene({
      cwd: repo,
      before,
      label: "test",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("foo.txt");
  });
});
