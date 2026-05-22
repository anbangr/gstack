import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { tailStdoutLog } from "../investigate-context";

const FIXTURE_LOG = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/stdout-log.txt",
);
const FIXTURE_STATE = path.resolve(
  __dirname,
  "../../../test/fixtures/investigate/state-with-recent-errors.json",
);

describe("tailStdoutLog", () => {
  test("returns last 500 lines when state has no recentErrors", () => {
    const result = tailStdoutLog({
      stdoutPath: FIXTURE_LOG,
      recentErrors: [],
      tailLines: 500,
      windowLines: 50,
    });
    const lines = result.trim().split("\n");
    expect(lines.length).toBe(500);
    expect(lines[lines.length - 1]).toContain("heartbeat 1999");
  });

  test("includes ±50 lines around each recentErrors timestamp", () => {
    const recentErrors = [
      { timestamp: "2026-05-22T10:12:30.000Z", summary: "round 5" },
    ];
    const result = tailStdoutLog({
      stdoutPath: FIXTURE_LOG,
      recentErrors,
      tailLines: 500,
      windowLines: 50,
    });
    expect(result).toContain("codex review round 5 changes-requested");
  });

  test("merges overlapping windows and dedupes lines", () => {
    const recentErrors = [
      { timestamp: "2026-05-22T10:14:55.000Z", summary: "round 7" },
      { timestamp: "2026-05-22T10:14:56.000Z", summary: "cap reached" },
    ];
    const result = tailStdoutLog({
      stdoutPath: FIXTURE_LOG,
      recentErrors,
      tailLines: 0,
      windowLines: 50,
    });
    const round7Count = (result.match(/codex review round 7/g) ?? []).length;
    expect(round7Count).toBe(1);
  });

  test("returns empty string when stdoutPath does not exist", () => {
    expect(
      tailStdoutLog({
        stdoutPath: "/nonexistent/path/to/log.txt",
        recentErrors: [],
        tailLines: 500,
        windowLines: 50,
      }),
    ).toBe("");
  });
});
