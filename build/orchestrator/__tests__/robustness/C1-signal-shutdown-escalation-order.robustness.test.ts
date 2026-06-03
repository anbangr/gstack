/**
 * C1 — signal-shutdown-escalation-order  [RED]  (integration)
 *
 * Crash/shutdown failure mode: the orchestrator installs TWO competing
 * signal handlers for the SAME SIGINT/SIGTERM signal.
 *
 *   Site 1 (child-registry.ts:62 `installSignalHandlers`, wired at
 *           cli.ts:12533): on signal, runs `shutdownAndExit(signal)` which
 *           does `killAllChildren("SIGTERM")` -> `await sleep(2000)` ->
 *           `killAllChildren("SIGKILL")` -> `process.exit(143/130)`. This is
 *           the escalation path that reaps a SIGTERM-IGNORING sub-agent group.
 *
 *   Site 2 (cli.ts:13142 `onSignal`): on the same signal, synchronously
 *           `saveState`s, releases the lock, and calls `process.exit(130)`
 *           IMMEDIATELY — no await of the 2s grace.
 *
 * Both fire on one signal. Site 2's synchronous `process.exit(130)` pre-empts
 * Site 1's `await sleep(2000)`, so the SIGKILL escalation NEVER runs. A
 * sub-agent process group that ignores SIGTERM (the realistic case: a
 * shell-wrapped CLI that traps TERM) is orphaned to init — leaked LLM
 * sub-processes on every interrupt, compounding across restarts.
 *
 * DESIRED INVARIANT (this spec, asserted against a forked harness that
 * reproduces BOTH handler sites verbatim):
 *   (1) state file written AND lock removed (Site 2's cleanup still happens), AND
 *   (2) the trapped `sh -c "trap '' TERM; sleep 60"` process GROUP is dead
 *       within a bounded window after SIGTERM (Site 1's SIGKILL escalation
 *       reached it).
 *
 * Today (1) holds but (2) FAILS — the trapped group survives because exit(130)
 * wins the race. That is the confirmed gap from the audit
 * (BUILD_ROBUSTNESS_SUITE.md §C1), committed as `describe.skip` with the
 * UNSKIP banner. The fix PR makes the cleanup handler defer to (or sequence
 * after) the escalation grace, removes `.skip`, and this goes green.
 *
 * Real-process integration: there is no pure-unit way to reproduce two
 * competing OS signal handlers racing on a real `process.exit`. The harness
 * forks a real short-lived `bun` process and spawns a real `/bin/sh`+`sleep`
 * grandchild; every wait is bounded and the grandchild's process group is
 * reaped in afterEach so nothing leaks past the test.
 *
 * See ./README.md for the PIN/RED protocol and
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §C1 for full context.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTmp } from "./helpers";

// Resolve the real production modules from this file. The forked harness
// imports the SAME child-registry.ts (Site 1) and state.ts (saveState /
// releaseLock / acquireLock, the file ops Site 2 performs) so the race is
// the real one, not a re-implementation.
const childRegistryPath = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "..",
  "child-registry.ts",
);
const statePath = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "..",
  "state.ts",
);

/** Liveness check for a process group (negative pid) or a pid. */
function groupAlive(pid: number): boolean {
  try {
    // Negative pid checks the whole process group. Detached children get
    // their own pgid == pid, so the trapped grandchild's group is -pid.
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists but not signalable
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

describe.skip("[RED] C1 signal-shutdown-escalation-order — UNSKIP WHEN C1 IS FIXED", () => {
  let tmpDir: string;
  let stateDirPath: string;
  const slug = "build-c1-shutdown-race";

  // Track everything we spawn so afterEach can reap it even on assertion
  // failure — no leaked harness or trapped grandchild past the test.
  let harnessPid: number | null = null;
  let childPid: number | null = null;

  let origStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkTmp("gstack-robustness-c1-");
    stateDirPath = path.join(tmpDir, "build-state");
    fs.mkdirSync(stateDirPath, { recursive: true });

    // Isolate state away from the developer's real ~/.gstack. saveState /
    // acquireLock / releaseLock all route through stateDir() which reads
    // GSTACK_BUILD_STATE_DIR at call time.
    origStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    process.env.GSTACK_BUILD_STATE_DIR = stateDirPath;

    harnessPid = null;
    childPid = null;
  });

  afterEach(() => {
    // Reap the trapped grandchild's GROUP first (it ignores SIGTERM, so
    // SIGKILL the group), then the harness, before removing the temp dir.
    if (childPid !== null) {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (harnessPid !== null) {
      try {
        process.kill(harnessPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }

    if (origStateDir === undefined) {
      delete process.env.GSTACK_BUILD_STATE_DIR;
    } else {
      process.env.GSTACK_BUILD_STATE_DIR = origStateDir;
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("SIGTERM saves state, releases lock, AND escalates SIGKILL to the trapped child group", async () => {
    if (process.platform === "win32") {
      // POSIX-only: process groups + SIGTERM/SIGKILL escalation don't apply.
      return;
    }

    // The harness reproduces BOTH real signal-handler sites against the
    // isolated state dir + slug, then registers a real detached
    // SIGTERM-IGNORING grandchild via the registry's spawn().
    const harnessScript = path.join(tmpDir, "harness.ts");
    fs.writeFileSync(
      harnessScript,
      `
import { installSignalHandlers, spawn } from ${JSON.stringify(childRegistryPath)};
import { saveState, acquireLock, releaseLock } from ${JSON.stringify(statePath)};

const slug = ${JSON.stringify(slug)};
const state = { slug, phases: [], schemaVersion: 1, planFile: "/tmp/c1-plan.md" };

// --- Site 1: child-registry handlers (SIGTERM children -> sleep 2s -> SIGKILL -> exit) ---
installSignalHandlers();

// --- Site 2: cli.ts onSignal pair (verbatim shape from cli.ts:13142) ---
let interrupted = false;
const onSignal = () => {
  if (interrupted) return;
  interrupted = true;
  try { saveState(state, { noGbrain: true }); } catch {}
  releaseLock(slug);
  process.exit(130);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// Acquire the lock + seed initial state, exactly as the orchestrator does
// before the run loop, so the test can observe the cleanup transition.
acquireLock(slug);
saveState(state, { noGbrain: true });

// Register a SIGTERM-IGNORING grandchild process group. Only a SIGKILL
// escalation can reap it — exactly the sub-agent the C1 bug orphans.
const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 60"], { stdio: "ignore" });
if (typeof child.pid !== "number") {
  console.error("FAILED: no child pid");
  process.exit(2);
}

console.log(JSON.stringify({ parentPid: process.pid, childPid: child.pid }));

// Idle like the orchestrator run loop until a signal arrives.
setInterval(() => {}, 60_000);
`,
    );

    // Launch the harness DETACHED (its own session + process group) so the
    // bun-test supervisor's job control can't cascade-kill the trapped
    // grandchild when the harness exits. Without `detached`, the test
    // runner's session teardown can reap the grandchild for the WRONG reason
    // (a SIGHUP cascade rather than Site 1's SIGKILL escalation), which made
    // this spec flaky. Detaching isolates the harness subtree so the
    // grandchild's death has exactly one possible cause: the escalation we
    // are asserting. The state dir is passed explicitly so the fresh process
    // reads the same isolated dir.
    const harnessProc = nodeSpawn(process.execPath, [harnessScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GSTACK_BUILD_STATE_DIR: stateDirPath },
    });
    harnessProc.unref();
    harnessPid = harnessProc.pid ?? null;
    expect(typeof harnessPid).toBe("number");

    // Read the pids line (bounded) off the harness stdout.
    let buf = "";
    let pids: { parentPid: number; childPid: number } | null = null;
    harnessProc.stdout!.setEncoding("utf8");
    harnessProc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1 && !pids) {
        try {
          pids = JSON.parse(buf.slice(0, nl));
        } catch {
          /* keep reading */
        }
      }
    });
    const readDeadline = Date.now() + 8000;
    while (Date.now() < readDeadline && !pids) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(pids).not.toBeNull();
    childPid = pids!.childPid;
    const parentPid = pids!.parentPid;

    const stateFile = path.join(stateDirPath, `${slug}.json`);
    const lockFile = path.join(stateDirPath, `${slug}.lock`);

    // Preconditions: lock held, state seeded, both processes alive.
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(pidAlive(parentPid)).toBe(true);
    expect(groupAlive(childPid)).toBe(true);

    // Interrupt the orchestrator harness.
    process.kill(parentPid, "SIGTERM");

    // Wait (bounded) for the harness to exit. Site 2's cleanup runs here.
    const exitDeadline = Date.now() + 8000;
    while (Date.now() < exitDeadline && pidAlive(parentPid)) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Invariant (1): graceful cleanup happened — state file present, lock gone.
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);

    // Invariant (2 — the C1 gap): the SIGTERM-ignoring grandchild GROUP must
    // be dead within a bounded window because Site 1's `wait 2s -> SIGKILL`
    // escalation reached it. Today it survives: Site 2's synchronous
    // `process.exit(130)` pre-empts the 2s grace, so the SIGKILL never fires
    // and the group is orphaned to init. Bound the wait generously past the
    // 2000ms hardcoded grace (escalation + delivery).
    const childDeadline = Date.now() + 6000;
    while (Date.now() < childDeadline && groupAlive(childPid)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(groupAlive(childPid)).toBe(false);
  });
});
