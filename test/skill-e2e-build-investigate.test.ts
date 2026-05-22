import { test, expect, beforeAll, afterAll } from "bun:test";
import { runSkillTest } from "./helpers/session-runner";
import {
  ROOT,
  runId,
  describeIfSelected,
} from "./helpers/e2e-helpers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describeIfSelected("Build investigate E2E", ["build-investigate-bug-report"], () => {
  let tmpRoot: string;
  let faultsDir: string;
  let inboxDir: string;
  let haltEvent: any;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-e2e-investigate-"));
    faultsDir = path.join(tmpRoot, "skill-faults");
    inboxDir = path.join(tmpRoot, "inbox");
    fs.mkdirSync(path.join(faultsDir, "pending-investigations"), {
      recursive: true,
    });
    fs.mkdirSync(inboxDir, { recursive: true });

    haltEvent = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "fixtures/investigate/halt-event-codex-convergence.json",
        ),
        "utf8",
      ),
    );

    const statePath = path.join(tmpRoot, "state.json");
    const stdoutPath = path.join(tmpRoot, "stdout.log");
    const planPath = path.join(tmpRoot, "living-plan.md");

    fs.copyFileSync(
      path.resolve(
        __dirname,
        "fixtures/investigate/state-with-recent-errors.json",
      ),
      statePath,
    );
    fs.copyFileSync(
      path.resolve(__dirname, "fixtures/investigate/stdout-log.txt"),
      stdoutPath,
    );
    fs.writeFileSync(
      planPath,
      "# Living plan\n\nPhase 3: Wire up the CLI (no acceptance criteria specified).\n",
    );

    haltEvent.pointers.stateFile = statePath;
    haltEvent.pointers.stdoutLog = stdoutPath;
    haltEvent.pointers.livingPlan = planPath;
    haltEvent.pointers.worktreePath = tmpRoot;

    fs.writeFileSync(
      path.join(
        faultsDir,
        "pending-investigations",
        `${haltEvent.runId}-${haltEvent.faultId}.json`,
      ),
      JSON.stringify(haltEvent),
    );

    // Extract just the /build investigate methodology section so the
    // agent's context stays small (~30 lines vs the full 2k-line SKILL.md).
    const buildSkill = fs.readFileSync(
      path.resolve(ROOT, "build", "SKILL.md"),
      "utf8",
    );
    const startIdx = buildSkill.indexOf(
      "## /build investigate — manual fault investigation",
    );
    const slice =
      startIdx >= 0
        ? buildSkill.slice(startIdx, startIdx + 4000)
        : buildSkill.slice(0, 4000);
    fs.writeFileSync(path.join(tmpRoot, "build-investigate-skill.md"), slice);
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // swallow cleanup errors
    }
  });

  test(
    "build-investigate-bug-report",
    async () => {
      const reportPath = path.join(tmpRoot, "report.json");
      const prompt = `You are testing the /build investigate subcommand.

Read ${path.join(tmpRoot, "build-investigate-skill.md")} for the methodology.

Then:

1. Run: gstack-build investigate ${haltEvent.faultId}
   Parse the briefing block between <<<GSTACK_INVESTIGATE_BRIEFING>>> and <<<END>>>.

2. Read the file pointers in the briefing (statePath, stdoutLogPath, livingPlanPath) to investigate.

3. Write your InvestigationReport JSON to ${reportPath}. The schema is in build/orchestrator/investigator-dispatch.ts:24-56. The faultId field MUST equal "${haltEvent.faultId}". Set outcome to "root-cause-identified" if you can identify the root cause, propose at least one fix option, and (if applicable) include a learnedPatternProposal.

4. Run: gstack-build investigate-finalize --run-id ${haltEvent.runId} --fault-id ${haltEvent.faultId} --report ${reportPath}

5. Report back the final paths (machine report and bug report).`;

      const result = await runSkillTest({
        prompt,
        workingDirectory: ROOT,
        maxTurns: 25,
        timeout: 10 * 60 * 1000,
        testName: "build-investigate-bug-report",
        runId,
        env: {
          GSTACK_HOME: tmpRoot,
          GSTACK_INBOX_DIR: inboxDir,
        },
      });

      const machineReport = path.join(
        faultsDir,
        haltEvent.runId,
        `${haltEvent.faultId}.md`,
      );
      expect(fs.existsSync(machineReport)).toBe(true);
      const machineContent = fs.readFileSync(machineReport, "utf8");
      expect(
        /acceptance|convergence|loop|never converged|iteration cap/i.test(
          machineContent,
        ),
      ).toBe(true);

      const inboxFiles = fs.readdirSync(inboxDir);
      const bugReport = inboxFiles.find((n) => n.startsWith("BUGREPORT-"));
      expect(bugReport).toBeDefined();
      const bugContent = fs.readFileSync(
        path.join(inboxDir, bugReport!),
        "utf8",
      );
      expect(bugContent).toContain("# Bug:");
      expect(bugContent).toContain("### Option 1:");
    },
    10 * 60 * 1000,
  );
});
