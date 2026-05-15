import { describe, it, expect } from "bun:test";
import { startHeartbeat } from "../heartbeat";

describe("startHeartbeat", () => {
  it("emits one RUN_HEARTBEAT line per scheduled tick", () => {
    const lines: string[] = [];
    let scheduled: (() => void) | null = null;
    const ctrl = startHeartbeat({
      runId: "run-x",
      getPhase: () => 2,
      write: (line) => lines.push(line),
      schedule: (fn) => {
        scheduled = fn;
        return { unref: () => {} };
      },
    });

    expect(typeof scheduled).toBe("function");

    // Three ticks → three lines.
    scheduled!();
    scheduled!();
    scheduled!();

    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line.trim());
      expect(parsed.event).toBe("RUN_HEARTBEAT");
      expect(parsed.runId).toBe("run-x");
      expect(parsed.phase).toBe(2);
      expect(typeof parsed.timestamp).toBe("string");
    }

    ctrl.stop();
  });

  it("stop() halts emission", () => {
    const lines: string[] = [];
    let scheduled: (() => void) | null = null;
    const ctrl = startHeartbeat({
      runId: "run-x",
      write: (line) => lines.push(line),
      schedule: (fn) => {
        scheduled = fn;
        return { unref: () => {} };
      },
    });

    scheduled!();
    expect(lines.length).toBe(1);

    ctrl.stop();
    scheduled!(); // tick after stop is a no-op
    expect(lines.length).toBe(1);
  });

  it("stop() is idempotent", () => {
    const ctrl = startHeartbeat({
      runId: "run-x",
      write: () => {},
      schedule: () => ({ unref: () => {} }),
    });
    expect(() => {
      ctrl.stop();
      ctrl.stop();
      ctrl.stop();
    }).not.toThrow();
  });

  it("unref()'s the scheduled handle so node can exit naturally", () => {
    let unreffed = 0;
    startHeartbeat({
      runId: "run-x",
      write: () => {},
      schedule: () => ({
        unref: () => {
          unreffed++;
        },
      }),
    });
    expect(unreffed).toBe(1);
  });

  it("stops emission on the first write error (EPIPE-style)", () => {
    let writeCalls = 0;
    let scheduled: (() => void) | null = null;
    const ctrl = startHeartbeat({
      runId: "run-x",
      write: () => {
        writeCalls++;
        throw new Error("EPIPE");
      },
      schedule: (fn) => {
        scheduled = fn;
        return { unref: () => {} };
      },
    });

    // First tick throws inside write, heartbeat catches and stops.
    expect(() => scheduled!()).not.toThrow();
    expect(writeCalls).toBe(1);

    // Subsequent ticks must NOT call write again (stop() was triggered).
    scheduled!();
    scheduled!();
    expect(writeCalls).toBe(1);

    ctrl.stop();
  });

  it("tickNow() emits a line for testability without waiting for the scheduler", () => {
    const lines: string[] = [];
    const ctrl = startHeartbeat({
      runId: "run-y",
      write: (line) => lines.push(line),
      schedule: () => ({ unref: () => {} }),
    });

    ctrl.tickNow();
    ctrl.tickNow();
    expect(lines.length).toBe(2);
    ctrl.stop();
  });
});
