import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordEscalation,
  resetStreak,
  shouldSurface,
  streakSurfaceMessage,
  streakPath,
  peekStreak,
  STREAK_LIMIT,
  STREAK_WINDOW_MS,
} from "../escalation-streak";

let tmpDir: string;
let oldStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-streak-"));
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (oldStateDir) process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SLUG = "build-run-test";

describe("escalation streak counter", () => {
  it("increments count on each recorded escalation", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    const t1 = new Date("2026-05-15T10:01:00.000Z");
    const t2 = new Date("2026-05-15T10:02:00.000Z");

    const s1 = recordEscalation(SLUG, "no_action", t0);
    expect(s1.count).toBe(1);
    expect(s1.recentVerdicts).toEqual(["no_action"]);

    const s2 = recordEscalation(SLUG, "host_action_required", t1);
    expect(s2.count).toBe(2);
    expect(s2.recentVerdicts).toEqual(["no_action", "host_action_required"]);

    const s3 = recordEscalation(SLUG, "no_action", t2);
    expect(s3.count).toBe(3);
    expect(s3.firstSeenAt).toBe(t0.toISOString());
    expect(s3.lastSeenAt).toBe(t2.toISOString());
  });

  it("shouldSurface trips at STREAK_LIMIT", () => {
    expect(STREAK_LIMIT).toBeGreaterThanOrEqual(2);
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    let last;
    for (let i = 0; i < STREAK_LIMIT; i++) {
      last = recordEscalation(
        SLUG,
        i % 2 === 0 ? "no_action" : "host_action_required",
        new Date(t0.getTime() + i * 60_000),
      );
    }
    expect(last).toBeTruthy();
    expect(shouldSurface(last!)).toBe(true);
  });

  it("does NOT surface below the limit", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    const s = recordEscalation(SLUG, "no_action", t0);
    expect(shouldSurface(s)).toBe(STREAK_LIMIT <= 1);
  });

  it("resetStreak() clears the file (counter starts fresh)", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    recordEscalation(SLUG, "no_action", t0);
    recordEscalation(SLUG, "no_action", new Date(t0.getTime() + 60_000));
    expect(fs.existsSync(streakPath(SLUG))).toBe(true);

    resetStreak(SLUG);
    expect(fs.existsSync(streakPath(SLUG))).toBe(false);

    const next = recordEscalation(
      SLUG,
      "no_action",
      new Date(t0.getTime() + 120_000),
    );
    expect(next.count).toBe(1);
  });

  it("resetStreak() is idempotent (file already missing is fine)", () => {
    expect(() => resetStreak(SLUG)).not.toThrow();
    expect(() => resetStreak(SLUG)).not.toThrow();
  });

  it("aging: escalation outside STREAK_WINDOW_MS resets the count to 1", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    recordEscalation(SLUG, "no_action", t0);

    // Past the window: a fresh streak should start.
    const tFar = new Date(t0.getTime() + STREAK_WINDOW_MS + 60_000);
    const next = recordEscalation(SLUG, "no_action", tFar);
    expect(next.count).toBe(1);
    expect(next.firstSeenAt).toBe(tFar.toISOString());
  });

  it("aging: escalation within STREAK_WINDOW_MS continues the streak", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    recordEscalation(SLUG, "no_action", t0);

    // Inside the window: count continues.
    const tNear = new Date(t0.getTime() + STREAK_WINDOW_MS - 60_000);
    const next = recordEscalation(SLUG, "no_action", tNear);
    expect(next.count).toBe(2);
    expect(next.firstSeenAt).toBe(t0.toISOString());
  });

  it("recentVerdicts is capped to last 5 entries", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    for (let i = 0; i < 8; i++) {
      recordEscalation(
        SLUG,
        `v${i}`,
        new Date(t0.getTime() + i * 60_000),
      );
    }
    const final = peekStreak(SLUG);
    expect(final).toBeTruthy();
    expect(final!.recentVerdicts.length).toBe(5);
    expect(final!.recentVerdicts).toEqual(["v3", "v4", "v5", "v6", "v7"]);
    expect(final!.count).toBe(8);
  });

  it("surface message names count, age, and recent verdicts", () => {
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    recordEscalation(SLUG, "no_action", t0);
    const s = recordEscalation(
      SLUG,
      "host_action_required",
      new Date(t0.getTime() + 4 * 60_000),
    );
    const msg = streakSurfaceMessage(s, new Date(t0.getTime() + 6 * 60_000));
    expect(msg).toContain("monitor agent escalated 2 times");
    expect(msg).toContain("6min");
    expect(msg).toContain("no_action,host_action_required");
    expect(msg).toContain("supervisor may be unreachable");
  });

  it("recovers from a torn / unreadable streak file (treats as no streak)", () => {
    fs.mkdirSync(path.dirname(streakPath(SLUG)), { recursive: true });
    fs.writeFileSync(streakPath(SLUG), "{not json");
    const t0 = new Date("2026-05-15T10:00:00.000Z");
    const next = recordEscalation(SLUG, "no_action", t0);
    expect(next.count).toBe(1);
  });
});
