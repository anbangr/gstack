import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { measureHaltRecurrence } from "../../scripts/measure-halt-recurrence";
import { useIsolatedGstackHome } from "../../../test/helpers/test-home";

function makePattern(
  category: string,
  hitCount: number,
  lastHit: string,
  overrides?: Record<string, unknown>,
) {
  return {
    category,
    severity: "HIGH" as const,
    description: `desc for ${category}`,
    matcherKind: "stdout_contains" as const,
    pattern: `pattern-${category}-${hitCount}`,
    source: "test",
    learnedAt: "2026-01-01T00:00:00Z",
    hitCount,
    lastHit,
    ...overrides,
  };
}

describe("measure-halt-recurrence", () => {
  const home = useIsolatedGstackHome("measure-halt-");

  function writeLearned(patterns: unknown[]) {
    const skillFaultsDir = path.join(home.dir(), "skill-faults");
    fs.mkdirSync(skillFaultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillFaultsDir, "learned-patterns.json"),
      JSON.stringify(patterns),
    );
  }

  function readBaseline(): unknown {
    const files = fs
      .readdirSync(home.dir())
      .filter((f) => f.startsWith("halt-recurrence-baseline-"));
    expect(files.length).toBe(1);
    return JSON.parse(fs.readFileSync(path.join(home.dir(), files[0]), "utf8"));
  }

  function baselineFileName(): string {
    const files = fs
      .readdirSync(home.dir())
      .filter((f) => f.startsWith("halt-recurrence-baseline-"));
    expect(files.length).toBe(1);
    return files[0];
  }

  // T1: Empty learned-patterns
  test("T1: empty learned-patterns → total 0, perCategory empty", () => {
    writeLearned([]);
    const result = measureHaltRecurrence({ gstackHome: home.dir() });
    expect(result.total).toBe(0);
    expect(result.perCategory).toEqual({});
    const baseline = readBaseline();
    expect(baseline).toMatchObject({ window: "7d", total: 0, perCategory: {} });
    expect(typeof (baseline as Record<string, unknown>).capturedAt).toBe("string");
  });

  // T2: Single-category sum
  test("T2: single-category sum of hitCounts within 7d", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([
      makePattern("provider-timeout", 4, "2026-05-20T00:00:00Z"),
      makePattern("provider-timeout", 2, "2026-05-19T00:00:00Z"),
      makePattern("provider-timeout", 1, "2026-05-18T00:00:00Z"),
    ]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory["provider-timeout"].hits).toBe(7);
    expect(result.total).toBe(7);
  });

  // T3: 7-day window filter
  test("T3: entry with lastHit 10 days ago is excluded from rolling window", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([
      makePattern("provider-timeout", 100, "2026-05-10T00:00:00Z"), // 11 days ago
      makePattern("provider-timeout", 5, "2026-05-20T00:00:00Z"), // 1 day ago
    ]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory["provider-timeout"].hits).toBe(5);
    expect(result.total).toBe(5);
  });

  // T4: Multi-category aggregation
  test("T4: multi-category aggregation with hits, lastHit, and patternIds", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([
      makePattern("cat-a", 3, "2026-05-20T00:00:00Z"),
      makePattern("cat-b", 1, "2026-05-19T00:00:00Z"),
      makePattern("cat-c", 5, "2026-05-18T00:00:00Z"),
      makePattern("cat-d", 2, "2026-05-17T00:00:00Z"),
      makePattern("cat-e", 4, "2026-05-16T00:00:00Z"),
    ]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(Object.keys(result.perCategory).sort()).toEqual([
      "cat-a",
      "cat-b",
      "cat-c",
      "cat-d",
      "cat-e",
    ]);
    expect(result.perCategory["cat-a"].hits).toBe(3);
    expect(result.perCategory["cat-b"].hits).toBe(1);
    expect(result.perCategory["cat-c"].hits).toBe(5);
    expect(result.perCategory["cat-d"].hits).toBe(2);
    expect(result.perCategory["cat-e"].hits).toBe(4);
    expect(Array.isArray(result.perCategory["cat-a"].patternIds)).toBe(true);
    expect(typeof result.perCategory["cat-a"].lastHit).toBe("string");
    expect(result.total).toBe(15);
  });

  // T5: Missing learned-patterns.json
  test("T5: missing learned-patterns.json → baseline with total 0, no crash", () => {
    const result = measureHaltRecurrence({ gstackHome: home.dir() });
    expect(result.total).toBe(0);
    expect(result.perCategory).toEqual({});
    const baseline = readBaseline();
    expect(baseline).toMatchObject({ window: "7d", total: 0, perCategory: {} });
  });

  // Edge: missing hitCount → treat as zero
  test("edge: entry missing hitCount is treated as zero", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    const p = makePattern("provider-timeout", 3, "2026-05-20T00:00:00Z");
    delete (p as Record<string, unknown>).hitCount;
    writeLearned([p]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory["provider-timeout"].hits).toBe(0);
  });

  // Edge: missing lastHit → exclude
  test("edge: entry missing lastHit is excluded from aggregation", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    const p = makePattern("provider-timeout", 100, "2026-05-20T00:00:00Z");
    delete (p as Record<string, unknown>).lastHit;
    writeLearned([p]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory).toEqual({});
    expect(result.total).toBe(0);
  });

  // Edge: same category + same lastHit → summed correctly, not double-counted by mistake
  test("edge: same category and same lastHit are both counted once each", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([
      makePattern("provider-timeout", 3, "2026-05-20T00:00:00Z"),
      makePattern("provider-timeout", 5, "2026-05-20T00:00:00Z"),
    ]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory["provider-timeout"].hits).toBe(8);
  });

  // Edge: daylight-saving boundary with UTC timestamps
  test("edge: daylight-saving boundary handled with UTC ISO timestamps", () => {
    const now = new Date("2026-03-15T10:00:00Z");
    writeLearned([
      makePattern("dst-test", 3, "2026-03-09T10:00:00Z"), // 6 days ago
      makePattern("dst-test", 5, "2026-03-01T10:00:00Z"), // 14 days ago
    ]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory["dst-test"].hits).toBe(3);
    expect(result.total).toBe(3);
  });

  // Additional: output filename uses YYYY-MM-DD from run date
  test("output filename uses YYYY-MM-DD from the run date", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([]);
    measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(baselineFileName()).toBe("halt-recurrence-baseline-2026-05-21.json");
  });

  // Additional: perCategory lastHit is the most recent lastHit for that category
  test("perCategory lastHit is the most recent lastHit within the window", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([
      makePattern("provider-timeout", 1, "2026-05-18T00:00:00Z"),
      makePattern("provider-timeout", 2, "2026-05-20T00:00:00Z"),
      makePattern("provider-timeout", 3, "2026-05-19T00:00:00Z"),
    ]);
    const result = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result.perCategory["provider-timeout"].lastHit).toBe(
      "2026-05-20T00:00:00Z",
    );
  });

  // Additional: idempotency check — same input produces same totals (capturedAt differs)
  test("idempotency: same input produces same totals and perCategory", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    writeLearned([
      makePattern("cat-a", 3, "2026-05-20T00:00:00Z"),
      makePattern("cat-b", 2, "2026-05-19T00:00:00Z"),
    ]);
    const result1 = measureHaltRecurrence({ gstackHome: home.dir(), now });
    // Remove the first baseline so the second run creates a fresh one
    const files1 = fs
      .readdirSync(home.dir())
      .filter((f) => f.startsWith("halt-recurrence-baseline-"));
    for (const f of files1) fs.unlinkSync(path.join(home.dir(), f));
    const result2 = measureHaltRecurrence({ gstackHome: home.dir(), now });
    expect(result1.total).toBe(result2.total);
    expect(result1.perCategory).toEqual(result2.perCategory);
    expect(result1.window).toBe(result2.window);
  });
});
