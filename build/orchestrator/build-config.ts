import * as fs from "fs";
import * as path from "path";
import type {
  RoleConfigs,
  RoleKey,
  RoleProvider,
  RoleReasoning,
} from "./role-config";

export interface BuildLimits {
  codexMaxIterations: number;
  redSpecMaxIterations: number;
  testMaxIterations: number;
  originVerificationMaxIterations: number;
  /**
   * Default cap on per-feature meta-review cycles (FEATURE_REDO loops).
   * Hitting the cap prompts the user via stdin readline; non-TTY runs
   * fail the feature and write BLOCKED-feature-N.md.
   */
  featureReviewMaxIterations: number;
}

export interface BuildTimeoutsMs {
  gemini: number;
  kimi: number;
  codex: number;
  ship: number;
  test: number;
  judge: number;
  /** Per-invocation timeout for the configurable feature-level reviewer. */
  featureReview: number;
  /** Per-invocation timeout for the plan-level second-opinion reviewer. */
  planReview: number;
}

export interface BuildDefaults {
  roles: RoleConfigs;
  limits: BuildLimits;
  timeoutsMs: BuildTimeoutsMs;
  /**
   * Glob patterns for files that always warrant a feature-review even when
   * the size/iter skip heuristic would otherwise skip. Defense against the
   * case where a small, clean diff happens to weaken a security control.
   * When undefined or empty, no file-path safety gate is applied.
   * See shouldSkipFeatureReview in feature-review.ts (T11).
   */
  alwaysReviewPaths: string[];
}

export const DEFAULT_BUILD_CONFIG_FILE = path.join(
  import.meta.dir,
  "..",
  "configure.cm",
);

const ROLE_KEYS: RoleKey[] = [
  "testWriter",
  "primaryImpl",
  "testFixer",
  "secondaryImpl",
  "review",
  "reviewSecondary",
  "qa",
  "ship",
  "land",
  "judge",
  "featureReview",
  "monitorAgent",
  "planReviewer",
];

const PROVIDERS: RoleProvider[] = ["claude", "codex", "gemini", "kimi"];
const REASONING: RoleReasoning[] = ["low", "medium", "high", "xhigh"];

export function loadBuildDefaults(
  filePath: string = process.env.GSTACK_BUILD_CONFIG_FILE ||
    process.env.GSTACK_BUILD_DEFAULTS_FILE ||
    DEFAULT_BUILD_CONFIG_FILE,
): BuildDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to load build config from ${filePath}: ${(err as Error).message}`,
    );
  }

  const config = parsed as Partial<BuildDefaults>;
  const roles = validateRoles(
    withMigratedRoles(config.roles, filePath),
    filePath,
  );
  const limits = validateNumberSection(
    withMigratedNumberSection(
      config.limits,
      "limits",
      ["featureReviewMaxIterations"],
      filePath,
    ),
    [
      "codexMaxIterations",
      "redSpecMaxIterations",
      "testMaxIterations",
      "originVerificationMaxIterations",
      "featureReviewMaxIterations",
    ],
    `${filePath}:limits`,
  ) as unknown as BuildLimits;
  const timeoutsMs = validateNumberSection(
    withMigratedNumberSection(
      config.timeoutsMs,
      "timeoutsMs",
      ["kimi", "featureReview", "planReview"],
      filePath,
    ),
    [
      "gemini",
      "kimi",
      "codex",
      "ship",
      "test",
      "judge",
      "featureReview",
      "planReview",
    ],
    `${filePath}:timeoutsMs`,
  ) as unknown as BuildTimeoutsMs;
  const alwaysReviewPaths = validateAlwaysReviewPaths(
    withMigratedAlwaysReviewPaths(
      (config as unknown as { alwaysReviewPaths?: unknown }).alwaysReviewPaths,
      filePath,
    ),
    `${filePath}:alwaysReviewPaths`,
  );

  return { roles, limits, timeoutsMs, alwaysReviewPaths };
}

/**
 * Backfill alwaysReviewPaths when missing from an older user-edited
 * configure.cm. Pulls from the in-tree default; if loading the default
 * file itself, leave as-is so a missing/invalid value still surfaces.
 */
function withMigratedAlwaysReviewPaths(
  value: unknown,
  filePath: string,
): unknown {
  if (value !== undefined) return value;
  const isLoadingDefault =
    path.resolve(filePath) === path.resolve(DEFAULT_BUILD_CONFIG_FILE);
  if (isLoadingDefault) return value;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(DEFAULT_BUILD_CONFIG_FILE, "utf8"),
    ) as { alwaysReviewPaths?: unknown };
    return parsed.alwaysReviewPaths;
  } catch {
    return value;
  }
}

function validateAlwaysReviewPaths(value: unknown, label: string): string[] {
  // Treat missing as empty array (safety gate disabled) rather than throwing.
  // The default file always defines it, so this only matters for older
  // user-edited configs where the migration also didn't find a default.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings when present`);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(
        `${label}[${i}] must be a non-empty string glob pattern`,
      );
    }
    out.push(item);
  }
  return out;
}

