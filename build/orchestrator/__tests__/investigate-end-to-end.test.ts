import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInvestigateMode,
  runInvestigateFinalize,
} from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-e2e-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const inboxDir = path.join(tmpRoot, "inbox");

const FIXTURE_HALT = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/halt-event-codex-convergence.json",
);
const FIXTURE_REPORT = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/canned-report-success.json",
);

let stdoutBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(path.join(faultsDir, "pending-investigations"), { recursive: true });
  const event = JSON.parse(fs.readFileSync(FIXTURE_HALT, "utf8"));
  fs.writeFileSync(
    path.join(faultsDir, "pending-investigations", `${event.runId}-${event.faultId}.json`),
    JSON.stringify(event),
  );
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

describe("end-to-end /build investigate flow", () => {
  test("briefing → finalize writes both artifacts", async () => {
    const event = JSON.parse(fs.readFileSync(FIXTURE_HALT, "utf8"));
    const code1 = await runInvestigateMode({
      faultId: event.faultId,
      faultsDir,
      activeRunsRegistryDir: path.join(tmpRoot, "active-runs-empty"),
      ttyAvailable: false,
    });
    expect(code1).toBe(0);
    expect(stdoutBuf).toContain("<<<GSTACK_INVESTIGATE_BRIEFING>>>");
    const jsonMatch = stdoutBuf.match(
      /<<<GSTACK_INVESTIGATE_BRIEFING>>>\n([\s\S]+?)\n<<<END>>>/,
    );
    const briefing = JSON.parse(jsonMatch![1]);
    expect(briefing.faultId).toBe(event.faultId);
    expect(briefing.runId).toBe(event.runId);

    const reportPath = path.join(tmpRoot, "report.json");
    fs.copyFileSync(FIXTURE_REPORT, reportPath);

    const code2 = await runInvestigateFinalize({
      runId: event.runId,
      faultId: event.faultId,
      reportPath,
      severity: "HIGH",
      faultsDir, inboxDir,
    });
    expect(code2).toBe(0);

    const machineReportPath = path.join(faultsDir, event.runId, `${event.faultId}.md`);
    expect(fs.existsSync(machineReportPath)).toBe(true);
    const machineContent = fs.readFileSync(machineReportPath, "utf8");
    expect(machineContent).toContain("does not specify a stop condition");
    expect(machineContent).toContain("root-cause-identified");

    const inboxFiles = fs.readdirSync(inboxDir);
    const bugReport = inboxFiles.find((n) => n.startsWith("BUGREPORT-"));
    expect(bugReport).toBeDefined();
    const bugContent = fs.readFileSync(path.join(inboxDir, bugReport!), "utf8");
    expect(bugContent).toContain("# Bug:");
    expect(bugContent).toContain("**Severity:** HIGH");
    expect(bugContent).toContain("does not specify a stop condition");
    expect(bugContent).toContain("Add an explicit acceptance checklist");
  });
});
