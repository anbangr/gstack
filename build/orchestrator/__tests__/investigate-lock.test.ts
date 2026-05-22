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
      acquiredAt: new Date().toISOString(),
    };
    expect(() => releaseFaultLock(handle)).not.toThrow();
  });
});

describe("isLockStale", () => {
  test("returns true when acquiredAt older than maxAgeMs", () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(isLockStale({ pid: 1, acquiredAt: old }, Date.now(), 60 * 60 * 1000)).toBe(true);
  });

  test("returns false when acquiredAt is fresh", () => {
    const fresh = new Date().toISOString();
    expect(isLockStale({ pid: 1, acquiredAt: fresh }, Date.now(), 60 * 60 * 1000)).toBe(false);
  });
});
