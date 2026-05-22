import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FaultLockPayload {
  pid: number;
  acquiredAt: string;
}

export interface FaultLockHandle {
  lockPath: string;
  acquiredAt: string;
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
  const acquiredAt = new Date().toISOString();
  const payload: FaultLockPayload = { pid: process.pid, acquiredAt };

  if (fs.existsSync(lockPath)) {
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
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  const tmpPath = `${lockPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmpPath, lockPath);
  return { lockPath, acquiredAt };
}

export function releaseFaultLock(handle: FaultLockHandle): void {
  try {
    fs.unlinkSync(handle.lockPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    throw err;
  }
}
