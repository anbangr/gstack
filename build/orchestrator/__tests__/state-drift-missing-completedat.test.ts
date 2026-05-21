/**
 * Tests for PR8 Phase 2 — STATE_DRIFT:missing_completedAt warning.
 *
 * T9:  State JSON with `status: 'committed', completedAt: undefined` triggers
 *      a warning naming the feature and suggesting the recovery command.
 * T10: The warning is a warning, not a halt — build continues, no halt event.
 *
 * Edge cases:
 *   - State missing both completedAt AND status logs a separate warning and
 *     does not crash.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, statePath } from "../state";
import { loadPendingInvestigations } from "../halt-events";

// We test the state-load path in state.ts (via loadState → migrateState).
// The STATE_DRIFT warning logic does not exist until the primary-impl role
// adds it, so these tests start red.

describe("STATE_DRIFT:missing_completedAt warning", () => {
  let realStateDir: string | undefined;
  let tmpStateDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    tmpStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-drift-"),
    );
    process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmpStateDir;
  });

  afterEach(() => {
    if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
    else delete process.env.GSTACK_BUILD_STATE_DIR;
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  function writeDriftState(slug: string, extra?: Record<string, unknown>): void {
    const state = {
      planFile: "/x/plan.md",
      planBasename: "plan",
      slug,
      branch: "main",
      startedAt: "2026-05-21T00:00:00.000Z",
      lastUpdatedAt: "2026-05-21T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      phases: [
        { index: 0, number: "1", name: "Phase 1", status: "committed" },
      ],
      features: [
        {
          index: 0,
          number: "1",
          name: "Feature One",
          phaseIndexes: [0],
          status: "committed",
          // completedAt is intentionally absent to trigger STATE_DRIFT
        },
      ],
      completed: false,
      ...extra,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2));
  }

  test("T9: warning logged with feature name and recovery command hint", () => {
    const slug = "build-drift-t9";
    writeDriftState(slug);

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      const loaded = loadState(slug, { noGbrain: true });
      expect(loaded).not.toBeNull();
    } finally {
      console.warn = origWarn;
    }

    const driftMsg = warns.find((w) => w.includes("STATE_DRIFT:missing_completedAt"));
    expect(driftMsg).toBeDefined();
    expect(driftMsg).toContain("Feature One");
    expect(driftMsg).toContain("gstack-build mark-shipped");
    expect(driftMsg).toContain("--feature 1");
  });

  test("T10: warning only — build continues, no halt event recorded", () => {
    const slug = "build-drift-t10";
    writeDriftState(slug);

    const origWarn = console.warn;
    console.warn = () => {}; // swallow
    try {
      const loaded = loadState(slug, { noGbrain: true });
      expect(loaded).not.toBeNull();
      expect(loaded!.features![0].status).toBe("committed");
    } finally {
      console.warn = origWarn;
    }

    const pending = loadPendingInvestigations({
      queueDir: path.join(tmpStateDir, "skill-faults"),
    });
    const driftEvents = pending.filter((e) => e.kind === "STATE_DRIFT");
    expect(driftEvents.length).toBe(0);
  });

  test("edge: missing both completedAt and status — logs warning, does not crash", () => {
    const slug = "build-drift-broken";
    const state = {
      planFile: "/x/plan.md",
      planBasename: "plan",
      slug,
      branch: "main",
      startedAt: "2026-05-21T00:00:00.000Z",
      lastUpdatedAt: "2026-05-21T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      phases: [
        { index: 0, number: "1", name: "Phase 1", status: "committed" },
      ],
      features: [
        {
          index: 0,
          number: "1",
          name: "Broken Feature",
          phaseIndexes: [0],
          // status is missing
          // completedAt is missing
        },
      ],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2));

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      const loaded = loadState(slug, { noGbrain: true });
      expect(loaded).not.toBeNull();
    } finally {
      console.warn = origWarn;
    }

    // At minimum we expect a STATE_DRIFT warning about missing status.
    const statusWarning = warns.find((w) =>
      w.includes("STATE_DRIFT") && w.includes("missing status"),
    );
    expect(statusWarning).toBeDefined();
  });
});
