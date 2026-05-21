import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, statePath } from "../state";

// PR1b state migration: state files written before iterationsSuccessful and
// providerRetryAttempts existed must load cleanly, with the new fields
// backfilled. Pin these invariants so a future refactor doesn't quietly
// break resume-from-pre-PR1b state.

let realStateDir: string | undefined;
let tmpStateDir: string;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-pr1b-migration-"),
  );
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

function writePreMigrationState(slug: string, body: object): void {
  const p = statePath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(body, null, 2));
}

describe("PR1b state migration", () => {
  it("backfills iterationsSuccessful from iterations when missing", () => {
    const slug = "build-pr1b-migrate-iter";
    writePreMigrationState(slug, {
      slug,
      planFile: "/tmp/p.md",
      branch: "feat/x",
      lastUpdatedAt: "2026-05-21T00:00:00Z",
      features: [
        { index: 0, number: "1", phaseIndexes: [0], status: "running" },
      ],
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_red",
          codexReview: {
            iterations: 3,
            outputLogPaths: ["a.log", "b.log", "c.log"],
            // No iterationsSuccessful field — pre-PR1b state.
          },
        },
      ],
    });
    const state = loadState(slug, { noGbrain: true })!;
    expect(state.phases[0].codexReview?.iterationsSuccessful).toBe(3);
  });

  it("preserves an explicitly-set iterationsSuccessful", () => {
    const slug = "build-pr1b-preserve-iter";
    writePreMigrationState(slug, {
      slug,
      planFile: "/tmp/p.md",
      branch: "feat/x",
      lastUpdatedAt: "2026-05-21T00:00:00Z",
      features: [
        { index: 0, number: "1", phaseIndexes: [0], status: "running" },
      ],
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_red",
          codexReview: {
            iterations: 4,
            iterationsSuccessful: 2, // mid-PR1b state: 2 of 4 were verdict-writing
            outputLogPaths: [],
          },
        },
      ],
    });
    const state = loadState(slug, { noGbrain: true })!;
    expect(state.phases[0].codexReview?.iterationsSuccessful).toBe(2);
    expect(state.phases[0].codexReview?.iterations).toBe(4);
  });

  it("does not touch phases without a codexReview field", () => {
    const slug = "build-pr1b-no-codex";
    writePreMigrationState(slug, {
      slug,
      planFile: "/tmp/p.md",
      branch: "feat/x",
      lastUpdatedAt: "2026-05-21T00:00:00Z",
      features: [
        { index: 0, number: "1", phaseIndexes: [0], status: "pending" },
      ],
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "pending",
          // No codexReview at all.
        },
      ],
    });
    const state = loadState(slug, { noGbrain: true })!;
    expect(state.phases[0].codexReview).toBeUndefined();
  });

  it("backfills providerRetryAttempts to 0 when missing", () => {
    const slug = "build-pr1b-backfill-retry";
    writePreMigrationState(slug, {
      slug,
      planFile: "/tmp/p.md",
      branch: "feat/x",
      lastUpdatedAt: "2026-05-21T00:00:00Z",
      features: [
        { index: 0, number: "1", phaseIndexes: [0, 1], status: "running" },
      ],
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase A",
          status: "committed",
          // No providerRetryAttempts.
        },
        {
          index: 1,
          number: "2",
          name: "Phase B",
          status: "tests_red",
          // No providerRetryAttempts.
        },
      ],
    });
    const state = loadState(slug, { noGbrain: true })!;
    expect(state.phases[0].providerRetryAttempts).toBe(0);
    expect(state.phases[1].providerRetryAttempts).toBe(0);
  });

  it("preserves an explicitly-set providerRetryAttempts", () => {
    const slug = "build-pr1b-preserve-retry";
    writePreMigrationState(slug, {
      slug,
      planFile: "/tmp/p.md",
      branch: "feat/x",
      lastUpdatedAt: "2026-05-21T00:00:00Z",
      features: [
        { index: 0, number: "1", phaseIndexes: [0], status: "running" },
      ],
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_red",
          providerRetryAttempts: 3, // resuming mid-budget
        },
      ],
    });
    const state = loadState(slug, { noGbrain: true })!;
    expect(state.phases[0].providerRetryAttempts).toBe(3);
  });

  it("co-migrates iterationsSuccessful + providerRetryAttempts in one phase", () => {
    const slug = "build-pr1b-co-migrate";
    writePreMigrationState(slug, {
      slug,
      planFile: "/tmp/p.md",
      branch: "feat/x",
      lastUpdatedAt: "2026-05-21T00:00:00Z",
      features: [
        { index: 0, number: "1", phaseIndexes: [0], status: "running" },
      ],
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_red",
          codexReview: { iterations: 2, outputLogPaths: [] },
        },
      ],
    });
    const state = loadState(slug, { noGbrain: true })!;
    expect(state.phases[0].codexReview?.iterationsSuccessful).toBe(2);
    expect(state.phases[0].providerRetryAttempts).toBe(0);
  });
});
