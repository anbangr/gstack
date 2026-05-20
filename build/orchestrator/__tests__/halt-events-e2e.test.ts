import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  emitHaltEvent,
  loadPendingInvestigations,
  markInvestigated,
  processedDir,
} from "../halt-events";
import { detectSkillFaults } from "../skill-fault-detector";
import { useIsolatedGstackHome } from "../../../test/helpers/test-home";

/**
 * Gate-tier E2E pin for the 2026-05-17 polis hand-merged-feature regression.
 *
 * Scope (PR 4 only): detector fires, halt event is queued + readable +
 * moveable to processed. Full investigator round-trip (drain-faults → codex
 * dispatch) lands in PR 5; this test exercises only the foundation +
 * detector pipeline.
 */
describe("halt-events e2e: polis HAND_MERGED_FEATURE regression", () => {
  useIsolatedGstackHome("halt-events-e2e-");

  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "he-e2e-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("polis fixture → detector fires HAND_MERGED_FEATURE", () => {
    const state = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "halt-events",
          "hand-merged-feature-state.json",
        ),
        "utf8",
      ),
    );
    const out = detectSkillFaults({
      state,
      livingPlanPath: "/x",
      worktreePath: "/x",
      stateDir: "/x",
      stdoutLogPath: "/x",
    });
    expect(out.length).toBeGreaterThan(0);
    const f = out.find((x) => x.category === "HAND_MERGED_FEATURE");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("HIGH");
  });

  test("emit halt event → load → mark investigated round trip", () => {
    const state = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "halt-events",
          "hand-merged-feature-state.json",
        ),
        "utf8",
      ),
    );
    const faultId = emitHaltEvent(
      {
        kind: "PHASE_FAILED",
        runId: "polis-mesh-lane-b-r1",
        stateSlug: state.slug,
        severity: "HIGH",
        message:
          "[HAND_MERGED_FEATURE] Feature 1 carries mergeSha+prNumber but completedAt is missing.",
        pointers: {
          stateFile: path.join(tmp, "state.json"),
          stdoutLog: path.join(tmp, "stdout.log"),
          livingPlan: state.planFile,
          worktreePath: tmp,
        },
        snapshot: {
          feature: state.features[0],
          stdoutTail: "",
        },
      },
      { queueDir: tmp },
    );

    const pending = loadPendingInvestigations({ queueDir: tmp });
    expect(pending.length).toBe(1);
    expect(pending[0].faultId).toBe(faultId);
    expect(pending[0].snapshot.feature?.mergeSha).toBe(
      state.features[0].mergeSha,
    );

    markInvestigated("polis-mesh-lane-b-r1", faultId, "investigated", {
      queueDir: tmp,
    });

    const afterDrain = loadPendingInvestigations({ queueDir: tmp });
    expect(afterDrain.length).toBe(0);

    const processed = fs.readdirSync(processedDir({ queueDir: tmp }));
    expect(processed.length).toBe(1);
  });
});
