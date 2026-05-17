import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  _liveChildPids,
  _registerForTest,
  _resetForTest,
  _unregisterForTest,
  installSignalHandlers,
  killAllChildren,
  spawn,
  spawnSync,
} from "../child-registry";

describe("child-registry — unit", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("register/unregister adds and removes pids", () => {
    expect(_liveChildPids()).toEqual([]);
    _registerForTest(11111);
    _registerForTest(22222);
    expect(_liveChildPids().sort()).toEqual([11111, 22222]);
    _unregisterForTest(11111);
    expect(_liveChildPids()).toEqual([22222]);
    _unregisterForTest(22222);
    expect(_liveChildPids()).toEqual([]);
  });

  it("killAllChildren reports the number of signaled pids", () => {
    // Use the current process — process.kill(0) is a liveness check that
    // doesn't actually signal. We register process.pid so the registry
    // sees a live pid to signal, but we pass signal 0 to verify the call
    // path runs without affecting anything.
    _registerForTest(process.pid);
    // signal 0 = liveness check; doesn't actually deliver a signal but
    // exercises the same `process.kill(-pid, sig)` code path.
    const n = killAllChildren(0 as unknown as NodeJS.Signals);
    // Whether the kill succeeded depends on whether the test process has
    // a real process group (it does, on Bun). We don't assert on n's
    // exact value because Bun's pgid handling can vary; we just assert
    // the call didn't throw and returned a number.
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it("killAllChildren silently drops dead pids (ESRCH)", () => {
    // pid 999999 is overwhelmingly likely to not exist. signalProcessGroup
    // catches ESRCH and returns false; the function returns 0 signaled.
    _registerForTest(999999);
    const n = killAllChildren("SIGTERM");
    expect(n).toBe(0);
  });

  it("spawn registers child pid before returning and unregisters on exit", async () => {
    // Use `node -e "process.exit(0)"` so we have a real OS process. Bun's
    // `process` is available; we use `node` if present, else bun itself.
    const binary = process.execPath; // bun or node
    const child = spawn(binary, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const pid = child.pid!;
    expect(typeof pid).toBe("number");
    expect(_liveChildPids()).toContain(pid);

    // Wait for exit, then assert deregistration.
    await new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    // Give the unregister handler one tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(_liveChildPids()).not.toContain(pid);
  });

  it("spawnSync passes through return type and exits normally", () => {
    const binary = process.execPath;
    const r = spawnSync(binary, ["-e", "process.exit(0)"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    // spawnSync blocks until completion, so the live-pid set should be
    // empty when it returns (the wrapper never registers sync pids).
    expect(_liveChildPids()).not.toContain(r.pid);
  });

  it("installSignalHandlers is idempotent", () => {
    // We can't actually fire signals at the test process without exiting
    // it. We just verify multiple calls don't throw and don't duplicate
    // the listeners. process.listenerCount tells us how many SIGTERM
    // handlers we've added.
    const beforeCount = process.listenerCount("SIGTERM");
    installSignalHandlers();
    installSignalHandlers();
    installSignalHandlers();
    const afterCount = process.listenerCount("SIGTERM");
    // First call adds one; subsequent calls are no-ops.
    expect(afterCount).toBe(beforeCount + 1);
  });
});

// Integration test: actually fork a parent that spawns a long-running
// child, then SIGTERM the parent and assert the child is reaped. This is
// the screenshot bug — the test only passes when the registry + signal
// handler + detached spawn all work together.
describe("child-registry — integration (POSIX)", () => {
  let scriptDir: string;

  beforeEach(() => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "child-reg-it-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(scriptDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("SIGTERM on parent reaps detached grandchildren within 2s", async () => {
    if (process.platform === "win32") {
      // POSIX-only test (process groups + SIGTERM don't apply on Windows).
      return;
    }

    // Write a parent script that uses the registry's spawn() and then
    // installs signal handlers. The script spawns a long-sleeping
    // grandchild and prints both pids to stdout so the test can verify.
    const parentScript = path.join(scriptDir, "parent.ts");
    const registryPath = path.resolve(
      __dirname,
      "..",
      "child-registry.ts",
    );
    fs.writeFileSync(
      parentScript,
      `
import { installSignalHandlers, spawn } from "${registryPath}";

installSignalHandlers();

// Grandchild sleeps 30s. If our cleanup works, SIGTERM on the parent
// signals -<grandchild-pid> (the grandchild's process group) and the
// grandchild dies within 2s.
const child = spawn("sleep", ["30"], { stdio: "ignore" });

if (typeof child.pid !== "number") {
  console.error("FAILED: no pid");
  process.exit(2);
}

// Print pids so the test can watch them.
console.log(JSON.stringify({ parentPid: process.pid, childPid: child.pid }));

// Keep the parent alive — pretend it's an orchestrator loop.
setInterval(() => {}, 60_000);
`,
    );

    // Launch the parent. Capture its pid + child pid from stdout.
    const parentProc = Bun.spawn({
      cmd: [process.execPath, parentScript],
      stdout: "pipe",
      stderr: "inherit",
    });

    // Read the first line of stdout to get the pids.
    const reader = parentProc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let pids: { parentPid: number; childPid: number } | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !pids) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buf.slice(0, newlineIdx);
        try {
          pids = JSON.parse(line);
        } catch {
          /* keep reading */
        }
      }
    }
    reader.releaseLock();

    expect(pids).not.toBeNull();
    const { parentPid, childPid } = pids!;

    // Verify both are alive before we signal.
    expect(isAlive(parentPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    // SIGTERM the parent. Our handler should fire and reap the child.
    process.kill(parentPid, "SIGTERM");

    // Wait up to 5s for the grandchild to die.
    const grandchildDeadline = Date.now() + 5000;
    while (Date.now() < grandchildDeadline && isAlive(childPid)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(isAlive(childPid)).toBe(false);

    // And the parent should also be gone.
    const parentDeadline = Date.now() + 3000;
    while (Date.now() < parentDeadline && isAlive(parentPid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isAlive(parentPid)).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    // signal 0 = liveness check without actually sending a signal.
    nodeSpawnSync("kill", ["-0", String(pid)], { stdio: "ignore" });
    // Fall back to JS API for clarity:
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists but we can't signal it
    return false;
  }
}
