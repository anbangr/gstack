import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInvestigateFinalize,
  type InvestigateFinalizeArgs,
} from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-finalize-val-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const inboxDir = path.join(tmpRoot, "inbox");

let stderrBuf = "";
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  stderrBuf = "";
  process.stderr.write = ((chunk: any) => {
    stderrBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stderr.write = origStderr;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("investigate-finalize JSON validation", () => {
  test("invalid JSON → exit 2, no artifacts written", async () => {
    const reportPath = path.join(tmpRoot, "bad.json");
    fs.writeFileSync(reportPath, "{not valid json");
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir, inboxDir,
    });
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(faultsDir, "run-Z"))).toBe(false);
  });

  test("missing rootCause field → exit 2", async () => {
    const reportPath = path.join(tmpRoot, "missing.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        faultId: "CAT:p0:abc",
        outcome: "root-cause-identified",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    );
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir, inboxDir,
    });
    expect(code).toBe(2);
    expect(stderrBuf).toContain("rootCause");
  });

  test("invalid outcome value → exit 2", async () => {
    const reportPath = path.join(tmpRoot, "bad-outcome.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        faultId: "CAT:p0:abc",
        outcome: "not-a-real-outcome",
        rootCause: "x",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    );
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      faultsDir, inboxDir,
    });
    expect(code).toBe(2);
    expect(stderrBuf).toContain("invalid outcome");
  });

  test("needs-human outcome → exit 1, artifacts still written", async () => {
    const reportPath = path.join(tmpRoot, "human.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        faultId: "CAT:p0:abc",
        outcome: "needs-human",
        rootCause: "cannot determine without more context",
        evidence: [],
        proposedFix: null,
        learnedPatternProposal: null,
      }),
    );
    const { acquireFaultLock } = await import("../investigate-lock");
    acquireFaultLock({ runId: "run-Z", faultId: "CAT:p0:abc", faultsDir });
    const code = await runInvestigateFinalize({
      runId: "run-Z",
      faultId: "CAT:p0:abc",
      reportPath,
      severity: "HIGH",
      faultsDir, inboxDir,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(faultsDir, "run-Z", "CAT:p0:abc.md"))).toBe(true);
  });
});
