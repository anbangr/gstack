/**
 * Regression tests for two gstack-build orphaning-class root causes found
 * investigating the polis-mesh reputation-ema-decay runs (2026-05-29):
 *
 *   RC1 — A transient git-fetch network error at feature-start (e.g.
 *         "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to
 *         github.com:443") was turned into a HARD feature failure with no
 *         retry. One TLS blip killed Feature 2 of a 6-feature dependency
 *         chain. Fix: gitFetchWithRetry() retries transient network errors
 *         with backoff before failing; non-transient errors fail fast.
 *
 *   RC3 — `--single-branch` reached args.singleBranch (live behavior correct)
 *         but was never persisted into state.launch. Monitor / investigator /
 *         halt-event tools read STATE, not args, so they misclassified
 *         single-branch runs as multi-branch "re-points each feature to
 *         origin" — the source of the misdiagnosis in the bug report. Fix:
 *         BuildLaunchOptions (types.ts) declares singleBranch and
 *         buildLaunchOptions() (cli.ts) persists args.singleBranch.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isTransientGitNetworkError, gitFetchWithRetry } from "../cli";

const cliSource = fs.readFileSync(
  path.resolve(import.meta.dir, "../cli.ts"),
  "utf-8",
);
const typesSource = fs.readFileSync(
  path.resolve(import.meta.dir, "../types.ts"),
  "utf-8",
);

describe("RC1 — transient git-fetch network errors are classified", () => {
  it("treats real transient network failures as retryable", () => {
    const transient = [
      "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
      "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
      "ssh: connect to host github.com port 22: Connection refused",
      "fatal: unable to access '...': Failed to connect to github.com port 443: Connection timed out",
      "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
      "fatal: the remote end hung up unexpectedly\nfatal: early EOF",
      "The requested URL returned error: 503",
    ];
    for (const e of transient) {
      expect(isTransientGitNetworkError(e), e).toBe(true);
    }
  });

  it("does NOT retry real, non-transient git errors", () => {
    const permanent = [
      "fatal: Authentication failed for 'https://github.com/x/y.git/'",
      "fatal: couldn't find remote ref refs/heads/nope",
      "fatal: not a git repository (or any of the parent directories): .git",
      "error: pathspec 'main' did not match any file(s) known to git",
      // Git wraps auth/permission HTTP failures in the same "unable to access"
      // prefix as transient ones. These must NOT retry — the regex deliberately
      // omits a bare "unable to access" alternative so 401/403 fail fast.
      "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403",
      "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 401",
      "", // empty stderr must not be treated as transient
    ];
    for (const e of permanent) {
      expect(isTransientGitNetworkError(e), e).toBe(false);
    }
  });

  it("still retries transient HTTP failures even though they share the 'unable to access' prefix", () => {
    // The fix drops the bare prefix; genuine transient cases keep their own
    // explicit reason, so these must still classify as transient.
    const transientUnderPrefix = [
      "fatal: unable to access 'https://x/': Could not resolve host: github.com",
      "fatal: unable to access 'https://x/': Failed to connect to github.com port 443: Connection timed out",
      "fatal: unable to access 'https://x/': The requested URL returned error: 503",
    ];
    for (const e of transientUnderPrefix) {
      expect(isTransientGitNetworkError(e), e).toBe(true);
    }
  });
});

describe("RC1 — gitFetchWithRetry loop behavior", () => {
  const transientErr = {
    status: 128,
    stdout: "",
    stderr: "SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
  };
  const ok = { status: 0, stdout: "", stderr: "" };

  it("retries a transient failure then succeeds within attempts", () => {
    let calls = 0;
    const slept: number[] = [];
    const res = gitFetchWithRetry("/tmp", ["fetch", "origin"], {
      attempts: 3,
      sleepMs: (ms) => slept.push(ms),
      runFetch: () => (++calls < 3 ? transientErr : ok),
    });
    expect(res.status).toBe(0);
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(slept).toEqual([1000, 2000]); // exponential backoff between retries
  });

  it("gives up after `attempts` on a persistent transient failure", () => {
    let calls = 0;
    const res = gitFetchWithRetry("/tmp", ["fetch", "origin"], {
      attempts: 3,
      sleepMs: () => {},
      runFetch: () => {
        calls += 1;
        return transientErr;
      },
    });
    expect(res.status).toBe(128); // returns the last failure for downstream handling
    expect(calls).toBe(3);
  });

  it("fails fast (no retry) on a non-transient error", () => {
    let calls = 0;
    const authErr = {
      status: 128,
      stdout: "",
      stderr: "fatal: Authentication failed",
    };
    const res = gitFetchWithRetry("/tmp", ["fetch", "origin"], {
      attempts: 5,
      sleepMs: () => {},
      runFetch: () => {
        calls += 1;
        return authErr;
      },
    });
    expect(res.status).toBe(128);
    expect(calls).toBe(1); // no retries for a permanent error
  });

  it("does not retry on first-try success", () => {
    let calls = 0;
    const res = gitFetchWithRetry("/tmp", ["fetch", "origin"], {
      sleepMs: () => {
        throw new Error("must not sleep on success");
      },
      runFetch: () => {
        calls += 1;
        return ok;
      },
    });
    expect(res.status).toBe(0);
    expect(calls).toBe(1);
  });

  it("default runFetch surfaces spawnSync .error so a spawn failure is not an empty message", () => {
    // Finding #2 from adversarial review: when git can't be launched (ENOENT /
    // killed), spawnSync returns status:null + empty stderr with the cause on
    // .error. The helper must turn that into a non-empty stderr so downstream
    // builds a real "failed to fetch" message, not "...: ". Exercise the
    // DEFAULT runFetch (no injected runFetch) by pointing at a git binary that
    // does not exist.
    const realGitBin = process.env.GIT_BIN;
    const realPath = process.env.PATH;
    try {
      // Force `git` to be unresolvable so spawnSync sets .error (ENOENT).
      process.env.PATH = "/nonexistent-dir-for-gstack-test";
      process.env.GIT_BIN = "/nonexistent/git-binary-xyz";
      const res = gitFetchWithRetry("/tmp", ["fetch", "origin"], {
        attempts: 1,
        sleepMs: () => {},
      });
      expect(res.status).not.toBe(0);
      // The key assertion: stderr is NON-empty even though the process never ran.
      expect(res.stderr.length).toBeGreaterThan(0);
    } finally {
      if (realGitBin === undefined) delete process.env.GIT_BIN;
      else process.env.GIT_BIN = realGitBin;
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
    }
  });
});

describe("RC1 — feature/ship-boundary fetches route through the retry helper", () => {
  it("ensureFeatureBranch fetches origin via gitFetchWithRetry, not bare spawnSync", () => {
    // The confirmed failure site. A bare `spawnSync("git", ["fetch", ...])`
    // reintroduces the no-retry data-loss bug.
    expect(cliSource).toMatch(
      /const fetchBase = gitFetchWithRetry\(args\.cwd, \["fetch", "origin", base\]\)/,
    );
    expect(cliSource).not.toMatch(
      /spawnSync\("git", \["fetch", "origin", base\]/,
    );
  });

  it("syncLandedBase / syncFeatureBranchWithBase fetch via the retry helper", () => {
    expect(cliSource).toMatch(
      /const fetch = gitFetchWithRetry\(cwd, \["fetch", "origin"\]\)/,
    );
    // The bare `spawnSync("git", ["fetch", "origin"], { cwd ...})` form in
    // those two functions must be gone.
    expect(cliSource).not.toMatch(
      /const fetch = spawnSync\("git", \["fetch", "origin"\], \{\s*cwd,/,
    );
  });
});

describe("RC3 — singleBranch is persisted into launch state", () => {
  it("BuildLaunchOptions (types.ts) declares singleBranch", () => {
    const iface = typesSource.match(
      /export interface BuildLaunchOptions \{[\s\S]*?\n\}/,
    );
    expect(iface).not.toBeNull();
    expect(iface![0]).toMatch(/singleBranch\?:\s*boolean/);
  });

  it("buildLaunchOptions() copies args.singleBranch into the persisted object", () => {
    const fn = cliSource.match(/function buildLaunchOptions\([\s\S]*?\n\}\n/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/singleBranch:\s*args\.singleBranch/);
  });
});
