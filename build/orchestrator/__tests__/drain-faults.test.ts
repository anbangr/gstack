/**
 * Tests for the drain-faults helper + CLI subcommand.
 *
 * Coverage targets (from the approved plan, plan-eng-review run on 2026-05-17):
 *
 *   1. Empty log → no spawns, exit 0
 *   2. Single fault → one spawn, one report on disk
 *   3. 78 dupes with same (runId, category) → dedup to 1 spawn
 *   4. Multiple unique (runId, category) pairs → N spawns
 *   5. Malformed JSON line in log → skip, continue
 *   6. Existing report on disk → reportsSkipped++, no spawn
 *   7. Investigator command fails (exit 1) → reportsFailed++, CLI exits 1
 *   8. --dry-run: counts intent, no spawns
 *   9. --catch-all + RUN_FAILED + no faults → discovery spawn (looser trigger per 1B)
 *  10. Missing manifest path → empty result, exit 0 (idempotent recovery)
 *  11. Idempotent re-run: second invocation dedups against first run's reports
 *  12. --build-tmp-dir argument form (per 1D)
 *  13. Sanitize-name compatibility: runId/category with special chars produce
 *      the same filename TS-side as bash `tr -c 'A-Za-z0-9._-' '_'` (per 2B)
 *  14. Defensive monitor-exit-code parse: empty file → corrupt=true, code=null (per 2C)
 *  15. Defensive monitor-exit-code parse: numeric → code parsed, corrupt=false
 *  16. Provider table dispatch: each provider's argv builder produces expected shape (per 2A)
 *  17. Investigator timeout: command sleeps longer than timeout → reportsFailed++
 *  18. parseFaultLog handles event types other than SKILL_FAULT_DETECTED correctly
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  drainFaults,
  parseFaultLog,
  parseMonitorExitCode,
  sanitizeForFilename,
} from "../drain-faults";

// ---------------------------------------------------------------------------
// GSTACK_HOME isolation — drain-faults writes to ${GSTACK_HOME}/skill-faults.
// Per the test-isolation-lint, files that import drain-faults must isolate.
// ---------------------------------------------------------------------------

let tmpDir: string;
let oldGstackHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-faults-test-"));
  oldGstackHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = tmpDir;
});

afterEach(() => {
  if (oldGstackHome !== undefined) process.env.GSTACK_HOME = oldGstackHome;
  else delete process.env.GSTACK_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupBuildTmpDir(): {
  buildTmpDir: string;
  monitorLog: string;
  primaryDir: string;
} {
  const buildTmpDir = path.join(tmpDir, "build-tmp");
  fs.mkdirSync(buildTmpDir, { recursive: true });
  return {
    buildTmpDir,
    monitorLog: path.join(buildTmpDir, "monitor-output.log"),
    primaryDir: path.join(tmpDir, "skill-faults"),
  };
}

function writeLog(monitorLog: string, lines: object[]): void {
  fs.writeFileSync(
    monitorLog,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function faultEvent(
  runId: string,
  category: string,
  description = "test fault",
  sourceFiles: string[] = [],
): object {
  return {
    event: "SKILL_FAULT_DETECTED",
    timestamp: new Date().toISOString(),
    runId,
    stateSlug: `build-${runId}`,
    stateFile: `/tmp/${runId}.json`,
    manifestPath: `/tmp/manifest-${runId}.json`,
    faults: [
      { category, severity: "MEDIUM", description, sourceFiles, evidence: {} },
    ],
  };
}

// A stub investigator that writes a known string to FAULT_PRIMARY.
const STUB_OK = `cat > "$FAULT_PRIMARY" <<EOF
# STUB INVESTIGATION
category=$FAULT_CATEGORY
runId=$FAULT_RUN_ID
EOF
echo "ok"`;

const STUB_FAIL = `exit 1`;

const STUB_SLEEP = `sleep 30; echo "should never get here" > "$FAULT_PRIMARY"`;

// ---------------------------------------------------------------------------
// sanitizeForFilename (per 2B — MUST mirror bash `tr -c 'A-Za-z0-9._-' '_'`)
// ---------------------------------------------------------------------------

describe("sanitizeForFilename", () => {
  test("preserves the bash tr allow-set (alnum, ., _, -)", () => {
    expect(sanitizeForFilename("abc-123_foo.md")).toBe("abc-123_foo.md");
    expect(sanitizeForFilename("ABC")).toBe("ABC");
  });

  test("replaces every other character with underscore", () => {
    expect(sanitizeForFilename("hello world")).toBe("hello_world");
    expect(sanitizeForFilename("path/to/file")).toBe("path_to_file");
    expect(sanitizeForFilename("a!b@c#d$e")).toBe("a_b_c_d_e");
  });

  test("matches what bash tr would produce (cross-path dedup invariant)", () => {
    const input = "agnt2-prototype-bisectiongame@settlement/20260516";
    // What bash `tr -c 'A-Za-z0-9._-' '_'` would emit:
    const bashEquivalent = "agnt2-prototype-bisectiongame_settlement_20260516";
    expect(sanitizeForFilename(input)).toBe(bashEquivalent);
  });
});

// ---------------------------------------------------------------------------
// parseFaultLog
// ---------------------------------------------------------------------------

describe("parseFaultLog", () => {
  test("empty content → no rows, no events", () => {
    const r = parseFaultLog("");
    expect(r.totalEvents).toBe(0);
    expect(r.rows).toHaveLength(0);
    expect(r.hasRunFailed).toBe(false);
  });

  test("dedups 78 same (runId, category) events to 1 row", () => {
    const lines: string[] = [];
    for (let i = 0; i < 78; i++) {
      lines.push(JSON.stringify(faultEvent("run-a", "FOO")));
    }
    const r = parseFaultLog(lines.join("\n"));
    expect(r.totalEvents).toBe(78);
    expect(r.rows).toHaveLength(1);
  });

  test("two unique (runId, category) pairs → 2 rows", () => {
    const lines = [
      JSON.stringify(faultEvent("run-a", "FOO")),
      JSON.stringify(faultEvent("run-b", "BAR")),
    ].join("\n");
    const r = parseFaultLog(lines);
    expect(r.rows).toHaveLength(2);
  });

  test("malformed JSON line is skipped without throwing", () => {
    const lines = [
      JSON.stringify(faultEvent("run-a", "FOO")),
      "{not valid json",
      JSON.stringify(faultEvent("run-b", "BAR")),
    ].join("\n");
    const r = parseFaultLog(lines);
    expect(r.rows).toHaveLength(2);
  });

  test("ignores non-SKILL_FAULT_DETECTED events", () => {
    const lines = [
      JSON.stringify({ event: "RUN_RUNNING", timestamp: "now" }),
      JSON.stringify(faultEvent("run-a", "FOO")),
      JSON.stringify({ event: "RUN_FAILED", runId: "run-a" }),
    ].join("\n");
    const r = parseFaultLog(lines);
    expect(r.rows).toHaveLength(1);
    expect(r.hasRunFailed).toBe(true);
  });

  // Fix for SKILL_FAULT_DETECTED_IS_APPEND_ONLY_TELEMETRY: when a fault is
  // RESOLVED later in the log, drain-faults must NOT spawn an investigator
  // for it. The runId+faultId pair identifies the fault session; a RESOLVED
  // event closes that session.
  test("DETECTED followed by RESOLVED for same (runId, faultId) → drops the DETECTED row", () => {
    const detected = faultEvent("run-a", "FOO");
    // Embed faultId on the DETECTED's fault so drain-faults can match it.
    (detected as any).faults[0].faultId = "FOO:all:*";
    const resolved = {
      event: "SKILL_FAULT_RESOLVED",
      timestamp: new Date().toISOString(),
      runId: "run-a",
      faultId: "FOO:all:*",
      firstDetectedAt: new Date().toISOString(),
      lastDetectedAt: new Date().toISOString(),
    };
    const lines = [JSON.stringify(detected), JSON.stringify(resolved)].join(
      "\n",
    );
    const r = parseFaultLog(lines);
    expect(r.rows).toHaveLength(0);
  });

  test("RESOLVED for a DIFFERENT faultId does NOT drop the DETECTED row", () => {
    const detected = faultEvent("run-a", "FOO");
    (detected as any).faults[0].faultId = "FOO:all:*";
    const resolved = {
      event: "SKILL_FAULT_RESOLVED",
      timestamp: new Date().toISOString(),
      runId: "run-a",
      faultId: "BAR:all:*", // different fault
      firstDetectedAt: new Date().toISOString(),
      lastDetectedAt: new Date().toISOString(),
    };
    const lines = [JSON.stringify(detected), JSON.stringify(resolved)].join(
      "\n",
    );
    const r = parseFaultLog(lines);
    expect(r.rows).toHaveLength(1);
  });

  test("DETECTED → RESOLVED → DETECTED (re-occurrence) keeps the latest DETECTED", () => {
    // Fault transient: appears, resolves, appears again. The second DETECTED
    // is a fresh session and SHOULD trigger an investigator.
    const firstDetected = faultEvent("run-a", "FOO");
    (firstDetected as any).faults[0].faultId = "FOO:all:*";
    const resolved = {
      event: "SKILL_FAULT_RESOLVED",
      timestamp: "2026-05-18T10:00:00.000Z",
      runId: "run-a",
      faultId: "FOO:all:*",
      firstDetectedAt: "2026-05-18T09:55:00.000Z",
      lastDetectedAt: "2026-05-18T09:58:00.000Z",
    };
    const secondDetected = faultEvent("run-a", "FOO");
    (secondDetected as any).timestamp = "2026-05-18T10:30:00.000Z";
    (secondDetected as any).faults[0].faultId = "FOO:all:*";
    const lines = [
      JSON.stringify(firstDetected),
      JSON.stringify(resolved),
      JSON.stringify(secondDetected),
    ].join("\n");
    const r = parseFaultLog(lines);
    expect(r.rows).toHaveLength(1);
  });

  test("RESOLVED only (no DETECTED) → no rows, no errors", () => {
    const resolved = {
      event: "SKILL_FAULT_RESOLVED",
      timestamp: new Date().toISOString(),
      runId: "run-a",
      faultId: "FOO:all:*",
      firstDetectedAt: new Date().toISOString(),
      lastDetectedAt: new Date().toISOString(),
    };
    const r = parseFaultLog(JSON.stringify(resolved));
    expect(r.rows).toHaveLength(0);
  });

  test("backwards-compat: DETECTED without faultId field still dedups by (runId, category)", () => {
    // Pre-fix DETECTED events don't carry faultId. drain-faults must
    // continue handling them (legacy logs in the wild).
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(JSON.stringify(faultEvent("run-a", "FOO")));
    }
    const r = parseFaultLog(lines.join("\n"));
    expect(r.rows).toHaveLength(1); // existing dedup behavior
  });
});

// ---------------------------------------------------------------------------
// parseMonitorExitCode (per 2C defensive parse)
// ---------------------------------------------------------------------------

describe("parseMonitorExitCode", () => {
  test("missing file → code:null, corrupt:false", () => {
    const r = parseMonitorExitCode(path.join(tmpDir, "does-not-exist"));
    expect(r.code).toBeNull();
    expect(r.corrupt).toBe(false);
  });

  test("empty file (1-byte newline — the actual bug shape) → code:null, corrupt:true", () => {
    const p = path.join(tmpDir, "exit-code");
    fs.writeFileSync(p, "\n");
    const r = parseMonitorExitCode(p);
    expect(r.code).toBeNull();
    expect(r.corrupt).toBe(true);
  });

  test("numeric content → code parsed, corrupt:false", () => {
    const p = path.join(tmpDir, "exit-code");
    fs.writeFileSync(p, "20\n");
    const r = parseMonitorExitCode(p);
    expect(r.code).toBe(20);
    expect(r.corrupt).toBe(false);
  });

  test("non-numeric content → code:null, corrupt:true", () => {
    const p = path.join(tmpDir, "exit-code");
    fs.writeFileSync(p, "banana\n");
    const r = parseMonitorExitCode(p);
    expect(r.code).toBeNull();
    expect(r.corrupt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// drainFaults end-to-end (with stub investigator command)
// ---------------------------------------------------------------------------

describe("drainFaults", () => {
  test("missing monitor-output.log → empty result, no spawns, no error", async () => {
    const { buildTmpDir } = setupBuildTmpDir();
    const r = await drainFaults({ buildTmpDir });
    expect(r.logExists).toBe(false);
    expect(r.totalEvents).toBe(0);
    expect(r.reportsSpawned).toBe(0);
    expect(r.reportsFailed).toBe(0);
  });

  test("empty log → no spawns", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    fs.writeFileSync(monitorLog, "");
    const r = await drainFaults({ buildTmpDir });
    expect(r.logExists).toBe(true);
    expect(r.uniqueFaults).toBe(0);
    expect(r.reportsSpawned).toBe(0);
  });

  test("single fault → one report on disk", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    writeLog(monitorLog, [faultEvent("run-a", "FOO")]);
    const r = await drainFaults({
      buildTmpDir,
      investigatorCommand: STUB_OK,
    });
    expect(r.uniqueFaults).toBe(1);
    expect(r.reportsSpawned).toBe(1);
    expect(r.reportsFailed).toBe(0);
    const reportPath = path.join(primaryDir, "skill-fault-run-a-FOO.md");
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toContain("category=FOO");
  });

  test("78 dupes of same (runId, category) → 1 spawn", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    const lines: object[] = [];
    for (let i = 0; i < 78; i++) lines.push(faultEvent("run-a", "FOO"));
    writeLog(monitorLog, lines);
    const r = await drainFaults({ buildTmpDir, investigatorCommand: STUB_OK });
    expect(r.totalEvents).toBe(78);
    expect(r.uniqueFaults).toBe(1);
    expect(r.reportsSpawned).toBe(1);
    expect(
      fs.readdirSync(primaryDir).filter((f) => f.endsWith(".md")),
    ).toHaveLength(1);
  });

  test("multiple unique (runId, category) → N reports", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    writeLog(monitorLog, [
      faultEvent("run-a", "FOO"),
      faultEvent("run-b", "BAR"),
      faultEvent("run-c", "BAZ"),
    ]);
    const r = await drainFaults({ buildTmpDir, investigatorCommand: STUB_OK });
    expect(r.uniqueFaults).toBe(3);
    expect(r.reportsSpawned).toBe(3);
    expect(
      fs.readdirSync(primaryDir).filter((f) => f.endsWith(".md")),
    ).toHaveLength(3);
  });

  test("existing report on disk → skipped, not re-spawned", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    fs.mkdirSync(primaryDir, { recursive: true });
    // Pre-populate the report file
    fs.writeFileSync(
      path.join(primaryDir, "skill-fault-run-a-FOO.md"),
      "# already done",
    );
    writeLog(monitorLog, [faultEvent("run-a", "FOO")]);
    const r = await drainFaults({ buildTmpDir, investigatorCommand: STUB_OK });
    expect(r.reportsSpawned).toBe(0);
    expect(r.reportsSkipped).toBe(1);
    // Pre-existing content must NOT be overwritten
    expect(
      fs.readFileSync(
        path.join(primaryDir, "skill-fault-run-a-FOO.md"),
        "utf-8",
      ),
    ).toBe("# already done");
  });

  test("investigator command exits 1 → reportsFailed++", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    writeLog(monitorLog, [faultEvent("run-a", "FOO")]);
    const r = await drainFaults({
      buildTmpDir,
      investigatorCommand: STUB_FAIL,
    });
    expect(r.uniqueFaults).toBe(1);
    expect(r.reportsSpawned).toBe(0);
    expect(r.reportsFailed).toBe(1);
  });

  test("--dry-run → no spawns, intent counted", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    writeLog(monitorLog, [
      faultEvent("run-a", "FOO"),
      faultEvent("run-b", "BAR"),
    ]);
    const r = await drainFaults({
      buildTmpDir,
      dryRun: true,
      investigatorCommand: STUB_OK,
    });
    expect(r.uniqueFaults).toBe(2);
    // dry-run records intent in reportsSpawned but no files written
    expect(r.reportsSpawned).toBe(2);
    expect(r.reportPaths).toHaveLength(2);
    // No files written
    expect(fs.existsSync(primaryDir)).toBe(true); // dir was created by mkdirSync
    expect(
      fs.readdirSync(primaryDir).filter((f) => f.endsWith(".md")),
    ).toHaveLength(0);
  });

  test("catch-all (looser trigger per 1B): RUN_FAILED + no faults → discovery spawn", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    writeLog(monitorLog, [
      {
        event: "RUN_FAILED",
        timestamp: "t",
        runId: "run-x",
        message: "failed",
      },
    ]);
    const r = await drainFaults({
      buildTmpDir,
      catchAll: true,
      investigatorCommand: STUB_OK,
    });
    expect(r.uniqueFaults).toBe(0);
    expect(r.discoverySpawned).toBe(1);
    const files = fs
      .readdirSync(primaryDir)
      .filter((f) => f.startsWith("skill-fault-discovery-"));
    expect(files).toHaveLength(1);
  });

  test("catch-all is off by default: RUN_FAILED + no faults → no spawn", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    writeLog(monitorLog, [
      { event: "RUN_FAILED", timestamp: "t", runId: "run-x" },
    ]);
    const r = await drainFaults({ buildTmpDir, investigatorCommand: STUB_OK });
    expect(r.discoverySpawned).toBe(0);
  });

  test("idempotent re-run: second invocation skips all faults", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    writeLog(monitorLog, [
      faultEvent("run-a", "FOO"),
      faultEvent("run-b", "BAR"),
    ]);

    const first = await drainFaults({
      buildTmpDir,
      investigatorCommand: STUB_OK,
    });
    expect(first.reportsSpawned).toBe(2);
    expect(first.reportsSkipped).toBe(0);

    const second = await drainFaults({
      buildTmpDir,
      investigatorCommand: STUB_OK,
    });
    expect(second.reportsSpawned).toBe(0);
    expect(second.reportsSkipped).toBe(2);
  });

  test("--build-tmp-dir input form (per 1D): equivalent to --manifest", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    writeLog(monitorLog, [faultEvent("run-a", "FOO")]);

    // Via build-tmp-dir
    const r1 = await drainFaults({
      buildTmpDir,
      investigatorCommand: STUB_OK,
    });
    expect(r1.reportsSpawned).toBe(1);

    // Same dir reachable via manifestPath (the manifest file doesn't need to exist
    // — drain only uses path.dirname() on it)
    const r2 = await drainFaults({
      manifestPath: path.join(buildTmpDir, "build-run-manifest.json"),
      investigatorCommand: STUB_OK,
    });
    expect(r2.reportsSkipped).toBe(1); // dedup against the report from r1
  });

  test("special-character runId/category sanitized identically to bash", async () => {
    const { buildTmpDir, monitorLog, primaryDir } = setupBuildTmpDir();
    // runId with /, @, spaces — none of these survive the sanitizer
    writeLog(monitorLog, [faultEvent("agnt2/test@v1", "CATEGORY WITH SPACES")]);
    const r = await drainFaults({ buildTmpDir, investigatorCommand: STUB_OK });
    expect(r.reportsSpawned).toBe(1);
    const expectedName = "skill-fault-agnt2_test_v1-CATEGORY_WITH_SPACES.md";
    expect(fs.existsSync(path.join(primaryDir, expectedName))).toBe(true);
  });

  test("investigator timeout → kills + counts as failed", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    writeLog(monitorLog, [faultEvent("run-a", "FOO")]);
    const start = Date.now();
    const r = await drainFaults({
      buildTmpDir,
      investigatorCommand: STUB_SLEEP, // sleeps 30s, timeout will kill at 1s
      investigatorTimeoutMs: 1000,
    });
    const elapsed = Date.now() - start;
    expect(r.reportsFailed).toBe(1);
    expect(r.reportsSpawned).toBe(0);
    expect(elapsed).toBeLessThan(5000); // killed well before sleep finishes
  });

  test("monitor-exit-code corruption is reflected in result.monitorExitCodeCorrupt", async () => {
    const { buildTmpDir, monitorLog } = setupBuildTmpDir();
    fs.writeFileSync(path.join(buildTmpDir, "monitor-exit-code"), "\n");
    writeLog(monitorLog, []);
    const r = await drainFaults({ buildTmpDir, investigatorCommand: STUB_OK });
    expect(r.monitorExitCodeCorrupt).toBe(true);
    expect(r.monitorExitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI integration: run the gstack-build binary directly to test parseArgs +
// dispatch. Uses `bun run` to execute the TS entry point so we don't need to
// pre-compile.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "build", "orchestrator", "cli.ts");

describe("CLI dispatch", () => {
  test("drain-faults --help shape: rejects missing input forms", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "drain-faults"], {
      encoding: "utf-8",
      env: { ...process.env, GSTACK_HOME: tmpDir },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("requires --manifest");
  });

  test("drain-faults rejects both --manifest and --build-tmp-dir", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        CLI_PATH,
        "drain-faults",
        "--manifest",
        "/tmp/m.json",
        "--build-tmp-dir",
        "/tmp/b",
      ],
      { encoding: "utf-8", env: { ...process.env, GSTACK_HOME: tmpDir } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("provide only one");
  });

  test("drain-faults --build-tmp-dir on missing log → exit 0, empty result", () => {
    const buildTmpDir = path.join(tmpDir, "empty-build");
    fs.mkdirSync(buildTmpDir, { recursive: true });
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "drain-faults", "--build-tmp-dir", buildTmpDir],
      { encoding: "utf-8", env: { ...process.env, GSTACK_HOME: tmpDir } },
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { logExists: boolean };
    expect(out.logExists).toBe(false);
  });

  test("drain-faults rejects --investigator-timeout-ms below 1000", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        CLI_PATH,
        "drain-faults",
        "--build-tmp-dir",
        "/tmp/b",
        "--investigator-timeout-ms",
        "500",
      ],
      { encoding: "utf-8", env: { ...process.env, GSTACK_HOME: tmpDir } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--investigator-timeout-ms");
  });
});