function withMigratedRoles(value: unknown, filePath: string): unknown {
  if (!value || typeof value !== "object") return value;
  const roles = { ...(value as Record<string, unknown>) };
  // Backfill roles added after a config file was first written so older
  // user-edited configure.cm files do not throw on load. Each new role
  // pulls its definition from the in-tree default config file. Skip when
  // already loading the default file (would recurse) and when the field
  // is already present (user explicitly set it).
  const isLoadingDefault =
    path.resolve(filePath) === path.resolve(DEFAULT_BUILD_CONFIG_FILE);
  delete roles.contextSave;
  for (const key of [
    "featureReview",
    "monitorAgent",
    "planReviewer",
  ] as const) {
    if (!roles[key] && !isLoadingDefault) roles[key] = readDefaultRole(key);
  }
  return roles;
}

function readDefaultRole(key: RoleKey): unknown {
  const parsed = JSON.parse(
    fs.readFileSync(DEFAULT_BUILD_CONFIG_FILE, "utf8"),
  ) as Partial<BuildDefaults>;
  return (parsed.roles as Record<string, unknown> | undefined)?.[key];
}

/**
 * Backfill numeric config keys added after a user's configure.cm was first
 * written. Without this, adding `featureReviewMaxIterations` would throw
 * `must be a positive number` on every existing install. Pulls each missing
 * key's value from the in-tree default config so user files don't need
 * regeneration.
 */
function withMigratedNumberSection(
  value: unknown,
  section: "limits" | "timeoutsMs",
  newKeys: string[],
  filePath: string,
): unknown {
  if (!value || typeof value !== "object") return value;
  const isLoadingDefault =
    path.resolve(filePath) === path.resolve(DEFAULT_BUILD_CONFIG_FILE);
  if (isLoadingDefault) return value;
  const out = { ...(value as Record<string, unknown>) };
  let defaults: Record<string, unknown> | undefined;
  for (const key of newKeys) {
    if (out[key] === undefined) {
      if (!defaults) {
        const parsed = JSON.parse(
          fs.readFileSync(DEFAULT_BUILD_CONFIG_FILE, "utf8"),
        ) as Partial<BuildDefaults>;
        defaults =
          ((parsed as unknown as Record<string, unknown>)[section] as Record<
            string,
            unknown
          >) ?? {};
      }
      const fallback = defaults[key];
      if (fallback !== undefined) out[key] = fallback;
    }
  }
  return out;
}

