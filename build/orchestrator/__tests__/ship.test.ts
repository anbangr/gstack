import { describe, it, expect, spyOn, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as subAgents from "../sub-agents";
import { shipOnly, landOnly, shipAndDeploy } from "../ship";

describe("ship module", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-ship-test-"));
    prevStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    process.env.GSTACK_BUILD_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
    else process.env.GSTACK_BUILD_STATE_DIR = prevStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("shipOnly generates correct input prompt", async () => {
    const slug = "ship-only";
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

    await shipOnly({
      cwd: "/tmp/repo",
      slug,
      shipRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-ship",
      },
    });

    const inputFile = path.join(stateDir, slug, "ship-input.md");
    expect(fs.existsSync(inputFile)).toBe(true);
    const prompt = fs.readFileSync(inputFile, "utf8");
    expect(prompt).toContain("/gstack-ship");
    expect(prompt).toContain("Report exactly what happened");

    runSlashCommandSpy.mockRestore();
  });

  it("landOnly generates correct unscoped input prompt", async () => {
    const slug = "land-unscoped";
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
    expect(fs.existsSync(inputFile)).toBe(true);
    const prompt = fs.readFileSync(inputFile, "utf8");
    expect(prompt).toContain("/gstack-land-and-deploy");
    expect(prompt).toContain("Report exactly what happened");

    runSlashCommandSpy.mockRestore();
  });

  it("landOnly accepts optional prNumber and featureBranch parameters", async () => {
    const slug = "land-params";
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

    // Should not throw when called with the new parameters
    await landOnly({
      cwd: "/tmp/repo",
      slug,
      landRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-land-and-deploy",
      },
      prNumber: 789,
      featureBranch: "feature/z",
    } as any);

    runSlashCommandSpy.mockRestore();
  });

  it("shipAndDeploy runs ship then land", async () => {
    const slug = "ship-deploy";
    const calls: string[] = [];

    const runShipSpy = spyOn(subAgents, "runShip").mockImplementation(
      async (opts: any) => {
        calls.push(opts.ship.command);
        calls.push(opts.land.command);
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: "/tmp/log",
          durationMs: 1,
          retries: 0,
        };
      },
    );

    await shipAndDeploy({
      cwd: "/tmp/repo",
      slug,
      shipRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-ship",
      },
      landRole: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoning: "high",
        command: "/gstack-land-and-deploy",
      },
    });

    expect(calls).toContain("/gstack-ship");
    expect(calls).toContain("/gstack-land-and-deploy");

    runShipSpy.mockRestore();
  });
});
