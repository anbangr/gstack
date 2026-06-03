import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, saveState, statePath, freshState } from "../../state";
import * as gbrain from "../../gbrain";
import {
  sweepOrphans,
  // (only sweepOrphans is needed from cli; explicit import keeps the load
  // surface minimal so the file loads even while the gap is unfixed.)
} from "../../cli";
import {
  writeActiveRunRecord,
  readActiveRunRecords,
  type ActiveRunRecord,
} from "../../active-runs";

/**
 * H1 — selective medium-hygiene batch (three highest-leverage state/sweep
 * findings in one file). All three are `[RED]`: they pin the *desired*
 * invariant against code that does not yet satisfy it. Committed `describe.skip`
 * so the gate stays green today; the fix PR for each gap removes `.skip`.
 *
 * The file imports only symbols that exist today (`saveState`, `loadState`,
 * `statePath`, `freshState` from state.ts; `sweepOrphans` from cli.ts;
 * `writeActiveRunRecord`/`readActiveRunRecords` from active-runs.ts;
 * `isGbrainAvailable`/`gbrainGet` from gbrain.ts) and drives every scenario
 * through those existing entry points. All setup lives inside `beforeEach`/`it`
 * bodies so the module loads cleanly while the gaps are unfixed.
 *
 * The three gaps (see docs/designs/BUILD_ROBUSTNESS_SUITE.md §H1):
 *
 *   1. savestate-write-failure-no-tmp-orphan — `saveState` advances
 *      `state.lastUpdatedAt` *before* the temp+rename and leaves the `.tmp.<pid>`
 *      orphan behind if `fs.renameSync` throws. On a long run, a transient
 *      ENOSPC at one save leaks a tmp file every time AND records a durable-write
 *      timestamp for a write that never landed.
 *   2. sweep-pid-reuse-not-protected — `classifyRecord` short-circuits to "live"
 *      on `isPidAlive(record.pid) && status === "running"` *before* any heartbeat
 *      / identity check. After OS PID recycling, an abandoned record can match a
 *      live unrelated PID and protect its leaked worktree forever.
 *   3. gbrain-restore-preserves-lastupdatedat — `loadState`'s gbrain-restore
 *      path mirrors the restored state back to local JSON via `saveState`, which
 *      stamps a fresh `lastUpdatedAt`. A cross-machine resume therefore looks
 *      brand-new to the stall detector even though the real last write was hours
 *      ago.
 */

// Save+restore GSTACK_BUILD_STATE_DIR for the state-path-driven specs (1 & 3)
// so we never touch the developer's real ~/.gstack/build-state.
let realStateDir: string | undefined;
let tmpStateDir: string;

