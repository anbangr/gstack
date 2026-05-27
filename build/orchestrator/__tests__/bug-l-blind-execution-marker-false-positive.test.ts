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
});

describe("Bug L — static-grep wiring guards", () => {
  it("T-L5: the legacy bare 'sandbox denied' substring is gone from BLIND_EXECUTION_MARKERS.codex", () => {
    // Pin the removal. A future refactor that re-adds the bare
    // substring re-introduces the false-positive class. The
    // structured forms (`ERROR codex_core...`, `error: sandbox
    // denied:` with colon, `workspace-write violation:`) are
    // intentional and the test allows them.
    const codexBlock = cliContent.match(
      /codex:\s*\[[\s\S]{0,500}?\]/,
    );
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
