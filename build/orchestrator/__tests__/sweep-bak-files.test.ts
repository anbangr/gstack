/**
 * Tests for sweepBakFilesNewerThan — Bug T4 (mitosis-control-plane
 * cp-pod-log-archival 2026-05-25).
 *
 * Gemini's --yolo mode leaves *.bak files behind. We sweep only the ones
 * created during a particular spawn (mtime > sinceMs) so we don't touch the
 * user's pre-existing backups.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepBakFilesNewerThan } from "../sub-agents";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-sweep-bak-"));
});

afterEach(() => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function writeFileWithMtime(p: string, content: string, mtimeMs: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = new Date(mtimeMs);
  fs.utimesSync(p, t, t);
}

describe("sweepBakFilesNewerThan", () => {
  it("returns empty when cwd has no .bak files", () => {
    fs.writeFileSync(path.join(scratch, "real.ts"), "x");
    const swept = sweepBakFilesNewerThan(scratch, Date.now() - 60_000);
    expect(swept).toEqual([]);
  });

  it("deletes a .bak file with mtime newer than sinceMs", () => {
    const now = Date.now();
    const bak = path.join(scratch, "real.ts.bak");
    writeFileWithMtime(bak, "stale", now + 5_000);
    const swept = sweepBakFilesNewerThan(scratch, now);
    expect(swept).toEqual([bak]);
    expect(fs.existsSync(bak)).toBe(false);
  });

  it("does NOT delete a .bak file with mtime older than sinceMs", () => {
    const now = Date.now();
    const oldBak = path.join(scratch, "old.bak");
    writeFileWithMtime(oldBak, "stale", now - 60_000);
    const swept = sweepBakFilesNewerThan(scratch, now);
    expect(swept).toEqual([]);
    expect(fs.existsSync(oldBak)).toBe(true);
  });

  it("only deletes .bak files (leaves .bak.gz and bak.txt alone)", () => {
    const now = Date.now();
    const realBak = path.join(scratch, "file.ts.bak");
    const notBakGz = path.join(scratch, "file.bak.gz");
    const baktxt = path.join(scratch, "bak.txt");
    writeFileWithMtime(realBak, "x", now + 5_000);
    writeFileWithMtime(notBakGz, "x", now + 5_000);
    writeFileWithMtime(baktxt, "x", now + 5_000);
    const swept = sweepBakFilesNewerThan(scratch, now);
    expect(swept).toEqual([realBak]);
    expect(fs.existsSync(realBak)).toBe(false);
    expect(fs.existsSync(notBakGz)).toBe(true);
    expect(fs.existsSync(baktxt)).toBe(true);
  });

  it("descends into nested directories", () => {
    const now = Date.now();
    const nested = path.join(scratch, "a", "b", "c", "nested.test.ts.bak");
    writeFileWithMtime(nested, "x", now + 5_000);
    const swept = sweepBakFilesNewerThan(scratch, now);
    expect(swept).toContain(nested);
    expect(fs.existsSync(nested)).toBe(false);
  });

  it("returns empty when cwd does not exist", () => {
    const swept = sweepBakFilesNewerThan(
      path.join(scratch, "does-not-exist"),
      Date.now() - 60_000,
    );
    expect(swept).toEqual([]);
  });

  it("does not delete directories named *.bak", () => {
    const now = Date.now();
    const dirBak = path.join(scratch, "weird.bak");
    fs.mkdirSync(dirBak);
    fs.utimesSync(dirBak, new Date(now + 5_000), new Date(now + 5_000));
    const swept = sweepBakFilesNewerThan(scratch, now);
    expect(swept).toEqual([]);
    expect(fs.existsSync(dirBak)).toBe(true);
    expect(fs.statSync(dirBak).isDirectory()).toBe(true);
  });
});
