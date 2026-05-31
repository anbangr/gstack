/**
 * Regression tests for Bug L — `BLIND_EXECUTION_MARKERS.codex`'s
 * `"sandbox denied"` substring matched codex's own narrative output
 * about solved sandbox issues, causing false-positive blind-execution
 * detections that discarded 4+ minutes of real agent work.
 *
 * Canonical incident:
 *   ~/.gstack/skill-faults/pending-investigations/
 *     agnt2-prototype-prodl2-f3-f4-soak-and-backup-20260527-112737-28b96729
 *       -HYGIENE_FAIL:p4:a7235d1c.json
 *
 * agnt2 Phase 3.5 (Run actual 1h × 10k-IP staging soak, kind: manual).
 * Codex primary implementor ran for 257 seconds, hit a Go-cache
 * sandbox limit (`/Users/.../Library/Caches/go-build` outside
 * workspace), worked around it by re-running with workspace-local
 * GOCACHE, succeeded, wrote in its output summary:
 *
 *   "- Initial `go test ./soak/...` without `GOCACHE` failed because
 *   the sandbox denied writes to `/Users/.../Library/Caches/go-build`;
 *   rerun with workspace-local `GOCACHE` passed."
 *
 * The substring "sandbox denied" matched the legacy marker, the
 * blind-execution detector flagged the run as a workspace violation,
 * discardBlindExecutionChanges deleted the agent's real work, and
 * the operator saw the misleading `primary implementor: blind
 * execution — input file unreachable; changes discarded`.
 *
 * Plan ref: ~/.claude/plans/fixing-plan-bugs-k-through-n-post-pr-108.md
 *
 * Coverage:
 *   T-L1: detectBlindExecution returns ok=true for narrative codex
 *         output that contains "sandbox denied" inside a markdown
 *         bullet (the canonical incident shape)
 *   T-L2: detectBlindExecution returns ok=false for STRUCTURED codex
 *         error output (`ERROR codex_core::tools::router: error=...`)
 *   T-L3: detectBlindExecution returns ok=false for `error: sandbox
 *         denied:` CLI error format (with trailing colon)
 *   T-L4: detectBlindExecution returns ok=false for `workspace-write
 *         violation:` (existing marker preserved)
 *   T-L5: static-grep — the legacy "sandbox denied" substring (no
 *         qualifier) is gone from BLIND_EXECUTION_MARKERS.codex
 *
 * Bug L follow-up (2026-05-31): the router-error PREFIX
 * `"ERROR codex_core::tools::router: error="` is too broad — codex emits it
 * for non-sandbox errors too (notably `write_stdin failed: stdin is closed`
 * because codex is spawned with stdin closed). That false-positive discarded
 * the agnt2 wave-1 Phase 1 test-writer's real tests, mislabeled "input file
 * unreachable". detectBlindExecution now gates the prefix on a per-line
 * sandbox/write-rejection signal.
 *   T-L6: benign `write_stdin failed: stdin is closed` router error → ok=true
 *   T-L7: a genuine `patch rejected ... read-only sandbox` router error still → ok=false
 *   T-L8: a benign router error + a SEPARATE real sandbox line still → ok=false
 *   T-L9: a bare non-sandbox `patch rejected` router error → ok=true (the
 *         cross-model-review FP fix: `patch rejected` dropped from the regex)
 *   T-L10: a `read-only file system` / EROFS write-block router error → ok=false
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectBlindExecution } from "../cli";

const cliPath = path.resolve(import.meta.dir, "../cli.ts");
const cliContent = fs.readFileSync(cliPath, "utf-8");

function writeLog(body: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bug-l-"));
  const p = path.join(tmp, "agent.log");
  fs.writeFileSync(p, body);
  return p;
}

describe("Bug L — codex blind-execution marker false-positive", () => {
  it("T-L1: prose 'sandbox denied' inside an agent's narrative output does NOT trigger blind-execution", () => {
    // Verbatim shape from the canonical Phase 3.5 incident.
    const narrative = [
      "[ERR] Output summary:",
      "[ERR] - Files changed: scripts/soak-runner.sh",
      "[ERR] - Tests run:",
      "[ERR]   - `go test ./tier/...` — PASSED",
      "[ERR] - Initial `go test ./soak/...` without `GOCACHE` failed because the sandbox denied writes to `/Users/.../Library/Caches/go-build`; rerun with workspace-local `GOCACHE` passed.",
      "[ERR] ## Commit SHA",
      "[ERR] - abc1234",
    ].join("\n");
    const logPath = writeLog(narrative);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  it("T-L2: structured codex error log `ERROR codex_core::tools::router: error=...` DOES trigger blind-execution", () => {
    // Real codex structured error from the Bug J incident shape —
    // the marker MUST still fire on this to keep Bug E/J detection
    // working.
    const log = [
      "[ERR] OpenAI Codex v0.133.0",
      "[ERR] running phase work...",
      "[ERR] 2026-05-27T04:30:00Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings",
      "[ERR] BLOCKED: read-only sandbox prevented writing /Users/.../output.md",
    ].join("\n");
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(false);
    expect(result.agent).toBe("codex");
    expect(result.violation).toContain("ERROR codex_core::tools::router");
  });

  it("T-L3: `error: sandbox denied:` CLI error format DOES trigger blind-execution", () => {
    // Trailing colon distinguishes this from prose mentions like
    // "sandbox denied writes" or "sandbox denied access".
    const log = [
      "[ERR] running impl...",
      "[ERR] error: sandbox denied: /etc/passwd: read access blocked",
    ].join("\n");
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(false);
    expect(result.agent).toBe("codex");
    expect(result.violation).toBe("error: sandbox denied:");
  });

  it("T-L4: existing `workspace-write violation:` marker is preserved", () => {
    // Back-compat: pre-Bug-L marker continues to work.
    const log = "[ERR] workspace-write violation: cannot write to /system/path";
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(false);
    expect(result.agent).toBe("codex");
    expect(result.violation).toBe("workspace-write violation:");
  });

  // Bug L follow-up (2026-05-31): the router-error prefix is too broad. Codex
  // is spawned with stdin closed, so an agent's interactive exec_command logs a
  // benign `write_stdin failed: stdin is closed` router error and exits 0. That
  // must NOT count as blind execution. Canonical incident: agnt2 wave-1 Phase 1
  // test-writer — real tests generated, then discarded as "input file
  // unreachable". See INVESTIGATION-2026-05-31-wave1-blind-execution-input-unreachable.md.
  it("T-L6: benign `write_stdin failed: stdin is closed` router error does NOT trigger blind-execution", () => {
    const log = [
      "[ERR] OpenAI Codex running test-writer...",
      "[ERR] 2026-05-31T07:19:29Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
      "[ERR] (recovered; wrote test files)",
    ].join("\n");
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  it("T-L7: a genuine sandbox/patch-rejection router error STILL triggers (T-L2 preserved)", () => {
    const log =
      "[ERR] ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings";
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(false);
    expect(result.agent).toBe("codex");
    expect(result.violation).toContain("ERROR codex_core::tools::router");
  });

  it("T-L8: a benign router error alongside a SEPARATE real sandbox line still triggers", () => {
    const log = [
      "[ERR] ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session",
      "[ERR] error: sandbox denied: /etc/passwd: read access blocked",
    ].join("\n");
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(false);
    expect(result.agent).toBe("codex");
  });

  // Cross-model review follow-up (2026-05-31): the affirmative regex must NOT
  // match a bare `patch rejected`. A stale-hunk / context-mismatch patch
  // failure is a normal failed edit codex routinely recovers from; matching it
  // re-opened the same discard-real-work false positive this guard closes. The
  // genuine sandbox case (Bug J / T-L2) still halts because it also says
  // "...blocked by read-only sandbox".
  it("T-L9: a non-sandbox `patch rejected` router error does NOT trigger blind-execution", () => {
    const log = [
      "[ERR] ERROR codex_core::tools::router: error=patch rejected: failed to find expected lines in file; context mismatch",
      "[ERR] (re-applied with fresh context; wrote files)",
    ].join("\n");
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  it("T-L10: a `read-only file system` write-block router error STILL triggers", () => {
    const log =
      "[ERR] ERROR codex_core::tools::router: error=apply_patch failed: failed to write file: Read-only file system (os error 30)";
    const logPath = writeLog(log);
    const result = detectBlindExecution(logPath);
    expect(result.ok).toBe(false);
    expect(result.agent).toBe("codex");
    expect(result.violation).toContain("ERROR codex_core::tools::router");
  });
});

// Bug N — operator-UX command for the SILENT_STATE_MUTATION class.
// Ships alongside Bug L because both are small operator-tooling
// fixes that touch only cli.ts and have no test-fixture overlap with
// the larger Bug K/M behavioral changes.
describe("Bug N — markFeatureShippedAfterManualRecovery", () => {
  // Use a fresh import so the function is in scope. The function is
  // exported alongside markPhaseCommittedAfterManualRecovery in cli.ts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { markFeatureShippedAfterManualRecovery } = require("../cli") as {
    markFeatureShippedAfterManualRecovery: (args: {
      state: any;
      featureNumber: string;
      prNumber: number;
      shippedCommit?: string;
      dryRun?: boolean;
    }) => { ok: true; featureIndex: number } | { ok: false; error: string };
  };

  function mkState(): any {
    return {
      features: [
        { number: "1", name: "feature-one", status: "phases_done" },
        { number: "5", name: "feature-five", status: "phases_done" },
      ],
      phases: [],
    };
  }

  it("T-N1: atomically sets status=release_queued + shippedAt + prNumber", () => {
    const state = mkState();
    const result = markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "5",
      prNumber: 119,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.featureIndex).toBe(1);
    const f = state.features[1];
    expect(f.status).toBe("release_queued");
    expect(f.prNumber).toBe(119);
    expect(f.shippedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Without explicit commit, shippedCommit stays unset.
    expect(f.shippedCommit).toBeUndefined();
  });

  it("T-N2: includes shippedCommit when provided", () => {
    const state = mkState();
    const result = markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "5",
      prNumber: 119,
      shippedCommit: "abc1234def",
    });
    expect(result.ok).toBe(true);
    expect(state.features[1].shippedCommit).toBe("abc1234def");
  });

  it("T-N3: refuses non-integer / non-positive prNumber", () => {
    const state = mkState();
    const r1 = markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "5",
      prNumber: 0,
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error("unreachable");
    expect(r1.error).toContain("positive integer");
    const r2 = markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "5",
      prNumber: -1,
    });
    expect(r2.ok).toBe(false);
  });

  it("T-N4: refuses unknown feature number with descriptive error", () => {
    const state = mkState();
    const result = markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "99",
      prNumber: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("feature not found: 99");
  });

  it("T-N5: refuses to overwrite a feature that already shipped via real pipeline", () => {
    const state = mkState();
    // Simulate prior real ship: status + shippedAt + prNumber all set.
    state.features[1].status = "release_queued";
    state.features[1].shippedAt = "2026-05-26T12:00:00.000Z";
    state.features[1].prNumber = 108;
    const result = markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "5",
      prNumber: 200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("already shipped");
    expect(result.error).toContain("PR #108");
    // State must be unchanged.
    expect(state.features[1].prNumber).toBe(108);
  });

  it("T-N6: orchestrator's SILENT_STATE_MUTATION self-heal accepts the mark-feature-shipped output", () => {
    // Pin the contract: after markFeatureShippedAfterManualRecovery
    // sets status=release_queued + shippedAt + prNumber, the
    // SILENT_STATE_MUTATION classifier (cli.ts:12677 region) sees a
    // FULLY-shipped feature and does NOT re-process. Validated by
    // mirroring the classifier's predicate inline.
    const state = mkState();
    markFeatureShippedAfterManualRecovery({
      state,
      featureNumber: "5",
      prNumber: 119,
    });
    const f = state.features[1];
    // The classifier's predicate from cli.ts:12681-12683:
    //   featureState.status === "release_queued" && !isFeatureTerminal(featureState)
    // isFeatureTerminal returns true when shippedAt && prNumber both
    // set. After our mark, the negation is FALSE → classifier skips.
    const isTerminal = !!f.shippedAt && f.prNumber != null;
    expect(isTerminal).toBe(true);
  });
});

describe("Bug N — static-grep wiring guards", () => {
  it("T-N7: cli.ts declares --mark-feature-shipped + companion flags", () => {
    expect(cliContent).toContain('a === "--mark-feature-shipped"');
    expect(cliContent).toContain('a === "--mark-feature-shipped-pr"');
    expect(cliContent).toContain('a === "--mark-feature-shipped-commit"');
  });

  it("T-N8: --help mentions the new CLI command + companions", () => {
    expect(cliContent).toMatch(/--mark-feature-shipped\s+<feature>/);
    expect(cliContent).toMatch(/--mark-feature-shipped-pr\s+<N>/);
  });
});

describe("Bug L — static-grep wiring guards", () => {
  it("T-L5: the legacy bare 'sandbox denied' substring is gone from BLIND_EXECUTION_MARKERS.codex", () => {
    // Pin the removal. A future refactor that re-adds the bare
    // substring re-introduces the false-positive class. The
    // structured forms (`ERROR codex_core...`, `error: sandbox
    // denied:` with colon, `workspace-write violation:`) are
    // intentional and the test allows them.
    const codexBlock = cliContent.match(/codex:\s*\[[\s\S]{0,500}?\]/);
    expect(codexBlock).not.toBeNull();
    const codexBlockText = codexBlock![0];
    // Forbid the bare-substring form: `"sandbox denied"` immediately
    // followed by a comma OR a closing bracket (no trailing colon).
    expect(codexBlockText).not.toMatch(/"sandbox denied"\s*[,\]]/);
    // Confirm the new structural markers are present.
    expect(codexBlockText).toContain("ERROR codex_core::tools::router: error=");
    expect(codexBlockText).toContain("error: sandbox denied:");
  });
});
