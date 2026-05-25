/**
 * Tests for resolveStreamSilenceMs — Bug 1 (polis-mesh / simclaw / 12
 * pending PROVIDER_TIMEOUT records: long-thinking models silently killed
 * by stream-silence stallMs that defaulted to overall timeoutMs).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveStreamSilenceMs } from "../sub-agents";

const ENV_KEYS = [
  "GSTACK_BUILD_STREAM_SILENCE_MS",
  "GSTACK_BUILD_STREAM_SILENCE_MS_CLAUDE",
  "GSTACK_BUILD_STREAM_SILENCE_MS_CODEX",
  "GSTACK_BUILD_STREAM_SILENCE_MS_GEMINI",
  "GSTACK_BUILD_STREAM_SILENCE_MS_KIMI",
  "GSTACK_BUILD_STREAM_SILENCE_MS_SHELL",
];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveStreamSilenceMs", () => {
  it("returns defaultMs when no env vars are set (current behavior preserved)", () => {
    expect(resolveStreamSilenceMs("claude", 900_000)).toBe(900_000);
    expect(resolveStreamSilenceMs("kimi", 750_000)).toBe(750_000);
    expect(resolveStreamSilenceMs("shell", 60_000)).toBe(60_000);
  });

  it("honors GSTACK_BUILD_STREAM_SILENCE_MS as a global override", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS = "1800000";
    expect(resolveStreamSilenceMs("claude", 900_000)).toBe(1_800_000);
    expect(resolveStreamSilenceMs("kimi", 60_000)).toBe(1_800_000);
  });

  it("provider-specific env beats the global", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS = "1800000";
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_CLAUDE = "3600000";
    expect(resolveStreamSilenceMs("claude", 900_000)).toBe(3_600_000);
    // Provider without specific override still gets the global.
    expect(resolveStreamSilenceMs("kimi", 900_000)).toBe(1_800_000);
  });

  it("treats '0' as 'use default' (disable override)", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_CLAUDE = "0";
    expect(resolveStreamSilenceMs("claude", 900_000)).toBe(900_000);
  });

  it("treats empty string as unset", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_CLAUDE = "";
    expect(resolveStreamSilenceMs("claude", 900_000)).toBe(900_000);
  });

  it("treats non-numeric as 'use default' (safe fallback)", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_KIMI = "long";
    expect(resolveStreamSilenceMs("kimi", 900_000)).toBe(900_000);
  });

  it("treats negative as 'use default'", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_CLAUDE = "-1000";
    expect(resolveStreamSilenceMs("claude", 900_000)).toBe(900_000);
  });

  it("trims surrounding whitespace before parsing", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_CODEX = "  600000  ";
    expect(resolveStreamSilenceMs("codex", 900_000)).toBe(600_000);
  });

  it("allows shortening the window (operators want fast-fail in CI)", () => {
    process.env.GSTACK_BUILD_STREAM_SILENCE_MS_SHELL = "5000";
    expect(resolveStreamSilenceMs("shell", 900_000)).toBe(5_000);
  });
});