function validateRoles(value: unknown, filePath: string): RoleConfigs {
  if (!value || typeof value !== "object") {
    throw new Error(`${filePath}:roles must be an object`);
  }
  const roles = value as Record<string, any>;
  for (const key of ROLE_KEYS) {
    const role = roles[key];
    if (!role || typeof role !== "object") {
      throw new Error(`${filePath}:roles.${key} must be an object`);
    }
    if (!PROVIDERS.includes(role.provider)) {
      throw new Error(
        `${filePath}:roles.${key}.provider must be one of: ${PROVIDERS.join(", ")}`,
      );
    }
    if (typeof role.model !== "string" || role.model.trim() === "") {
      throw new Error(
        `${filePath}:roles.${key}.model must be a non-empty string`,
      );
    }
    if (!REASONING.includes(role.reasoning)) {
      throw new Error(
        `${filePath}:roles.${key}.reasoning must be one of: ${REASONING.join(", ")}`,
      );
    }
    if (role.command != null && typeof role.command !== "string") {
      throw new Error(
        `${filePath}:roles.${key}.command must be a string when present`,
      );
    }
    if (role.backupProvider != null && !PROVIDERS.includes(role.backupProvider)) {
      throw new Error(
        `${filePath}:roles.${key}.backupProvider must be one of: ${PROVIDERS.join(", ")}`,
      );
    }
    if (role.backupModel != null && typeof role.backupModel !== "string") {
      throw new Error(
        `${filePath}:roles.${key}.backupModel must be a string when present`,
      );
    }
    if (
      role.timeoutMs != null &&
      (!Number.isInteger(role.timeoutMs) || role.timeoutMs <= 0)
    ) {
      throw new Error(
        `${filePath}:roles.${key}.timeoutMs must be a positive integer (ms) when present`,
      );
    }
    if (
      role.backupTimeoutMs != null &&
      (!Number.isInteger(role.backupTimeoutMs) || role.backupTimeoutMs <= 0)
    ) {
      throw new Error(
        `${filePath}:roles.${key}.backupTimeoutMs must be a positive integer (ms) when present`,
      );
    }
  }
  return roles as RoleConfigs;
}

function validateNumberSection(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, number> {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const section = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const n = section[key];
    if (!Number.isFinite(n) || (n as number) <= 0) {
      throw new Error(`${label}.${key} must be a positive number`);
    }
    out[key] = n as number;
  }
  return out;
}

export const BUILD_DEFAULTS = loadBuildDefaults();

export function envNumberOrDefault(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Under liveness semantics, GSTACK_BUILD_*_TIMEOUT env vars represent stall
 * windows (max ms of silence), not wall-clock budgets. Values above 30min
 * almost certainly come from the old model where users padded the budget to
 * avoid mid-flight kills. That's no longer needed — emit a one-line nudge
 * pointing at the semantic shift.
 *
 * Idempotent: only logs once per process. Logs nothing if no oversized env
 * vars are set, so quiet defaults stay quiet.
 */
const LARGE_STALL_WINDOW_THRESHOLD_MS = 30 * 60 * 1000;
const STALL_ENV_VARS = [
  "GSTACK_BUILD_GEMINI_TIMEOUT",
  "GSTACK_BUILD_KIMI_TIMEOUT",
  "GSTACK_BUILD_CODEX_TIMEOUT",
  "GSTACK_BUILD_TEST_TIMEOUT",
  "GSTACK_BUILD_SHIP_TIMEOUT",
  "GSTACK_BUILD_FEATURE_REVIEW_TIMEOUT",
  "GSTACK_BUILD_JUDGE_TIMEOUT",
  "GSTACK_BUILD_MONITOR_AGENT_TIMEOUT_MS",
];
let warnOnLargeStallWindowsCalled = false;
export function warnOnLargeStallWindows(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (msg) => console.warn(msg),
): void {
  if (warnOnLargeStallWindowsCalled) return;
  warnOnLargeStallWindowsCalled = true;
  const oversized: Array<{ name: string; valueMs: number }> = [];
  for (const name of STALL_ENV_VARS) {
    const raw = env[name];
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= LARGE_STALL_WINDOW_THRESHOLD_MS) continue;
    oversized.push({ name, valueMs: n });
  }
  if (oversized.length === 0) return;
  log(
    `[gstack-build] ${oversized.length} timeout env var${oversized.length === 1 ? "" : "s"} set above 30min. ` +
      `Under liveness semantics these are STALL WINDOWS (max ms of silence), not wall-clock budgets — ` +
      `oversized values probably aren't doing what you expect.`,
  );
  for (const { name, valueMs } of oversized) {
    log(`  ${name}=${valueMs}ms (${Math.round(valueMs / 60000)}min)`);
  }
}

/** Test-only: reset the one-shot warning flag. */
export function _resetWarnOnLargeStallWindowsForTest(): void {
  warnOnLargeStallWindowsCalled = false;
}
