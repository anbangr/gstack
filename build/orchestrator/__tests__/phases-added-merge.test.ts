/**
 * Regression test for the FEATURE_NEEDS_PHASES merge math.
 *
 * Background: when feature-review for Feature N returns FEATURE_NEEDS_PHASES,
 * `appendFeaturePhases` inserts `### Phase N.review-K` headings into the plan
 * markdown under `## Feature N`, before the next `## Feature` heading. The
 * orchestrator then re-parses the plan and must merge the new phases into
 * `state.phases` without shifting any in-flight phase state out of alignment.
 *
 * The previous merge implementation in cli.ts assumed new phases append to
 * the END of `reparsed.phases`. That broke the moment `N` was not the last
 * feature: the new phase landed mid-array, the parser shifted every
 * downstream index, and the slice captured the wrong tail. See `state.ts`
 * `mergeReparsedPhases` for the fix.
 *
 * These tests pin the post-merge invariants:
 *   - `state.phases[i].number === reparsed.phases[i].number` for every i
 *   - `state.phases[i].index === i`
 *   - existing PhaseState entries (status, gemini outputs, codexReview, etc.)
 *     are preserved across the merge — only `.index` and `.name` are rewritten
 *   - `featureState[f].phaseIndexes` matches `reparsed.features[f].phaseIndexes`
 *   - no duplicate `number` values in state.phases
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePlan } from "../parser";
import { appendFeaturePhases, _testWritePlan } from "../plan-mutator";
import { mergeReparsedPhases } from "../state";
import type { BuildState, PhaseState, SubAgentInvocation } from "../types";

/** Typed sentinel SubAgentInvocation for tests — avoids `as unknown as` double-casts. */
function makeSentinelInvocation(
  overrides: Partial<SubAgentInvocation> = {},
): SubAgentInvocation {
  return {
    startedAt: "2026-05-18T15:10:00Z",
    outputLogPath: "phase-impl.log",
    outputFilePath: "phase-impl.md",
    ...overrides,
  };
}

/** Minimal BuildState scaffold for these tests — only the fields the merge touches. */
function buildStateFromParsed(parsed: {
  phases: ReturnType<typeof parsePlan>["phases"];
  features: ReturnType<typeof parsePlan>["features"];
}): BuildState {
  return {
    planFile: "/tmp/fake.md",
    planBasename: "fake",
    slug: "fake",
    branch: "main",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    currentPhaseIndex: 0,
    currentFeatureIndex: 0,
    features: parsed.features.map((f) => ({
      index: f.index,
      number: f.number,
      name: f.name,
      phaseIndexes: [...f.phaseIndexes],
      status: "pending" as const,
    })),
    phases: parsed.phases.map(
      (p): PhaseState => ({
        index: p.index,
        number: p.number,
        name: p.name,
        status: "pending",
        kind: p.kind,
      }),
    ),
    completed: false,
  };
}

