import { describe, it, expect, beforeEach } from "bun:test";
import {
  warnOnLargeStallWindows,
  _resetWarnOnLargeStallWindowsForTest,
} from "../build-config";

describe("warnOnLargeStallWindows", () => {
  beforeEach(() => {
    _resetWarnOnLargeStallWindowsForTest();
  });

  it("silent when no env vars are set", () => {
    const logs: string[] = [];
    warnOnLargeStallWindows({}, (msg) => logs.push(msg));
    expect(logs).toEqual([]);
  });

  it("silent when env vars are below the 30min threshold", () => {
    const logs: string[] = [];
    warnOnLargeStallWindows(
      {
        GSTACK_BUILD_GEMINI_TIMEOUT: "900000", // 15min
        GSTACK_BUILD_KIMI_TIMEOUT: "1500000", // 25min
        GSTACK_BUILD_SHIP_TIMEOUT: "1800000", // 30min exactly
      },
      (msg) => logs.push(msg),
    );
    expect(logs).toEqual([]);
  });

  it("warns when one env var exceeds the 30min threshold", () => {
    const logs: string[] = [];
    warnOnLargeStallWindows(
      {
        GSTACK_BUILD_KIMI_TIMEOUT: "3600000", // 60min
      },
      (msg) => logs.push(msg),
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain("GSTACK_BUILD_KIMI_TIMEOUT");
    expect(logs.join("\n")).toContain("60min");
  });

  it("warns when value is 1ms above the 30min threshold (off-by-one guard)", () => {
    const logs: string[] = [];
    warnOnLargeStallWindows(
      {
        GSTACK_BUILD_SHIP_TIMEOUT: "1800001", // 30min + 1ms
      },
      (msg) => logs.push(msg),
    );
    expect(logs.length).toBeGreaterThan(0);
  });

  it("warns for each oversized var", () => {
    const logs: string[] = [];
    warnOnLargeStallWindows(
      {
        GSTACK_BUILD_KIMI_TIMEOUT: "3600000",
        GSTACK_BUILD_GEMINI_TIMEOUT: "4500000",
      },
      (msg) => logs.push(msg),
    );
    const joined = logs.join("\n");
    expect(joined).toContain("GSTACK_BUILD_KIMI_TIMEOUT");
    expect(joined).toContain("GSTACK_BUILD_GEMINI_TIMEOUT");
  });

  it("is idempotent — second call is a no-op even with oversized values", () => {
    const logs1: string[] = [];
    const logs2: string[] = [];
    warnOnLargeStallWindows(
      { GSTACK_BUILD_KIMI_TIMEOUT: "3600000" },
      (msg) => logs1.push(msg),
    );
    warnOnLargeStallWindows(
      { GSTACK_BUILD_KIMI_TIMEOUT: "3600000" },
      (msg) => logs2.push(msg),
    );
    expect(logs1.length).toBeGreaterThan(0);
    expect(logs2).toEqual([]);
  });

  it("ignores non-numeric values", () => {
    const logs: string[] = [];
    warnOnLargeStallWindows(
      { GSTACK_BUILD_KIMI_TIMEOUT: "huge" },
      (msg) => logs.push(msg),
    );
    expect(logs).toEqual([]);
  });
});
