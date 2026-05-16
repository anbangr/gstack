/**
 * Tests for the read-only `gstack-build doctor` audit.
 *
 * The doctor is exercised both:
 *   - directly as a pure function (buildDoctorReport) so we can assert
 *     finding shapes precisely;
 *   - via the subprocess CLI path so we cover the dispatch + exit-code
 *     contract a user actually depends on.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildDoctorReport,
  renderDoctorReport,
  resolveLogDirForState,
} from "../build-doctor";
import type { BuildState } from "../types";

const CLI = path.resolve(__dirname, "..", "cli.ts");

interface Fixture {
  dir: string;
  planFile: string;
  stateFile: string;
  logDir: string;
  state: BuildState;
  planContent: string;
  cleanup: () => void;
}

function setupFixture(opts?: {
  planContent?: string;
  stateOverride?: Partial<BuildState>;
  /** Optional: pre-create the log dir + artifacts inline. */
  artifacts?: Record<string, string>;
}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
  const planFile = path.join(dir, "plan.md");
  const planContent =
    opts?.planContent ??
    `# Plan\n\n### Phase 1: Foo\n- [ ] **Implementation**: do\n- [ ] **Review**: rev\n\n### Phase 2: Bar\n- [ ] **Implementation**: do\n- [ ] **Review**: rev\n`;
  fs.writeFileSync(planFile, planContent);

  const stateFile = path.join(dir, "state.json");
  const baseState: BuildState = {
    planFile,
    phases: [
      { index: 0, number: "1", name: "Foo", status: "pending" },
      { index: 1, number: "2", name: "Bar", status: "pending" },
    ],
    ...(opts?.stateOverride ?? {}),
  } as BuildState;
  fs.writeFileSync(stateFile, JSON.stringify(baseState, null, 2));

  const logDir = resolveLogDirForState(stateFile);
  if (opts?.artifacts) {
    fs.mkdirSync(logDir, { recursive: true });
    for (const [name, body] of Object.entries(opts.artifacts)) {
      fs.writeFileSync(path.join(logDir, name), body);
    }
  }

  return {
    dir,
    planFile,
    stateFile,
    logDir,
    state: baseState,
    planContent,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("buildDoctorReport — clean states", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("returns HEALTHY (no findings) when all phases are pending and no artifacts exist", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    const report = buildDoctorReport({
      planFile: f.planFile,
      stateFile: f.stateFile,
      state: f.state,
      planContent: f.planContent,
      logDir: f.logDir,
    });
    expect(report.findings).toEqual([]);
    expect(report.worstSeverity).toBe(null);
    expect(renderDoctorReport(report)).toContain("HEALTHY");
  });
});

