/**
 * Tests for malformed-ref quarantine preflight.
 *
 * Before `git fetch` in base-sync / feature-branch-create paths, the
 * orchestrator enumerates refs, validates each via `git check-ref-format`,
 * and moves invalid refs to `.git/quarantine/<sanitized>.ref` with a sidecar
 * JSON.  No ref content is deleted — everything is restorable.
 *
 * Coverage target: ≥80%
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as cli from "../cli";

let tmpDir: string;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function quarantineFn(): ((cwd: string) => { quarantined: number; skipped?: boolean }) | undefined {
  return (cli as any).quarantineMalformedRefs;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-quarantine-"));
  git(["init", "--initial-branch=main"], tmpDir);
  git(["config", "user.email", "t@t.com"], tmpDir);
  git(["config", "user.name", "Test"], tmpDir);
  fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
  git(["add", "."], tmpDir);
  git(["commit", "-m", "init"], tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// T5: Malformed ref quarantined
// ------------------------------------------------------------------
describe("quarantineMalformedRefs", () => {
  test("T5: malformed ref is moved to .git/quarantine with sidecar JSON", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);
    // Create a Finder-duplicate-shaped malformed ref: trailing space + digit
    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo 1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, sha + "\n");

    const result = fn(tmpDir);
    expect(result.quarantined).toBeGreaterThanOrEqual(1);

    const quarantineDir = path.join(tmpDir, ".git", "quarantine");
    expect(fs.existsSync(path.join(quarantineDir, "feat-foo-1.ref"))).toBe(true);
    const sidecarPath = path.join(quarantineDir, "feat-foo-1.json");
    expect(fs.existsSync(sidecarPath)).toBe(true);

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    expect(sidecar.originalRef).toBe("refs/heads/feat/foo 1");
    expect(sidecar.originalSha).toBe(sha);
    expect(sidecar.timestamp).toBeTruthy();
    expect(sidecar.reason).toContain("invalid");
  });

  // ----------------------------------------------------------------
  // T6: Quarantine restorable
  // ----------------------------------------------------------------
  test("T6: running the documented recovery command restores the ref", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);
    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo 1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, sha + "\n");

    fn(tmpDir);

    // The original ref must no longer exist
    expect(fs.existsSync(malformedRefPath)).toBe(false);

    // Run the recovery command from the sidecar
    const sidecarPath = path.join(tmpDir, ".git", "quarantine", "feat-foo-1.json");
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    const recovery = sidecar.recoveryCommand;
    expect(recovery).toBeTruthy();
    expect(recovery).toContain("git update-ref");

    // Execute the recovery command
    const r = spawnSync("sh", ["-c", recovery], { cwd: tmpDir, encoding: "utf8" });
    expect(r.status).toBe(0);

    // Ref is back
    expect(fs.existsSync(malformedRefPath)).toBe(true);
    expect(fs.readFileSync(malformedRefPath, "utf8").trim()).toBe(sha);
  });

  // ----------------------------------------------------------------
  // T7: Valid refs untouched
  // ----------------------------------------------------------------
  test("T7: well-formed refs are left alone", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);
    const result = fn(tmpDir);
    expect(result.quarantined).toBe(0);

    const quarantineDir = path.join(tmpDir, ".git", "quarantine");
    expect(fs.existsSync(quarantineDir)).toBe(false);

    // main ref is untouched
    const mainRef = path.join(tmpDir, ".git", "refs", "heads", "main");
    expect(fs.readFileSync(mainRef, "utf8").trim()).toBe(sha);
  });

  // ----------------------------------------------------------------
  // T8: Disk full during quarantine
  // ----------------------------------------------------------------
  test("T8: ENOSPC bubbles up; original ref untouched (no half-move)", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);
    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo 1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, sha + "\n");

    // Make the quarantine directory read-only to simulate ENOSPC
    const quarantineDir = path.join(tmpDir, ".git", "quarantine");
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.chmodSync(quarantineDir, 0o555);

    let threw = false;
    let errorMessage = "";
    try {
      fn(tmpDir);
    } catch (err) {
      threw = true;
      errorMessage = (err as Error).message;
    } finally {
      fs.chmodSync(quarantineDir, 0o755);
    }

    // Must throw (or return an error) — we accept either shape
    expect(threw || errorMessage).toBeTruthy();

    // Original ref must still exist (atomic move failed before unlink)
    expect(fs.existsSync(malformedRefPath)).toBe(true);
  });

  // ----------------------------------------------------------------
  // T11: Kill switch
  // ----------------------------------------------------------------
  test("T11: GSTACK_DISABLE_REF_QUARANTINE=1 skips enumeration", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const prev = process.env.GSTACK_DISABLE_REF_QUARANTINE;
    process.env.GSTACK_DISABLE_REF_QUARANTINE = "1";

    const sha = git(["rev-parse", "HEAD"], tmpDir);
    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo 1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, sha + "\n");

    try {
      const result = fn(tmpDir);
      expect(result.skipped).toBe(true);
      expect(result.quarantined).toBe(0);

      // Original ref untouched
      expect(fs.existsSync(malformedRefPath)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_DISABLE_REF_QUARANTINE;
      else process.env.GSTACK_DISABLE_REF_QUARANTINE = prev;
    }
  });

  // ----------------------------------------------------------------
  // Edge: two malformed refs colliding to same sanitized name
  // ----------------------------------------------------------------
  test("edge: colliding sanitized names get counter suffixes", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);

    // Both are malformed and both sanitize to "feat-foo-1"
    const refA = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo 1");
    const refB = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo?1");
    fs.mkdirSync(path.dirname(refA), { recursive: true });
    fs.writeFileSync(refA, sha + "\n");
    fs.mkdirSync(path.dirname(refB), { recursive: true });
    fs.writeFileSync(refB, sha + "\n");

    const result = fn(tmpDir);
    expect(result.quarantined).toBe(2);

    const quarantineDir = path.join(tmpDir, ".git", "quarantine");
    const files = fs.readdirSync(quarantineDir).sort();
    expect(files.filter((f) => f.endsWith(".ref")).length).toBe(2);

    // Both sidecars must exist and preserve original names
    const sidecars = files.filter((f) => f.endsWith(".json"));
    expect(sidecars.length).toBe(2);

    const originals = sidecars.map((s) =>
      JSON.parse(fs.readFileSync(path.join(quarantineDir, s), "utf8")).originalRef,
    );
    expect(originals).toContain("refs/heads/feat/foo 1");
    expect(originals).toContain("refs/heads/feat/foo?1");
  });

  test("edge: valid refs are not quarantined when their sanitized name collides", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);

    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat", "foo 1");
    const validRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat-foo-1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, sha + "\n");
    fs.writeFileSync(validRefPath, sha + "\n");

    const result = fn(tmpDir);
    expect(result.quarantined).toBe(1);

    const quarantineDir = path.join(tmpDir, ".git", "quarantine");
    const sidecars = fs.readdirSync(quarantineDir).filter((f) => f.endsWith(".json"));
    expect(sidecars.length).toBe(1);
    const sidecar = JSON.parse(fs.readFileSync(path.join(quarantineDir, sidecars[0]), "utf8"));
    expect(sidecar.originalRef).toBe("refs/heads/feat/foo 1");
    expect(fs.existsSync(validRefPath)).toBe(true);
    expect(fs.readFileSync(validRefPath, "utf8").trim()).toBe(sha);
  });

  // ----------------------------------------------------------------
  // Edge: ref pointing at missing SHA (already-corrupt repo)
  // ----------------------------------------------------------------
  test("edge: quarantine records originalSha: null when ref SHA is missing", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const badSha = "0000000000000000000000000000000000000000";
    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat", "bad 1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, badSha + "\n");

    fn(tmpDir);

    const sidecarPath = path.join(tmpDir, ".git", "quarantine", "feat-bad-1.json");
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    expect(sidecar.originalSha).toBeNull();
    expect(sidecar.originalRef).toBe("refs/heads/feat/bad 1");
  });

  // ----------------------------------------------------------------
  // Edge: Windows backslash sanitization
  // ----------------------------------------------------------------
  test("edge: backslashes in ref names are sanitized to dash", () => {
    const fn = quarantineFn();
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    const sha = git(["rev-parse", "HEAD"], tmpDir);
    // A ref name that could appear on Windows with backslash
    const malformedRefPath = path.join(tmpDir, ".git", "refs", "heads", "feat\\win 1");
    fs.mkdirSync(path.dirname(malformedRefPath), { recursive: true });
    fs.writeFileSync(malformedRefPath, sha + "\n");

    fn(tmpDir);

    const quarantineDir = path.join(tmpDir, ".git", "quarantine");
    const files = fs.readdirSync(quarantineDir).filter((f) => f.endsWith(".ref"));
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain("\\");
    expect(files[0]).toContain("feat-");
  });
});
