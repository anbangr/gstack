/**
 * E4 — corrupt-repo matcher coverage (`build-robustness` suite).
 *
 * Group E (git / quarantine / worktree). See ./README.md for the PIN/RED
 * protocol and `docs/designs/BUILD_ROBUSTNESS_SUITE.md` §"Group E" → E4 for the
 * design context.
 *
 * THE GAP (confirmed by reading production `cli.ts`):
 * `isCorruptRepoError(stderr)` (cli.ts, module-private) only matches TWO
 * literal substrings today:
 *     text.includes("did not send all necessary objects")
 *  || text.includes("bad object refs/heads/")
 * Most REAL repository-corruption messages git emits during `git fetch` miss
 * both literals, so they never classify as `GIT_REPO_CORRUPT` and the user
 * never gets the actionable `git fsck --full` recovery hint. They surface as a
 * plain `{ ok: false, error }` (or, for status-0 corruption, get swallowed and
 * resurface later as an opaque merge/checkout failure).
 *
 * WHY RED (not PIN), and WHY DRIVEN THROUGH THE PUBLIC ENTRY:
 * `isCorruptRepoError` is NOT exported from cli.ts — it is a module-private
 * `function`. Per the E4 spec instruction ("if not exported, drive via the
 * public entry and skip"), this file asserts the DESIRED invariant through the
 * exported public halt path `syncFeatureBranchWithBase()` / `syncLandedBase()`
 * (same entry the sibling `git-repo-corrupt-halt.test.ts` exercises), using a
 * REAL `git fetch` against a clone we deterministically corrupt. The desired
 * invariant fails today, so the block is committed `describe.skip`. The fix PR
 * (widen the matcher to recognize these representative real corruption
 * messages, and/or scan fetch stderr even on a status-0 fetch) removes `.skip`
 * and the block goes green.
 *
 * Representative REAL corruption messages exercised here (beyond the two
 * current literals), each produced by a REAL `git fetch` in this test — no
 * synthetic stderr:
 *   - "fatal: unexpected line in .git/packed-refs: ..."  (corrupt packed-refs,
 *      fetch exit 128 — hits the `fetch.status !== 0` matcher branch directly)
 *   - "error: object file .git/objects/.. is empty"      (emptied loose object,
 *      surfaces as a corrupt-commit parse failure on the merge leg)
 *
 * No LLM, no network. Only a short-lived real `git` is spawned (bounded, fast),
 * all under an isolated OS temp dir removed in afterEach. Env vars touched
 * (GSTACK_HOME, GSTACK_BUILD_STATE_DIR, GEMINI_BIN, CODEX_BIN,
 * GSTACK_DISABLE_REF_QUARANTINE) are saved + restored so we never read or write
 * the developer's real ~/.gstack.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as cli from "../../cli";
import { mkTmp } from "./helpers";

// --- env isolation -------------------------------------------------------
const SAVED_ENV: Record<string, string | undefined> = {};
const ISOLATED_ENV_KEYS = [
  "GSTACK_HOME",
  "GSTACK_BUILD_STATE_DIR",
  "GEMINI_BIN",
  "CODEX_BIN",
  "GSTACK_DISABLE_REF_QUARANTINE",
] as const;

let tmpDir: string;
let bareDir: string;
let serverDir: string;
let cloneDir: string;
let baseBranch: string;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

/** A real bare repo + server + client clone, mirroring git-repo-corrupt-halt.test.ts. */
function makeRealClone(): void {
  bareDir = path.join(tmpDir, "bare.git");
  serverDir = path.join(tmpDir, "server");
  cloneDir = path.join(tmpDir, "clone");
  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  git(["init"], serverDir);
  // Pin identity locally so the test never depends on developer git config.
  git(["config", "user.email", "robustness@example.invalid"], serverDir);
  git(["config", "user.name", "robustness"], serverDir);
  fs.writeFileSync(path.join(serverDir, "file.txt"), "hello");
  git(["add", "."], serverDir);
  git(["commit", "-m", "init"], serverDir);

  git(["clone", "--bare", serverDir, bareDir], tmpDir);
  git(["clone", bareDir, cloneDir], tmpDir);

  // Detect the actual default branch (git init may default to main or master).
  baseBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], cloneDir);
}

/** Empty a client loose object — real on-disk corruption ("object file .. is empty"). */
function emptyOneLooseObject(clientDir: string): void {
  const find = spawnSync(
    "bash",
    [
      "-c",
      `find "${path.join(clientDir, ".git", "objects")}" -type f -not -path '*/pack/*' | head -1`,
    ],
    { encoding: "utf8" },
  );
  const obj = (find.stdout || "").trim();
  if (!obj) {
    throw new Error("no loose object found to corrupt");
  }
  // Loose objects are mode 0444; make writable before truncating.
  fs.chmodSync(obj, 0o644);
  fs.writeFileSync(obj, "");
}

