/**
 * C3 — state-resume-torn-file  [PIN] — smoke
 *
 * Long-run failure mode: the orchestrator gets OOM-killed / power-lost mid-save
 * and the on-disk `state.json` is left truncated or partially written. On the
 * next resume the orchestrator MUST NOT silently act on partial state (which
 * would double-run or skip phases). It must fail closed.
 *
 * This pins behavior that is ALREADY CORRECT in `state.ts` today (verified by
 * reading the production source):
 *   - `loadState` throws a clear "...is corrupt..." error on a truncated JSON
 *     state file (build/orchestrator/state.ts:529-565), so a torn file can never
 *     be mistaken for a clean resume.
 *   - `saveState` writes via tmp+rename: `${finalPath}.tmp.${process.pid}` then
 *     `fs.renameSync(tmpPath, finalPath)` (build/orchestrator/state.ts:572-590).
 *     On success the final file is complete valid JSON and no `.tmp.<pid>`
 *     orphan is left behind.
 *
 * There is no separate `readState` symbol — `loadState(slug, opts)` is the
 * read/load entry point and is the one a resume calls. We import only symbols
 * that exist today: `statePath`, `freshState`, `loadState`, `saveState`.
 *
 * See ./README.md for the PIN/RED protocol and
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §Group C (C3) for design context.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { statePath, freshState, loadState, saveState } from "../../state";
import type { Phase } from "../../types";

// Isolate GSTACK_BUILD_STATE_DIR to a temp dir so we never touch the
// developer's real ~/.gstack/build-state. Save+restore the env var.
let realStateDir: string | undefined;
let tmpStateDir: string;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-robustness-c3-state-"),
  );
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

// A pair of minimal phases so freshState produces a realistic state object.
const phases: Phase[] = [
  {
    index: 0,
    number: "1",
    name: "Foo",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "Full plan",
    testSpecDone: true,
    implementationDone: false,
    reviewDone: false,
    body: "",
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: 5,
    reviewCheckboxLine: 6,
    kind: "code",
  },
  {
    index: 1,
    number: "2",
    name: "Bar",
    featureIndex: 0,
    featureNumber: "1",
    featureName: "Full plan",
    testSpecDone: true,
    implementationDone: true,
    reviewDone: true,
    body: "",
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: 10,
    reviewCheckboxLine: 11,
    kind: "code",
  },
];

// Write `bytes` directly to the state path for `slug`, creating the dir.
function writeRawState(slug: string, bytes: string): string {
  const p = statePath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}

describe("[PIN] C3 state-resume-torn-file — fail-closed read + tmp+rename save", () => {
  // ---- Fail-closed on a torn/partial state file --------------------------

  it("loadState throws a clear 'corrupt' error on a truncated JSON state file (never silently acts on partial state)", () => {
    // Build a complete valid state, serialize it the way saveState would, then
    // chop it in half to simulate a write that was interrupted by an OOM/kill.
    const slug = "build-c3-truncated";
    const full =
      JSON.stringify(
        freshState({
          planFile: "/x/foo.md",
          branch: "main",
          phases,
        }),
        null,
        2,
      ) + "\n";
    const torn = full.slice(0, Math.floor(full.length / 2));
    // Sanity: the truncation must actually produce non-parseable JSON.
    expect(() => JSON.parse(torn)).toThrow();

    writeRawState(slug, torn);

    // The read/load entry must fail closed: a clear error, never a partial
    // BuildState object the resume could act on.
    expect(() => loadState(slug, { noGbrain: true })).toThrow(/corrupt/);
    expect(() => loadState(slug, { noGbrain: true })).toThrow(
      /Inspect or delete/,
    );
  });

  it("loadState throws on an empty (zero-length) state file rather than returning a half-built object", () => {
    // A power-loss between open() and the first write leaves a 0-byte file.
    // The file EXISTS, so the gbrain fallback is not consulted; the parse must
    // throw rather than silently producing `null`/partial state.
    const slug = "build-c3-empty";
    writeRawState(slug, "");
    expect(() => loadState(slug, { noGbrain: true })).toThrow(/corrupt/);
  });

  it("loadState throws on a state file with trailing garbage (partial overwrite of a longer prior file)", () => {
    // A short save over a longer prior file can leave valid-prefix + junk tail.
    const slug = "build-c3-trailing-garbage";
    const full = JSON.stringify(
      freshState({
        planFile: "/x/foo.md",
        branch: "main",
        phases,
      }),
    );
    writeRawState(slug, full + "\n{leftover from a longer previous write");
    expect(() => loadState(slug, { noGbrain: true })).toThrow(/corrupt/);
  });

  it("a torn read does not leave a usable partial state — the throw is the only outcome", () => {
    // Guard against any future change that swallows the parse error and returns
    // a defaulted object. The contract is throw-or-throw on a torn file; there
    // is no "return null and move on" path when the file exists but is corrupt.
    const slug = "build-c3-no-silent-recovery";
    writeRawState(slug, "{not valid json");
    let threw = false;
    let result: unknown = "sentinel";
    try {
      result = loadState(slug, { noGbrain: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The call never produced a value the resume could have acted on.
    expect(result).toBe("sentinel");
  });

  // ---- tmp+rename save hygiene -------------------------------------------

  it("saveState writes via tmp+rename: final file is complete valid JSON, no .tmp.<pid> orphan", () => {
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    saveState(s, { noGbrain: true });

    const finalPath = statePath(s.slug);
    const dir = path.dirname(finalPath);

    // Final file exists and parses to a complete BuildState (round-trips).
    expect(fs.existsSync(finalPath)).toBe(true);
    const reparsed = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    expect(reparsed.slug).toBe(s.slug);
    expect(reparsed.phases).toHaveLength(2);
    expect(reparsed.phases[1].status).toBe("committed");

    // No `.tmp.<pid>` orphan left behind after a successful save.
    const stragglers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(stragglers).toEqual([]);

    // Specifically: the predictable tmp path for this process is gone.
    const tmpPath = `${finalPath}.tmp.${process.pid}`;
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("a state written by saveState reloads cleanly via loadState (the rename produced a non-torn file)", () => {
    // Closes the loop: tmp+rename means a reader never sees a half-written
    // file, so the very file saveState produced is always loadable.
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    saveState(s, { noGbrain: true });

    const reloaded = loadState(s.slug, { noGbrain: true });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.slug).toBe(s.slug);
    expect(reloaded!.phases).toHaveLength(2);
  });

  it("repeated saves leave exactly one final file and zero .tmp.<pid> orphans", () => {
    // A long run saves state on every tick. Over many saves the rename must
    // never accumulate tmp orphans (which would otherwise grow unbounded and,
    // worse, look like state files to a sweep).
    const s = freshState({ planFile: "/x/foo.md", branch: "main", phases });
    for (let i = 0; i < 5; i++) saveState(s, { noGbrain: true });

    const dir = path.dirname(statePath(s.slug));
    const entries = fs.readdirSync(dir);
    const tmpOrphans = entries.filter((f) => f.includes(".tmp."));
    const finalFiles = entries.filter((f) => f === `${s.slug}.json`);
    expect(tmpOrphans).toEqual([]);
    expect(finalFiles).toEqual([`${s.slug}.json`]);
  });
});
