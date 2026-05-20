import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  emitHaltEventResolved,
  pendingInvestigationsDir,
} from "../halt-events";

describe("emitHaltEventResolved", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "her-"));
    origHome = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("T_HER1: writes minimal-shape JSON to pending-investigations/", () => {
    const skillFaults = path.join(tmp, "skill-faults");
    const ok = emitHaltEventResolved(
      "MANUAL_RECOVERY_INVOKED:all:276ba8b1",
      "drain-faults",
      { queueDir: skillFaults },
    );
    expect(ok).toBe(true);

    const pendingDir = pendingInvestigationsDir({ queueDir: skillFaults });
    const files = fs.readdirSync(pendingDir);
    expect(files.length).toBe(1);

    const content = JSON.parse(
      fs.readFileSync(path.join(pendingDir, files[0]), "utf8"),
    );
    expect(content.event).toBe("SKILL_FAULT_RESOLVED");
    expect(content.runId).toBe("drain-faults");
    expect(content.faultId).toBe("MANUAL_RECOVERY_INVOKED:all:276ba8b1");
    expect(typeof content.timestamp).toBe("string");
    // Should not contain extra HaltEvent fields like kind/severity/snapshot
    expect(content.kind).toBeUndefined();
    expect(content.severity).toBeUndefined();
    expect(content.snapshot).toBeUndefined();
  });

  test("T_HER2: filename pattern includes RESOLVED + faultId for dedup", () => {
    const skillFaults = path.join(tmp, "skill-faults");
    emitHaltEventResolved("PHASE_FAILED:p3:abc12345", "my-run", {
      queueDir: skillFaults,
    });
    const pendingDir = pendingInvestigationsDir({ queueDir: skillFaults });
    const files = fs.readdirSync(pendingDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("RESOLVED");
    expect(files[0]).toContain("PHASE_FAILED:p3:abc12345");
  });

  test("T_HER3: write failure surfaces (returns false, stderr warn)", () => {
    // Pre-create the pending-investigations/ dir as read-only so the
    // emitter cannot write to it. Capture stderr to verify the warning.
    const skillFaults = path.join(tmp, "skill-faults");
    const pendingDir = pendingInvestigationsDir({ queueDir: skillFaults });
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.chmodSync(pendingDir, 0o500); // read+execute only — no write

    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    // @ts-expect-error — patching for the test
    process.stderr.write = (s: any): boolean => {
      captured += typeof s === "string" ? s : s.toString();
      return true;
    };

    try {
      const ok = emitHaltEventResolved(
        "MANUAL_RECOVERY_INVOKED:all:276ba8b1",
        "drain-faults",
        { queueDir: skillFaults },
      );
      expect(ok).toBe(false);
      expect(captured).toContain("emitHaltEventResolved");
      // No file should have been written
      expect(fs.readdirSync(pendingDir).length).toBe(0);
    } finally {
      // restore stderr + perms so afterEach can clean up
      process.stderr.write = origWrite;
      fs.chmodSync(pendingDir, 0o755);
    }
  });
});
