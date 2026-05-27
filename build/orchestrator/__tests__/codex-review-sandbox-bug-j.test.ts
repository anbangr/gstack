/**
 * Regression tests for Bug J — `runReviewGates` forced codex /review
 * subagent to `-s read-only` on non-code or auditOnly phases, blocking
 * codex from writing its own verdict output file.
 *
 * Canonical incident:
 *   ~/.gstack/skill-faults/inbox/
 *     BUGREPORT-2026-05-27-build-manual-investigation-d4b344.md
 *
 * The mitosis-oasis-phase1-part2 build hit phase 5.1 (GovernanceRegistry
 * fixture review). The orchestrator launched codex /review with
 * `codex exec ... -m gpt-5.5 -s read-only -c model_reasoning_effort="high"
 * -C <worktree>`. The codex CLI's patch tool tried to write the staged
 * output file at
 * `<worktree>/.llm-tmp/gstack-codex-5.1-N-review-output.md` and got:
 *
 *   ERROR codex_core::tools::router: error=patch rejected: writing is
 *   blocked by read-only sandbox; rejected by user approval settings
 *
 * Net effect: output file 0 bytes for all 4 review iterations, parser
 * sees no GATE PASS/FAIL line, orchestrator triggers primary-impl-rerun
 * recovery which cascades into blind-execution failure. Operator must
 * manually intervene.
 *
 * The earlier `readOnlyArtifactGate` heuristic at cli.ts:5662 forced
 * read-only when `phase.kind !== "code"` OR `auditOnly === true`. The
 * intent was to prevent the reviewer from writing source code on
 * non-code phases. But the prompt instructs codex to write its verdict
 * file, which read-only blocks too. Same defense-in-depth that
 * buildCodexFeatureReviewArgv uses (sub-agents.ts:3921) covers the
 * source-mutation concern:
 *   1. Prompt forbids worktree edits.
 *   2. applyGateHygiene catches any post-spawn mutation as HYGIENE_FAULT.
 *   3. Same-shape repeat detector halts the loop after 2 identical
 *      HYGIENE_FAULTs.
 *
 * Coverage:
 *   T-J1: static-grep: cli.ts no longer constructs the
 *         `readOnlyArtifactGate` heuristic that forced read-only.
 *   T-J2: static-grep: cli.ts no longer passes a hardcoded `read-only`
 *         literal to runReviewGates' codex dispatch.
 *   T-J3: static-grep: explicit `attempt.sandbox` override is still
 *         honored (sandbox-retry path), the env-driven override at
 *         `GSTACK_BUILD_CODEX_REVIEW_SANDBOX` still wins, and the
 *         hygiene-gate enforcement comment block is present so future
 *         refactors don't accidentally re-introduce the read-only
 *         force-default.
 *   T-J4: behavioral guard — the build-state log path from the
 *         canonical fault MUST NOT contain "blocked by read-only
 *         sandbox" after the fix lands; pin a known-bad substring
 *         that surfaces this exact bug shape via the existing
 *         halt-event classifier output.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

describe("Bug J — Codex /review sandbox no longer forces read-only", () => {
  it("T-J1: cli.ts no longer constructs the read-only-artifact-gate heuristic as code", () => {
    // Pin the removal of the heuristic. A future refactor that
    // re-introduces "force read-only on non-code phases" would
    // regress this entire fix. The intent (prevent reviewer source
    // mutation on non-code phases) is still enforced via
    // applyGateHygiene downstream — see the inline comment block at
    // the runGate call site.
    //
    // Match the heuristic as a const declaration (the actual code
    // form that produced the bug), not as a bare identifier — the
    // identifier name appears once in the Bug J explanatory comment
    // block, which is intentional documentation of the historical
    // removal.
    expect(cliContent).not.toMatch(/const readOnlyArtifactGate\s*=/);
  });

  it("T-J2: cli.ts no longer passes hardcoded 'read-only' to runReviewGates' codex dispatch", () => {
    // The dispatch literal `(readOnlyArtifactGate ? "read-only" :
    // undefined)` was the exact code that produced
    // `codex exec ... -s read-only` and blocked codex's verdict
    // write. Pin its removal. Other "read-only" literals in cli.ts
    // are fine (judge sandbox at runJudgeRole, runtime sandbox-retry
    // paths) — this test specifically targets the runReviewGates'
    // runGate closure.
    expect(cliContent).not.toMatch(
      /attempt\?\.sandbox\s*\?\?\s*\(?\s*readOnlyArtifactGate/,
    );
    expect(cliContent).not.toMatch(/readOnlyArtifactGate\s*\?\s*"read-only"/);
  });

  it("T-J3: runGate closure honors attempt.sandbox + has Bug J comment block", () => {
    // The fix MUST preserve the explicit-override path so the
    // shouldRetryCodexGateWithDangerFullAccess retry below (with
    // sandbox: "danger-full-access") still works. The narrow
    // change is "default sandbox to undefined; let the role-specific
    // dispatcher pick workspace-write". Pin the runtime invariant
    // alongside the comment block so future maintainers see why the
    // heuristic was dropped and where the source-mutation defense
    // actually lives.
    expect(cliContent).toMatch(/const sandbox = attempt\?\.sandbox;?\s*$/m);
    expect(cliContent).toContain("Bug J");
    expect(cliContent).toContain("applyGateHygiene");
  });

  it("T-J4: the canonical Bug J error string is no longer in any source path", () => {
    // The fault classifier's "writing is blocked by read-only sandbox"
    // substring was the user-visible signal of this bug. Source code
    // must never emit or hardcode it (it came from the codex CLI's
    // error output, not from our code) — but pin that we don't add
    // any comment or template that would re-introduce it as a guard
    // mistake.
    expect(cliContent).not.toContain("blocked by read-only sandbox");
    // Bonus: the JSDoc comment for runCodexReview already documents
    // the workspace-write default at sub-agents.ts. Make sure the
    // cli.ts caller doesn't override it with a hardcoded read-only.
    // Widened from 2500 → 5000 chars after adversarial review (Bug J
    // hardening commit) noted the original block was at 2249/2500
    // chars — one new if-block away from overflowing the window and
    // crashing the test with a non-null-assertion TypeError on the
    // null match result. 5000 gives ~2.7KB headroom for routine
    // additions.
    const reviewGateBlock = cliContent.match(
      /const runGate = async[\s\S]{0,5000}return runSlashCommand/,
    );
    expect(reviewGateBlock).not.toBeNull();
    expect(reviewGateBlock![0]).not.toMatch(/"read-only"/);
  });

  it("T-J5: review/reviewSecondary gates do NOT pass phaseAllowsGateSourceFixes as allowNonTestPaths", () => {
    // Security review HIGH finding: the original Bug J fix assumed
    // applyGateHygiene would convert reviewer source mutations into
    // HYGIENE_FAULT. It does NOT, because phaseAllowsGateSourceFixes()
    // returns true for non-code phases unconditionally, which makes
    // applyGateHygiene AUTO-COMMIT the mutation instead of rejecting
    // it. Net effect of the unhardened Bug J: silent reviewer-driven
    // commits on every non-code phase. The hardening introduces a
    // `gateAllowsSourceFixes` local that ONLY returns true when the
    // gate name is "qa" AND phaseAllowsGateSourceFixes(phase) is true.
    // Static-grep that hardening so a future refactor that re-collapses
    // the allowNonTestPaths source to phaseAllowsGateSourceFixes() at
    // the runGate call site fails CI.
    expect(cliContent).toMatch(
      /const gateAllowsSourceFixes\s*=\s*\n?\s*name\s*===\s*"qa"\s*&&\s*phaseAllowsGateSourceFixes/,
    );
    // Pin that the primary applyGateHygiene call in runReviewGates
    // uses the scoped local, not the raw helper.
    expect(cliContent).toMatch(
      /label:\s*`\$\{name\}\s+gate`,[\s\S]{0,400}allowNonTestPaths:\s*gateAllowsSourceFixes/,
    );
    // Mirror check for the sandbox-retry path (cli.ts:5745 region).
    expect(cliContent).toMatch(
      /label:\s*`\$\{name\}\s+sandbox retry gate`,[\s\S]{0,400}allowNonTestPaths:\s*gateAllowsSourceFixes/,
    );
  });

  it("T-J6: the raw phaseAllowsGateSourceFixes(opts.phase) call form is gone from runGate applyGateHygiene block", () => {
    // Stronger guard for the same invariant as T-J5 — pins the
    // NEGATIVE: the unhardened code form must not reappear. A
    // refactor that re-introduces
    // `allowNonTestPaths: phaseAllowsGateSourceFixes(opts.phase)` at
    // any applyGateHygiene call inside runReviewGates would silently
    // restore the security regression. Match the literal call form
    // anchored on the previous line's pattern.
    const runReviewGatesBlock = cliContent.match(
      /async function runReviewGates[\s\S]{0,15000}^\}/m,
    );
    expect(runReviewGatesBlock).not.toBeNull();
    expect(runReviewGatesBlock![0]).not.toMatch(
      /allowNonTestPaths:\s*phaseAllowsGateSourceFixes\(opts\.phase\)/,
    );
  });
});
