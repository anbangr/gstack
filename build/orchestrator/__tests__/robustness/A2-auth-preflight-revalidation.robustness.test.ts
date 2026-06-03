/**
 * A2 — auth-preflight-revalidation  [RED→FIXED]  (smoke)
 *
 * Long-run failure mode: the orchestrator probed provider auth once before the
 * first sub-agent spawn and cached a positive `{ok:true}` *process-wide with no
 * TTL*. A build that runs for hours kept spawning Gemini sub-agents on a token
 * that expired at, say, hour 1 — the cached positive was never revisited, so the
 * early-halt preflight that exists specifically to fail fast on dead auth was
 * silently skipped for the rest of the run.
 *
 * THE FIX (A2): `assertGeminiAuth` now caches its result against a TTL
 * (`GEMINI_AUTH_TTL_MS`, default 10 min) with an injectable `now`/`ttlMs` seam.
 * Within the TTL the cached result is served (no per-spawn re-probe on a healthy
 * run — the existing `gemini-auth-preflight.test.ts` back-to-back "cached, no
 * second invocation" test still holds because no time passes there). Once the
 * TTL lapses, the next call re-probes, so a token that expired mid-run is caught
 * within ~one TTL instead of never.
 *
 * This spec drives the real `assertGeminiAuth` with an injected fake clock and a
 * counter-file `GEMINI_BIN` whose first call exits 0 and whose later calls print
 * "please re-authenticate" + exit 1. Advancing the clock past the TTL must make
 * the second probe re-invoke the binary and return `{ok:false}` — proving the
 * positive is revalidated, not served forever.
 *
 * See ./README.md for the PIN/RED protocol and
 * docs/designs/BUILD_ROBUSTNESS_SUITE.md §A2 for full context.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as subAgents from "../../sub-agents";
import { mkTmp, writeExecutable, counterScript } from "./helpers";

describe("[RED→FIXED] A2 auth-preflight-revalidation", () => {
  let tmpDir: string;
  let counterFile: string;
  let origGeminiBin: string | undefined;
  // A manually-advanced clock injected into assertGeminiAuth so the TTL can be
  // crossed deterministically without real wall-clock waits.
  let fakeNowMs: number;
  const TTL_MS = 10 * 60_000;

  beforeEach(() => {
    tmpDir = mkTmp("gstack-robustness-a2-");
    counterFile = path.join(tmpDir, "counter");
    fs.writeFileSync(counterFile, "0");

    // First invocation (counter 0 -> 1): healthy, exit 0.
    // Every later invocation (counter >= 1): the token has expired, the CLI
    // prints an auth-shaped prompt to stderr and exits non-zero.
    const script = counterScript(
      counterFile,
      [
        'if [ "$n" -eq 0 ]; then',
        "  exit 0",
        "else",
        '  echo "please re-authenticate" >&2',
        "  exit 1",
        "fi",
      ].join("\n"),
    );
    const binPath = writeExecutable(path.join(tmpDir, "gemini"), script);

    origGeminiBin = process.env.GEMINI_BIN;
    process.env.GEMINI_BIN = binPath;
    fakeNowMs = 0;
    // Clean cache so the FIRST probe below seeds the positive at t=0.
    subAgents._resetAuthPreflightForTests();
  });

  afterEach(() => {
    subAgents._resetAuthPreflightForTests();
    if (origGeminiBin === undefined) delete process.env.GEMINI_BIN;
    else process.env.GEMINI_BIN = origGeminiBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const probe = () =>
    subAgents.assertGeminiAuth({ now: () => fakeNowMs, ttlMs: TTL_MS });

  it("serves the cached positive within the TTL, then re-probes once it lapses and surfaces the expired token", async () => {
    // t=0: token healthy -> positive (counter 0 -> 1).
    const first = await probe();
    expect(first.ok).toBe(true);
    expect(Number(fs.readFileSync(counterFile, "utf8"))).toBe(1);

    // Within the TTL: cached, NOT re-probed (a healthy run is not re-probed on
    // every spawn). The binary is not re-invoked — counter stays 1.
    fakeNowMs = TTL_MS - 1;
    const cached = await probe();
    expect(cached.ok).toBe(true);
    expect(Number(fs.readFileSync(counterFile, "utf8"))).toBe(1);

    // Past the TTL: the positive is revalidated, not served forever. The binary
    // is re-invoked (counter -> 2), hits the expired-token branch, ok:false.
    fakeNowMs = TTL_MS + 1;
    const second = await probe();
    expect(Number(fs.readFileSync(counterFile, "utf8"))).toBeGreaterThanOrEqual(
      2,
    );
    expect(second.ok).toBe(false);
  });

  it("a stale positive does not outlive a plausible token lifetime", async () => {
    const seeded = await probe();
    expect(seeded.ok).toBe(true);

    // "Hours later" in the same process, well past the TTL: a correctly
    // revalidating preflight surfaces the now-dead token rather than returning
    // the original positive forever.
    fakeNowMs = TTL_MS * 6;
    const latest = await probe();
    expect(latest.ok).toBe(false);
  });
});
