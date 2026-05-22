import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireFaultLock,
  releaseFaultLock,
  isLockStale,
  type FaultLockHandle,
} from "../investigate-lock";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-lock-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireFaultLock", () => {
  test("acquires lock when none exists", () => {
    const handle = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    });
    expect(handle).not.toBeNull();
    expect(handle!.lockPath).toBe(
      path.join(tmpRoot, "run-1", ".CAT:p0:abc123.lock"),
    );
    expect(fs.existsSync(handle!.lockPath)).toBe(true);
  });

  test("returns null when fresh lock already exists", () => {
    const first = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    });
    expect(first).not.toBeNull();
    const second = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    });
    expect(second).toBeNull();
  });

  test("reclaims stale lock older than maxAgeMs", () => {
    const lockPath = path.join(tmpRoot, "run-1", ".CAT:p0:abc123.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const oldPayload = {
      pid: 999999,
      acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(oldPayload));
    const handle = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
      maxAgeMs: 60 * 60 * 1000,
    });
    expect(handle).not.toBeNull();
  });
});

describe("releaseFaultLock", () => {
  test("removes the lockfile", () => {
    const handle = acquireFaultLock({
      runId: "run-1",
      faultId: "CAT:p0:abc123",
      faultsDir: tmpRoot,
    })!;
    releaseFaultLock(handle);
    expect(fs.existsSync(handle.lockPath)).toBe(false);
  });

  test("is idempotent when lockfile already gone", () => {
    const handle: FaultLockHandle = {
      lockPath: path.join(tmpRoot, "nonexistent.lock"),
      nonce: "00000000000000000000000000000000",
    };
    expect(() => releaseFaultLock(handle)).not.toThrow();
  });

  test("refuses to release when on-disk nonce doesn't match handle", () => {
    // Caller A holds the lock with nonce A.
    const handleA = acquireFaultLock({
      runId: "run-N",
      faultId: "CAT:p0:nonce",
      faultsDir: tmpRoot,
    })!;
    // Caller B steals it via stale-reclaim (write a stale payload, then acquire).
    fs.writeFileSync(
      handleA.lockPath,
      JSON.stringify({
        pid: 99999,
        acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        nonce: "stale-nonce-from-an-older-holder",
      }),
    );
    const handleB = acquireFaultLock({
      runId: "run-N",
      faultId: "CAT:p0:nonce",
      faultsDir: tmpRoot,
    })!;
    expect(handleB.nonce).not.toBe(handleA.nonce);
    // A tries to release. Lock file exists but has B's nonce. Release should be a no-op.
    const released = releaseFaultLock(handleA);
    expect(released).toBe(false);
    expect(fs.existsSync(handleA.lockPath)).toBe(true);
    // B can still release its own lock.
    expect(releaseFaultLock(handleB)).toBe(true);
    expect(fs.existsSync(handleA.lockPath)).toBe(false);
  });
});

describe("isLockStale", () => {
  test("returns true when acquiredAt older than maxAgeMs", () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(
      isLockStale(
        { pid: 1, acquiredAt: old, nonce: "n" },
        Date.now(),
        60 * 60 * 1000,
      ),
    ).toBe(true);
  });

  test("returns false when acquiredAt is fresh", () => {
    const fresh = new Date().toISOString();
    expect(
      isLockStale(
        { pid: 1, acquiredAt: fresh, nonce: "n" },
        Date.now(),
        60 * 60 * 1000,
      ),
    ).toBe(false);
  });
});
