import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FaultLockPayload {
  pid: number;
  acquiredAt: string;
}

export interface FaultLockHandle {
  lockPath: string;
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
      // Lock file already exists — read it and decide.
      let existing: FaultLockPayload | null = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        existing = null;
      }
      if (existing && !isLockStale(existing, Date.now(), maxAgeMs)) {
        return null;
      }
      // Stale or corrupt — reclaim and retry.
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr: any) {
        if (unlinkErr.code !== "ENOENT") throw unlinkErr;
      }
      continue;
    }

    // Exclusive create succeeded — write payload and close.
    const payload: FaultLockPayload = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      fs.writeSync(fd, JSON.stringify(payload));
    } finally {
      fs.closeSync(fd);
    }
    return { lockPath };
  }

  return null;
}

export function releaseFaultLock(handle: FaultLockHandle): void {
  try {
    fs.unlinkSync(handle.lockPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    throw err;
  }
}
