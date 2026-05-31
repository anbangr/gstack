/**
 * Inbox 2a0574 — review-gate thinking-block 400 regression tests.
 *
 * The build review gate spawns the Claude CLI as a long multi-turn agentic
 * `/review` session with extended thinking on (configure.cm review role
 * reasoning:"xhigh"; buildClaudeTaskArgv prompt "Use xhigh thinking. Run
 * /review."). The Anthropic Messages API requires the latest assistant message's
 * thinking/redacted_thinking blocks to come back byte-identical on the next turn
 * (they are signed). Across /review's many tool-use turns the CLI intermittently
 * re-serializes one, producing a 400:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified"
 * Confirmed from run logs (polis-mesh-rep-ema-decay-r3): review iter 1 exited 0
 * with a real verdict (281s); iter 2 hit this 400 and exited 1 with NO verdict,
 * which hard-failed the phase because runReviewGates had no classifier/retry.
 *
 * Fix: a content-aware bounded retry — retry ONLY when the gate exited non-zero
 * AND produced no parseable verdict ("unclear") AND the log carries the 400
 * marker. A real GATE FAIL parses as verdict "fail", so a legitimately failed
 * review is never retried.
 *
 * Coverage:
 *   T1: isThinkingBlock400 classifier — true positives + the content-aware
 *       boundary (a real GATE FAIL string is NOT a 400).
 *   T2-T5: static-grep tripwires that the retry in runReviewGates is wired
 *       verdict-aware, bounded, and uses the classifier (the gate logic is deep
 *       inside runReviewGates and needs heavy fixtures to run end-to-end; these
 *       are the same fast-tripwire shape as bug-k-review-gate-trust-boundary).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isThinkingBlock400 } from "../cli";

const cliContent = fs.readFileSync(
  path.resolve(import.meta.dir, "../cli.ts"),
  "utf-8",
);

describe("inbox 2a0574 — isThinkingBlock400 classifier", () => {
  it("T1a: matches the canonical API 400 from the real run log", () => {
    const real400 =
      "[OUT] API Error: 400 messages.3.content.13: `thinking` or " +
      "`redacted_thinking` blocks in the latest assistant message cannot be " +
      "modified. These blocks must remain as they were in the original response.";
    expect(isThinkingBlock400(real400)).toBe(true);
    // Alternate phrasing of the same API error still matches when an error
    // indicator is present.
    expect(
      isThinkingBlock400(
        "HTTP 400: thinking blocks in the latest assistant message cannot be modified",
      ),
    ).toBe(true);
  });

  it("T1b: content-aware — a real GATE FAIL verdict is NOT a thinking-block 400", () => {
    expect(
      isThinkingBlock400("GATE FAIL\n\nFound 3 real bugs in the diff."),
    ).toBe(false);
    expect(isThinkingBlock400("")).toBe(false);
    expect(isThinkingBlock400("thinking about it, the blocks were fine")).toBe(
      false,
    );
  });

  it("T1c: content-injection guard — a reviewer QUOTING the phrase (no API-error line) does NOT match", () => {
    // Finding 4/5 from adversarial review: the marker is anchored to a real
    // "API Error"/"400" line, not the bare phrase. A /review of THIS commit (or
    // the inbox report) quotes the error text in its findings; that benign quote
    // must never trip the retry.
    const reviewerQuote =
      "The fix targets the error 'thinking or redacted_thinking blocks in the " +
      "latest assistant message cannot be modified' — looks correct.\n\nGATE PASS";
    expect(isThinkingBlock400(reviewerQuote)).toBe(false);
    expect(
      isThinkingBlock400(
        "Note: thinking blocks in the latest assistant message cannot be modified across turns.",
      ),
    ).toBe(false);
  });
});

describe("inbox 2a0574 — retry loop is provider-scoped (Finding 4)", () => {
  it("T1d: the thinking-retry while-loop is gated on role.provider === 'claude'", () => {
    // codex/gemini/kimi gates cannot emit an Anthropic API 400, so a codex
    // reviewer that merely quotes the string must never enter the retry loop.
    const loop = cliContent.match(
      /let thinkingRetries = 0;\s*while \([\s\S]{0,900}thinkingRetries < THINKING_BLOCK_400_MAX_RETRIES/,
    );
    expect(loop).not.toBeNull();
    expect(loop![0]).toMatch(/role\.provider === "claude"/);
  });
});

describe("inbox 2a0574 — runReviewGates retry wiring (static tripwires)", () => {
  it("T2: a bounded retry constant exists with an env override", () => {
    expect(cliContent).toMatch(/THINKING_BLOCK_400_MAX_RETRIES/);
    expect(cliContent).toContain("GSTACK_BUILD_REVIEW_THINKING_RETRY_MAX");
  });

  it("T3: the retry is content-aware — gated on no-verdict (unclear) + the classifier", () => {
    // The retry loop must require verdict === "unclear" AND isThinkingBlock400,
    // so a real GATE FAIL (verdict "fail") is never retried.
    const loop = cliContent.match(
      /while \([\s\S]{0,400}isThinkingBlock400\([\s\S]{0,200}\) \{/,
    );
    expect(loop).not.toBeNull();
    expect(loop![0]).toMatch(/verdict === "unclear"/);
    expect(loop![0]).toMatch(/result\.exitCode !== 0/);
    expect(loop![0]).toMatch(
      /thinkingRetries < THINKING_BLOCK_400_MAX_RETRIES/,
    );
  });

  it("T4: the retry re-runs the gate and re-parses the verdict (not just swallow)", () => {
    const block = cliContent.match(
      /thinkingRetries \+= 1;[\s\S]{0,2000}verdict = parseVerdict/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/runGate\(name, role, \{/);
    expect(block![0]).toMatch(/thinking-retry/);
    // It must run the same hygiene gate as the primary attempt (discard on
    // failure, no-HEAD-advance for reviewers) — not bypass it.
    expect(block![0]).toMatch(/applyGateHygiene\(/);
    expect(block![0]).toMatch(/discardOnFailure: true/);
  });

  it("T5: the classifier is exported (so this test imports the real impl)", () => {
    expect(cliContent).toMatch(/export function isThinkingBlock400\(/);
  });
});
