import { describe, it, expect } from "bun:test";
import {
  formatGateHygieneRecoveryHint,
  phaseRefForHygieneHint,
} from "../cli";
import type { Phase } from "../types";

function fakePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    index: 0,
    number: "1",
    name: "P",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "F",
    kind: "code",
    implementationDone: false,
    reviewDone: false,
    implementationCheckboxLine: -1,
    reviewCheckboxLine: -1,
    testSpecCheckboxLine: -1,
    body: "",
    ...overrides,
  } as unknown as Phase;
}

describe("formatGateHygieneRecoveryHint", () => {
  it("includes the --mark-phase-committed command with the phase number", () => {
    const hint = formatGateHygieneRecoveryHint({
      phaseRef: { phaseNumber: "2.1" },
      nonTestPaths: ["src/auth.ts"],
    });
    expect(hint).toContain("--mark-phase-committed 2.1");
    expect(hint).toContain("src/auth.ts");
  });

  it("uses feature.phase form when featureNumber is supplied", () => {
    const hint = formatGateHygieneRecoveryHint({
      phaseRef: { featureNumber: "3", phaseNumber: "2" },
      nonTestPaths: ["src/x.ts"],
    });
    expect(hint).toContain("--mark-phase-committed 3.2");
  });

  it("falls back to <feature>.<phase> placeholder without a phaseRef", () => {
    const hint = formatGateHygieneRecoveryHint({
      nonTestPaths: ["src/x.ts"],
    });
    expect(hint).toContain("--mark-phase-committed <feature>.<phase>");
  });

  it("truncates the path list after 5 entries with a +N more line", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const hint = formatGateHygieneRecoveryHint({
      phaseRef: { phaseNumber: "1" },
      nonTestPaths: paths,
    });
    expect(hint).toContain("src/f0.ts");
    expect(hint).toContain("src/f4.ts");
    expect(hint).toContain("+3 more");
    expect(hint).not.toContain("src/f7.ts");
  });

  it("returns empty string when there are no non-test paths to report", () => {
    const hint = formatGateHygieneRecoveryHint({
      phaseRef: { phaseNumber: "1" },
      nonTestPaths: [],
    });
    expect(hint).toBe("");
  });
});

// ---------------------------------------------------------------------------
// phaseRefForHygieneHint — Bug T3 (tidy-haven 2026-05-21 review-qa-hygiene
// -manual-recovery-phase-id-risk)
// ---------------------------------------------------------------------------
describe("phaseRefForHygieneHint", () => {
  it("merges featureNumber + bare phase number for bare-stem plans", () => {
    // Bare convention: phase.number === "1" (per-feature stem), feature is "3".
    // Pre-fix the caller dropped featureNumber and produced `--mark-phase-committed 1`,
    // ambiguous when the plan has multiple features each with a phase 1.
    const ref = phaseRefForHygieneHint(
      fakePhase({ number: "1", featureNumber: "3" }),
    );
    expect(ref).toEqual({ featureNumber: "3", phaseNumber: "1" });
    const hint = formatGateHygieneRecoveryHint({
      phaseRef: ref,
      nonTestPaths: ["src/x.ts"],
    });
    expect(hint).toContain("--mark-phase-committed 3.1");
  });

  it("does NOT double-prefix when phase.number already contains a dot (dot-numbered plans)", () => {
    // Dot convention: phase.number === "2.1" already encodes feature.phase.
    // Passing both featureNumber AND phase.number would produce "1.2.1" — broken.
    const ref = phaseRefForHygieneHint(
      fakePhase({ number: "2.1", featureNumber: "1" }),
    );
    expect(ref).toEqual({ phaseNumber: "2.1" });
    const hint = formatGateHygieneRecoveryHint({
      phaseRef: ref,
      nonTestPaths: ["src/x.ts"],
    });
    expect(hint).toContain("--mark-phase-committed 2.1");
    expect(hint).not.toContain("--mark-phase-committed 1.2.1");
  });
});
