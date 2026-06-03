/**
 * D1 — release-daemon-stale-inflight-reclaim  [RED] — smoke
 *
 * Failure mode (from BUILD_ROBUSTNESS_SUITE.md, ranked #4):
 *   A SIGKILL / OOM / reboot strands a release-queue record in an in-flight
 *   status (`landing` / `claiming` / `drift_repairing`) on disk. The freshly
 *   restarted daemon process has an EMPTY `activeRecords` map (no in-memory
 *   snapshot survived the hard kill), so `reviveActiveRecordsForSignal` can
 *   never touch it. And `runReleaseDaemon`'s candidate filter only considers
 *   `status === "queued"` records, so the stranded `landing` record is never
 *   handed to the processor and never rewritten to `queued`/`blocked`. Even a
 *   manual `retryReleaseQueueRecord` is a no-op: it only requeues `blocked`
 *   records and returns any other status unchanged. The PR is permanently
 *   abandoned — one silently-lost PR per hard kill.
 *
 * Desired invariant (what the fix must deliver):
 *   1. A fresh daemon (empty activeRecords, simulated via
 *      `_resetReleaseDaemonForTests`) that finds a stale-`lastUpdatedAt`
 *      in-flight record on disk either hands it to the processor OR rewrites
 *      it to `queued`/`blocked` — an in-flight status is NEVER a permanent
 *      dead end.
 *   2. `retryReleaseQueueRecord` can rescue an in-flight record (not just a
 *      `blocked` one), moving it back to `queued`.
 *
 * Committed as `describe.skip`. Remove `.skip` in the same commit as the
 * production fix (see ../README.md "Unskip checklist").
 *
 * Idioms (makeRepo / TMP_ALLOWLIST / record builder) are lifted from
 * ../../release-daemon.test.ts so this spec shares the same seams.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _resetReleaseDaemonForTests,
  retryReleaseQueueRecord,
  runReleaseDaemon,
} from "../../release-daemon";
import {
  readReleaseQueueRecords,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../../release-queue";
import { DEFAULT_ROLE_CONFIGS } from "../../role-config";

describe("[RED→FIXED] D1 release-daemon-stale-inflight-reclaim", () => {
  let queueDir: string;
  // Repos created per-test get a real .git marker so the daemon's allowlist
  // security gate (isAllowedRepoPath) accepts them. Tracked for teardown.
  const trackedRepos: string[] = [];
  // Allowlist that admits any tmpdir-rooted path. Uses the realpath of tmpdir
  // because the gate validates against realpath. Same as release-daemon.test.ts.
  const TMP_ALLOWLIST = [fs.realpathSync(os.tmpdir()) + path.sep];

  function makeRepo(slug: string): string {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), `gstack-d1-${slug}-`));
    fs.mkdirSync(path.join(p, ".git"));
    trackedRepos.push(p);
    return p;
  }

  function record(overrides: Partial<ReleaseQueueRecord>): ReleaseQueueRecord {
    return {
      runId: "d1-run",
      repoPath: overrides.repoPath ?? makeRepo("default"),
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 1,
      version: "1.0.0.1",
      livingPlanPath: "/plans/living.md",
      worktreePath: "/worktree",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  beforeEach(() => {
    queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-d1-queue-"));
    // Simulate a fresh post-SIGKILL process: no surviving in-memory snapshot
    // of any in-flight record. The signal-revival path has nothing to act on.
    _resetReleaseDaemonForTests();
  });

  afterEach(() => {
    _resetReleaseDaemonForTests();
    fs.rmSync(queueDir, { recursive: true, force: true });
    for (const repo of trackedRepos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
    trackedRepos.length = 0;
  });

  it("reclaims a stranded in-flight (landing) record instead of abandoning it forever", async () => {
    // A record left mid-land by a hard kill: status=landing, with an OLD
    // lastUpdatedAt to mark it as definitively stale (no live daemon is
    // touching it). NOT registered in activeRecords — the kill erased that.
    const repo = makeRepo("stranded");
    const stranded = record({
      runId: "stranded-landing",
      repoPath: repo,
      prNumber: 7,
      status: "landing",
    });
    writeReleaseQueueRecord(queueDir, stranded);
    // Force a stale lastUpdatedAt on disk so a reclaim heuristic that keys
    // on age has the signal it needs (writeReleaseQueueRecord stamps "now").
    const onDiskFile = path.join(queueDir, fs.readdirSync(queueDir)[0]);
    const raw = JSON.parse(
      fs.readFileSync(onDiskFile, "utf8"),
    ) as ReleaseQueueRecord;
    raw.lastUpdatedAt = "2026-05-09T00:00:00.000Z"; // hours old
    fs.writeFileSync(onDiskFile, JSON.stringify(raw, null, 2));

    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir,
      repoPath: repo,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      allowlistPrefixes: TMP_ALLOWLIST,
      log: () => {},
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    // DESIRED: the stranded record is NOT a permanent dead end. Either it
    // got handed to the processor (most direct reclaim), OR the daemon
    // rewrote it to queued/blocked on disk so a subsequent tick can act.
    const onDisk = readReleaseQueueRecords(queueDir);
    const reclaimed = onDisk.find((r) => r.runId === "stranded-landing");
    const wasProcessed = processed.includes(7);
    const wasRewritten =
      reclaimed !== undefined &&
      (reclaimed.status === "queued" ||
        reclaimed.status === "blocked" ||
        reclaimed.status === "landed");

    expect(wasProcessed || wasRewritten).toBe(true);
    // And the once-mode exit code is a defined daemon outcome, never a hang.
    expect(typeof exit).toBe("number");
    // The record must NOT still be stuck in the original in-flight status.
    expect(reclaimed?.status).not.toBe("landing");
  });

  it("retryReleaseQueueRecord rescues an in-flight record back to queued (not just blocked)", () => {
    // Today retryReleaseQueueRecord short-circuits with `return record` for
    // any status !== "blocked", so a manual retry of a stranded landing
    // record is a no-op. The desired behavior: it requeues the in-flight
    // record so the daemon can pick it up again.
    const repo = makeRepo("manual-retry");
    const stuck = record({
      runId: "stuck-inflight",
      repoPath: repo,
      prNumber: 99,
      status: "landing",
    });
    writeReleaseQueueRecord(queueDir, stuck);

    const result = retryReleaseQueueRecord(99, queueDir);

    // DESIRED: the in-flight record is rescued back to "queued".
    expect(result).not.toBeNull();
    expect(result?.status).toBe("queued");
    // And the rescue is durable on disk, not just the returned object.
    const onDisk = readReleaseQueueRecords(queueDir).find(
      (r) => r.prNumber === 99,
    );
    expect(onDisk?.status).toBe("queued");
  });
});
