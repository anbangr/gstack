#!/usr/bin/env bun
/**
 * One-shot legacy halt-event snapshot backfill.
 *
 * Before this PR, wrap-console.ts hard-coded `snapshot: { stdoutTail: "" }`
 * on every emit. Rows already on disk in ~/.gstack/skill-faults/
 * {pending-investigations,processed}/ from before the fix carry empty
 * stdoutTail, so the codex investigator runs with no log context.
 *
 * This script walks both queue dirs, and for each HaltEvent row whose
 * `snapshot.stdoutTail` is empty AND whose `pointers.stdoutLog` points to
 * an existing file, reads the last 200 lines of that log and writes them
 * into the row. Atomic tmp+rename per file. Idempotent: rows with
 * non-empty stdoutTail are left alone.
 *
 * RESOLVED-shape rows (those with `event: "SKILL_FAULT_RESOLVED"`) have
 * no snapshot field — they get skipped silently.
 *
 * Run from anywhere; reads GSTACK_HOME env (defaults to ~/.gstack).
 * Best-effort only — failures on individual rows print a stderr warn and
 * continue. Exit code is always 0 unless a top-level setup error occurs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STDOUT_TAIL_LINES = 200;

function tail(logPath: string): string {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.split("\n");
    return lines
      .slice(Math.max(0, lines.length - STDOUT_TAIL_LINES))
      .join("\n");
  } catch {
    return "";
  }
}

function backfillDir(dir: string): { scanned: number; backfilled: number } {
  let scanned = 0;
  let backfilled = 0;
  if (!fs.existsSync(dir)) return { scanned, backfilled };
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    scanned += 1;
    const fullPath = path.join(dir, name);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      process.stderr.write(
        `[backfill] skip malformed ${name}: ${(err as Error).message}\n`,
      );
      continue;
    }
    // RESOLVED-shape: no snapshot field. Skip.
    if (parsed.event === "SKILL_FAULT_RESOLVED") continue;
    const snapshot = (parsed.snapshot ?? {}) as { stdoutTail?: string };
    const pointers = (parsed.pointers ?? {}) as { stdoutLog?: string };
    const existing = snapshot.stdoutTail ?? "";
    if (existing !== "") continue; // idempotent
    const logPath = pointers.stdoutLog ?? "";
    if (!logPath) continue;
    if (!fs.existsSync(logPath)) continue;
    const newTail = tail(logPath);
    if (newTail === "") continue;
    parsed.snapshot = { ...snapshot, stdoutTail: newTail };
    const tmpPath = `${fullPath}.backfill.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmpPath, fullPath);
      backfilled += 1;
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      process.stderr.write(
        `[backfill] failed to rewrite ${name}: ${(err as Error).message}\n`,
      );
    }
  }
  return { scanned, backfilled };
}

function main(): void {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  const skillFaults = path.join(home, "skill-faults");
  const pending = path.join(skillFaults, "pending-investigations");
  const processed = path.join(skillFaults, "processed");
  const a = backfillDir(pending);
  const b = backfillDir(processed);
  process.stderr.write(
    `[backfill] pending: ${a.backfilled}/${a.scanned} backfilled\n`,
  );
  process.stderr.write(
    `[backfill] processed: ${b.backfilled}/${b.scanned} backfilled\n`,
  );
}

main();
