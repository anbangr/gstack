import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as subAgents from "../sub-agents";

/**
 * T9–T11 + T14: Auth preflight for Gemini (and Codex mirror).
 *
 * Before spawning a Gemini sub-agent, assertGeminiAuth runs a lightweight
 * probe (`gemini auth status` or `gemini --version`) with a 5s timeout.
 * On failure the build halts early with PROVIDER_AUTH_REQUIRED instead of
 * hanging on the full phase timeout.
 *
 * The success result is cached per-process so resume doesn't re-probe.
 */

function makeFakeBin(
  dir: string,
  name: string,
  script: string,
): string {
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

// Helper to reset the per-process cache between test suites.
// The implementation stores the cache in a module-level variable.
// We reach into the module namespace to clear it when exposed.
function clearPreflightCache() {
  subAgents._resetAuthPreflightForTests();
}

describe("assertGeminiAuth", () => {
  let tmpDir: string;
  let origGeminiBin: string | undefined;
  let origPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-preflight-"));
    origGeminiBin = process.env.GEMINI_BIN;
    origPath = process.env.PATH;
    clearPreflightCache();
  });

  afterEach(() => {
    if (origGeminiBin === undefined) delete process.env.GEMINI_BIN;
    else process.env.GEMINI_BIN = origGeminiBin;
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("T9: passes when gemini auth status returns 0", async () => {
    if (typeof (subAgents as any).assertGeminiAuth !== "function") {
      expect(false).toBe(true);
      return;
    }

    makeFakeBin(
      tmpDir,
      "gemini",
      '#!/bin/bash\necho "Authenticated"\nexit 0\n',
    );
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath ?? ""}`;

    const result = await (subAgents as any).assertGeminiAuth();
    expect(result.ok).toBe(true);
  });

  test("T10: fails when gemini auth status returns non-zero", async () => {
    if (typeof (subAgents as any).assertGeminiAuth !== "function") {
      expect(false).toBe(true);
      return;
    }

    makeFakeBin(
      tmpDir,
      "gemini",
      '#!/bin/bash\necho "Not authenticated" >&2\nexit 1\n',
    );
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath ?? ""}`;

    const result = await (subAgents as any).assertGeminiAuth();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("auth");
  });

  test("T11: success is cached — second call does not re-run probe", async () => {
    if (typeof (subAgents as any).assertGeminiAuth !== "function") {
      expect(false).toBe(true);
      return;
    }

    let callCount = 0;
    makeFakeBin(
      tmpDir,
      "gemini",
      `#!/bin/bash\n((callCount++))\necho "ok"\nexit 0\n`,
    );
    // Use a wrapper script that tracks invocations via a file.
    const counterFile = path.join(tmpDir, "counter");
    fs.writeFileSync(counterFile, "0");
    fs.writeFileSync(
      path.join(tmpDir, "gemini"),
      `#!/bin/bash\nn=$(cat "${counterFile}")\necho $((n + 1)) > "${counterFile}"\nexit 0\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath ?? ""}`;

    const r1 = await (subAgents as any).assertGeminiAuth();
    expect(r1.ok).toBe(true);
    const afterFirst = Number(fs.readFileSync(counterFile, "utf8"));

    const r2 = await (subAgents as any).assertGeminiAuth();
    expect(r2.ok).toBe(true);
    const afterSecond = Number(fs.readFileSync(counterFile, "utf8"));

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // cached — no second invocation
  });

  test("T14: GSTACK_DISABLE_AUTH_PREFLIGHT=1 skips probe and returns ok", async () => {
    if (typeof (subAgents as any).assertGeminiAuth !== "function") {
      expect(false).toBe(true);
      return;
    }

    const prev = process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
    process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = "1";

    try {
      // Even with a broken gemini binary, the skip should succeed.
      makeFakeBin(
        tmpDir,
        "gemini",
        '#!/bin/bash\nexit 127\n',
      );
      process.env.PATH = `${tmpDir}${path.delimiter}${origPath ?? ""}`;

      const result = await (subAgents as any).assertGeminiAuth();
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_DISABLE_AUTH_PREFLIGHT;
      else process.env.GSTACK_DISABLE_AUTH_PREFLIGHT = prev;
    }
  });

  test("concurrent calls share the same cache (no duplicate probes)", async () => {
    if (typeof (subAgents as any).assertGeminiAuth !== "function") {
      expect(false).toBe(true);
      return;
    }

    const counterFile = path.join(tmpDir, "counter");
    fs.writeFileSync(counterFile, "0");
    fs.writeFileSync(
      path.join(tmpDir, "gemini"),
      `#!/bin/bash\nn=$(cat "${counterFile}")\necho $((n + 1)) > "${counterFile}"\nsleep 0.1\nexit 0\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath ?? ""}`;

    const [r1, r2] = await Promise.all([
      (subAgents as any).assertGeminiAuth(),
      (subAgents as any).assertGeminiAuth(),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const totalCalls = Number(fs.readFileSync(counterFile, "utf8"));
    expect(totalCalls).toBe(1);
  });
});

describe("assertCodexAuth (mirror)", () => {
  let tmpDir: string;
  let origPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-preflight-"));
    origPath = process.env.PATH;
    clearPreflightCache();
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("degrades to codex --version when codex auth status is unsupported", async () => {
    const fn = (subAgents as any).assertCodexAuth;
    if (typeof fn !== "function") {
      expect(false).toBe(true);
      return;
    }

    // Simulate a codex binary that rejects "auth status" but accepts --version.
    fs.writeFileSync(
      path.join(tmpDir, "codex"),
      `#!/bin/bash\nif [[ "$1" == "auth" && "$2" == "status" ]]; then\n  echo "unknown command: auth status" >&2\n  exit 1\nfi\necho "1.0.0"\nexit 0\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpDir}${path.delimiter}${origPath ?? ""}`;

    const result = await fn();
    expect(result.ok).toBe(true);
  });
});
