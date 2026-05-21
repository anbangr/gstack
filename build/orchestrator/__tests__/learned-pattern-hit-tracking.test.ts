/**
 * Tests for learned-pattern hit-counter increment (T14) and edge cases.
 *
 * Coverage:
 *   - T14: Static detector match increments hitCount and updates lastHit
 *   - Concurrent writers: two parallel detections do not lose updates
 *   - Malformed entry: missing category is logged and skipped, not crashed
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { detectSkillFaults, loadLearnedPatterns } from "../skill-fault-detector";
import { drainFaultsFromHaltEventsQueue } from "../drain-faults";
import { emitHaltEvent } from "../halt-events";
import { useIsolatedGstackHome } from "../../../test/helpers/test-home";

describe("hit-counter increment (T14)", () => {
  useIsolatedGstackHome("hit-track-");

  test("static detector match increments hitCount and updates lastHit", () => {
    const home = process.env.GSTACK_HOME!;
    const learnedFile = path.join(home, "skill-faults", "learned-patterns.json");
    fs.mkdirSync(path.dirname(learnedFile), { recursive: true });

    const beforeLastHit = "2026-05-14T10:00:00.000Z";
    fs.writeFileSync(
      learnedFile,
      JSON.stringify([
        {
          category: "HAND_MERGED_FEATURE",
          severity: "HIGH",
          description: "hand merged feature",
          matcherKind: "state_jsonpath",
          pattern: "$.features[*]",
          source: "test",
          learnedAt: "2026-01-01T00:00:00Z",
          hitCount: 4,
          lastHit: beforeLastHit,
        },
      ]),
    );

    // Trigger HAND_MERGED_FEATURE static detection
    const state = {
      phases: [],
      features: [
        { number: "1", status: "committed", mergeSha: "abc", prNumber: 1 },
      ],
    } as any;

    detectSkillFaults(
      {
        state,
        livingPlanPath: "/x",
        worktreePath: "/x",
        stateDir: "/x",
        stdoutLogPath: "/x",
      },
      loadLearnedPatterns(),
    );

    const updated = JSON.parse(fs.readFileSync(learnedFile, "utf8"));
    expect(updated).toHaveLength(1);
    expect(updated[0].hitCount).toBe(5);
    expect(updated[0].lastHit).not.toBe(beforeLastHit);
    expect(typeof updated[0].lastHit).toBe("string");
    expect(updated[0].lastHit).toContain("T"); // ISO string
  });
});

describe("concurrent hit-counter writers", () => {
  useIsolatedGstackHome("hit-race-");

  test("two parallel writers do not lose updates", async () => {
    const home = process.env.GSTACK_HOME!;
    const learnedFile = path.join(home, "skill-faults", "learned-patterns.json");
    fs.mkdirSync(path.dirname(learnedFile), { recursive: true });

    fs.writeFileSync(
      learnedFile,
      JSON.stringify([
        {
          category: "RACE_TEST",
          severity: "HIGH",
          description: "race test",
          matcherKind: "stdout_contains",
          pattern: "race trigger",
          source: "test",
          learnedAt: "2026-01-01T00:00:00Z",
          hitCount: 0,
        },
      ]),
    );

    const stdoutPath = path.join(home, "stdout.log");
    fs.writeFileSync(stdoutPath, "race trigger");

    const script = `
import { detectSkillFaults, loadLearnedPatterns } from "${path.resolve(__dirname, "..", "skill-fault-detector.ts").replace(/\\/g, "/")}";
for (let i = 0; i < 50; i++) {
  detectSkillFaults({
    state: { phases: [], features: [] },
    livingPlanPath: "/x",
    worktreePath: "/x",
    stateDir: "/x",
    stdoutLogPath: "${stdoutPath.replace(/\\/g, "\\")}",
  }, loadLearnedPatterns());
}
`;
    const scriptPath = path.join(home, "race.ts");
    fs.writeFileSync(scriptPath, script);

    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("bun", ["run", scriptPath], {
          env: { ...process.env, GSTACK_HOME: home },
          stdio: "ignore",
        });
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`exit ${code}`));
        });
        child.on("error", reject);
      });

    await Promise.all([run(), run(), run(), run()]);

    const updated = JSON.parse(fs.readFileSync(learnedFile, "utf8"));
    expect(updated[0].hitCount).toBe(200);
  });
});

describe("malformed learned-patterns entry", () => {
  useIsolatedGstackHome("hit-malformed-");

  test("missing category is logged and skipped without crashing", () => {
    const home = process.env.GSTACK_HOME!;
    const learnedFile = path.join(home, "skill-faults", "learned-patterns.json");
    fs.mkdirSync(path.dirname(learnedFile), { recursive: true });

    fs.writeFileSync(
      learnedFile,
      JSON.stringify([
        {
          severity: "HIGH",
          description: "missing category",
          matcherKind: "stdout_contains",
          pattern: "test",
          source: "test",
          learnedAt: "2026-01-01T00:00:00Z",
          hitCount: 99,
        },
        {
          category: "VALID_ENTRY",
          severity: "HIGH",
          description: "valid entry",
          matcherKind: "stdout_contains",
          pattern: "valid",
          source: "test",
          learnedAt: "2026-01-01T00:00:00Z",
          hitCount: 3,
        },
      ]),
    );

    const stdoutPath = path.join(home, "stdout.log");
    fs.writeFileSync(stdoutPath, "valid");

    const logs: string[] = [];
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...args: any[]) => logs.push(args.join(" "));
    console.error = (...args: any[]) => logs.push(args.join(" "));

    try {
      detectSkillFaults(
        {
          state: { phases: [], features: [] } as any,
          livingPlanPath: "/x",
          worktreePath: "/x",
          stateDir: "/x",
          stdoutLogPath: stdoutPath,
        },
        loadLearnedPatterns(),
      );
    } finally {
      console.warn = origWarn;
      console.error = origError;
    }

    // Should not crash — if we got here, no throw
    expect(true).toBe(true);

    const updated = JSON.parse(fs.readFileSync(learnedFile, "utf8"));
    const valid = updated.find((e: any) => e.category === "VALID_ENTRY");
    expect(valid.hitCount).toBe(4);

    // Implementation should log about malformed entry
    const hasLog = logs.some(
      (l) =>
        l.toLowerCase().includes("malformed") ||
        l.toLowerCase().includes("missing") ||
        l.toLowerCase().includes("category") ||
        l.toLowerCase().includes("learned"),
    );
    expect(hasLog).toBe(true);
  });
});

describe("drain-faults dedup for halt events (T10 behaviour)", () => {
  useIsolatedGstackHome("drain-dedup-");

  test("two halt events with same kind and matching evidence produce only one processed entry", async () => {
    const home = process.env.GSTACK_HOME!;

    const baseEvent = {
      kind: "PROVIDER_QUOTA_EXHAUSTED" as const,
      runId: "r1",
      stateSlug: "s1",
      severity: "HIGH" as const,
      message: "quota exhausted",
      pointers: {
        stateFile: "/x",
        stdoutLog: "/x",
        livingPlan: "/x",
        worktreePath: "/x",
      },
      snapshot: { stdoutTail: "", failureReason: "quota" },
    };

    // Two events with different messages but same underlying evidence
    emitHaltEvent({ ...baseEvent, message: "quota exhausted on codex" }, { queueDir: home });
    emitHaltEvent({ ...baseEvent, message: "quota exhausted on gemini" }, { queueDir: home });

    const result = await drainFaultsFromHaltEventsQueue({
      queueDir: home,
      inboxDir: path.join(home, "inbox"),
      mockInvestigator: () => ({
        outcome: "root-cause-identified",
        rootCause: "quota",
        evidence: [],
        proposedFix: { options: [] },
      }),
    });

    expect(result.processed).toBe(1);
  });
});
