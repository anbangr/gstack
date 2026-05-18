import { describe, it, expect } from "bun:test";
import { resolveClaudeCodeMonitorWallMsCap } from "../cli";

const DEFAULT_WALL_MS = 3_600_000;
const CAP = 540_000;

describe("resolveClaudeCodeMonitorWallMsCap", () => {
  it("returns null when CLAUDECODE env var is unset", () => {
    const cap = resolveClaudeCodeMonitorWallMsCap({
      env: {},
      userSetMaxWallMs: false,
      currentMaxWallMs: DEFAULT_WALL_MS,
    });
    expect(cap).toBeNull();
  });

  it("caps to 540000 when CLAUDECODE is set and user did not pass --max-wall-ms", () => {
    const cap = resolveClaudeCodeMonitorWallMsCap({
      env: { CLAUDECODE: "1" },
      userSetMaxWallMs: false,
      currentMaxWallMs: DEFAULT_WALL_MS,
    });
    expect(cap).toBe(CAP);
  });

  it("returns null when user explicitly set --max-wall-ms even under Claude Code", () => {
    const cap = resolveClaudeCodeMonitorWallMsCap({
      env: { CLAUDECODE: "1" },
      userSetMaxWallMs: true,
      currentMaxWallMs: 7_200_000,
    });
    expect(cap).toBeNull();
  });

  it("returns null when the current value is already at or below the cap (idempotent)", () => {
    const cap1 = resolveClaudeCodeMonitorWallMsCap({
      env: { CLAUDECODE: "1" },
      userSetMaxWallMs: false,
      currentMaxWallMs: CAP,
    });
    expect(cap1).toBeNull();
    const cap2 = resolveClaudeCodeMonitorWallMsCap({
      env: { CLAUDECODE: "1" },
      userSetMaxWallMs: false,
      currentMaxWallMs: 300_000,
    });
    expect(cap2).toBeNull();
  });

  it("treats any non-empty CLAUDECODE value as Claude Code", () => {
    const cap = resolveClaudeCodeMonitorWallMsCap({
      env: { CLAUDECODE: "true" },
      userSetMaxWallMs: false,
      currentMaxWallMs: DEFAULT_WALL_MS,
    });
    expect(cap).toBe(CAP);
  });
});
