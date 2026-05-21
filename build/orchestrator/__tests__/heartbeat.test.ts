import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startHeartbeat,
  removeHeartbeatSidecar,
  __heartbeatInternals,
} from "../heartbeat";

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

describe("startHeartbeat — sidecar", () => {
  it("embeds the state snapshot in both the stdout line and the sidecar payload", () => {
    const lines: string[] = [];
    const sidecarWrites: { path: string; payload: string }[] = [];
    const ctrl = startHeartbeat({
      runId: "run-x",
      pid: 1234,
      stateSlug: "build-x",
      heartbeatFilePath: "/tmp/heartbeat-x.json",
      getStateSnapshot: () => ({
        lastUpdatedAt: "2026-05-21T00:30:00Z",
        currentPhaseIndex: 3,
        drainProcessedCount: 7,
      }),
      write: (line) => lines.push(line),
      writeSidecar: (p, payload) => sidecarWrites.push({ path: p, payload }),
      schedule: () => ({ unref: () => {} }),
    });

    ctrl.tickNow();

    expect(lines.length).toBe(1);
    const parsedLine = JSON.parse(lines[0].trim());
    expect(parsedLine.event).toBe("RUN_HEARTBEAT");
    expect(parsedLine.runId).toBe("run-x");
    expect(parsedLine.phase).toBe(3);
    expect(parsedLine.stateLastUpdatedAt).toBe("2026-05-21T00:30:00Z");
    expect(parsedLine.drainProcessedCount).toBe(7);

    expect(sidecarWrites.length).toBe(1);
    expect(sidecarWrites[0].path).toBe("/tmp/heartbeat-x.json");
    const parsedSidecar = JSON.parse(sidecarWrites[0].payload);
    expect(parsedSidecar.runId).toBe("run-x");
    expect(parsedSidecar.pid).toBe(1234);
    expect(parsedSidecar.stateSlug).toBe("build-x");
    expect(parsedSidecar.phase).toBe(3);
    expect(parsedSidecar.stateLastUpdatedAt).toBe("2026-05-21T00:30:00Z");
    expect(parsedSidecar.drainProcessedCount).toBe(7);

    ctrl.stop();
  });

  it("omits the sidecar entirely when heartbeatFilePath is not provided", () => {
    const lines: string[] = [];
    let sidecarCalled = 0;
    const ctrl = startHeartbeat({
      runId: "run-x",
      getStateSnapshot: () => ({ lastUpdatedAt: "2026-05-21T00:00:00Z" }),
      write: (line) => lines.push(line),
      writeSidecar: () => {
        sidecarCalled++;
      },
      schedule: () => ({ unref: () => {} }),
    });

    ctrl.tickNow();
    expect(lines.length).toBe(1);
    expect(sidecarCalled).toBe(0);

    ctrl.stop();
  });

  it("handles getStateSnapshot returning undefined fields without crashing", () => {
    const lines: string[] = [];
    const sidecarWrites: string[] = [];
    const ctrl = startHeartbeat({
      runId: "run-x",
      heartbeatFilePath: "/tmp/heartbeat-x.json",
      getStateSnapshot: () => ({}),
      write: (line) => lines.push(line),
      writeSidecar: (_p, payload) => sidecarWrites.push(payload),
      schedule: () => ({ unref: () => {} }),
    });

    ctrl.tickNow();

    const parsedLine = JSON.parse(lines[0].trim());
    expect(parsedLine.stateLastUpdatedAt).toBeUndefined();
    expect(parsedLine.drainProcessedCount).toBeUndefined();

    const parsedSidecar = JSON.parse(sidecarWrites[0]);
    expect(parsedSidecar.stateLastUpdatedAt).toBeUndefined();
    expect(parsedSidecar.drainProcessedCount).toBeUndefined();

    ctrl.stop();
  });

  it("logs once and keeps stdout ticking when sidecar write fails", () => {
    const lines: string[] = [];
    let scheduled: (() => void) | null = null;
    const ctrl = startHeartbeat({
      runId: "run-x",
      heartbeatFilePath: "/tmp/heartbeat-x.json",
      getStateSnapshot: () => ({ lastUpdatedAt: "2026-05-21T00:00:00Z" }),
      write: (line) => lines.push(line),
      writeSidecar: () => {
        throw new Error("ENOSPC");
      },
      schedule: (fn) => {
        scheduled = fn;
        return { unref: () => {} };
      },
    });

    scheduled!();
    scheduled!();
    scheduled!();

    // Three ticks of the heartbeat line PLUS exactly one
    // RUN_HEARTBEAT_SIDECAR_FAILED warning on the first failure only.
    const events = lines.map((l) => JSON.parse(l.trim()).event);
    expect(events.filter((e) => e === "RUN_HEARTBEAT").length).toBe(3);
    expect(events.filter((e) => e === "RUN_HEARTBEAT_SIDECAR_FAILED").length).toBe(1);

    ctrl.stop();
  });

  it("defaultWriteSidecar uses tmp + rename atomic write semantics", () => {
    // Real fs: verify the atomic write produces a complete file (or no file)
    // and never the empty/partial state truncate-write would create.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-atomic-"));
    const target = path.join(dir, "build-x.heartbeat.json");

    __heartbeatInternals.defaultWriteSidecar(
      target,
      JSON.stringify({ ts: "2026-05-21T00:00:00Z", runId: "run-x" }),
    );

    expect(fs.existsSync(target)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(parsed.runId).toBe("run-x");

    // No leftover tmp file in the directory.
    const remaining = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(remaining.length).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sidecarPathFor returns per-run path under stateDir", () => {
    const p = __heartbeatInternals.sidecarPathFor(
      "/home/u/.gstack/build-state",
      "build-x",
    );
    expect(p).toBe("/home/u/.gstack/build-state/build-x.heartbeat.json");
  });

  it("removeHeartbeatSidecar is best-effort and never throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-rm-"));
    const target = path.join(dir, "build-x.heartbeat.json");
    fs.writeFileSync(target, "{}");
    expect(fs.existsSync(target)).toBe(true);

    removeHeartbeatSidecar(target);
    expect(fs.existsSync(target)).toBe(false);

    // Double-remove is a no-op, no throw.
    expect(() => removeHeartbeatSidecar(target)).not.toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
