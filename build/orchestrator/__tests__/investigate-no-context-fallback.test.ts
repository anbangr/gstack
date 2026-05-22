import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInvestigateMode } from "../investigate-mode";

const tmpRoot = path.join(os.tmpdir(), `gstack-investigate-fallback-${process.pid}`);
const faultsDir = path.join(tmpRoot, "skill-faults");
const activeRunsDir = path.join(tmpRoot, "active-runs");

let stderrBuf = "";
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  fs.mkdirSync(faultsDir, { recursive: true });
  fs.mkdirSync(activeRunsDir, { recursive: true });
  stderrBuf = "";
  process.stderr.write = ((chunk: any) => {
    stderrBuf += chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stderr.write = origStderr;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("no context, non-TTY → exit 3 with stderr explanation", async () => {
  const code = await runInvestigateMode({
    faultsDir, activeRunsRegistryDir: activeRunsDir,
    ttyAvailable: false,
  });
  expect(code).toBe(3);
  expect(stderrBuf).toContain("no context auto-detected");
  expect(stderrBuf).toContain("--state");
  expect(stderrBuf).toContain("--symptoms");
});
