#!/usr/bin/env bun
/**
 * measure-halt-recurrence — compute per-category halt-recurrence baseline.
 *
 * Reads ~/.gstack/skill-faults/learned-patterns.json, sums hitCount per
 * category within the last 7 days, and writes a baseline JSON file.
 *
 * Usage:
 *   bun run scripts/measure-halt-recurrence.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LearnedPattern {
  category?: string;
  pattern?: string;
  hitCount?: number;
  lastHit?: string;
  [key: string]: unknown;
}

export interface PerCategoryResult {
  hits: number;
  lastHit: string;
  patternIds: string[];
}

export interface BaselineResult {
  window: "7d";
  capturedAt: string;
  perCategory: Record<string, PerCategoryResult>;
  total: number;
}

export interface MeasureOptions {
  gstackHome?: string;
  now?: Date;
}

function resolveGstackHome(options?: MeasureOptions): string {
  if (options?.gstackHome) return options.gstackHome;
  if (process.env.GSTACK_HOME) return process.env.GSTACK_HOME;
  return path.join(process.env.HOME || "/tmp", ".gstack");
}

function formatDateYMD(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function measureHaltRecurrence(
  options?: MeasureOptions,
): BaselineResult {
  const gstackHome = resolveGstackHome(options);
  const now = options?.now ? new Date(options.now) : new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const learnedPath = path.join(gstackHome, "skill-faults", "learned-patterns.json");
  let patterns: LearnedPattern[] = [];

  if (fs.existsSync(learnedPath)) {
    try {
      const raw = fs.readFileSync(learnedPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        patterns = parsed;
      }
    } catch {
      // malformed or unreadable — treat as empty
    }
  }

  const perCategory = new Map<string, PerCategoryResult>();

  for (const p of patterns) {
    if (!p.category || typeof p.category !== "string") continue;
    if (!p.lastHit || typeof p.lastHit !== "string") continue;

    const lastHitDate = new Date(p.lastHit);
    if (isNaN(lastHitDate.getTime())) continue;
    if (lastHitDate < cutoff) continue;

    const hits = typeof p.hitCount === "number" ? p.hitCount : 0;
    const patternId = typeof p.pattern === "string" ? p.pattern : "";

    const existing = perCategory.get(p.category);
    if (existing) {
      existing.hits += hits;
      if (patternId) existing.patternIds.push(patternId);
      if (p.lastHit > existing.lastHit) {
        existing.lastHit = p.lastHit;
      }
    } else {
      perCategory.set(p.category, {
        hits,
        lastHit: p.lastHit,
        patternIds: patternId ? [patternId] : [],
      });
    }
  }

  const perCategoryObj: Record<string, PerCategoryResult> = {};
  let total = 0;
  for (const [category, data] of perCategory) {
    perCategoryObj[category] = data;
    total += data.hits;
  }

  const result: BaselineResult = {
    window: "7d",
    capturedAt: now.toISOString(),
    perCategory: perCategoryObj,
    total,
  };

  const outFile = path.join(
    gstackHome,
    `halt-recurrence-baseline-${formatDateYMD(now)}.json`,
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  return result;
}

function main() {
  const result = measureHaltRecurrence();
  console.log(`Baseline written: ${result.total} total hits`);
  for (const [cat, data] of Object.entries(result.perCategory)) {
    console.log(`  ${cat}: ${data.hits} hits`);
  }
}

if (import.meta.main) {
  main();
}
