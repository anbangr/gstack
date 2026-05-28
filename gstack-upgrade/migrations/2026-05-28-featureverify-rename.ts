#!/usr/bin/env bun
/**
 * Migration: in user configure.cm files, when limits.featureReviewMaxIterations
 * is present but limits.featureVerifyMaxIterations is absent, copy the value
 * across. Same for timeoutsMs.featureReview -> timeoutsMs.featureVerify.
 * Idempotent: skips if the target keys already exist.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface MigrationResult {
  migrated: boolean;
  changes: string[];
}

export function migrate(configPath: string): MigrationResult {
  if (!fs.existsSync(configPath)) return { migrated: false, changes: [] };
  const raw = fs.readFileSync(configPath, "utf8");
  let config: {
    limits?: Record<string, unknown>;
    timeoutsMs?: Record<string, unknown>;
  };
  try {
    config = JSON.parse(raw);
  } catch {
    return {
      migrated: false,
      changes: [`skipped: ${configPath} not valid JSON`],
    };
  }
  const changes: string[] = [];
  const srcLimitVal = config.limits?.featureReviewMaxIterations;
  const isPositiveInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
  if (
    isPositiveInt(srcLimitVal) &&
    config.limits?.featureVerifyMaxIterations === undefined
  ) {
    config.limits!.featureVerifyMaxIterations = srcLimitVal;
    changes.push(
      `limits.featureVerifyMaxIterations := ${String(srcLimitVal)} (from featureReviewMaxIterations)`,
    );
  }
  const srcTimeoutVal = config.timeoutsMs?.featureReview;
  if (
    isPositiveInt(srcTimeoutVal) &&
    config.timeoutsMs?.featureVerify === undefined
  ) {
    config.timeoutsMs!.featureVerify = srcTimeoutVal;
    changes.push(
      `timeoutsMs.featureVerify := ${String(srcTimeoutVal)} (from featureReview)`,
    );
  }
  if (changes.length === 0)
    return { migrated: false, changes: ["already current"] };
  // Atomic write: tmp + rename. POSIX rename is atomic; on Windows it
  // succeeds when the destination already exists.
  const tmp = configPath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
  return { migrated: true, changes };
}

if (import.meta.main) {
  const target =
    process.argv[2] ||
    path.join(
      process.env.HOME || "",
      ".claude/skills/gstack/build/configure.cm",
    );
  const result = migrate(target);
  console.log(JSON.stringify(result, null, 2));
}
