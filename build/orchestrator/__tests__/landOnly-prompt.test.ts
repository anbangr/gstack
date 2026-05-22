import { describe, it, expect, spyOn, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as subAgents from "../sub-agents";
import { landOnly } from "../ship";

describe("landOnly prompt generation", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-land-prompt-"));
    prevStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    process.env.GSTACK_BUILD_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
    else process.env.GSTACK_BUILD_STATE_DIR = prevStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("generates a scoped landing prompt with prNumber and featureBranch", async () => {
    const slug = "scoped-land";
    const runSlashCommandSpy = spyOn(
      subAgents,
      "runSlashCommand",
    ).mockImplementation(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/log",
      durationMs: 1,
      retries: 0,
    }));

    await landOnly({
      cwd: "/tmp/repo",
      slug,
      landRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-land-and-deploy",
      },
      prNumber: 123,
      featureBranch: "feature/x",
    } as any);

    const inputFile = path.join(stateDir, slug, "land-and-deploy-input.md");
    expect(fs.existsSync(inputFile)).toBe(true);
    const prompt = fs.readFileSync(inputFile, "utf8");

    expect(prompt).toContain("PR #123");
    expect(prompt).toContain("feature/x");
    expect(prompt).toContain("land exactly PR #123");
    expect(prompt).toContain("verify branch feature/x");
    expect(prompt).toContain("fail on mismatch");

    runSlashCommandSpy.mockRestore();
  });

  it("falls back to unscoped prompt when prNumber and featureBranch are absent", async () => {
    const slug = "unscoped-land";
    const runSlashCommandSpy = spyOn(
      subAgents,
      "runSlashCommand",
    ).mockImplementation(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/log",
      durationMs: 1,
      retries: 0,
    }));

    await landOnly({
      cwd: "/tmp/repo",
      slug,
      landRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-land-and-deploy",
      },
    });

    const inputFile = path.join(stateDir, slug, "land-and-deploy-input.md");
    const prompt = fs.readFileSync(inputFile, "utf8");

    // Should be the backward-compatible generic prompt
    expect(prompt).toContain("/gstack-land-and-deploy");
    expect(prompt).not.toContain("PR #");
    expect(prompt).not.toContain("verify branch");

    runSlashCommandSpy.mockRestore();
  });

  it("includes branch mismatch failure instruction in scoped prompt", async () => {
    const slug = "scoped-fail-mismatch";
    const runSlashCommandSpy = spyOn(
      subAgents,
      "runSlashCommand",
    ).mockImplementation(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/log",
      durationMs: 1,
      retries: 0,
    }));

    await landOnly({
      cwd: "/tmp/repo",
      slug,
      landRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-land-and-deploy",
      },
      prNumber: 456,
      featureBranch: "feature/y",
    } as any);

    const inputFile = path.join(stateDir, slug, "land-and-deploy-input.md");
    const prompt = fs.readFileSync(inputFile, "utf8");

    expect(prompt).toContain("fail on mismatch");
    expect(prompt).toContain("do not land");

    runSlashCommandSpy.mockRestore();
  });

  it("scoped prompt includes hard targeting instructions", async () => {
    const slug = "hard-target";
    const runSlashCommandSpy = spyOn(
      subAgents,
      "runSlashCommand",
    ).mockImplementation(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/log",
      durationMs: 1,
      retries: 0,
    }));

    await landOnly({
      cwd: "/tmp/repo",
      slug,
      landRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-land-and-deploy",
      },
      prNumber: 999,
      featureBranch: "fix/security-patch",
    } as any);

    const inputFile = path.join(stateDir, slug, "land-and-deploy-input.md");
    const prompt = fs.readFileSync(inputFile, "utf8");

    // Hard targeting instructions must be unambiguous
    expect(prompt).toContain("#999");
    expect(prompt).toContain("fix/security-patch");
    expect(prompt).toContain("origin/fix/security-patch");
    expect(prompt).toContain("current branch");

    runSlashCommandSpy.mockRestore();
  });
});
