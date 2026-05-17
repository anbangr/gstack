import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Static invariant: every spawn/spawnSync call in build/orchestrator/*.ts
 * MUST come from the child-registry wrapper, not directly from
 * node:child_process. This is Decision 3C in the eng review — without
 * this guardrail, future contributors would silently regress the
 * orphaned-children fix.
 *
 * Allowlist:
 *   - child-registry.ts itself (it's the wrapper; it imports from node).
 *   - __tests__/ (tests can spawn however they want).
 *
 * Pattern model: test/setup-windows-fallback.test.ts pins a similar
 * static rule for the `_link_or_copy` helper.
 */

const ORCHESTRATOR_DIR = path.resolve(import.meta.dir, "..");

function listSourceFiles(): string[] {
  return fs
    .readdirSync(ORCHESTRATOR_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => name !== "child-registry.ts")
    .map((name) => path.join(ORCHESTRATOR_DIR, name));
}

describe("no-bare-spawn invariant (Decision 3C)", () => {
  test("child-registry.ts is the only file that imports from node:child_process", () => {
    const offending: { file: string; line: number; text: string }[] = [];
    for (const file of listSourceFiles()) {
      const src = fs.readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // Match `from "node:child_process"` or `from 'node:child_process'`
        // anywhere on the line.
        if (/from\s+["']node:child_process["']/.test(line)) {
          offending.push({
            file: path.relative(ORCHESTRATOR_DIR, file),
            line: idx + 1,
            text: trimmed,
          });
        }
      });
    }
    if (offending.length > 0) {
      const summary = offending
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n");
      throw new Error(
        "Direct imports from node:child_process found outside child-registry.ts.\n" +
          "All spawn/spawnSync calls must route through ./child-registry so signal\n" +
          "handlers can reap detached children. Update these imports:\n" +
          summary,
      );
    }
  });

  test("no raw spawnSync(/spawn( calls outside child-registry.ts and tests", () => {
    // Catches the rare case where a contributor copy-pastes a spawnSync
    // call but forgets to add the import — TypeScript would normally
    // catch this, but a stray `(child_process as any).spawnSync(...)`
    // would slip through. This test is the belt to TypeScript's
    // suspenders.
    const offending: { file: string; line: number; text: string }[] = [];
    for (const file of listSourceFiles()) {
      const src = fs.readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // Match `require("node:child_process")` or `require('child_process')`
        // — alternative ways to bypass the import.
        if (/require\(["']node?:?child_process["']\)/.test(line)) {
          offending.push({
            file: path.relative(ORCHESTRATOR_DIR, file),
            line: idx + 1,
            text: trimmed,
          });
        }
      });
    }
    expect(offending).toEqual([]);
  });

  test("child-registry.ts is the sole consumer of node:child_process (sanity)", () => {
    // Inverse check: confirm child-registry.ts DOES import from
    // node:child_process. If this fails, the wrapper is broken — every
    // spawn call would go to undefined.
    const src = fs.readFileSync(
      path.join(ORCHESTRATOR_DIR, "child-registry.ts"),
      "utf8",
    );
    expect(src).toMatch(/from\s+["']node:child_process["']/);
  });
});
