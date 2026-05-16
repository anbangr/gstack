import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Isolate ~/.gstack writes for the calling test file.
 *
 * Sets GSTACK_HOME to a fresh tmpdir per test, cleans it up after.
 * Without this, code under test that writes to ${GSTACK_HOME:-~/.gstack}
 * (analytics, learnings, projects, sessions, skill-faults) pollutes the
 * developer's real home directory.
 *
 * See TODOS.md "test/brain-sync.test.ts GSTACK_HOME isolation fixed on main
 * in v1.13.0.0" — the same fix has been applied piecemeal across test files;
 * this helper consolidates the pattern.
 *
 * Usage:
 *
 *   import { useIsolatedGstackHome } from "./helpers/test-home";
 *
 *   describe("my test", () => {
 *     const home = useIsolatedGstackHome("my-test-");
 *     test("writes to tmpdir, not real home", () => {
 *       // anything that resolves GSTACK_HOME will hit home.dir()
 *     });
 *   });
 *
 * Call once at the top of a describe() block (or top-level). Returns a getter
 * for the tmpdir path so individual tests can read/write into the same
 * isolated tree if they want.
 */
export function useIsolatedGstackHome(prefix = "gstack-test-"): {
  dir: () => string;
} {
  let tmpDir = "";
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    savedHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmpDir;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.GSTACK_HOME = savedHome;
    else delete process.env.GSTACK_HOME;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort; tmpdir cleanup is non-fatal.
    }
  });

  return { dir: () => tmpDir };
}
