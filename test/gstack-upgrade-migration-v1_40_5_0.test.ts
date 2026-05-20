/**
 * Unit tests for gstack-upgrade/migrations/v1.40.5.0.sh — legacy
 * MANUAL_RECOVERY_INVOKED rows flagged as audit-only (investigate:false).
 *
 * Test matrix (T9-T16 in the plan):
 *   T9:  legacy MANUAL_RECOVERY_INVOKED row in pending/ → investigate:false added
 *   T10: legacy row in processed/                       → investigate:false added
 *   T11: row with investigate already set               → untouched
 *   T12: idempotent re-run                              → no-op (no rewrites)
 *   T13: malformed JSON row                             → skipped with warn, others migrated
 *   T14: fresh install (no skill-faults dir)            → no-op + marker written
 *   T15: mid-flight crash resume (re-run after partial) → completes safely + idempotent
 *   T16: non-MANUAL_RECOVERY_INVOKED row                → untouched
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const MIGRATION = join(
  import.meta.dir,
  "..",
  "gstack-upgrade",
  "migrations",
  "v1.40.5.0.sh",
);

interface MigEnv {
  tmp: string;
  gstackHome: string;
  skillFaults: string;
  pending: string;
  processed: string;
  doneMarker: string;
  cleanup: () => void;
}

function makeEnv(opts: { createSkillFaults?: boolean } = {}): MigEnv {
  const tmp = mkdtempSync(join(tmpdir(), "mig-v1405-"));
  const gstackHome = join(tmp, ".gstack");
  const skillFaults = join(gstackHome, "skill-faults");
  const pending = join(skillFaults, "pending-investigations");
  const processed = join(skillFaults, "processed");
  const doneMarker = join(skillFaults, ".migrations", "v1.40.5.0.done");

  mkdirSync(gstackHome, { recursive: true });
  if (opts.createSkillFaults !== false) {
    mkdirSync(pending, { recursive: true });
    mkdirSync(processed, { recursive: true });
  }

  return {
    tmp,
    gstackHome,
    skillFaults,
    pending,
    processed,
    doneMarker,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function runMigration(env: MigEnv): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const res = spawnSync("bash", [MIGRATION], {
    env: {
      ...process.env,
      GSTACK_HOME: env.gstackHome,
      HOME: env.tmp,
    },
    encoding: "utf8",
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? 0,
  };
}

function writeLegacyRow(
  dir: string,
  faultId: string,
  fields: Record<string, unknown>,
): string {
  const filename = `drain-faults-${faultId}.json`;
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(fields, null, 2));
  return path;
}

const baseLegacyRow = (faultId: string) => ({
  faultId,
  runId: "drain-faults",
  stateSlug: "drain-faults-no-plan",
  kind: "MANUAL_RECOVERY_INVOKED",
  severity: "HIGH",
  timestamp: "2026-05-19T00:00:00.000Z",
  message: "drain-faults subcommand invoked (queue)",
  pointers: {
    stateFile: "",
    stdoutLog: "",
    livingPlan: "",
    worktreePath: "/tmp",
  },
  snapshot: { stdoutTail: "" },
});

describe("migration v1.40.5.0 — flag legacy MANUAL_RECOVERY_INVOKED rows as audit-only", () => {
  it("T9: legacy row in pending-investigations/ gets investigate:false", () => {
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:t9";
      const path = writeLegacyRow(env.pending, faultId, baseLegacyRow(faultId));

      runMigration(env);

      const updated = JSON.parse(readFileSync(path, "utf8"));
      expect(updated.investigate).toBe(false);
      expect(updated.kind).toBe("MANUAL_RECOVERY_INVOKED");
      expect(updated.faultId).toBe(faultId);
      expect(existsSync(env.doneMarker)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("T10: legacy row in processed/ also gets investigate:false", () => {
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:t10";
      const path = writeLegacyRow(env.processed, faultId, baseLegacyRow(faultId));

      runMigration(env);

      const updated = JSON.parse(readFileSync(path, "utf8"));
      expect(updated.investigate).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("T11: row with investigate already set is untouched", () => {
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:t11";
      const row = { ...baseLegacyRow(faultId), investigate: true }; // pre-flagged
      const path = writeLegacyRow(env.pending, faultId, row);

      runMigration(env);

      const updated = JSON.parse(readFileSync(path, "utf8"));
      // investigate stays at original value (true) — migration only adds when absent
      expect(updated.investigate).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("T12: idempotent re-run — second invocation is a no-op", () => {
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:t12";
      writeLegacyRow(env.pending, faultId, baseLegacyRow(faultId));

      const first = runMigration(env);
      expect(existsSync(env.doneMarker)).toBe(true);

      // Re-run: must early-exit on marker before touching any files
      const second = runMigration(env);
      // No new "flagged N legacy" log line on the second run
      expect(second.stderr).not.toContain("flagged");
    } finally {
      env.cleanup();
    }
  });

  it("T13: malformed JSON row is skipped with a warn; other rows still migrated; marker NOT written", () => {
    // Codex H1+H2 hardening: while there are malformed rows, the marker
    // MUST NOT be written. The good rows still get migrated (so progress
    // is real), but the next gstack-upgrade retries to give the user a
    // chance to fix the source of corruption.
    const env = makeEnv();
    try {
      const goodId = "MANUAL_RECOVERY_INVOKED:all:t13-good";
      const goodPath = writeLegacyRow(env.pending, goodId, baseLegacyRow(goodId));
      const badPath = join(env.pending, "drain-faults-broken.json");
      writeFileSync(badPath, "{ this is: not valid json,");

      const result = runMigration(env);

      // Good row was migrated
      const good = JSON.parse(readFileSync(goodPath, "utf8"));
      expect(good.investigate).toBe(false);

      // Migration warned about the bad row but continued
      expect(result.stderr).toContain("malformed");
      expect(result.stderr).toContain("drain-faults-broken.json");

      // Marker NOT written — re-run after fixing the bad row will complete
      expect(existsSync(env.doneMarker)).toBe(false);
      // Exit non-zero so wrapper scripts know to retry
      expect(result.status).not.toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("T14: fresh install (no skill-faults dir) → no-op + marker written", () => {
    const env = makeEnv({ createSkillFaults: false });
    try {
      runMigration(env);
      expect(existsSync(env.doneMarker)).toBe(true);
      // skill-faults dir was created only to hold the marker
      expect(existsSync(env.skillFaults)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("T15: mid-flight crash resume — partial migration completes safely + idempotent", () => {
    const env = makeEnv();
    try {
      // Simulate prior partial run: one row migrated, marker NOT yet written.
      const migratedId = "MANUAL_RECOVERY_INVOKED:all:t15-mig";
      const unmigratedId = "MANUAL_RECOVERY_INVOKED:all:t15-unmig";
      const migrated = writeLegacyRow(env.pending, migratedId, {
        ...baseLegacyRow(migratedId),
        investigate: false, // already flagged from prior interrupted run
      });
      const unmigrated = writeLegacyRow(
        env.pending,
        unmigratedId,
        baseLegacyRow(unmigratedId),
      );

      runMigration(env);

      // Already-migrated row still has investigate:false (untouched)
      const migContent = JSON.parse(readFileSync(migrated, "utf8"));
      expect(migContent.investigate).toBe(false);

      // Unmigrated row gained investigate:false
      const unmigContent = JSON.parse(readFileSync(unmigrated, "utf8"));
      expect(unmigContent.investigate).toBe(false);

      // Marker now written
      expect(existsSync(env.doneMarker)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("T16: non-MANUAL_RECOVERY_INVOKED row is untouched", () => {
    const env = makeEnv();
    try {
      const faultId = "PHASE_FAILED:p3:t16";
      const path = writeLegacyRow(env.pending, faultId, {
        ...baseLegacyRow(faultId),
        kind: "PHASE_FAILED",
        severity: "CRITICAL",
        message: "phase 3 failed",
      });

      runMigration(env);

      const after = JSON.parse(readFileSync(path, "utf8"));
      // No investigate field added — this is a real PHASE_FAILED and must dispatch
      expect(after.investigate).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("H2: per-file write failure prevents the marker from being written", () => {
    // Codex adversarial H2: if any rewrite fails (permissions, disk, race),
    // the marker MUST NOT be written so the next gstack-upgrade retries.
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:h2";
      writeLegacyRow(env.pending, faultId, baseLegacyRow(faultId));

      // Make pending/ read-only so the mv inside the migration fails.
      const fs = require("fs");
      fs.chmodSync(env.pending, 0o500);

      try {
        const result = runMigration(env);

        // Migration exits non-zero on rewrite failure
        expect(result.status).not.toBe(0);
        // Marker MUST NOT be written
        expect(existsSync(env.doneMarker)).toBe(false);
        // Stderr surfaces the failure
        expect(result.stderr).toContain("write failed");
      } finally {
        fs.chmodSync(env.pending, 0o755);
      }
    } finally {
      env.cleanup();
    }
  });

  it("M3: row whose message is NOT a known recovery-sink prefix is left untouched", () => {
    // Codex adversarial M3: a custom MANUAL_RECOVERY_INVOKED row from
    // outside the three production cli sites (e.g., an external tool that
    // emits MANUAL_RECOVERY_INVOKED for genuine investigative purposes)
    // must NOT be silently reclassified as audit-only.
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:m3";
      const customPath = writeLegacyRow(env.pending, faultId, {
        ...baseLegacyRow(faultId),
        message: "custom external recovery — please investigate",
      });

      const result = runMigration(env);
      expect(result.status).toBe(0);

      const after = JSON.parse(readFileSync(customPath, "utf8"));
      // No investigate field added — message gate prevented the rewrite.
      expect(after.investigate).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it("M3 (mark-shipped): message 'mark-shipped subcommand invoked' is flagged", () => {
    // M3 complement: the migration MUST still flag rows from all three
    // production cli sites, identified by their message prefixes.
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:m3-ship";
      const p = writeLegacyRow(env.pending, faultId, {
        ...baseLegacyRow(faultId),
        runId: "mark-shipped",
        message: "mark-shipped subcommand invoked for feature 3 (PR #42)",
      });
      runMigration(env);
      const after = JSON.parse(readFileSync(p, "utf8"));
      expect(after.investigate).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("M3 (mark-phase-committed): message '--mark-phase-committed invoked' is flagged", () => {
    const env = makeEnv();
    try {
      const faultId = "MANUAL_RECOVERY_INVOKED:all:m3-mpc";
      const p = writeLegacyRow(env.pending, faultId, {
        ...baseLegacyRow(faultId),
        runId: "build-something",
        message: "--mark-phase-committed invoked for phase 2.1",
      });
      runMigration(env);
      const after = JSON.parse(readFileSync(p, "utf8"));
      expect(after.investigate).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("malformed-row presence prevents the marker (don't lock out retry while bad rows exist)", () => {
    // Same anti-lockout invariant as H2: as long as there are malformed
    // rows, the marker MUST NOT be written so a future run can retry once
    // the source of corruption is fixed.
    const env = makeEnv();
    try {
      const goodId = "MANUAL_RECOVERY_INVOKED:all:soft-good";
      writeLegacyRow(env.pending, goodId, baseLegacyRow(goodId));
      const badPath = require("path").join(env.pending, "drain-faults-broken.json");
      require("fs").writeFileSync(badPath, "{ not valid json,");

      const result = runMigration(env);

      // Good row migrated, marker NOT written, exit non-zero
      expect(result.status).not.toBe(0);
      expect(existsSync(env.doneMarker)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