describe("buildDoctorReport — P0 findings", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("flags committed phase with null codexReview but artifacts on disk (F2 signature)", () => {
    // The exact F2 case from the investigation: state.phases[0].status =
    // "committed", codexReview = null, but artifacts exist on disk.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: null,
          } as unknown as BuildState["phases"][number],
          {
            index: 1,
            number: "2",
            name: "Bar",
            status: "pending",
          } as BuildState["phases"][number],
        ],
      },
      // Also ensure the plan rows ARE checked so we don't get the
      // secondary "committed-with-unchecked-plan-row" finding clouding
      // this assertion.
      planContent: `# Plan\n\n### Phase 1: Foo\n- [x] **Implementation**: do\n- [x] **Review**: rev\n\n### Phase 2: Bar\n- [ ] **Implementation**: do\n- [ ] **Review**: rev\n`,
      artifacts: {
        "phase-1-review-1-output.md": "review iter 1\n",
        "phase-1-qa-1-output.md": "qa iter 1\n",
      },
    });
    cleanup = f.cleanup;
    const report = buildDoctorReport({
      planFile: f.planFile,
      stateFile: f.stateFile,
      state: f.state,
      planContent: f.planContent,
      logDir: f.logDir,
    });
    expect(report.worstSeverity).toBe("P0");
    const p0 = report.findings.find(
      (x) => x.check === "committed-null-review-with-artifacts",
    );
    expect(p0).toBeDefined();
    expect(p0!.message).toContain("Phase 1");
    expect(p0!.message).toContain("2 artifact(s)");
    expect(p0!.remediation).toContain(
      "gstack-build reconcile --from-artifacts",
    );
  });

  it("flags committed phase with unchecked plan checkboxes (F1+F2 living-plan signature)", () => {
    // state.phases[0].status="committed" but the plan row still shows `[ ]`.
    // Doctor must name this as P0 — silent visual drift the user reported.
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            // codexReview populated so we DON'T also trigger the
            // "committed-null-review-with-artifacts" finding.
            codexReview: {
              iterations: 1,
              outputLogPaths: [],
            },
          } as BuildState["phases"][number],
        ],
      },
    });
    cleanup = f.cleanup;
    const report = buildDoctorReport({
      planFile: f.planFile,
      stateFile: f.stateFile,
      state: f.state,
      planContent: f.planContent,
      logDir: f.logDir,
    });
    const p0 = report.findings.find(
      (x) => x.check === "committed-with-unchecked-plan-row",
    );
    expect(p0).toBeDefined();
    expect(p0!.severity).toBe("P0");
    expect(p0!.message).toContain("Phase 1");
    expect(p0!.message).toMatch(/\d+ unchecked checkbox/);
    expect(p0!.remediation).toContain("gstack-build reconcile");
    expect(p0!.remediation).not.toContain("--from-artifacts"); // checkbox-only fix
  });
});

describe("buildDoctorReport — P1 findings", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("flags stale state.planFile pointing to a missing file", () => {
    const f = setupFixture({
      stateOverride: {
        planFile: "/some/path/that/does/not/exist.md",
      } as Partial<BuildState>,
    });
    cleanup = f.cleanup;
    // Doctor uses the state object's planFile, not the on-disk planFile arg.
    const report = buildDoctorReport({
      planFile: f.planFile,
      stateFile: f.stateFile,
      state: f.state,
      planContent: f.planContent,
      logDir: f.logDir,
    });
    const finding = report.findings.find(
      (x) => x.check === "stale-state-planFile",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("P1");
  });

  it("flags orphan artifacts referencing phases not present in state", () => {
    const f = setupFixture({
      // Only phase numbers "1" and "2" in state.
      artifacts: {
        // Belongs to phase "999" — orphan.
        "phase-999-review-1-output.md": "orphan review\n",
      },
    });
    cleanup = f.cleanup;
    const report = buildDoctorReport({
      planFile: f.planFile,
      stateFile: f.stateFile,
      state: f.state,
      planContent: f.planContent,
      logDir: f.logDir,
    });
    const finding = report.findings.find(
      (x) => x.check === "orphan-artifact-phase",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("P1");
    expect(finding!.message).toContain("999");
  });
});

describe("gstack-build doctor CLI", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("exits 0 on healthy state and prints HEALTHY", () => {
    const f = setupFixture();
    cleanup = f.cleanup;
    const r = spawnSync(
      "bun",
      ["run", CLI, "doctor", "--plan", f.planFile, "--state", f.stateFile],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("HEALTHY");
  });

  it("exits 1 on P0 drift (committed phase + on-disk artifacts + nulled review)", () => {
    const f = setupFixture({
      stateOverride: {
        phases: [
          {
            index: 0,
            number: "1",
            name: "Foo",
            status: "committed",
            codexReview: null,
          } as unknown as BuildState["phases"][number],
        ],
      },
      planContent: `# Plan\n\n### Phase 1: Foo\n- [x] **Implementation**: do\n- [x] **Review**: rev\n`,
      artifacts: {
        "phase-1-review-1-output.md": "review\n",
      },
    });
    cleanup = f.cleanup;
    const r = spawnSync(
      "bun",
      ["run", CLI, "doctor", "--plan", f.planFile, "--state", f.stateFile],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[P0]");
    expect(r.stdout).toContain("gstack-build reconcile --from-artifacts");
  });
});
