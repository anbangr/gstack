/**
 * Tests for PR8 Phase 2 — recovery-boundary migration script.
 *
 * T6:  Migration scrubs 4 manual-recovery patterns from learned-patterns.json.
 * T7:  migration-notes.md is appended with a dated, single-line explanation.
 * T8:  Running the migration twice is idempotent (no duplicate note, no re-removal).
 * T11: Migration auto-runs via the upgrade pipeline and registers as applied.
 * T12: Re-running skips when the applied-migrations marker exists.
 *
 * Edge cases:
 *   - manual-recovery-other matches the regex (accepted false positive).
 *   - Fresh install with no learned-patterns.json → clean no-op exit.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The migration module under test.  It does not exist until the
// primary-impl role creates it, so these tests start red (TDD).
const MIGRATION_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "gstack-upgrade",
  "migrations",
  "2026-05-21-recovery-boundary-rename.ts",
);

describe("recovery-boundary migration", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let skillFaults: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "rb-mig-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmpHome;
    skillFaults = path.join(tmpHome, "skill-faults");
    fs.mkdirSync(skillFaults, { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeLearnedPatterns(entries: unknown[]): void {
    fs.writeFileSync(
      path.join(skillFaults, "learned-patterns.json"),
      JSON.stringify(entries, null, 2),
    );
  }

  function readLearnedPatterns(): unknown[] {
    const p = path.join(skillFaults, "learned-patterns.json");
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8")) as unknown[];
  }

  function readMigrationNotes(): string {
    const p = path.join(skillFaults, "migration-notes.md");
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  }

  test("T6: scrubs 4 manual-recovery patterns, leaves others untouched", async () => {
    // The module may not exist yet — dynamic import lets us fail gracefully
    // with a clear message instead of a static TS compile error.
    const mod = await import(MIGRATION_PATH);
    expect(mod.runMigration).toBeDefined();

    writeLearnedPatterns([
      { patternId: "p1", category: "manual-recovery", hitCount: 5, lastHit: "2026-05-20T00:00:00Z" },
      { patternId: "p2", category: "manual_recovery", hitCount: 3, lastHit: "2026-05-20T00:00:00Z" },
      { patternId: "p3", category: "manual-phase-commit", hitCount: 2, lastHit: "2026-05-20T00:00:00Z" },
      { patternId: "p4", category: "manual_phase_commit", hitCount: 1, lastHit: "2026-05-20T00:00:00Z" },
      { patternId: "p5", category: "provider-timeout", hitCount: 10, lastHit: "2026-05-20T00:00:00Z" },
      { patternId: "p6", category: "gemini-stall", hitCount: 7, lastHit: "2026-05-20T00:00:00Z" },
    ]);

    await mod.runMigration();

    const remaining = readLearnedPatterns();
    const ids = remaining.map((e: any) => e.patternId);
    expect(ids).toEqual(["p5", "p6"]);
  });

  test("T7: appends a single-line dated note to migration-notes.md", async () => {
    const mod = await import(MIGRATION_PATH);
    writeLearnedPatterns([
      { patternId: "p1", category: "manual-recovery", hitCount: 5, lastHit: "2026-05-20T00:00:00Z" },
    ]);

    await mod.runMigration();

    const notes = readMigrationNotes();
    expect(notes).toContain("2026-05-21");
    expect(notes).toContain("manual-recovery");
    expect(notes.split("\n").filter((l) => l.trim() !== "").length).toBe(1);
  });

  test("T8: idempotent — second run makes no changes and adds no duplicate line", async () => {
    const mod = await import(MIGRATION_PATH);
    writeLearnedPatterns([
      { patternId: "p1", category: "manual-recovery", hitCount: 5, lastHit: "2026-05-20T00:00:00Z" },
    ]);

    await mod.runMigration();
    const firstPatterns = readLearnedPatterns();
    const firstNotes = readMigrationNotes();

    await mod.runMigration();
    const secondPatterns = readLearnedPatterns();
    const secondNotes = readMigrationNotes();

    expect(secondPatterns).toEqual(firstPatterns);
    expect(secondNotes).toBe(firstNotes);
  });

  test("T11: auto-run registers applied-migrations marker", async () => {
    const mod = await import(MIGRATION_PATH);
    writeLearnedPatterns([
      { patternId: "p1", category: "manual-recovery", hitCount: 1, lastHit: "2026-05-20T00:00:00Z" },
    ]);

    await mod.runMigration();

    const marker = path.join(skillFaults, ".migrations", "2026-05-21-recovery-boundary-rename.done");
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("T12: already-applied marker causes skip on re-run", async () => {
    const mod = await import(MIGRATION_PATH);
    writeLearnedPatterns([
      { patternId: "p1", category: "manual-recovery", hitCount: 1, lastHit: "2026-05-20T00:00:00Z" },
    ]);

    // Pre-create the marker to simulate a previous run.
    const markerDir = path.join(skillFaults, ".migrations");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, "2026-05-21-recovery-boundary-rename.done"),
      "",
    );

    await mod.runMigration();

    // Patterns should NOT have been touched because the migration skipped.
    const remaining = readLearnedPatterns();
    expect(remaining.length).toBe(1);
    expect((remaining[0] as any).patternId).toBe("p1");
  });

  test("edge: manual-recovery-other is caught by regex (accepted false positive)", async () => {
    const mod = await import(MIGRATION_PATH);
    writeLearnedPatterns([
      { patternId: "p-other", category: "manual-recovery-other", hitCount: 1, lastHit: "2026-05-20T00:00:00Z" },
    ]);

    await mod.runMigration();

    const remaining = readLearnedPatterns();
    expect(remaining.length).toBe(0);
  });

  test("edge: fresh install with no learned-patterns.json exits cleanly", async () => {
    const mod = await import(MIGRATION_PATH);
    // Ensure the file does not exist.
    const lp = path.join(skillFaults, "learned-patterns.json");
    if (fs.existsSync(lp)) fs.unlinkSync(lp);

    await expect(mod.runMigration()).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(skillFaults, "migration-notes.md"))).toBe(false);
  });
});
