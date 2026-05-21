import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * T8 + T15: Gemini spawn must close stdin by default, with a kill switch
 * to keep it open for debugging.
 *
 * Why this matters: Gemini CLI v2.1+ blocks waiting for stdin EOF when
 * running in non-interactive mode. Without closeStdin: true, the spawn
 * hangs forever after the prompt is sent. Codex already has closeStdin: true
 * (sub-agents.ts:1241); Gemini needs the same treatment.
 */

describe("runRoleTask Gemini spawn closeStdin", () => {
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "sub-agents.ts"),
      "utf8",
    );
  });

  test("T8: runRoleTask passes closeStdin: true to spawnCaptured", () => {
    const fnIdx = src.indexOf("export async function runRoleTask(opts:");
    expect(fnIdx).toBeGreaterThan(-1);

    // Find the end of the function body (next export or end of file).
    const nextExport = src.indexOf("\nexport ", fnIdx + 1);
    const bodyEnd = nextExport > -1 ? nextExport : src.length;
    const body = src.slice(fnIdx, bodyEnd);

    // The spawnCaptured call inside runRoleTask must carry closeStdin: true.
    const spawnIdx = body.indexOf("spawnCaptured");
    expect(spawnIdx).toBeGreaterThan(-1);

    // Look for the closeStdin field in the same call (within the next 400 chars).
    const callWindow = body.slice(spawnIdx, spawnIdx + 400);
    expect(callWindow).toMatch(/closeStdin:\s*true/);
  });

  test("T15: GSTACK_KEEP_GEMINI_STDIN_OPEN=1 keeps closeStdin false", () => {
    const fnIdx = src.indexOf("export async function runRoleTask(opts:");
    expect(fnIdx).toBeGreaterThan(-1);

    const nextExport = src.indexOf("\nexport ", fnIdx + 1);
    const bodyEnd = nextExport > -1 ? nextExport : src.length;
    const body = src.slice(fnIdx, bodyEnd);

    // There must be a conditional that respects the kill switch.
    expect(body).toMatch(/GSTACK_KEEP_GEMINI_STDIN_OPEN/);

    // When the env var is set, closeStdin must be false.
    // Accept either a ternary or an if-statement that sets closeStdin to false.
    expect(body).toMatch(
      /closeStdin:\s*(?:false|process\.env\.GSTACK_KEEP_GEMINI_STDIN_OPEN\s*!==?\s*['"]1['"])/,
    );
  });
});
