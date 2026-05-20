import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// cli.ts::runRoleTask mirrors sub-agents.ts::runConfiguredRoleTask: on
// primary failure, it console.warn's a "falling back to <backup>" line
// (which wrap-console turns into a DETECTED row) and runs the backup
// provider. Same as the Class 4 pattern: when the backup succeeds, emit
// a paired RESOLVED so the queue consumer collapses the pair pre-dispatch
// instead of paying codex to investigate a transient primary failure.
//
// runRoleTask is the BROADER surface: it covers core phase / feature-review
// / merge-fixer flows. Without the Class 4 pattern here, every successful
// primary→backup recovery on those paths would leave an unpaired
// SOFT_HALT_WARN DETECTED in pending/.

describe("runRoleTask (non-Configured variant) emits paired RESOLVED on backup success (class 4)", () => {
  let src: string;

  test("T7d: cli.ts imports emitHaltEventResolved + computeFaultId", () => {
    src = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "cli.ts"),
      "utf8",
    );
    expect(src).toMatch(/emitHaltEventResolved/);
    expect(src).toMatch(/computeFaultId/);
  });

  test("T7e: runRoleTask fallback builds the warn message as a const before logging", () => {
    // Find the runRoleTask body and its fallback emit block.
    const fnIdx = src.indexOf("export async function runRoleTask(opts:");
    expect(fnIdx).toBeGreaterThan(-1);
    const bodyEnd = src.indexOf("\nasync function runJudgeRole(", fnIdx);
    expect(bodyEnd).toBeGreaterThan(fnIdx);
    const body = src.slice(fnIdx, bodyEnd);
    // Expect a const declaration for the fallback message used by both
    // console.warn AND the post-success RESOLVED emit.
    expect(body).toMatch(/const\s+\w*[Mm]sg\s*=/);
    expect(body).toMatch(/falling back to/);
  });

  test("T7f: runRoleTask emits RESOLVED on backup success", () => {
    const fnIdx = src.indexOf("export async function runRoleTask(opts:");
    const bodyEnd = src.indexOf("\nasync function runJudgeRole(", fnIdx);
    const body = src.slice(fnIdx, bodyEnd);
    // The RESOLVED emit should appear AFTER the "falling back to" line,
    // gated on backupResult.exitCode === 0 && !backupResult.timedOut.
    const fbIdx = body.indexOf("falling back to");
    const resolvedIdx = body.indexOf("emitHaltEventResolved", fbIdx);
    expect(resolvedIdx).toBeGreaterThan(fbIdx);
    // Pair-collapse correctness: the gate must check both exitCode and
    // timedOut. A timed-out backup leaving the orchestrator with an empty
    // outputFilePath is NOT a recovery — the DETECTED must stay in pending/
    // so codex can investigate.
    const gateWindow = body.slice(
      Math.max(0, resolvedIdx - 300),
      resolvedIdx + 50,
    );
    expect(gateWindow).toMatch(/exitCode\s*===\s*0/);
    expect(gateWindow).toMatch(/!\s*backupResult\.timedOut|timedOut\s*===\s*false/);
  });

  test("T7g: runRoleTask resolves runId via opts → env → opts.slug fallback chain", () => {
    // The faultId pair-collapse depends on producer (here) and consumer
    // (wrap-console.ts's helperCtxFor) computing the SAME runId. wrap-console
    // uses state.launch?.runId ?? state.slug. We mirror that via:
    //   opts.runId ?? process.env.GSTACK_BUILD_RUN_ID ?? opts.slug
    // where GSTACK_BUILD_RUN_ID is set by cli.ts at launch from launch.runId.
    const fnIdx = src.indexOf("export async function runRoleTask(opts:");
    const bodyEnd = src.indexOf("\nasync function runJudgeRole(", fnIdx);
    const body = src.slice(fnIdx, bodyEnd);
    expect(body).toMatch(
      /opts\.runId\s*\?\?\s*process\.env\.GSTACK_BUILD_RUN_ID\s*\?\?\s*opts\.slug/,
    );
  });

  test("T7h: cli.ts publishes GSTACK_BUILD_RUN_ID at launch from state.launch.runId", () => {
    // The env-var bridge: set once near state.launch = launch so every
    // descendant sub-agent process inherits the right run identity for
    // its pair-collapse keying.
    expect(src).toMatch(
      /process\.env\.GSTACK_BUILD_RUN_ID\s*=\s*launch\.runId\s*\?\?\s*state\.slug/,
    );
  });
});

describe("runConfiguredRoleTask (sub-agents.ts) uses the same runId resolution chain", () => {
  test("T7i: sub-agents.ts resolves runId via opts → env → opts.slug", () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "sub-agents.ts"),
      "utf8",
    );
    // Same chain as runRoleTask. This is the codex-finding-B fix.
    expect(src).toMatch(
      /opts\.runId\s*\?\?\s*process\.env\.GSTACK_BUILD_RUN_ID\s*\?\?\s*opts\.slug/,
    );
  });
});
