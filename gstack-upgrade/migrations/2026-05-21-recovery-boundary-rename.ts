/**
 * Migration: 2026-05-21-recovery-boundary-rename
 *
 * Removes entries from learned-patterns.json whose category matches the
 * old manual-recovery naming conventions (promoted from the same noise
 * source per PR8). Appends a one-line note to migration-notes.md.
 *
 * Idempotent: skips entirely if the .done marker exists.
 * Crash-safe: writes are atomic (tmp+rename).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function gstackHome(): string {
  return process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
}

function skillFaultsDir(): string {
  return path.join(gstackHome(), "skill-faults");
}

function markerPath(): string {
  return path.join(skillFaultsDir(), ".migrations", "2026-05-21-recovery-boundary-rename.done");
}

function learnedPatternsPath(): string {
  return path.join(skillFaultsDir(), "learned-patterns.json");
}

function migrationNotesPath(): string {
  return path.join(skillFaultsDir(), "migration-notes.md");
}

const SCRUBBED_CATEGORY_RE = /^manual[-_]?recovery|^manual[-_]?phase[-_]?commit/;

interface LearnedPattern {
  patternId: string;
  category: string;
  hitCount?: number;
  lastHit?: string;
  [key: string]: unknown;
}

export async function runMigration(): Promise<void> {
  const marker = markerPath();
  if (fs.existsSync(marker)) {
    return;
  }

  const lpPath = learnedPatternsPath();
  if (!fs.existsSync(lpPath)) {
    // Fresh install: nothing to migrate. Write marker and exit.
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "");
    return;
  }

  let entries: LearnedPattern[];
  try {
    entries = JSON.parse(fs.readFileSync(lpPath, "utf8")) as LearnedPattern[];
  } catch {
    // If the file is unreadable, don't crash — leave it for human inspection.
    // Do NOT write the marker so a future run can retry.
    throw new Error(
      `Migration 2026-05-21-recovery-boundary-rename: learned-patterns.json at ${lpPath} is unreadable. Fix the file and re-run.`
    );
  }

  if (!Array.isArray(entries)) {
    throw new Error(
      `Migration 2026-05-21-recovery-boundary-rename: learned-patterns.json is not an array.`
    );
  }

  const removed: string[] = [];
  const kept: LearnedPattern[] = [];

  for (const entry of entries) {
    if (SCRUBBED_CATEGORY_RE.test(entry.category ?? "")) {
      removed.push(entry.patternId ?? entry.category ?? "unknown");
    } else {
      kept.push(entry);
    }
  }

  // Atomic write-back only if something changed.
  if (removed.length > 0) {
    const tmp = `${lpPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2) + "\n");
    fs.renameSync(tmp, lpPath);
  }

  // Append one-line note if we removed anything.
  if (removed.length > 0) {
    const notesDir = path.dirname(migrationNotesPath());
    fs.mkdirSync(notesDir, { recursive: true });
    const noteLine = `2026-05-21: removed ${removed.length} manual-recovery pattern(s) (${removed.join(", ")}) as part of RECOVERY_BOUNDARY rename — these were recovery-boundary events, not faults.\n`;
    fs.appendFileSync(migrationNotesPath(), noteLine);
  }

  // Write marker last, after all mutations succeeded.
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "");
}

// Allow direct execution via `bun .../2026-05-21-recovery-boundary-rename.ts`
if (import.meta.main) {
  runMigration().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
