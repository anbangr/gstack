import { describe, it, expect } from "bun:test";
import { Readable, Writable } from "node:stream";
import { runTriageGateTTY, type TriageGateResult } from "../plan-review-loop";
import type { PlanReviewObjection } from "../types";

function readableFrom(text: string): NodeJS.ReadableStream {
  const r = new Readable({ read() {} });
  r.push(Buffer.from(text));
  r.push(null);
  (r as any).isTTY = false;
  return r;
}

function captureWriter(): { stream: NodeJS.WritableStream; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

const obj = (i: number): PlanReviewObjection => ({
  severity: "CRITICAL",
  location: `F1, P${i}`,
  issue: `issue ${i}`,
  suggestion: `fix ${i}`,
});

describe("runTriageGateTTY", () => {
  it("per-objection accept produces accept decisions with empty rationale", async () => {
    const objections = [obj(1), obj(2), obj(3)];
    // Three accept answers, three empty rationales.
    const input = readableFrom("a\n\na\n\na\n\n");
    const out = captureWriter();
    const result: TriageGateResult = await runTriageGateTTY({
      objections,
      round: 1,
      trajectory: [3],
      historyPath: "/tmp/h.jsonl",
      input,
      output: out.stream,
      reRaisedSet: new Set(),
    });
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.every((d) => d.decision === "accept")).toBe(true);
    expect(result.decisions.every((d) => d.rationale === "")).toBe(true);
    expect(result.quitEarly).toBe(false);
  });

  it("captured rationale lands in the decision record", async () => {
    const objections = [obj(1)];
    const input = readableFrom("a\nbecause reasons\n");
    const out = captureWriter();
    const result = await runTriageGateTTY({
      objections, round: 1, trajectory: [1], historyPath: "/tmp/h.jsonl",
      input, output: out.stream, reRaisedSet: new Set(),
    });
    expect(result.decisions[0].rationale).toBe("because reasons");
  });

  it("reject + defer + accept produces the right mix", async () => {
    const objections = [obj(1), obj(2), obj(3)];
    const input = readableFrom("r\nfp\nd\nlater\na\n\n");
    const out = captureWriter();
    const result = await runTriageGateTTY({
      objections, round: 1, trajectory: [3], historyPath: "/tmp/h.jsonl",
      input, output: out.stream, reRaisedSet: new Set(),
    });
    expect(result.decisions.map((d) => d.decision)).toEqual([
      "reject", "defer", "accept",
    ]);
  });

  it("[A]ccept-ALL fast-paths the remainder as accept", async () => {
    const objections = [obj(1), obj(2), obj(3), obj(4)];
    const input = readableFrom("a\n\nA\n");
    const out = captureWriter();
    const result = await runTriageGateTTY({
      objections, round: 1, trajectory: [4], historyPath: "/tmp/h.jsonl",
      input, output: out.stream, reRaisedSet: new Set(),
    });
    expect(result.decisions).toHaveLength(4);
    expect(result.decisions.every((d) => d.decision === "accept")).toBe(true);
  });

  it("[R]eject-ALL fast-paths the remainder as reject", async () => {
    const objections = [obj(1), obj(2), obj(3)];
    const input = readableFrom("R\n");
    const out = captureWriter();
    const result = await runTriageGateTTY({
      objections, round: 1, trajectory: [3], historyPath: "/tmp/h.jsonl",
      input, output: out.stream, reRaisedSet: new Set(),
    });
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.every((d) => d.decision === "reject")).toBe(true);
  });

  it("[s]top treats remaining as accept (defaults to accept-all-remaining)", async () => {
    const objections = [obj(1), obj(2), obj(3)];
    const input = readableFrom("r\nno\ns\n");
    const out = captureWriter();
    const result = await runTriageGateTTY({
      objections, round: 1, trajectory: [3], historyPath: "/tmp/h.jsonl",
      input, output: out.stream, reRaisedSet: new Set(),
    });
    expect(result.decisions[0].decision).toBe("reject");
    expect(result.decisions[1].decision).toBe("accept");
    expect(result.decisions[2].decision).toBe("accept");
  });

  it("[q]uit returns quitEarly=true with partial decisions", async () => {
    const objections = [obj(1), obj(2), obj(3)];
    const input = readableFrom("a\n\nq\n");
    const out = captureWriter();
    const result = await runTriageGateTTY({
      objections, round: 1, trajectory: [3], historyPath: "/tmp/h.jsonl",
      input, output: out.stream, reRaisedSet: new Set(),
    });
    expect(result.quitEarly).toBe(true);
    expect(result.decisions).toHaveLength(1);
  });

  it("re-raise framing is shown when objection index is in reRaisedSet", async () => {
    const objections = [obj(1)];
    const input = readableFrom("r\nsame misread\n");
    const out = captureWriter();
    await runTriageGateTTY({
      objections, round: 2, trajectory: [3, 1], historyPath: "/tmp/h.jsonl",
      input, output: out.stream,
      reRaisedSet: new Set([0]),
      priorRejectRationale: new Map([[0, "synthesizer was correct"]]),
    });
    expect(out.read()).toContain("RE-RAISED");
    expect(out.read()).toContain("synthesizer was correct");
  });
});
