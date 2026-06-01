/**
 * Single-round plan review: unit tests for the pure helpers (synth-check
 * parsing, non-TTY dispute policy, the dispute gate) and the orchestrator
 * (runPlanReviewSingle) with injected reviewer/synth-check/synth fakes.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  parseSynthCheckOutput,
  resolveDisputeNonInteractive,
  runDisputeGateTTY,
  runPlanReviewSingle,
  type RunPlanReviewSingleInput,
} from "../plan-review-single";
import type { PlanReviewObjection, PlanReviewVerdict } from "../types";

function obj(
  severity: PlanReviewObjection["severity"],
  location: string,
  issue = "issue text",
  suggestion = "fix text",
): PlanReviewObjection {
  return { severity, location, issue, suggestion };
}

function verdictOf(objections: PlanReviewObjection[]): PlanReviewVerdict {
  return {
    verdict: objections.length ? "REVISE" : "APPROVE",
    objections,
    assessment: "",
    reviewedBy: "codex:gpt-5.5",
    round: 1,
  };
}

function fakeInput(lines: string[]): Readable {
  return Readable.from([lines.map((l) => l + "\n").join("")]);
}

function fakeOutput(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

describe("parseSynthCheckOutput", () => {
  it("parses ACCEPT and DISPUTE lines with reasons", () => {
    const raw = [
      "- STANCE 1: ACCEPT",
      "- STANCE 2: DISPUTE — the plan already handles this in Phase 4",
    ].join("\n");
    const { stances: out } = parseSynthCheckOutput(raw, 2);
    expect(out[0]).toEqual({ index: 0, stance: "ACCEPT", reason: undefined });
    expect(out[1].stance).toBe("DISPUTE");
    expect(out[1].reason).toBe("the plan already handles this in Phase 4");
  });

  it("defaults SOME unclassified objections to ACCEPT (one was classified)", () => {
    const { stances: out, parsedCount } = parseSynthCheckOutput(
      "- STANCE 1: DISPUTE — nope",
      3,
    );
    expect(out[0].stance).toBe("DISPUTE");
    expect(out[1].stance).toBe("ACCEPT");
    expect(out[2].stance).toBe("ACCEPT");
    // One objection was actually classified — this is NOT a synth failure.
    expect(parsedCount).toBe(1);
  });

  it("reports parsedCount=0 for fully-unparseable output (the synth-failure signal)", () => {
    const { stances, parsedCount } = parseSynthCheckOutput(
      "I'll analyze each objection now. The first one seems reasonable...",
      3,
    );
    expect(parsedCount).toBe(0);
    // The array still defaults to ACCEPT, but the caller MUST gate on
    // parsedCount and treat 0 as a failure (not unanimous agreement).
    expect(stances.every((s) => s.stance === "ACCEPT")).toBe(true);
  });

  it("tolerates hyphen separator, missing bullet, and extra whitespace", () => {
    const raw = [
      "STANCE 1: ACCEPT",
      "  - STANCE 2:  DISPUTE - short reason  ",
    ].join("\n");
    const { stances: out } = parseSynthCheckOutput(raw, 2);
    expect(out[0].stance).toBe("ACCEPT");
    expect(out[1].stance).toBe("DISPUTE");
    expect(out[1].reason).toBe("short reason");
  });

  it("ignores out-of-range indices", () => {
    const { stances: out, parsedCount } = parseSynthCheckOutput(
      "- STANCE 9: DISPUTE — x",
      2,
    );
    expect(out.every((s) => s.stance === "ACCEPT")).toBe(true);
    expect(parsedCount).toBe(0); // index 9 is out of range → nothing parsed
  });
});

describe("resolveDisputeNonInteractive", () => {
  it("auto-accept → reviewer, no fail-fast", () => {
    expect(resolveDisputeNonInteractive("auto-accept", "CRITICAL")).toEqual({
      resolution: "reviewer",
      failFast: false,
    });
  });
  it("auto-reject → synth", () => {
    expect(resolveDisputeNonInteractive("auto-reject", "CRITICAL")).toEqual({
      resolution: "synth",
      failFast: false,
    });
  });
  it("fail-fast + CRITICAL → reviewer + failFast", () => {
    expect(resolveDisputeNonInteractive("fail-fast", "CRITICAL")).toEqual({
      resolution: "reviewer",
      failFast: true,
    });
  });
  it("fail-fast + IMPORTANT → reviewer, no fail-fast", () => {
    expect(resolveDisputeNonInteractive("fail-fast", "IMPORTANT")).toEqual({
      resolution: "reviewer",
      failFast: false,
    });
  });
});

describe("runDisputeGateTTY", () => {
  const objs = [obj("CRITICAL", "F1.P1"), obj("IMPORTANT", "F2.P3")];
  const stances = [
    { index: 0, stance: "DISPUTE" as const, reason: "r0" },
    { index: 1, stance: "DISPUTE" as const, reason: "r1" },
  ];
  function queuedAsk(answers: string[]) {
    let i = 0;
    return async () => answers[i++] ?? "";
  }

  it("maps r/s/d to reviewer/synth/defer", async () => {
    const out = fakeOutput();
    const res = await runDisputeGateTTY({
      disputedIndices: [0, 1],
      objections: objs,
      stances,
      output: out.stream,
      ask: queuedAsk(["r", "s"]),
    });
    expect(res.aborted).toBe(false);
    expect(res.resolutions.get(0)).toBe("reviewer");
    expect(res.resolutions.get(1)).toBe("synth");
  });

  it("aborts on q", async () => {
    const out = fakeOutput();
    const res = await runDisputeGateTTY({
      disputedIndices: [0, 1],
      objections: objs,
      stances,
      output: out.stream,
      ask: queuedAsk(["q"]),
    });
    expect(res.aborted).toBe(true);
  });

  it("re-prompts on invalid input then accepts a valid key", async () => {
    const out = fakeOutput();
    const res = await runDisputeGateTTY({
      disputedIndices: [0],
      objections: objs,
      stances,
      output: out.stream,
      ask: queuedAsk(["huh", "d"]),
    });
    expect(res.resolutions.get(0)).toBe("defer");
  });

  it("ABORTS on stream close (EOF) — never applies an unapproved fix", async () => {
    const out = fakeOutput();
    const res = await runDisputeGateTTY({
      disputedIndices: [0, 1],
      objections: objs,
      stances,
      output: out.stream,
      ask: queuedAsk([]), // exhausted → returns ""
      isStreamClosed: () => true,
    });
    expect(res.aborted).toBe(true);
    // No resolution recorded — the gate did not silently side with reviewer.
    expect(res.resolutions.size).toBe(0);
  });

  it("bare enter on a LIVE stream re-prompts (does not default to apply)", async () => {
    const out = fakeOutput();
    const res = await runDisputeGateTTY({
      disputedIndices: [0],
      objections: objs,
      stances,
      output: out.stream,
      ask: queuedAsk(["", "s"]), // empty (live) → re-prompt → synth
      isStreamClosed: () => false,
    });
    expect(res.aborted).toBe(false);
    expect(res.resolutions.get(0)).toBe("synth");
  });
});

describe("runPlanReviewSingle", () => {
  let dir: string;
  let planPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-prs-"));
    planPath = path.join(dir, "PLAN.md");
    fs.writeFileSync(planPath, "# Plan\n\n### Phase 1\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function baseInput(
    over: Partial<RunPlanReviewSingleInput> & {
      objections: PlanReviewObjection[];
      synthCheckRaw?: string;
      synthCheckOk?: boolean;
      synthOk?: boolean;
    },
  ): { input: RunPlanReviewSingleInput; synthCalls: PlanReviewObjection[][] } {
    const synthCalls: PlanReviewObjection[][] = [];
    const out = fakeOutput();
    const input: RunPlanReviewSingleInput = {
      planPath,
      reviewerFn: async () => verdictOf(over.objections),
      synthCheckFn: async () => ({
        ok: over.synthCheckOk ?? true,
        raw: over.synthCheckRaw ?? "",
      }),
      synthFn: async (toFix) => {
        synthCalls.push(toFix);
        return { ok: over.synthOk ?? true };
      },
      isTTY: over.isTTY ?? false,
      nonInteractiveMode: over.nonInteractiveMode ?? "auto-accept",
      input: over.input ?? fakeInput([]),
      output: over.output ?? out.stream,
    };
    return { input, synthCalls };
  }

  it("approves with no CRITICAL/IMPORTANT objections (suggestions don't block)", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("SUGGESTION", "F1")],
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("approved");
    expect(r.exitCode).toBe(0);
    expect(synthCalls.length).toBe(0);
  });

  it("synth ACCEPTs all → one revision with all objections → revised", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1"), obj("IMPORTANT", "F2")],
      synthCheckRaw: "- STANCE 1: ACCEPT\n- STANCE 2: ACCEPT",
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("revised");
    expect(r.exitCode).toBe(0);
    expect(synthCalls).toHaveLength(1);
    expect(synthCalls[0]).toHaveLength(2);
  });

  it("synth-check failure → synth_failure exit 1, no revision", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckOk: false,
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("synth_failure");
    expect(r.exitCode).toBe(1);
    expect(synthCalls.length).toBe(0);
  });

  it("synth-check exits 0 but classifies NOTHING → synth_failure, never auto-applies", async () => {
    // The CRITICAL adversarial finding: an agent that narrates instead of
    // emitting STANCE lines must NOT default every objection to ACCEPT and
    // silently rewrite the plan with no human adjudication.
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1"), obj("IMPORTANT", "F2")],
      synthCheckOk: true,
      synthCheckRaw: "Sure! Let me look at these objections one by one...",
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("synth_failure");
    expect(r.exitCode).toBe(1);
    expect(synthCalls.length).toBe(0); // no revision — gate was NOT bypassed
  });

  it("TTY: stream closes mid-dispute → user_abort exit 4 (no unapproved fix)", async () => {
    // Stdin EOF (dropped terminal) must abort, not apply the reviewer's fix.
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: DISPUTE — debatable",
      isTTY: true,
      input: fakeInput([]), // empty stream → readline closes immediately
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("user_abort");
    expect(r.exitCode).toBe(4);
    expect(synthCalls.length).toBe(0);
  });

  it("TTY: user sides with reviewer on a dispute → fix applied → revised", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: DISPUTE — I think this is fine",
      isTTY: true,
      input: fakeInput(["r"]),
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("revised");
    expect(synthCalls[0]).toHaveLength(1);
  });

  it("TTY: user sides with synth on the only dispute → nothing to fix → approved", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: DISPUTE — already handled",
      isTTY: true,
      input: fakeInput(["s"]),
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("approved");
    expect(r.exitCode).toBe(0);
    expect(synthCalls.length).toBe(0);
  });

  it("TTY: user quits → user_abort exit 4", async () => {
    const { input } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: DISPUTE — nope",
      isTTY: true,
      input: fakeInput(["q"]),
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("user_abort");
    expect(r.exitCode).toBe(4);
  });

  it("non-TTY fail-fast on a CRITICAL dispute → critical_dispute exit 3", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: DISPUTE — nope",
      isTTY: false,
      nonInteractiveMode: "fail-fast",
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("critical_dispute");
    expect(r.exitCode).toBe(3);
    expect(synthCalls.length).toBe(0);
  });

  it("non-TTY auto-reject drops disputes → approved when nothing accepted", async () => {
    const { input, synthCalls } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: DISPUTE — already handled",
      isTTY: false,
      nonInteractiveMode: "auto-reject",
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("approved");
    expect(synthCalls.length).toBe(0);
  });

  it("revision agent failure → synth_failure exit 1", async () => {
    const { input } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: ACCEPT",
      synthOk: false,
    });
    const r = await runPlanReviewSingle(input);
    expect(r.outcome).toBe("synth_failure");
    expect(r.exitCode).toBe(1);
  });

  it("writes a top-of-plan outcome annotation", async () => {
    const { input } = baseInput({
      objections: [obj("CRITICAL", "F1")],
      synthCheckRaw: "- STANCE 1: ACCEPT",
    });
    await runPlanReviewSingle(input);
    const planText = fs.readFileSync(planPath, "utf8");
    expect(planText).toContain("PLAN REVIEW (single-round)");
    expect(planText).toContain("REVISED");
  });
});
