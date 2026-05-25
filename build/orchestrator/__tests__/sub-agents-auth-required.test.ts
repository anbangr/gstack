import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertGeminiAuth,
  assertCodexAuth,
  assertKimiAuth,
  _resetAuthPreflightForTests,
} from "../sub-agents";

/**
 * Auth preflight tests. Hardening pass closes two failure modes the
 * existing probes missed:
 *
 *   1. Provider exits 0 on interactive auth prompt → primary probe used
 *      to return ok:true, `--version` fallback never tripped, real
 *      failure surfaced inside the phase as a stall-kill (p9 signature).
 *   2. No Kimi preflight at all (p17 signature: Kimi+Gemini stall-killed
 *      with zero stdout).
 *
 * Strategy: write a temp shell script that mimics each provider CLI
 * shape (auth status / --version), point GEMINI_BIN / CODEX_BIN / KIMI_BIN
 * at the script, and assert the resulting preflight verdict. The probes
 * are sync so timing is deterministic.
 */

let tmpBin: string;
let originalGeminiBin: string | undefined;
let originalCodexBin: string | undefined;
let originalKimiBin: string | undefined;
let originalDisableFlag: string | undefined;

function writeFakeBin(
  name: string,
  body: string,
): string {
  const binPath = path.join(tmpBin, name);
  fs.writeFileSync(binPath, body, { mode: 0o755 });
  return binPath;
}

beforeEach(() => {
  tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "auth-probe-"));
  originalGeminiBin = process.env.GEMINI_BIN;
  originalCodexBin = process.env.CODEX_BIN;
  originalKimiBin = process.env.KIMI_BIN;
  originalDisableFlag = process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  delete process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  _resetAuthPreflightForTests();
});

afterEach(() => {
  fs.rmSync(tmpBin, { recursive: true, force: true });
  if (originalGeminiBin === undefined) delete process.env.GEMINI_BIN;
  else process.env.GEMINI_BIN = originalGeminiBin;
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
  if (originalKimiBin === undefined) delete process.env.KIMI_BIN;
  else process.env.KIMI_BIN = originalKimiBin;
  if (originalDisableFlag === undefined)
    delete process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
  else process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = originalDisableFlag;
  _resetAuthPreflightForTests();
});

describe("assertGeminiAuth — p9 fix: auth-required wins over --version fallback", () => {
  test("returns ok:true when auth status exits 0 cleanly", async () => {
    process.env.GEMINI_BIN = writeFakeBin(
      "gemini-ok",
      "#!/bin/bash\nexit 0\n",
    );
    const result = await assertGeminiAuth();
    expect(result.ok).toBe(true);
  });

  test("returns ok:false when stderr matches auth-required pattern (even on exit 0)", async () => {
    // The p9 signature: provider exits 0 but printed an auth prompt.
    // Pre-fix this returned ok:true because --version fallback succeeded.
    process.env.GEMINI_BIN = writeFakeBin(
      "gemini-auth-prompt",
      "#!/bin/bash\nif [[ \"$1\" == \"auth\" ]]; then\n  echo 'please log in' 1>&2\n  exit 0\nfi\nexit 0\n",
    );
    const result = await assertGeminiAuth();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("auth_required");
    expect(result.reason).toContain("please log");
  });

  test("returns ok:false when auth status exits 1 with 'not authenticated' stderr", async () => {
    process.env.GEMINI_BIN = writeFakeBin(
      "gemini-not-auth",
      "#!/bin/bash\nif [[ \"$1\" == \"auth\" ]]; then\n  echo 'not authenticated' 1>&2\n  exit 1\nfi\nexit 0\n",
    );
    const result = await assertGeminiAuth();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("auth_required");
  });

  test("--version fallback succeeds when auth status fails for unrelated reason", async () => {
    // auth status fails with NO auth pattern → fall through to --version.
    process.env.GEMINI_BIN = writeFakeBin(
      "gemini-unrelated",
      "#!/bin/bash\nif [[ \"$1\" == \"auth\" ]]; then\n  echo 'unknown error code 42' 1>&2\n  exit 1\nfi\nexit 0\n",
    );
    const result = await assertGeminiAuth();
    expect(result.ok).toBe(true);
  });

  test("respects GSTACK_DISABLE_AUTH_PREFLIGHT=1 kill switch", async () => {
    process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = "1";
    process.env.GEMINI_BIN = "/does-not-exist";
    const result = await assertGeminiAuth();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

describe("assertCodexAuth — auth-required parity with Gemini", () => {
  test("returns ok:false on auth-prompt stderr pattern", async () => {
    process.env.CODEX_BIN = writeFakeBin(
      "codex-auth-prompt",
      "#!/bin/bash\nif [[ \"$1\" == \"auth\" ]]; then\n  echo 'authentication required' 1>&2\n  exit 1\nfi\nexit 0\n",
    );
    const result = await assertCodexAuth();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("auth_required");
  });

  test("returns ok:true on clean auth status", async () => {
    process.env.CODEX_BIN = writeFakeBin(
      "codex-ok",
      "#!/bin/bash\nexit 0\n",
    );
    const result = await assertCodexAuth();
    expect(result.ok).toBe(true);
  });
});

describe("assertKimiAuth — new probe (p17 fix)", () => {
  test("returns ok:true when Kimi auth status exits 0", async () => {
    process.env.KIMI_BIN = writeFakeBin("kimi-ok", "#!/bin/bash\nexit 0\n");
    const result = await assertKimiAuth();
    expect(result.ok).toBe(true);
  });

  test("returns ok:false on Kimi auth-required pattern", async () => {
    process.env.KIMI_BIN = writeFakeBin(
      "kimi-auth-prompt",
      "#!/bin/bash\nif [[ \"$1\" == \"auth\" ]]; then\n  echo 'please sign in to continue' 1>&2\n  exit 1\nfi\nexit 0\n",
    );
    const result = await assertKimiAuth();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("auth_required");
  });

  test("respects GSTACK_DISABLE_AUTH_PREFLIGHT=1 for Kimi too", async () => {
    process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = "1";
    process.env.KIMI_BIN = "/does-not-exist";
    const result = await assertKimiAuth();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("--version fallback works for unrelated probe failures", async () => {
    process.env.KIMI_BIN = writeFakeBin(
      "kimi-unrelated",
      "#!/bin/bash\nif [[ \"$1\" == \"auth\" ]]; then\n  echo 'unknown error' 1>&2\n  exit 1\nfi\nexit 0\n",
    );
    const result = await assertKimiAuth();
    expect(result.ok).toBe(true);
  });
});