describe("[RED→FIXED] H1 state-and-sweep-hygiene", () => {
  // ---- savestate-write-failure-no-tmp-orphan -----------------------------
  describe("savestate-write-failure-no-tmp-orphan", () => {
    beforeEach(() => {
      realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
      tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "h1-savestate-"));
      process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
    });

    afterEach(() => {
      if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
      else delete process.env.GSTACK_BUILD_STATE_DIR;
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    });

    it("a torn rename (ENOSPC) leaves no .tmp orphan and does not advance lastUpdatedAt past the last durable write", () => {
      // Land one durable write first so we have a known-good baseline.
      const s = freshState({
        planFile: "/x/h1-savestate.md",
        branch: "main",
        phases: [
          {
            index: 0,
            number: "1",
            name: "Phase 1",
            body: "",
            testSpecDone: true,
            testSpecCheckboxLine: -1,
            implementationDone: false,
            reviewDone: false,
            implementationCheckboxLine: 5,
            reviewCheckboxLine: 6,
            kind: "code",
          },
        ],
        runId: "h1-savestate",
      });
      saveState(s, { noGbrain: true });
      const lastDurable = s.lastUpdatedAt;
      const dir = path.dirname(statePath(s.slug));

      // Mutate something so a second save has a reason to run, then make the
      // *next* renameSync fail once with ENOSPC (simulating a full disk at the
      // exact instant of the atomic rename).
      s.phases[0].status = "impl_done";
      const renameSpy = spyOn(fs, "renameSync").mockImplementationOnce(() => {
        const err = new Error(
          "ENOSPC: no space left on device, rename",
        ) as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      });

      try {
        // saveState today throws (no catch around the rename). Whether it throws
        // or is hardened to swallow, the two invariants below must hold either way.
        try {
          saveState(s, { noGbrain: true });
        } catch {
          // A torn write may surface as a throw; that is acceptable. The orphan
          // and timestamp invariants are what this spec pins.
        }
      } finally {
        renameSpy.mockRestore();
      }

      // DESIRED INVARIANT 1: no `.tmp.<pid>` straggler remains after the failed
      // rename. Today saveState writes the temp file then renames; a thrown
      // rename leaves the temp file behind with no cleanup.
      const stragglers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
      expect(stragglers).toEqual([]);

      // DESIRED INVARIANT 2: lastUpdatedAt was not advanced past the last
      // durable write. Today saveState sets state.lastUpdatedAt = now() BEFORE
      // the rename, so a failed rename records a timestamp for a write that
      // never hit disk.
      expect(s.lastUpdatedAt).toBe(lastDurable);

      // And the on-disk file still reflects the last good write (its
      // lastUpdatedAt matches the durable baseline, not the torn attempt).
      const onDisk = JSON.parse(fs.readFileSync(statePath(s.slug), "utf8")) as {
        lastUpdatedAt: string;
      };
      expect(onDisk.lastUpdatedAt).toBe(lastDurable);
    });
  });

  // ---- sweep-pid-reuse-not-protected -------------------------------------
  // Real `git worktree` + temp-HOME idiom, copied from
  // build/orchestrator/__tests__/sweep-orphans.test.ts and the D5 robustness
  // spec. No helpers.ts time/spawn fakes apply here — this exercises real git
  // and the real filesystem.
  describe("sweep-pid-reuse-not-protected", () => {
    let parentRepo: string;
    let buildWorktreesRoot: string;
    let registryDir: string;
    let fakeHome: string;
    let originalHome: string | undefined;
    let baseCommit: string;

    function git(args: string[], cwd: string) {
      return spawnSync("git", args, { cwd, encoding: "utf8" });
    }

    beforeEach(() => {
      // realpathSync canonicalizes /var/folders/... → /private/var/folders/...
      // on macOS so paths match what `git worktree list --porcelain` reports.
      parentRepo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "h1-sweep-parent-")),
      );
      fakeHome = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "h1-sweep-home-")),
      );
      // sweepOrphans takes an explicit homeDir override, but pin HOME too so no
      // code path that consults the real home env can touch ~/.gstack.
      originalHome = process.env.HOME;
      process.env.HOME = fakeHome;

      buildWorktreesRoot = path.join(
        fakeHome,
        ".gstack",
        "build-worktrees",
        "test-repo",
      );
      fs.mkdirSync(buildWorktreesRoot, { recursive: true });
      registryDir = path.join(
        fakeHome,
        ".gstack",
        "build-state",
        "active-runs",
      );
      fs.mkdirSync(registryDir, { recursive: true });

      git(["init", "-b", "main", "-q"], parentRepo);
      git(["config", "user.email", "h1-test@example.invalid"], parentRepo);
      git(["config", "user.name", "h1-test"], parentRepo);
      fs.writeFileSync(path.join(parentRepo, "README.md"), "test\n");
      git(["add", "README.md"], parentRepo);
      git(["commit", "-q", "-m", "init"], parentRepo);
      baseCommit = git(["rev-parse", "HEAD"], parentRepo).stdout.trim();
    });

    afterEach(() => {
      // Detach worktrees before deleting dirs so git's prune never trips.
      try {
        git(["worktree", "prune"], parentRepo);
      } catch {
        // ignore
      }
      fs.rmSync(parentRepo, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    });

    function addWorktree(runId: string): string {
      const wtPath = path.join(buildWorktreesRoot, runId);
      git(["worktree", "add", "--detach", wtPath, baseCommit], parentRepo);
      return wtPath;
    }

    it("reaps a stale-heartbeat record even when its recorded PID is currently alive (PID recycle)", () => {
      const wt = addWorktree("run-recycled");
      // The abandoned record: status "running", PID = this test process (so
      // isPidAlive() returns true — the OS recycled the PID onto an unrelated
      // live process), but the heartbeat is 48h stale. The orchestrator that
      // wrote this record is long dead; the matching live PID is a coincidence.
      const staleHeartbeat = new Date(
        Date.now() - 48 * 3600 * 1000,
      ).toISOString();
      const record: ActiveRunRecord = {
        runId: "run-recycled",
        stateSlug: "build-run-recycled",
        repoPath: parentRepo,
        worktreePath: wt,
        planFile: "/plans/plan.md",
        pid: process.pid, // live PID, but NOT the original owner (recycled)
        status: "running",
        startedAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
        lastUpdatedAt: staleHeartbeat,
        branches: ["feat/run-recycled"],
      };
      writeActiveRunRecord(registryDir, record);

      const stats = sweepOrphans(registryDir, { homeDir: fakeHome });

      // DESIRED INVARIANT: the live-PID short-circuit must be gated by an
      // identity / heartbeat check. A record whose heartbeat is older than the
      // stale threshold is a genuine leak regardless of whether its recorded
      // PID happens to match some live process now. So it must be reaped, not
      // protected as skipped-live.
      expect(stats.skippedLive).toBe(0);
      expect(stats.shapeX).toBe(1);
      expect(fs.existsSync(wt)).toBe(false);
      expect(readActiveRunRecords(registryDir).map((r) => r.runId)).toEqual([]);
    });
  });

  // ---- gbrain-restore-preserves-lastupdatedat ----------------------------
  describe("gbrain-restore-preserves-lastupdatedat", () => {
    let availSpy: ReturnType<typeof spyOn> | undefined;
    let getSpy: ReturnType<typeof spyOn> | undefined;

    beforeEach(() => {
      realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
      tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "h1-gbrain-"));
      process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
    });

    afterEach(() => {
      availSpy?.mockRestore();
      getSpy?.mockRestore();
      availSpy = undefined;
      getSpy = undefined;
      if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
      else delete process.env.GSTACK_BUILD_STATE_DIR;
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    });

    it("restoring a state from gbrain preserves its 3h-old lastUpdatedAt (does not stamp restore-time)", () => {
      const slug = "build-h1-gbrain-restore";
      const threeHoursAgo = new Date(
        Date.now() - 3 * 3600 * 1000,
      ).toISOString();

      // A state blob as it would live on the gbrain page: a build started on
      // another machine, last written 3h ago. No local JSON exists here (the
      // tmp state dir is empty), so loadState falls through to the gbrain path.
      const brainState = {
        planFile: "/x/h1-gbrain-restore.md",
        planBasename: "h1-gbrain-restore",
        slug,
        branch: "main",
        startedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
        lastUpdatedAt: threeHoursAgo,
        currentPhaseIndex: 0,
        phases: [{ index: 0, number: "1", name: "Phase 1", status: "pending" }],
        completed: false,
      };

      // No local JSON: loadState reads statePath(slug), misses, then consults
      // gbrain. Stub the gbrain seam so the restore path runs without a real
      // gbrain CLI / network.
      availSpy = spyOn(gbrain, "isGbrainAvailable").mockReturnValue(true);
      getSpy = spyOn(gbrain, "gbrainGet").mockReturnValue(
        JSON.stringify(brainState),
      );

      const loaded = loadState(slug);
      expect(loaded).not.toBeNull();

      // DESIRED INVARIANT: the restored state keeps its original (3h-old)
      // lastUpdatedAt. Today loadState mirrors the restored state back to local
      // JSON via saveState, which stamps a fresh now() timestamp — so a
      // cross-machine resume looks brand-new to the stall detector even though
      // the real last write was 3 hours ago.
      expect(loaded!.lastUpdatedAt).toBe(threeHoursAgo);

      // And the mirrored-back local JSON must carry the preserved timestamp too,
      // not a restore-time stamp.
      const onDisk = JSON.parse(fs.readFileSync(statePath(slug), "utf8")) as {
        lastUpdatedAt: string;
      };
      expect(onDisk.lastUpdatedAt).toBe(threeHoursAgo);
    });
  });
});
