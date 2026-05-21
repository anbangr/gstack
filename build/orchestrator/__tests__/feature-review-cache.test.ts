/**
 * T14: feature-review verdict cache tests.
 *
 * computeCacheKey is a pure sha256 over stable inputs — we pin invariants
 * (stability, sensitivity to each field, missing-sha → empty key).
 *
 * lookupCache/storeCache do disk I/O. We sandbox via GSTACK_BUILD_STATE_DIR
 * and verify slug isolation, write best-effort behavior, and defensive
 * rejection of non-PASS entries.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeCacheKey,
  lookupCache,
  storeCache,
} from "../feature-review-cache";
import type { Feature, PhaseState } from "../types";

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    index: 0,
    number: "1",
    name: "Test",
    body: "feature body",
    phaseIndexes: [0, 1],
    ...overrides,
  };
}

function makePhaseState(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "phase",
    status: "committed",
    committedSha: "deadbeef",
    ...overrides,
  } as PhaseState;
}

describe("computeCacheKey", () => {
  it("returns stable key for identical inputs", () => {
    const args = {
      feature: makeFeature(),
      phaseStates: [
        makePhaseState({ index: 0, number: "1", committedSha: "aaa" }),
        makePhaseState({ index: 1, number: "2", committedSha: "bbb" }),
      ],
      planBody: "plan content",
      reviewerRoleLabel: "codex:gpt-5.5:high",
    };
    const k1 = computeCacheKey(args);
    const k2 = computeCacheKey({ ...args });
    expect(k1).toBe(k2);
    expect(k1.length).toBe(64); // sha256 hex
  });

  it("returns empty string when any phase is missing committedSha", () => {
    const k = computeCacheKey({
      feature: makeFeature(),
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: undefined }),
      ],
      planBody: "plan",
      reviewerRoleLabel: "codex",
    });
    expect(k).toBe("");
  });

  it("changes when planBody changes", () => {
    const base = {
      feature: makeFeature(),
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: "bbb" }),
      ],
      reviewerRoleLabel: "codex",
    };
    const k1 = computeCacheKey({ ...base, planBody: "plan A" });
    const k2 = computeCacheKey({ ...base, planBody: "plan B" });
    expect(k1).not.toBe(k2);
  });

  it("changes when any phase sha changes", () => {
    const base = {
      feature: makeFeature(),
      planBody: "plan",
      reviewerRoleLabel: "codex",
    };
    const k1 = computeCacheKey({
      ...base,
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: "bbb" }),
      ],
    });
    const k2 = computeCacheKey({
      ...base,
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: "ccc" }),
      ],
    });
    expect(k1).not.toBe(k2);
  });

  it("changes when reviewer role label changes", () => {
    const base = {
      feature: makeFeature(),
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: "bbb" }),
      ],
      planBody: "plan",
    };
    const k1 = computeCacheKey({ ...base, reviewerRoleLabel: "codex:gpt-5.5:high" });
    const k2 = computeCacheKey({ ...base, reviewerRoleLabel: "codex:gpt-5.5:medium" });
    expect(k1).not.toBe(k2);
  });

  it("changes when feature body changes", () => {
    const base = {
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: "bbb" }),
      ],
      planBody: "plan",
      reviewerRoleLabel: "codex",
    };
    const k1 = computeCacheKey({ ...base, feature: makeFeature({ body: "body A" }) });
    const k2 = computeCacheKey({ ...base, feature: makeFeature({ body: "body B" }) });
    expect(k1).not.toBe(k2);
  });

  it("phaseIndexes order does not affect key (sorted internally)", () => {
    // The sort happens internally on the resolved committedShas. Two
    // features with the same phase shas but different phaseIndexes order
    // ([0, 1] vs [1, 0]) should produce the same key because the resolved
    // SHA list ["aaa", "bbb"] is identical after sort.
    const base = {
      planBody: "plan",
      reviewerRoleLabel: "codex",
      phaseStates: [
        makePhaseState({ index: 0, committedSha: "aaa" }),
        makePhaseState({ index: 1, committedSha: "bbb" }),
      ],
    };
    const k1 = computeCacheKey({
      ...base,
      feature: makeFeature({ phaseIndexes: [0, 1] }),
    });
    const k2 = computeCacheKey({
      ...base,
      feature: makeFeature({ phaseIndexes: [1, 0] }),
    });
    expect(k1).toBe(k2);
  });
});

describe("lookupCache / storeCache", () => {
  let tmpdir: string;
  const origStateDir = process.env.GSTACK_BUILD_STATE_DIR;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fr-cache-"));
    process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpdir, "build-state");
    fs.mkdirSync(process.env.GSTACK_BUILD_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (origStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
    else process.env.GSTACK_BUILD_STATE_DIR = origStateDir;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("lookupCache returns null when no file exists", () => {
    expect(lookupCache("anykey", "test-slug")).toBeNull();
  });

  it("storeCache + lookupCache round trip", () => {
    storeCache("key1", "test-slug", {
      verdict: "FEATURE_PASS",
      iteration: 2,
      outputFilePath: "/path/to/out.md",
      cachedAt: "2026-05-21T00:00:00Z",
      originalSlug: "test-slug",
    });
    const hit = lookupCache("key1", "test-slug");
    expect(hit).not.toBeNull();
    expect(hit!.verdict).toBe("FEATURE_PASS");
    expect(hit!.iteration).toBe(2);
    expect(hit!.outputFilePath).toBe("/path/to/out.md");
  });

  it("lookupCache scopes by slug (cross-slug isolation)", () => {
    storeCache("key1", "slug-a", {
      verdict: "FEATURE_PASS",
      iteration: 1,
      outputFilePath: "/a",
      cachedAt: "2026-05-21T00:00:00Z",
      originalSlug: "slug-a",
    });
    expect(lookupCache("key1", "slug-b")).toBeNull();
    expect(lookupCache("key1", "slug-a")).not.toBeNull();
  });

  it("storeCache write failure does not throw (best-effort)", () => {
    // Point at a path we can't create (root-owned, doesn't exist).
    process.env.GSTACK_BUILD_STATE_DIR = "/no/such/path/exists";
    expect(() =>
      storeCache("k", "slug", {
        verdict: "FEATURE_PASS",
        iteration: 1,
        outputFilePath: "/",
        cachedAt: "x",
        originalSlug: "slug",
      }),
    ).not.toThrow();
  });

  it("lookupCache with empty key returns null", () => {
    storeCache("", "slug", {
      verdict: "FEATURE_PASS",
      iteration: 1,
      outputFilePath: "/",
      cachedAt: "x",
      originalSlug: "slug",
    });
    expect(lookupCache("", "slug")).toBeNull();
  });

  it("lookupCache returns null when stored verdict is not FEATURE_PASS (defensive)", () => {
    // Manually write a non-PASS entry — simulates a stale or hand-edited cache.
    // The path layout must match cacheDir(slug): GSTACK_BUILD_STATE_DIR/../projects/<slug>/feature-review-cache/
    const dir = path.join(tmpdir, "projects", "slug", "feature-review-cache");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "weirdkey.json"),
      JSON.stringify({ verdict: "FEATURE_REDO", iteration: 1 }),
    );
    expect(lookupCache("weirdkey", "slug")).toBeNull();
  });
});