describe("mergeReparsedPhases — FEATURE_NEEDS_PHASES splice mid-array", () => {
  it("places new review phase at the parser-assigned index and shifts downstream PhaseStates", () => {
    const initialMd = `# Plan

## Feature 1: Auth

### Phase 1.1: Schema
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 1.2: Service
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 1.3: Endpoint
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 2: Billing

### Phase 2.1: Invoice model
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 2.2: Charge endpoint
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 3: Notify

### Phase 3.1: Email job
- [ ] **Implementation**: x
- [ ] **Review**: y
`;

    const planFile = _testWritePlan(initialMd);
    try {
      const initial = parsePlan(initialMd);
      const state = buildStateFromParsed(initial);

      // Simulate Feature 1's three phases having run to completion before
      // the review fires. We pin a marker we expect to survive the merge.
      state.phases[0].status = "committed";
      state.phases[1].status = "committed";
      state.phases[2].status = "committed";
      state.phases[0].committedAt = "2026-05-18T15:00:00Z";
      // Plant a sentinel on a Feature 2 phase that the OLD merge math
      // overwrote/duplicated. After the fix, this exact object must still
      // be at the slot whose number === "2.1" (i.e. parsed index 4).
      state.phases[3].gemini = makeSentinelInvocation({
        outputFilePath: "phase-2.1-impl.md",
        outputLogPath: "phase-2.1-impl.log",
      });
      const sentinelObj = state.phases[3];

      // Feature-review on Feature 1 returns FEATURE_NEEDS_PHASES; append
      // a `1.review-1` heading under Feature 1.
      const block = `### Phase 1.review-1: Codex follow-up
- [ ] **Implementation**: do the follow-up
- [ ] **Review**: review the follow-up`;
      appendFeaturePhases({
        planFile,
        featureNumber: "1",
        phasesMd: block,
      });

      // Re-parse and merge.
      const newContent = fs.readFileSync(planFile, "utf8");
      const reparsed = parsePlan(newContent);
      const report = mergeReparsedPhases(state, reparsed);

      // Reparsed shape is what we expect from the parser.
      expect(reparsed.phases.map((p) => p.number)).toEqual([
        "1.1",
        "1.2",
        "1.3",
        "1.review-1",
        "2.1",
        "2.2",
        "3.1",
      ]);

      // After the merge, state.phases must match parser order, phase-by-phase.
      expect(state.phases.map((s) => s.number)).toEqual([
        "1.1",
        "1.2",
        "1.3",
        "1.review-1",
        "2.1",
        "2.2",
        "3.1",
      ]);
      // ...and every state.phases[i].index === i.
      for (let i = 0; i < state.phases.length; i++) {
        expect(state.phases[i].index).toBe(i);
      }
      // No duplicates.
      const numbers = state.phases.map((s) => s.number);
      expect(new Set(numbers).size).toBe(numbers.length);

      // The merge report names the one added phase. No feature-level
      // mutation expected for this case (the splice happened inside an
      // existing feature).
      expect(report.added).toEqual(["1.review-1"]);
      expect(report.orphaned).toEqual([]);
      expect(report.addedFeatures).toEqual([]);
      expect(report.orphanedFeatures).toEqual([]);

      // Existing PhaseState identity is preserved: state.phases[4] is the
      // SAME object that was state.phases[3] before the merge. The sentinel
      // gemini.outputFilePath survives, but the .index field is rewritten 3 -> 4.
      expect(state.phases[4]).toBe(sentinelObj);
      expect(state.phases[4].index).toBe(4);
      expect(state.phases[4].number).toBe("2.1");
      expect(state.phases[4].gemini?.outputFilePath).toBe("phase-2.1-impl.md");

      // Feature 1's committed status survives.
      expect(state.phases[0].status).toBe("committed");
      expect(state.phases[0].committedAt).toBe("2026-05-18T15:00:00Z");

      // The new review phase is pending.
      expect(state.phases[3].status).toBe("pending");

      // featureState.phaseIndexes must match the parser's view.
      expect(state.features[0].phaseIndexes).toEqual(
        reparsed.features[0].phaseIndexes,
      );
      expect(state.features[1].phaseIndexes).toEqual(
        reparsed.features[1].phaseIndexes,
      );
      expect(state.features[2].phaseIndexes).toEqual(
        reparsed.features[2].phaseIndexes,
      );
      // Feature 1 now owns 4 phases (indexes 0, 1, 2, 3); Feature 2 owns
      // indexes 4 and 5; Feature 3 owns index 6.
      expect(state.features[0].phaseIndexes).toEqual([0, 1, 2, 3]);
      expect(state.features[1].phaseIndexes).toEqual([4, 5]);
      expect(state.features[2].phaseIndexes).toEqual([6]);
    } finally {
      fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
    }
  });

  it("appends correctly when the insertion target is the last feature (regression: old slice() math)", () => {
    const initialMd = `# Plan

## Feature 1: Only

### Phase 1.1: First
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 1.2: Second
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const planFile = _testWritePlan(initialMd);
    try {
      const initial = parsePlan(initialMd);
      const state = buildStateFromParsed(initial);
      state.phases[0].status = "committed";
      state.phases[1].status = "committed";

      const block = `### Phase 1.review-1: Late add
- [ ] **Implementation**: x
- [ ] **Review**: y`;
      appendFeaturePhases({
        planFile,
        featureNumber: "1",
        phasesMd: block,
      });

      const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"));
      const report = mergeReparsedPhases(state, reparsed);

      expect(state.phases.map((s) => s.number)).toEqual([
        "1.1",
        "1.2",
        "1.review-1",
      ]);
      expect(state.phases[0].status).toBe("committed");
      expect(state.phases[1].status).toBe("committed");
      expect(state.phases[2].status).toBe("pending");
      expect(state.phases[2].index).toBe(2);
      expect(report.added).toEqual(["1.review-1"]);
      expect(report.addedFeatures).toEqual([]);
      expect(report.orphanedFeatures).toEqual([]);
      expect(state.features[0].phaseIndexes).toEqual([0, 1, 2]);
    } finally {
      fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
    }
  });

  it("handles multiple review phases inserted in one verdict", () => {
    const initialMd = `# Plan

## Feature 1: A

### Phase 1.1: x
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 2: B

### Phase 2.1: y
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const planFile = _testWritePlan(initialMd);
    try {
      const initial = parsePlan(initialMd);
      const state = buildStateFromParsed(initial);
      state.phases[0].status = "committed";

      const block = `### Phase 1.review-1: First follow-up
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 1.review-2: Second follow-up
- [ ] **Implementation**: x
- [ ] **Review**: y`;
      appendFeaturePhases({
        planFile,
        featureNumber: "1",
        phasesMd: block,
      });

      const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"));
      const report = mergeReparsedPhases(state, reparsed);

      expect(state.phases.map((s) => s.number)).toEqual([
        "1.1",
        "1.review-1",
        "1.review-2",
        "2.1",
      ]);
      expect(state.phases[0].status).toBe("committed");
      expect(state.phases[3].number).toBe("2.1");
      expect(state.phases[3].status).toBe("pending");
      expect(report.added).toEqual(["1.review-1", "1.review-2"]);
      expect(report.addedFeatures).toEqual([]);
      expect(report.orphanedFeatures).toEqual([]);
      expect(state.features[0].phaseIndexes).toEqual([0, 1, 2]);
      expect(state.features[1].phaseIndexes).toEqual([3]);
    } finally {
      fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
    }
  });

  it("reports orphans without mutating their fate (defensive — production never removes phases today)", () => {
    // Simulate a state that has a phase number which is no longer in the
    // reparsed plan. This shouldn't happen in production, but the merge
    // must report it rather than silently retaining or dropping it.
    const md = `# Plan

## Feature 1: A

### Phase 1.1: x
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const planFile = _testWritePlan(md);
    try {
      const initial = parsePlan(md);
      const state = buildStateFromParsed(initial);
      // Plant an extra PhaseState that doesn't exist in the parser view.
      state.phases.push({
        index: 1,
        number: "1.ghost",
        name: "Ghost phase",
        status: "pending",
      });

      const reparsed = parsePlan(md);
      const report = mergeReparsedPhases(state, reparsed);

      expect(report.orphaned).toEqual(["1.ghost"]);
      expect(report.addedFeatures).toEqual([]);
      expect(report.orphanedFeatures).toEqual([]);
      // Orphan is dropped (the parser view is authoritative — there is no
      // such phase in the plan file anymore, so keeping the runtime entry
      // would only re-introduce the desync we just fixed).
      expect(state.phases.map((s) => s.number)).toEqual(["1.1"]);
    } finally {
      fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
    }
  });
});

describe("mergeReparsedPhases — resume-path repair of pre-fix on-disk state", () => {
  // Simulates the exact corrupted-state shape the bug report describes:
  //   * Plan markdown has Feature 1's review phase spliced in mid-array
  //   * On-disk state.json (written by pre-fix gstack) has the OLD phase order
  //     plus a duplicate of the actually-last phase pushed by slice(oldCount)
  // The cli.ts resume guard detects the disagreement and calls mergeReparsedPhases
  // to repair. This test pins that the repair restores invariants without losing
  // PhaseState content (status, committedAt, gemini outputs).
  it("repairs state.phases for a build started by the pre-fix code path", () => {
    const desyncedMd = `# Plan

## Feature 1: Auth

### Phase 1.1: Schema
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 1.2: Service
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 1.3: Endpoint
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 1.review-1: Codex follow-up
- [ ] **Implementation**: do the follow-up
- [ ] **Review**: review the follow-up

## Feature 2: Billing

### Phase 2.1: Invoice model
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 2.2: Charge endpoint
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 3: Notify

### Phase 3.1: Email job
- [ ] **Implementation**: x
- [ ] **Review**: y
`;

    const reparsed = parsePlan(desyncedMd);
    expect(reparsed.phases.map((p) => p.number)).toEqual([
      "1.1",
      "1.2",
      "1.3",
      "1.review-1",
      "2.1",
      "2.2",
      "3.1",
    ]);

    // Hand-construct the on-disk state shape that pre-fix /build would have
    // written: original 6 phases at their pre-splice positions + a duplicate
    // "3.1" pushed onto the end by slice(oldPhaseCount=6).
    const state: BuildState = {
      planFile: "/tmp/desynced.md",
      planBasename: "desynced",
      slug: "desynced",
      branch: "main",
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      currentPhaseIndex: 3,
      currentFeatureIndex: 1,
      features: [
        {
          index: 0,
          number: "1",
          name: "Auth",
          phaseIndexes: [0, 1, 2],
          status: "phases_done",
        },
        {
          index: 1,
          number: "2",
          name: "Billing",
          phaseIndexes: [3, 4],
          status: "pending",
        },
        {
          index: 2,
          number: "3",
          name: "Notify",
          phaseIndexes: [5],
          status: "pending",
        },
      ],
      phases: [
        {
          index: 0,
          number: "1.1",
          name: "Schema",
          status: "committed",
          committedAt: "2026-05-18T15:00:00Z",
        },
        {
          index: 1,
          number: "1.2",
          name: "Service",
          status: "committed",
          committedAt: "2026-05-18T15:05:00Z",
        },
        {
          index: 2,
          number: "1.3",
          name: "Endpoint",
          status: "committed",
          committedAt: "2026-05-18T15:10:00Z",
        },
        // Slot 3 is the bug: the pre-fix code ran the review against this
        // slot, leaving gemini.outputFilePath pointing at the new review
        // phase while .number still describes Feature 2's first phase.
        {
          index: 3,
          number: "2.1",
          name: "Invoice model",
          status: "pending",
          gemini: makeSentinelInvocation({
            outputFilePath: "phase-1.review-1-impl.md",
            outputLogPath: "phase-1.review-1-impl.log",
            startedAt: "2026-05-18T15:30:00Z",
          }),
        },
        {
          index: 4,
          number: "2.2",
          name: "Charge endpoint",
          status: "pending",
        },
        // First "3.1" — pin a distinct sentinel so we can verify which
        // duplicate survives the Map-based dedupe.
        {
          index: 5,
          number: "3.1",
          name: "Email job",
          status: "pending",
          gemini: makeSentinelInvocation({
            outputFilePath: "FIRST-3.1-impl.md",
          }),
        },
        // Duplicate "3.1" with index 6 — what the OLD slice() merge pushed.
        // Distinct sentinel from the first one.
        {
          index: 6,
          number: "3.1",
          name: "Email job",
          status: "pending",
          gemini: makeSentinelInvocation({
            outputFilePath: "DUPLICATE-3.1-impl.md",
          }),
        },
      ],
      completed: false,
    };

    // The resume guard's trigger condition: state.phases.length !==
    // reparsed.phases.length OR any per-index number mismatch.
    const needsRepairByLength = state.phases.length !== reparsed.phases.length;
    const needsRepairByOrder = state.phases.some(
      (ps, i) => reparsed.phases[i] && ps.number !== reparsed.phases[i].number,
    );
    expect(needsRepairByLength || needsRepairByOrder).toBe(true);

    // Run the repair (same function the resume guard calls).
    const report = mergeReparsedPhases(state, reparsed);

    // After repair: state.phases matches the parser, no duplicate, no orphan.
    expect(state.phases.map((s) => s.number)).toEqual([
      "1.1",
      "1.2",
      "1.3",
      "1.review-1",
      "2.1",
      "2.2",
      "3.1",
    ]);
    expect(state.phases.length).toBe(7);
    const numbers = state.phases.map((s) => s.number);
    expect(new Set(numbers).size).toBe(numbers.length); // no dup

    // PhaseState content survives the repair: Feature 1's committed status
    // and committedAt timestamps are preserved.
    expect(state.phases[0].status).toBe("committed");
    expect(state.phases[0].committedAt).toBe("2026-05-18T15:00:00Z");
    expect(state.phases[2].status).toBe("committed");

    // The new review phase lands at the parser-assigned index 3 with a
    // fresh "pending" status.
    expect(state.phases[3].number).toBe("1.review-1");
    expect(state.phases[3].status).toBe("pending");

    // The previously-stale slot now correctly describes "2.1" (parser index
    // 4) and retained the gemini sentinel that was planted on it. This is
    // the user-visible recovery: gemini.outputFilePath now matches its slot.
    expect(state.phases[4].number).toBe("2.1");
    expect(state.phases[4].gemini?.outputFilePath).toBe(
      "phase-1.review-1-impl.md",
    );

    // Duplicate-number collapse: pins the last-write-wins semantic
    // documented in mergeReparsedPhases. The Map insertion order means the
    // SECOND "3.1" entry (the corruption duplicate at original index 6)
    // overwrote the first in stateByNumber, so the duplicate's sentinel
    // is what survives. The first "3.1"'s sentinel is dropped silently —
    // this is by design, since the duplicate is the corruption artifact
    // and there is no principled way to choose between two same-numbered
    // PhaseStates. Future refactors that change this contract should
    // update this assertion deliberately.
    expect(state.phases[6].gemini?.outputFilePath).toBe(
      "DUPLICATE-3.1-impl.md",
    );

    // featureState.phaseIndexes resync with the parser.
    expect(state.features[0].phaseIndexes).toEqual([0, 1, 2, 3]);
    expect(state.features[1].phaseIndexes).toEqual([4, 5]);
    expect(state.features[2].phaseIndexes).toEqual([6]);

    // No orphans reported (everything in state had a matching parser entry,
    // including the duplicate which collapsed into the canonical "3.1" slot).
    // No feature-level mutation: parser sees the same 3 features as state.
    expect(report.orphaned).toEqual([]);
    expect(report.added).toEqual(["1.review-1"]);
    expect(report.addedFeatures).toEqual([]);
    expect(report.orphanedFeatures).toEqual([]);

    // The merge MUST NOT touch cursor fields. callers manage cursor
    // placement; the merge only fixes the array shape.
    expect(state.currentPhaseIndex).toBe(3);
    expect(state.currentFeatureIndex).toBe(1);
  });

  it("surfaces added and orphaned features in the report", () => {
    // State knows about 2 features (Feature 1, Feature 2). The parsed
    // plan adds Feature 3 (new) and removes Feature 2 (orphan). Production
    // never hits this today, but the report shape must surface both deltas
    // so a future runtime change can act on them.
    const initial = parsePlan(`# Plan

## Feature 1: Auth

### Phase 1.1: x
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 2: Billing

### Phase 2.1: x
- [ ] **Implementation**: x
- [ ] **Review**: y
`);
    const state = buildStateFromParsed(initial);

    const reparsed = parsePlan(`# Plan

## Feature 1: Auth

### Phase 1.1: x
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 3: Notify

### Phase 3.1: x
- [ ] **Implementation**: x
- [ ] **Review**: y
`);

    const report = mergeReparsedPhases(state, reparsed);

    expect(report.addedFeatures).toEqual(["3"]);
    expect(report.orphanedFeatures).toEqual(["2"]);
    expect(state.features.map((f) => f.number)).toEqual(["1", "3"]);
    expect(state.features.length).toBe(2);
    // The orphaned Feature 2's phases also drop from state.phases.
    expect(state.phases.map((s) => s.number)).toEqual(["1.1", "3.1"]);
    expect(report.orphaned).toEqual(["2.1"]);
    expect(report.added).toEqual(["3.1"]);
  });
});
