import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { pickParserForProvider } from "../sub-agents";

describe("pickParserForProvider env-var kill switch", () => {
  const originalEnv = process.env.GSTACK_TOOL_AWARE_WATCHDOG;

  beforeEach(() => {
    delete process.env.GSTACK_TOOL_AWARE_WATCHDOG;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GSTACK_TOOL_AWARE_WATCHDOG;
    } else {
      process.env.GSTACK_TOOL_AWARE_WATCHDOG = originalEnv;
    }
  });

  it("returns a parser for known providers when env var is unset", () => {
    expect(pickParserForProvider("gemini")).not.toBeNull();
    expect(pickParserForProvider("codex")).not.toBeNull();
    expect(pickParserForProvider("kimi")).not.toBeNull();
    expect(pickParserForProvider("claude")).not.toBeNull();
  });

  it("returns null when GSTACK_TOOL_AWARE_WATCHDOG=0", () => {
    process.env.GSTACK_TOOL_AWARE_WATCHDOG = "0";
    expect(pickParserForProvider("gemini")).toBeNull();
    expect(pickParserForProvider("codex")).toBeNull();
    expect(pickParserForProvider("kimi")).toBeNull();
    expect(pickParserForProvider("claude")).toBeNull();
  });

  it("returns a parser when GSTACK_TOOL_AWARE_WATCHDOG=1 (explicit on)", () => {
    process.env.GSTACK_TOOL_AWARE_WATCHDOG = "1";
    expect(pickParserForProvider("gemini")).not.toBeNull();
  });

  it("returns null for the shell provider regardless of env var", () => {
    expect(pickParserForProvider("shell")).toBeNull();
    process.env.GSTACK_TOOL_AWARE_WATCHDOG = "1";
    expect(pickParserForProvider("shell")).toBeNull();
  });
});
