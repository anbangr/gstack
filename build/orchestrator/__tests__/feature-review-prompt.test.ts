/**
 * F4: convergence-cap interactive prompt + BLOCKED-feature-N.md tests.
 *
 * promptYesNo is exercised with mock streams (no real TTY required) and
 * the buildBlockedFeatureMd builder is verified for content. The
 * orchestrator-side wiring (cap-hit triggers prompt → user declines →
 * BLOCKED file written + status=feature_blocked) is covered by the
 * integration test in this same file using --dry-run, an in-memory
 * plan, and a stubbed reviewer that always returns UNCLEAR.
 */
import { describe, it, expect } from "bun:test";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promptYesNo, buildBlockedFeatureMd } from "../feature-review-prompt";
import type { Feature, FeatureState } from "../types";

function readableFrom(text: string): NodeJS.ReadableStream {
  // Build a byte-mode stream readline can line-parse. Readable.from
  // with a string returns object-mode; readline ignores 'line' events
  // from that and only fires 'close', which makes the prompt always
  // return the default. Pushing Buffers explicitly avoids the trap.
  const r = new Readable({ read() {} });
  r.push(Buffer.from(text));
  r.push(null);
  (r as any).isTTY = false;
  return r;
}

function captureWriter(): {
  stream: NodeJS.WritableStream;
  read: () => string;
} {
  let buf = "";
  const w = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return {
    stream: w as unknown as NodeJS.WritableStream,
    read: () => buf,
  };
}

describe("promptYesNo", () => {
  it("returns the default when stdin is non-TTY (CI / piped runs)", async () => {
    const out = captureWriter();
    const result = await promptYesNo({
      question: "carry on?",
      defaultValue: false,
      inStream: readableFrom("y\n"), // would say yes if asked
      outStream: out.stream,
      isTTY: false, // explicit non-TTY
    });
    expect(result).toBe(false);
    expect(out.read()).toContain("non-interactive");
    expect(out.read()).toContain("default: no");
  });

  it("returns the user's `y` answer on a TTY", async () => {
    const out = captureWriter();
    const result = await promptYesNo({
      question: "carry on?",
      defaultValue: false,
      inStream: readableFrom("y\n"),
      outStream: out.stream,
      isTTY: true,
    });
    expect(result).toBe(true);
    expect(out.read()).toContain("[y/N]"); // default-no suffix
  });

  it("returns the user's `n` answer on a TTY", async () => {
    const out = captureWriter();
    const result = await promptYesNo({
      question: "carry on?",
      defaultValue: true,
      inStream: readableFrom("n\n"),
      outStream: out.stream,
      isTTY: true,
    });
    expect(result).toBe(false);
    expect(out.read()).toContain("[Y/n]"); // default-yes suffix
  });

  it("uses the default when the user just hits Enter on a TTY", async () => {
    const out = captureWriter();
    const result = await promptYesNo({
      question: "carry on?",
      defaultValue: true,
      inStream: readableFrom("\n"),
      outStream: out.stream,
      isTTY: true,
    });
    expect(result).toBe(true);
  });

  it("uses the default for unrecognized answers (no infinite re-prompt)", async () => {
    const out = captureWriter();
    const result = await promptYesNo({
      question: "carry on?",
      defaultValue: false,
      inStream: readableFrom("maybe\n"),
      outStream: out.stream,
      isTTY: true,
    });
    expect(result).toBe(false);
    expect(out.read()).toContain('Unrecognized answer "maybe"');
  });

  it("returns the default when stdin closes before a line arrives (piped EOF on TTY)", async () => {
    const out = captureWriter();
    const r = Readable.from([]); // empty stream that immediately ends
    (r as any).isTTY = true;
    const result = await promptYesNo({
      question: "carry on?",
      defaultValue: true,
      inStream: r,
      outStream: out.stream,
      isTTY: true,
    });
    expect(result).toBe(true);
  });

  it("accepts case-insensitive answers (Y, YES, n, no)", async () => {
    for (const [ans, expected] of [
      ["Y", true],
      ["YES", true],
      ["yes", true],
      ["N", false],
      ["NO", false],
      ["no", false],
    ] as const) {
      const out = captureWriter();
      const r = await promptYesNo({
        question: "?",
        defaultValue: !expected, // opposite default to ensure user input wins
        inStream: readableFrom(`${ans}\n`),
        outStream: out.stream,
        isTTY: true,
      });
      expect(r).toBe(expected);
    }
  });
});

