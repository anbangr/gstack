/**
 * Regression tests for Bug D — Gemini model 404 preflight probe.
 *
 * Bug ref:
 *   ~/.gstack/skill-faults/manual-1779768437194/MANUAL_INVESTIGATION:0:856e5242.md
 * Plan ref: ~/.claude/plans/fix-orchestrator-mitosis-oasis-may-26-faults.md
 *
 * Two layers:
 *   - parseGeminiModelProbeStderr: pure function, fully testable here.
 *   - assertGeminiModel: async, network-bound (skipped in CI without
 *     a live gemini install + GSTACK_AUTH_PREFLIGHT_LIVE=1 env knob).
 *
 * The static-grep wiring guard ensures the runtime call site at
 * sub-agents.ts continues to invoke assertGeminiModel after auth.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGeminiModelProbeStderr } from "../sub-agents";

describe("Bug D — parseGeminiModelProbeStderr", () => {
  it("T-D1a: empty stderr returns ok:true", () => {
    expect(parseGeminiModelProbeStderr("")).toEqual({ ok: true });
  });

  it("T-D1b: unrelated stderr (warning, debug noise) returns ok:true", () => {
    const stderr =
      "Warning: 256-color support not detected.\nRipgrep is not available. Falling back to GrepTool.\n";
    expect(parseGeminiModelProbeStderr(stderr)).toEqual({ ok: true });
  });

  it("T-D1c: ModelNotFoundError stack trace returns ok:false reason:model-not-found", () => {
    const stderr =
      "ModelNotFoundError: Requested entity was not found.\n  at <anonymous>\n  code: 404";
    const result = parseGeminiModelProbeStderr(stderr);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("model-not-found");
  });

  it("T-D1d: raw 'code: 404' alone is enough to trigger detection", () => {
    const stderr = "Error talking to Gemini API\n  code: 404";
    expect(parseGeminiModelProbeStderr(stderr).ok).toBe(false);
  });

  it("T-D1e: 'Requested entity was not found' alone is enough", () => {
    const stderr = "Requested entity was not found.";
    expect(parseGeminiModelProbeStderr(stderr).ok).toBe(false);
  });

  it("T-D1f: model name extraction when stderr names it", () => {
    const stderr =
      'ModelNotFoundError: model="gemini-3.5-flash" not found code: 404';
    const result = parseGeminiModelProbeStderr(stderr);
    expect(result.ok).toBe(false);
    expect(result.model).toBe("gemini-3.5-flash");
  });

  it("T-D1g: model name absent leaves model undefined (caller falls back)", () => {
    const stderr = "ModelNotFoundError: code: 404";
    const result = parseGeminiModelProbeStderr(stderr);
    expect(result.ok).toBe(false);
    expect(result.model).toBeUndefined();
  });

  it("T-D1h: case-insensitive matching for ModelNotFoundError", () => {
    expect(
      parseGeminiModelProbeStderr("modelnotfounderror occurred").ok,
    ).toBe(false);
  });
});

describe("Bug D — static-grep wiring guards", () => {
  const subAgentsPath = path.resolve(import.meta.dir, "../sub-agents.ts");
  const subAgentsContent = fs.readFileSync(subAgentsPath, "utf-8");

  it("T-D2a: configure.cm uses gemini-2.5-flash (no stale 3.5-flash refs)", () => {
    const configPath = path.resolve(import.meta.dir, "../../configure.cm");
    const configContent = fs.readFileSync(configPath, "utf-8");
    expect(configContent).not.toContain("gemini-3.5-flash");
    expect(configContent).toContain("gemini-2.5-flash");
  });

  it("T-D2b: runGeminiTask call site invokes assertGeminiModel after auth (with .catch)", () => {
    // Adversarial review tightened this from `void assertGeminiModel(...)`
    // (which leaks unhandled rejections) to `.catch(() => {})`. The
    // .catch must be present so the probe can never crash a phase even
    // if assertGeminiModel itself throws synchronously.
    expect(subAgentsContent).toMatch(
      /assertGeminiModel\(opts\.model\)\.catch\(/,
    );
  });

  it("T-D2c: probe cache + warned-set both cleared in _resetAuthPreflightForTests", () => {
    const start = subAgentsContent.indexOf(
      "_resetAuthPreflightForTests",
    );
    expect(start).toBeGreaterThan(0);
    // Function body is small — slice a generous window
    const block = subAgentsContent.slice(start, start + 800);
    expect(block).toContain("_geminiModelProbeCache.clear()");
    expect(block).toContain("_geminiModelWarnedSet.clear()");
  });
});
