import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  deriveSlug,
  deriveRunSlug,
  deriveStateSlug,
  statePath,
  lockPath,
  freshState,
  loadState,
  saveState,
  backfillKindFromPlan,
  acquireLock,
  cleanupDeadLock,
  releaseLock,
  readLockInfo,
} from "../state";
import type { Phase } from "../types";

// Override the state directory for each test so we don't pollute the real
// ~/.gstack/build-state.
let realStateDir: string | undefined;
let tmpStateDir: string;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-build-state-test-"),
  );
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

const phases: Phase[] = [
  {
    index: 0,
    number: "1",
    name: "Foo",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "Full plan",
    testSpecDone: true,
    implementationDone: false,
    reviewDone: false,
    body: "",
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: 5,
    reviewCheckboxLine: 6,
    kind: "code",
  },
  {
    index: 1,
    number: "2",
    name: "Bar",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "Full plan",
    testSpecDone: true,
    implementationDone: true,
    reviewDone: true,
    body: "",
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: 10,
    reviewCheckboxLine: 11,
    kind: "code",
  },
];

describe("deriveSlug", () => {
  it("strips .md extension and prefixes with build-", () => {
    expect(deriveSlug("/abs/path/agnt2-impl-plan-20260427.md")).toBe(
      "build-agnt2-impl-plan-20260427",
    );
  });
  it("handles uppercase .MD", () => {
    expect(deriveSlug("foo.MD")).toBe("build-foo");
  });
  it("uses run id state slugs when provided", () => {
    expect(deriveRunSlug("run:one/alpha")).toBe("build-run-one-alpha");
    expect(deriveStateSlug("/x/same.md", "run-a")).toBe("build-run-a");
    expect(deriveStateSlug("/y/same.md", "run-b")).toBe("build-run-b");
  });
});

describe("freshState", () => {
  it("marks already-checked phases as committed and others as pending", () => {
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    expect(s.phases[0].status).toBe("pending");
    expect(s.phases[1].status).toBe("committed");
    expect(s.features![0].status).toBe("pending");
  });
  it("run-id state slugs do not collide for same basename plans", () => {
    const a = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases,
      runId: "run-a",
    });
    const b = freshState({
      planFile: "/y/foo.md",
      branch: "main",
      phases,
      runId: "run-b",
    });
    expect(a.slug).toBe("build-run-a");
    expect(b.slug).toBe("build-run-b");
    expect(a.slug).not.toBe(b.slug);
  });
  it("points currentPhaseIndex at first non-committed", () => {
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    expect(s.currentPhaseIndex).toBe(0);
  });
  it("marks all pre-checked phases as ready to ship, not completed", () => {
    const allDone: Phase[] = phases.map((p) => ({
      ...p,
      implementationDone: true,
      reviewDone: true,
      kind: "code",
    }));
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases: allDone,
    });
    expect(s.completed).toBe(false);
    expect(s.features![0].status).toBe("phases_done");
    expect(s.currentFeatureIndex).toBe(0);
  });

  it("creates feature states from parsed feature groups", () => {
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases,
      features: [
        {
          index: 0,
          number: "1",
          name: "Foo feature",
          body: "",
          phaseIndexes: [0],
        },
        {
          index: 1,
          number: "2",
          name: "Bar feature",
          body: "",
          phaseIndexes: [1],
        },
      ],
    });
    expect(s.features!.map((f) => f.name)).toEqual([
      "Foo feature",
      "Bar feature",
    ]);
    expect(s.features![0].status).toBe("pending");
    expect(s.features![1].status).toBe("phases_done");
    expect(s.currentFeatureIndex).toBe(0);
  });

  it("does not create executable state for empty feature groups", () => {
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases,
      features: [
        {
          index: 0,
          number: "1",
          name: "Empty feature",
          body: "",
          phaseIndexes: [],
        },
        {
          index: 1,
          number: "2",
          name: "Real feature",
          body: "",
          phaseIndexes: [0, 1],
        },
      ],
    });
    expect(s.features!.map((f) => f.name)).toEqual(["Real feature"]);
    expect(s.features![0].phaseIndexes).toEqual([0, 1]);
    expect(s.features![0].status).toBe("pending");
  });

  it("does NOT mark a phase committed when testSpecDone=false even if impl+review are checked", () => {
    const tddPhase: Phase[] = [
      {
        index: 0,
        number: "1",
        name: "TDD",
        body: "",
        testSpecDone: false,
        testSpecCheckboxLine: 5,
        implementationDone: true,
        reviewDone: true,
        implementationCheckboxLine: 6,
        reviewCheckboxLine: 7,
        kind: "code",
      },
    ];
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases: tddPhase,
    });
    expect(s.phases[0].status).toBe("pending");
    expect(s.completed).toBe(false);
  });

  it("freshState sets impl_done (not gemini_done) when implementation checked but review is not", () => {
    const implDonePhase: Phase[] = [
      {
        index: 0,
        number: "1",
        name: "ImplDone",
        body: "",
        testSpecDone: true,
        testSpecCheckboxLine: -1,
        implementationDone: true,
        reviewDone: false,
        implementationCheckboxLine: 5,
        reviewCheckboxLine: 6,
        kind: "code",
      },
    ];
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases: implDonePhase,
    });
    expect(s.phases[0].status).toBe("impl_done");
  });

  it("records launch options for audit and recovery", () => {
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases,
      launch: {
        argv: ["/x/foo.md", "--project-root", "/repo"],
        projectRoot: "/repo",
        originPlan: "/x/origin.md",
        dryRun: false,
        skipShip: false,
        skipFeatureReview: false,
        launchedAt: "2026-05-07T00:00:00.000Z",
      },
    });
    expect(s.launch).toEqual({
      argv: ["/x/foo.md", "--project-root", "/repo"],
      projectRoot: "/repo",
      originPlan: "/x/origin.md",
      dryRun: false,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: "2026-05-07T00:00:00.000Z",
    });
  });
});

