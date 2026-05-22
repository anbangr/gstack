import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FaultLockPayload {
  pid: number;
  acquiredAt: string;
  // 16-byte hex nonce written at acquire time. release verifies the on-disk
  // nonce matches the one the caller holds before unlinking. Prevents one
  // investigation's finalize from releasing another investigation's lock
  // when the first one's lock was stale-reclaimed mid-run.
  nonce: string;
}

export interface FaultLockHandle {
  lockPath: string;
  nonce: string;
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

function defaultFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

export function isLockStale(
  payload: FaultLockPayload,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const acquiredMs = Date.parse(payload.acquiredAt);
  if (Number.isNaN(acquiredMs)) return true;
  return nowMs - acquiredMs > maxAgeMs;
}

export function acquireFaultLock(args: {
  runId: string;
  faultId: string;
  faultsDir?: string;
  maxAgeMs?: number;
}): FaultLockHandle | null {
  const faultsDir = args.faultsDir ?? defaultFaultsDir();
  const maxAgeMs = args.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const runDir = path.join(faultsDir, args.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, `.${args.faultId}.lock`);

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      let existing: FaultLockPayload | null = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        existing = null;
      }
      if (existing && !isLockStale(existing, Date.now(), maxAgeMs)) {
        return null;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr: any) {
        if (unlinkErr.code !== "ENOENT") throw unlinkErr;
      }
      continue;
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const payload: FaultLockPayload = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce,
    };
    try {
      fs.writeSync(fd, JSON.stringify(payload));
    } finally {
      fs.closeSync(fd);
    }
    return { lockPath, nonce };
  }

  return null;
}

// Release verifies the on-disk nonce matches the handle's nonce before
// unlinking. If the lock file is missing (ENOENT), that's fine — the caller
// either never held it or another caller already cleaned it up.
// If the file exists but contains a different nonce, ANOTHER investigation
// has taken over this lock slot — DO NOT delete. Return false so the caller
// knows the release was a no-op.
export function releaseFaultLock(handle: FaultLockHandle): boolean {
  let onDisk: FaultLockPayload | null = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(handle.lockPath, "utf8"));
  } catch (err: any) {
    if (err.code === "ENOENT") return true;
    // Corrupt or unreadable lock — best-effort unlink, swallow errors.
    try {
      fs.unlinkSync(handle.lockPath);
    } catch {
      // ignore
    }
    return true;
  }
  if (onDisk && onDisk.nonce !== handle.nonce) {
    // Someone else owns this lock slot now. Leave it alone.
    return false;
  }
  try {
    fs.unlinkSync(handle.lockPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return true;
    throw err;
  }
  return true;
}
