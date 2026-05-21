/**
 * Tests for PR8 — CRITICAL R2: state-load auto-upgrade of halt-event kind.
 *
 * T2: A state JSON containing the old kind "MANUAL_RECOVERY_INVOKED" is
 *     auto-upgraded to "RECOVERY_BOUNDARY" in memory on loadState().
 *     The next saveState() persists the new name to disk.
 *
 * Edge cases:
 *   - Post-upgrade state already typed as RECOVERY_BOUNDARY — passes through.
 *   - State with a mix of both kinds (mid-flight) — both upgrade on read;
 *     second save normalizes.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, saveState, statePath } from "../state";

describe("state-load auto-upgrade MANUAL_RECOVERY_INVOKED → RECOVERY_BOUNDARY", () => {
  let realStateDir: string | undefined;
  let tmpStateDir: string;

  beforeEach(() => {
    realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    tmpStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-build-state-mantra-"),
    );
    process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
  });

  afterEach(() => {
    if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
    else delete process.env.GSTACK_BUILD_STATE_DIR;
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  function writeStateWithKind(
    slug: string,
    kindValue: string,
    extra?: Record<string, unknown>,
  ): void {
    const state = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "main",
      startedAt: "2026-05-21T00:00:00.000Z",
      lastUpdatedAt: "2026-05-21T00:00:00.000Z",
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "Foo", status: "pending" }],
      completed: false,
      // Custom field that carries the halt-event kind for migration testing.
      // migrateState() must deep-replace this value.
      lastHaltKind: kindValue,
      ...extra,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2));
  }

  test("T2: old kind in state JSON upgrades in memory on loadState", () => {
    const slug = "build-mantra-upgrade";
    writeStateWithKind(slug, "MANUAL_RECOVERY_INVOKED");

    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect((loaded as any).lastHaltKind).toBe("RECOVERY_BOUNDARY");
  });

  test("T2: upgraded in-memory value is written back on saveState", () => {
    const slug = "build-mantra-writeback";
    writeStateWithKind(slug, "MANUAL_RECOVERY_INVOKED");

    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect((loaded as any).lastHaltKind).toBe("RECOVERY_BOUNDARY");

    saveState(loaded!, { noGbrain: true });

    const raw = fs.readFileSync(statePath(slug), "utf8");
    const reloaded = JSON.parse(raw);
    expect(reloaded.lastHaltKind).toBe("RECOVERY_BOUNDARY");
    expect(raw).not.toContain("MANUAL_RECOVERY_INVOKED");
  });

  test("edge: post-upgrade RECOVERY_BOUNDARY passes through unchanged", () => {
    const slug = "build-mantra-post-upgrade";
    writeStateWithKind(slug, "RECOVERY_BOUNDARY");

    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect((loaded as any).lastHaltKind).toBe("RECOVERY_BOUNDARY");

    saveState(loaded!, { noGbrain: true });

    const raw = fs.readFileSync(statePath(slug), "utf8");
    const reloaded = JSON.parse(raw);
    expect(reloaded.lastHaltKind).toBe("RECOVERY_BOUNDARY");
  });

  test("edge: mix of both kinds in state → both upgrade on read; second save normalizes", () => {
    const slug = "build-mantra-mixed";
    const state = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "main",
      startedAt: "2026-05-21T00:00:00.000Z",
      lastUpdatedAt: "2026-05-21T00:00:00.000Z",
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "Foo", status: "pending" }],
      completed: false,
      // Multiple fields with different kinds
      lastHaltKind: "MANUAL_RECOVERY_INVOKED",
      haltEventLog: [
        { kind: "RECOVERY_BOUNDARY", message: "already upgraded" },
        { kind: "MANUAL_RECOVERY_INVOKED", message: "needs upgrade" },
      ],
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2));

    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();

    // All occurrences upgraded in memory
    expect((loaded as any).lastHaltKind).toBe("RECOVERY_BOUNDARY");
    expect((loaded as any).haltEventLog[0].kind).toBe("RECOVERY_BOUNDARY");
    expect((loaded as any).haltEventLog[1].kind).toBe("RECOVERY_BOUNDARY");

    saveState(loaded!, { noGbrain: true });

    const raw = fs.readFileSync(statePath(slug), "utf8");
    expect(raw).not.toContain("MANUAL_RECOVERY_INVOKED");
    const reloaded = JSON.parse(raw);
    expect(reloaded.lastHaltKind).toBe("RECOVERY_BOUNDARY");
    expect(reloaded.haltEventLog[0].kind).toBe("RECOVERY_BOUNDARY");
    expect(reloaded.haltEventLog[1].kind).toBe("RECOVERY_BOUNDARY");
  });

  test("edge: state without halt kind fields is untouched", () => {
    const slug = "build-mantra-no-kind";
    const state = {
      planFile: "/x/foo.md",
      planBasename: "foo",
      slug,
      branch: "main",
      startedAt: "2026-05-21T00:00:00.000Z",
      lastUpdatedAt: "2026-05-21T00:00:00.000Z",
      currentPhaseIndex: 0,
      phases: [{ index: 0, number: "1", name: "Foo", status: "pending" }],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2));

    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect((loaded as any).lastHaltKind).toBeUndefined();

    saveState(loaded!, { noGbrain: true });

    const raw = fs.readFileSync(statePath(slug), "utf8");
    const reloaded = JSON.parse(raw);
    expect(reloaded.phases[0].status).toBe("pending");
    expect(reloaded.lastHaltKind).toBeUndefined();
  });
});