describe("loadState / saveState round-trip", () => {
  it("saves and reloads a state", () => {
    const original = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases,
    });
    saveState(original, { noGbrain: true });
    const reloaded = loadState(original.slug, { noGbrain: true });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.slug).toBe(original.slug);
    expect(reloaded!.phases).toHaveLength(2);
    expect(reloaded!.phases[1].status).toBe("committed");
  });

  it("returns null when no state file exists (and no gbrain)", () => {
    expect(loadState("build-nonexistent", { noGbrain: true })).toBeNull();
  });

  it("throws on corrupt state", () => {
    const slug = "build-corrupt";
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), "{not valid json");
    expect(() => loadState(slug, { noGbrain: true })).toThrow(/corrupt/);
  });

  it("updates lastUpdatedAt on every save", async () => {
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    saveState(s, { noGbrain: true });
    const first = s.lastUpdatedAt;
    await new Promise((r) => setTimeout(r, 10));
    saveState(s, { noGbrain: true });
    expect(s.lastUpdatedAt).not.toBe(first);
  });

  it("persists launch options across save/load", () => {
    const original = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases,
      launch: {
        argv: ["/x/foo.md", "--skip-ship"],
        projectRoot: "/repo",
        dryRun: false,
        skipShip: true,
        skipFeatureReview: false,
        launchedAt: "2026-05-07T00:00:00.000Z",
      },
    });
    saveState(original, { noGbrain: true });
    const reloaded = loadState(original.slug, { noGbrain: true });
    expect(reloaded?.launch?.skipShip).toBe(true);
    expect(reloaded?.launch?.argv).toEqual(["/x/foo.md", "--skip-ship"]);
    expect(reloaded?.launch?.projectRoot).toBe("/repo");
  });

  it("writes via temp+rename (no .tmp.* file left behind on success)", () => {
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    saveState(s, { noGbrain: true });
    const dir = path.dirname(statePath(s.slug));
    const stragglers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(stragglers).toHaveLength(0);
  });

  it("loadState migrates persisted gemini_done → impl_done (rename backward compat)", () => {
    // Simulate a state file written before the gemini_done→impl_done rename.
    const slug = "build-migration-test";
    const oldState = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "main",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "Foo", status: "gemini_done" }],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.phases[0].status).toBe("impl_done");
  });

  it("loadState migrates display-only done status → committed for manual recovery compatibility", () => {
    const slug = "build-done-status-migration-test";
    const oldState = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "main",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "Foo", status: "done" }],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.phases[0].status).toBe("committed");
  });

  it("loadState keeps legacy all-phase-done state unshipped when completed=false", () => {
    const slug = "build-legacy-unshipped-test";
    const oldState = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "feat/foo",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 0,
      phases: [
        { index: 0, number: "1", name: "Foo", status: "committed" },
        { index: 1, number: "2", name: "Bar", status: "committed" },
      ],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.features![0].status).toBe("pending");
    expect(loaded!.currentFeatureIndex).toBe(0);
    fs.rmSync(statePath(slug), { force: true });
  });

  it("loadState migrates legacy model fields into roleConfigs", () => {
    const slug = "build-model-migration-test";
    const oldState = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "main",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "Foo", status: "pending" }],
      completed: false,
      geminiModel: "legacy-primary-model",
      codexModel: "legacy-secondary-model",
      codexReviewModel: "legacy-review-model",
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.roleConfigs!.primaryImpl.model).toBe("legacy-primary-model");
    expect(loaded!.roleConfigs!.secondaryImpl.model).toBe(
      "legacy-secondary-model",
    );
    expect(loaded!.roleConfigs!.reviewSecondary.model).toBe(
      "legacy-review-model",
    );
  });
});

