import { describe, it, expect } from "bun:test";
import { formatGateHygieneRecoveryHint } from "../cli";

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