describe("buildBlockedFeatureMd", () => {
  function fakeFeature(): Feature {
    return {
      index: 0,
      number: "1",
      name: "Auth",
      body: "Build the auth flow.",
      phaseIndexes: [0, 1],
    };
  }

  function fakeFeatureStateWithReview(
    overrides: Partial<FeatureState["featureReview"]> = {},
  ): FeatureState {
    return {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [0, 1],
      status: "feature_blocked",
      featureReview: {
        iterations: 3,
        outputLogPaths: ["/logs/r1.log", "/logs/r2.log", "/logs/r3.log"],
        outputFilePaths: ["/logs/r1.md", "/logs/r2.md", "/logs/r3.md"],
        finalVerdict: "FEATURE_REDO",
        ...overrides,
      },
    };
  }

  it("includes the failure reason, cycle count, last verdict, and resume commands", () => {
    const md = buildBlockedFeatureMd({
      feature: fakeFeature(),
      featureState: fakeFeatureStateWithReview(),
      reason:
        "feature-review failed to converge after 3 cycles (user declined extension)",
      planFile: "/repo/PLAN.md",
      timestamp: "2026-05-04T12:00:00.000Z",
    });
    expect(md).toContain("# BLOCKED — Feature 1: Auth");
    expect(md).toContain("**Failure:** feature-review failed to converge");
    expect(md).toContain("**Date:** 2026-05-04T12:00:00.000Z");
    expect(md).toContain("**Review cycles run:** 3");
    expect(md).toContain("**Last verdict:** FEATURE_REDO");
    expect(md).toContain("**Phases in feature:** 2");
    // Resume guidance with the actual plan path.
    expect(md).toContain("/repo/PLAN.md");
    expect(md).toContain("--skip-feature-review");
    expect(md).toContain("--feature-review-max-iter");
    expect(md).toContain("--reset-phase");
  });

  it("lists every persisted review report path", () => {
    const md = buildBlockedFeatureMd({
      feature: fakeFeature(),
      featureState: fakeFeatureStateWithReview(),
      reason: "blocked",
      planFile: "/repo/PLAN.md",
      timestamp: "2026-05-04T12:00:00.000Z",
    });
    expect(md).toContain("- /logs/r1.md");
    expect(md).toContain("- /logs/r2.md");
    expect(md).toContain("- /logs/r3.md");
  });

  it("embeds a snippet of the last report when readable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-feat-md-"));
    try {
      const reportPath = path.join(dir, "report.md");
      fs.writeFileSync(
        reportPath,
        "## VERDICT\nFEATURE_REDO\n\n## Findings\n- the migration is wrong\n",
      );
      const md = buildBlockedFeatureMd({
        feature: fakeFeature(),
        featureState: fakeFeatureStateWithReview(),
        reason: "blocked",
        planFile: "/repo/PLAN.md",
        timestamp: "2026-05-04T12:00:00.000Z",
        lastReportPath: reportPath,
      });
      expect(md).toContain("the migration is wrong");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates oversized last-report content from the head, keeping the tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-feat-md-"));
    try {
      const reportPath = path.join(dir, "report.md");
      const huge = "X".repeat(20_000) + "\nIMPORTANT_TAIL_MARKER\n";
      fs.writeFileSync(reportPath, huge);
      const md = buildBlockedFeatureMd({
        feature: fakeFeature(),
        featureState: fakeFeatureStateWithReview(),
        reason: "blocked",
        planFile: "/repo/PLAN.md",
        timestamp: "2026-05-04T12:00:00.000Z",
        lastReportPath: reportPath,
      });
      expect(md).toContain("IMPORTANT_TAIL_MARKER");
      // Ensure we didn't blow up the file with the full 20K of X.
      expect(md.length).toBeLessThan(15_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a friendly placeholder when the last report path is unreadable", () => {
    const md = buildBlockedFeatureMd({
      feature: fakeFeature(),
      featureState: fakeFeatureStateWithReview(),
      reason: "blocked",
      planFile: "/repo/PLAN.md",
      timestamp: "2026-05-04T12:00:00.000Z",
      lastReportPath: "/does/not/exist/report.md",
    });
    expect(md).toContain("not readable");
  });

  it("omits the report list cleanly when no reports were persisted", () => {
    const fs = fakeFeature();
    const md = buildBlockedFeatureMd({
      feature: fs,
      featureState: {
        index: 0,
        number: "1",
        name: "Auth",
        phaseIndexes: [0, 1],
        status: "feature_blocked",
        featureReview: {
          iterations: 0,
          outputLogPaths: [],
          outputFilePaths: [],
        },
      },
      reason: "blocked",
      planFile: "/repo/PLAN.md",
      timestamp: "2026-05-04T12:00:00.000Z",
    });
    expect(md).toContain("(no review reports persisted)");
  });
});
