import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInvestigateMode,
  runInvestigateFinalize,
  type InvestigateModeArgs,
  type InvestigateFinalizeArgs,
} from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-mode-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");
const inboxDir = path.join(tmpRoot, "inbox");

let stdoutBuf = "";
let stderrBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  stdoutBuf = "";
  stderrBuf = "";
  process.stdout.write = ((chunk: any) => {
    stdoutBuf += chunk.toString();
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    stderrBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runInvestigateMode exit codes", () => {
  test("exit 2 when --state path does not exist", async () => {
    const args: InvestigateModeArgs = {
      statePath: "/nonexistent/state.json",
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("state file not found");
  });

  test("exit 2 when --fault-id given but not found", async () => {
    const args: InvestigateModeArgs = {
      faultId: "MISSING:p0:notthere",
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("fault not found");
  });

  test("exit 3 when nothing auto-detects and non-TTY", async () => {
    const args: InvestigateModeArgs = {
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(3);
    expect(stderrBuf).toContain("no context auto-detected");
  });

  test("exit 0 and emits briefing block when symptoms given", async () => {
    const args: InvestigateModeArgs = {
      symptoms: "build halts on phase 3 every time",
      faultsDir, activeRunsRegistryDir: activeRunsDir,

    };
    const code = await runInvestigateMode(args);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("<<<GSTACK_INVESTIGATE_BRIEFING>>>");
    expect(stdoutBuf).toContain("<<<END>>>");
    const jsonMatch = stdoutBuf.match(
      /<<<GSTACK_INVESTIGATE_BRIEFING>>>\n([\s\S]+?)\n<<<END>>>/,
    );
    expect(jsonMatch).not.toBeNull();
    const briefing = JSON.parse(jsonMatch![1]);
    expect(briefing.symptoms).toContain("phase 3");
    expect(briefing.faultId).toMatch(/^MANUAL_INVESTIGATION:/);
  });
});

describe("runInvestigateFinalize exit codes", () => {
  test("exit 2 when report file missing", async () => {
    const args: InvestigateFinalizeArgs = {
      runId: "run-X",
      faultId: "CAT:p0:abc",
      reportPath: "/nonexistent/report.json",
      faultsDir, inboxDir,
    };
    const code = await runInvestigateFinalize(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("report file not found");
  });

  test("exit 2 when report faultId does not match --fault-id", async () => {
    const reportPath = path.join(tmpRoot, "bad.json");
    fs.writeFileSync(
      reportPath,
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../test/fixtures/investigate/canned-report-bad-faultid.json",
        ),
        "utf8",
      ),
    );
    const args: InvestigateFinalizeArgs = {
      runId: "run-X",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir, inboxDir,
    };
    const code = await runInvestigateFinalize(args);
    expect(code).toBe(2);
    expect(stderrBuf).toContain("faultId mismatch");
  });

  test("exit 0 and writes both artifacts on valid HIGH report", async () => {
    const reportPath = path.join(tmpRoot, "good.json");
    const canned = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../test/fixtures/investigate/canned-report-success.json",
        ),
        "utf8",
      ),
    );
    fs.writeFileSync(reportPath, JSON.stringify(canned));
    const { acquireFaultLock } = await import("../investigate-lock");
    acquireFaultLock({
      runId: "test-run-investigate-001",
      faultId: canned.faultId,
      faultsDir,
    });
    const args: InvestigateFinalizeArgs = {
      runId: "test-run-investigate-001",
      faultId: canned.faultId,
      reportPath,
      severity: "HIGH",
      faultsDir, inboxDir,
    };
    const code = await runInvestigateFinalize(args);
    expect(code).toBe(0);
    expect(
      fs.existsSync(
        path.join(faultsDir, "test-run-investigate-001", `${canned.faultId}.md`),
      ),
    ).toBe(true);
    const inboxFiles = fs.readdirSync(inboxDir);
    expect(inboxFiles.some((n) => n.startsWith("BUGREPORT-"))).toBe(true);
  });
});
