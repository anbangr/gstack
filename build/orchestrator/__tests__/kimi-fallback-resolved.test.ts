import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// runConfiguredRoleTask in sub-agents.ts emits a console.warn ("primary X
// failed; falling back to Y") on fallback. Wrap-console turns that warn
// into a DETECTED row. After the fallback recursive call succeeds, we
// must emit a paired RESOLVED row so the queue consumer (T6) can collapse
// the pair instead of paying codex to investigate a transient warning.
//
// Test via static source inspection — the integration shape is to: build
// the fallback warn message into a const, log it, recursively call, and
// on success of the backup call, emit a RESOLVED keyed on the same
// faultId computeFaultId would produce for the wrap-console emit.

describe("Kimi→Gemini fallback emits paired RESOLVED on success (class 4)", () => {
  let src: string;

  test("T7a: sub-agents.ts imports emitHaltEventResolved + computeFaultId from halt-events", () => {
    src = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "sub-agents.ts"),
      "utf8",
    );
    expect(src).toMatch(/emitHaltEventResolved/);
    expect(src).toMatch(/computeFaultId/);
  });

  test("T7b: the fallback warn message is built as a const before logging (so RESOLVED can re-key it)", () => {
    // The fallback warning prelude. Find the "falling back to" emit block
    // and confirm the message is built into a variable so we can re-use it.
    const fbIdx = src.indexOf("falling back to");
    expect(fbIdx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, fbIdx - 400), fbIdx + 200);
    // Expect a const declaration (fallbackMsg or similar) used by both
    // console.warn and the post-success RESOLVED emit.
    expect(window).toMatch(/const\s+\w*[Mm]sg\s*=/);
  });

  test("T7c: post-recursive-call branch emits RESOLVED when the backup succeeded", () => {
    // After `const backupResult = runConfiguredRoleTask(...)`, on
    // success (exitCode === 0), call emitHaltEventResolved with the
    // computed faultId. We verify the source shape via a regex check.
    expect(src).toMatch(/emitHaltEventResolved\s*\(/);
    // The RESOLVED emit should appear AFTER the line that has
    // "falling back to" — i.e., in the fallback success path.
    const fbIdx = src.indexOf("falling back to");
    const resolvedIdx = src.indexOf("emitHaltEventResolved", fbIdx);
    expect(resolvedIdx).toBeGreaterThan(fbIdx);
  });
});