/** Corrupt packed-refs — real on-disk corruption ("unexpected line in .git/packed-refs"). */
function corruptPackedRefs(clientDir: string): void {
  git(["pack-refs", "--all"], clientDir);
  fs.writeFileSync(
    path.join(clientDir, ".git", "packed-refs"),
    "this is not a valid packed-refs sha line\n",
  );
}

function asCorruptHalt(result: {
  ok: boolean;
  error?: string;
  haltKind?: string;
}): boolean {
  const err = result.error ?? "";
  return (
    result.haltKind === "GIT_REPO_CORRUPT" || err.includes("git fsck --full")
  );
}

beforeEach(() => {
  for (const k of ISOLATED_ENV_KEYS) SAVED_ENV[k] = process.env[k];

  tmpDir = mkTmp("gstack-robustness-E4-");
  // Keep all build/security state inside the temp dir — never the real ~/.gstack.
  const fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.GSTACK_HOME = fakeHome;
  process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpDir, "build-state");
  // No provider binaries are invoked by the git sync path, but isolate the
  // env knobs anyway so a stray probe can never hit a real ~/.gemini / ~/.codex.
  process.env.GEMINI_BIN = path.join(tmpDir, "no-gemini");
  process.env.CODEX_BIN = path.join(tmpDir, "no-codex");
  // Production default for quarantine is ON; leave it unset (delete any
  // inherited override) so the test reflects the real shipped path.
  delete process.env.GSTACK_DISABLE_REF_QUARANTINE;

  makeRealClone();
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  for (const k of ISOLATED_ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

// =====================================================================
// [RED] E4 — the corrupt-repo matcher is too narrow. UNSKIP WHEN E4 IS FIXED.
//
// Today `isCorruptRepoError` only knows two literal substrings, so these
// representative REAL corruption messages do NOT classify as GIT_REPO_CORRUPT
// and the user never gets the `git fsck --full` recovery hint. Each test below
// asserts the DESIRED invariant (corrupt classification + recovery hint) and is
// expected to FAIL until the matcher is widened — hence describe.skip.
// =====================================================================
describe("[RED→FIXED] E4 corrupt-repo-matcher-coverage", () => {
  test("corrupt packed-refs ('unexpected line in .git/packed-refs') classifies as GIT_REPO_CORRUPT with a git fsck --full hint", () => {
    const fn = (cli as { syncFeatureBranchWithBase?: unknown })
      .syncFeatureBranchWithBase as
      | ((
          cwd: string,
          branch: string,
        ) => { ok: boolean; error?: string; haltKind?: string })
      | undefined;
    expect(typeof fn).toBe("function");

    corruptPackedRefs(cloneDir);
    const result = fn!(cloneDir, baseBranch);

    // It is genuinely a failed sync.
    expect(result.ok).toBe(false);
    // The fetch stderr really did contain a real corruption message.
    expect((result.error ?? "").includes("packed-refs")).toBe(true);

    // DESIRED (fails today — matcher does not recognize this real message):
    // a corrupt repo must surface the actionable GIT_REPO_CORRUPT halt with
    // the `git fsck --full` recovery hint, not an opaque plain error.
    expect(asCorruptHalt(result)).toBe(true);
  });

  test("emptied loose object ('object file .. is empty') classifies as GIT_REPO_CORRUPT with a git fsck --full hint", () => {
    const fn = (cli as { syncFeatureBranchWithBase?: unknown })
      .syncFeatureBranchWithBase as
      | ((
          cwd: string,
          branch: string,
        ) => { ok: boolean; error?: string; haltKind?: string })
      | undefined;
    expect(typeof fn).toBe("function");

    emptyOneLooseObject(cloneDir);
    const result = fn!(cloneDir, baseBranch);

    // Real on-disk corruption => the sync cannot succeed.
    expect(result.ok).toBe(false);
    // The surfaced error really did mention the empty/corrupt object.
    expect((result.error ?? "").includes("object file")).toBe(true);

    // DESIRED (fails today — neither the narrow matcher nor any stderr scan
    // catches this): surface GIT_REPO_CORRUPT + the `git fsck --full` hint.
    expect(asCorruptHalt(result)).toBe(true);
  });

  test("syncLandedBase also classifies corrupt packed-refs as GIT_REPO_CORRUPT with a recovery hint", () => {
    const fn = (cli as { syncLandedBase?: unknown }).syncLandedBase as
      | ((cwd: string) => { ok: boolean; error?: string; haltKind?: string })
      | undefined;
    expect(typeof fn).toBe("function");

    corruptPackedRefs(cloneDir);
    const result = fn!(cloneDir);

    expect(result.ok).toBe(false);
    expect((result.error ?? "").includes("packed-refs")).toBe(true);

    // DESIRED (fails today): same corrupt-repo classification on the
    // landed-base sync path as on the feature-branch sync path.
    expect(asCorruptHalt(result)).toBe(true);
  });
});