describe("lock acquire / release", () => {
  it("first acquire succeeds, second on same slug fails", () => {
    expect(acquireLock("build-x")).toBe(true);
    expect(acquireLock("build-x")).toBe(false);
    releaseLock("build-x");
  });

  it("release lets next acquire succeed", () => {
    acquireLock("build-x");
    releaseLock("build-x");
    expect(acquireLock("build-x")).toBe(true);
    releaseLock("build-x");
  });

  it("auto-clears a dead-pid lock and acquires the lock", () => {
    const p = lockPath("build-dead-lock");
    fs.writeFileSync(p, "99999999\n2026-05-08T00:00:00.000Z\n");

    expect(acquireLock("build-dead-lock")).toBe(true);
    const info = readLockInfo("build-dead-lock");
    expect(info).toContain(String(process.pid));
    releaseLock("build-dead-lock");
  });

  it("does not clear a live-pid lock", () => {
    const p = lockPath("build-live-lock");
    fs.writeFileSync(p, `${process.pid}\n2026-05-08T00:00:00.000Z\n`);

    expect(acquireLock("build-live-lock")).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toContain(String(process.pid));
  });

  it("does not clear a malformed lock", () => {
    const p = lockPath("build-malformed-lock");
    fs.writeFileSync(p, "not-a-pid\n2026-05-08T00:00:00.000Z\n");

    expect(cleanupDeadLock("build-malformed-lock").status).toBe("invalid");
    expect(acquireLock("build-malformed-lock")).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("does not coerce non-decimal lock pids", () => {
    const p = lockPath("build-coerced-lock");
    fs.writeFileSync(p, "1e8\n2026-05-08T00:00:00.000Z\n");

    expect(cleanupDeadLock("build-coerced-lock").status).toBe("invalid");
    expect(acquireLock("build-coerced-lock")).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("does not clear an unreadable lock path", () => {
    const p = lockPath("build-unreadable-lock");
    fs.mkdirSync(p, { recursive: true });

    expect(cleanupDeadLock("build-unreadable-lock").status).toBe("unreadable");
    expect(acquireLock("build-unreadable-lock")).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("release on missing lock is a no-op (no throw)", () => {
    expect(() => releaseLock("build-never-locked")).not.toThrow();
  });

  it("readLockInfo returns the pid + timestamp written at acquire", () => {
    acquireLock("build-x");
    const info = readLockInfo("build-x");
    expect(info).toContain(String(process.pid));
    releaseLock("build-x");
  });

  it("readLockInfo returns null when no lock", () => {
    expect(readLockInfo("build-no-lock")).toBeNull();
  });
});

describe("paths", () => {
  it("statePath, lockPath are siblings under ~/.gstack/build-state", () => {
    const s = statePath("build-x");
    const l = lockPath("build-x");
    expect(path.dirname(s)).toBe(path.dirname(l));
    expect(s.endsWith("build-x.json")).toBe(true);
    expect(l.endsWith("build-x.lock")).toBe(true);
  });
});

describe("PhaseState.kind persistence (freshState + backfillKindFromPlan)", () => {
  // Helper: build a non-code Phase fixture matching the shape in `phases` above.
  function nonCodePhase(index: number, kind: Phase["kind"]): Phase {
    return {
      index,
      number: String(index + 1),
      name: `Phase ${index + 1}`,
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Full plan",
      testSpecDone: true,
      implementationDone: false,
      reviewDone: false,
      body: "",
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 5 + index * 5,
      reviewCheckboxLine: 6 + index * 5,
      kind,
    };
  }

  it("freshState copies Phase.kind into PhaseState.kind for every phase", () => {
    const mixed: Phase[] = [
      nonCodePhase(0, "manual"),
      nonCodePhase(1, "writing"),
      nonCodePhase(2, "experiment"),
      nonCodePhase(3, "research"),
      nonCodePhase(4, "code"),
    ];
    const s = freshState({
      planFile: "/x/foo.md",
      branch: "main",
      phases: mixed,
    });
    expect(s.phases[0].kind).toBe("manual");
    expect(s.phases[1].kind).toBe("writing");
    expect(s.phases[2].kind).toBe("experiment");
    expect(s.phases[3].kind).toBe("research");
    expect(s.phases[4].kind).toBe("code");
  });

  // E5: saveState + loadState round-trip preserves kind through JSON
  // serialization. Guards against silent field drops in future schema
  // migrations.
  it("E5: saveState → loadState round-trip preserves PhaseState.kind", () => {
    const manualPhase = nonCodePhase(0, "manual");
    const s = freshState({
      planFile: "/x/round-trip.md",
      branch: "main",
      phases: [manualPhase],
      runId: "round-trip-test",
    });
    saveState(s, { noGbrain: true });
    const reloaded = loadState(s.slug, { noGbrain: true });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.phases[0].kind).toBe("manual");
  });

  it("backfillKindFromPlan hydrates kind:null from parsed plan", () => {
    const phase = nonCodePhase(0, "manual");
    const s = freshState({
      planFile: "/x/backfill.md",
      branch: "main",
      phases: [phase],
    });
    // Simulate an old state file: clear the kind field as if persisted before
    // the field existed.
    s.phases[0].kind = undefined;
    backfillKindFromPlan(s, [phase]);
    expect(s.phases[0].kind).toBe("manual");
  });

  it("backfillKindFromPlan is non-destructive: existing kind on state wins over plan", () => {
    const phase = nonCodePhase(0, "manual");
    const s = freshState({
      planFile: "/x/non-destructive.md",
      branch: "main",
      phases: [phase],
    });
    // State already has kind=code (e.g., user-set or earlier backfill). Plan
    // now says kind=manual. The state value must NOT change.
    s.phases[0].kind = "code";
    backfillKindFromPlan(s, [phase]);
    expect(s.phases[0].kind).toBe("code");
  });

  it("backfillKindFromPlan no-plan path: undefined phases arg leaves state intact", () => {
    const phase = nonCodePhase(0, "manual");
    const s = freshState({
      planFile: "/x/no-plan.md",
      branch: "main",
      phases: [phase],
    });
    s.phases[0].kind = undefined;
    const before = JSON.stringify(s.phases);
    // Pass undefined — gbrain-restore-before-parsePlan path.
    backfillKindFromPlan(s, undefined);
    expect(JSON.stringify(s.phases)).toBe(before);
    expect(s.phases[0].kind).toBeUndefined();
  });

  it("backfillKindFromPlan no-plan path: empty phases array leaves state intact", () => {
    const phase = nonCodePhase(0, "manual");
    const s = freshState({
      planFile: "/x/empty-plan.md",
      branch: "main",
      phases: [phase],
    });
    s.phases[0].kind = undefined;
    backfillKindFromPlan(s, []);
    expect(s.phases[0].kind).toBeUndefined();
  });

  // E1: length-mismatch defensive case. State has N phases, plan has M phases
  // (after mid-build plan edit). Backfill iterates min(N, M), no crash, no
  // out-of-bounds access, mismatched extras left untouched.
  it("E1: backfillKindFromPlan handles state.phases longer than plan phases", () => {
    const p0 = nonCodePhase(0, "manual");
    const p1 = nonCodePhase(1, "code");
    const p2 = nonCodePhase(2, "code");
    const s = freshState({
      planFile: "/x/longer-state.md",
      branch: "main",
      phases: [p0, p1, p2],
    });
    // Clear all kinds; simulate legacy state load.
    s.phases.forEach((ph) => (ph.kind = undefined));
    // Plan now has only 2 phases (third was deleted mid-build).
    backfillKindFromPlan(s, [p0, p1]);
    expect(s.phases[0].kind).toBe("manual");
    expect(s.phases[1].kind).toBe("code");
    // Phase 2 has no corresponding plan entry — left untouched (still undefined).
    expect(s.phases[2].kind).toBeUndefined();
    // No crash, no out-of-bounds — function returned normally.
  });

  it("E1: backfillKindFromPlan handles plan phases longer than state.phases", () => {
    const p0 = nonCodePhase(0, "manual");
    const p1 = nonCodePhase(1, "writing");
    const s = freshState({
      planFile: "/x/longer-plan.md",
      branch: "main",
      phases: [p0],
    });
    s.phases[0].kind = undefined;
    // Plan grew (a new phase was added). Backfill must not crash.
    backfillKindFromPlan(s, [p0, p1]);
    expect(s.phases[0].kind).toBe("manual");
    expect(s.phases.length).toBe(1); // state phases length unchanged
  });

  // E2: integration test for the cli.ts wiring path. Simulates the full
  // resume cycle: write legacy state (kind=null), loadState, parsePlan-equiv
  // (caller has Phase[]), backfillKindFromPlan, saveState, loadState again —
  // assert kind is now persisted to disk.
  it("E2: integration — legacy state on disk gets backfilled and persisted on resume", () => {
    const manualPhase = nonCodePhase(0, "manual");
    // Step 1: build state and clear kind to simulate legacy on-disk state.
    const initial = freshState({
      planFile: "/x/e2e-integration.md",
      branch: "main",
      phases: [manualPhase],
      runId: "e2e-integration-test",
    });
    initial.phases[0].kind = undefined;
    saveState(initial, { noGbrain: true });

    // Step 2: simulate the cli.ts resume path — loadState then backfill.
    const loaded = loadState(initial.slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.phases[0].kind).toBeUndefined();
    backfillKindFromPlan(loaded!, [manualPhase]);
    expect(loaded!.phases[0].kind).toBe("manual");

    // Step 3: saveState writes the backfilled kind to disk.
    saveState(loaded!, { noGbrain: true });

    // Step 4: loadState again — kind survives the disk round-trip.
    const reloaded = loadState(initial.slug, { noGbrain: true });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.phases[0].kind).toBe("manual");
  });
});
