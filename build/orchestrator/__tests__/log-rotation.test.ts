import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

/**
 * Tests the lazy log-rotation block embedded in build/SKILL.md.tmpl
 * (right before the `tee "$stdoutLog"` launch). The block:
 *
 *   if [ -f "$stdoutLog" ] && [ "$(wc -c < "$stdoutLog")" -gt 52428800 ]; then
 *     tail -c 26214400 "$stdoutLog" > "$stdoutLog.rotate.tmp" &&
 *       mv "$stdoutLog.rotate.tmp" "$stdoutLog" || true
 *   fi
 *
 * We re-run that exact shell logic against fixture log files to pin
 * the truncation contract.
 */
const ROTATE_SCRIPT = `
if [ -f "$stdoutLog" ] && [ "$(wc -c < "$stdoutLog" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  tail -c 26214400 "$stdoutLog" > "$stdoutLog.rotate.tmp" 2>/dev/null &&
    mv "$stdoutLog.rotate.tmp" "$stdoutLog" 2>/dev/null || true
fi
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rotate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agent-stdout.log lazy rotation", () => {
  it("leaves a small log untouched", () => {
    const log = path.join(tmpDir, "agent-stdout.log");
    const content = "small log content\n".repeat(100);
    fs.writeFileSync(log, content);
    const sizeBefore = fs.statSync(log).size;

    execSync(ROTATE_SCRIPT, {
      env: { ...process.env, stdoutLog: log },
      shell: "/bin/bash",
    });

    const sizeAfter = fs.statSync(log).size;
    expect(sizeAfter).toBe(sizeBefore);
    expect(fs.readFileSync(log, "utf8")).toBe(content);
  });

  it("truncates a 60MB log to ~25MB and keeps the trailing bytes", () => {
    const log = path.join(tmpDir, "agent-stdout.log");
    // Build a 60MB fixture with recognizable tail content.
    const chunk = "A".repeat(1024 * 1024);
    const fd = fs.openSync(log, "w");
    try {
      for (let i = 0; i < 60; i++) fs.writeSync(fd, chunk);
      fs.writeSync(fd, "TAIL_MARKER_END\n");
    } finally {
      fs.closeSync(fd);
    }
    const sizeBefore = fs.statSync(log).size;
    expect(sizeBefore).toBeGreaterThan(52428800);

    execSync(ROTATE_SCRIPT, {
      env: { ...process.env, stdoutLog: log },
      shell: "/bin/bash",
    });

    const sizeAfter = fs.statSync(log).size;
    expect(sizeAfter).toBe(26214400);
    // The trailing marker must survive — we keep the END of the file.
    const buf = fs.readFileSync(log);
    const tail = buf.subarray(buf.length - 32).toString("utf8");
    expect(tail).toContain("TAIL_MARKER_END");
  });

  it("does not error when the log file is missing (idempotent)", () => {
    const log = path.join(tmpDir, "does-not-exist.log");
    expect(() => {
      execSync(ROTATE_SCRIPT, {
        env: { ...process.env, stdoutLog: log },
        shell: "/bin/bash",
      });
    }).not.toThrow();
    expect(fs.existsSync(log)).toBe(false);
  });
});
