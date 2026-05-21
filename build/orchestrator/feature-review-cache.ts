/**
 * T14: Disk-persistent cache for feature-review FEATURE_PASS verdicts.
 *
 * Why this exists: featureReviewAlreadySatisfied() at cli.ts:3638 is the
 * intra-/build resume short-circuit — it reads finalVerdict from state.json
 * and skips re-running the reviewer if the prior run already returned
 * FEATURE_PASS. That works only as long as state.json survives. When the
 * user re-runs /build after pruning ~/.gstack/build-state/, or in CI where
 * the state file isn't preserved, the intra-build cache is gone but the
 * feature's content + plan + reviewer config are often unchanged. This
 * cache catches that case.
 *
 * Cache key (sha256 hex):
 *   feature.number + feature.name + feature.body
 *   + sorted phase committedShas (from T7, stable across re-runs that
 *     don't re-commit)
 *   + plan file body
 *   + reviewer role label
 *
 * Only FEATURE_PASS is cached. Failures, REDO, and NEEDS_PHASES are not —
 * they imply something to fix or extend, so caching them would defeat the
 * point.
 *
 * Safety: when any phase is missing committedSha, computeCacheKey returns
 * the empty string and the caller falls through to a normal spawn. This
 * is the structural invariant — without committedSha we can't tell whether
 * the code has changed since the cached PASS, so we refuse to use the
 * cache rather than risk a false positive.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Feature, PhaseState } from "./types";

export interface CacheKeyInputs {
  feature: Feature;
  phaseStates: PhaseState[];
  /** Body of the source plan file at the time of caching. */
  planBody: string;
  /** Role identifier for the configured featureReview reviewer. */
  reviewerRoleLabel: string;
}

export interface CachedVerdict {
  /** Always "FEATURE_PASS" — only PASS is cached. Stored as string for forward-compat. */
  verdict: "FEATURE_PASS";
  /** Iteration at which the original PASS landed. Informational. */
  iteration: number;
  /** Output file path from the original spawn. May not exist anymore. */
  outputFilePath: string;
  /** ISO timestamp of original cache write. */
  cachedAt: string;
  /** Original slug for forensics. */
  originalSlug: string;
}

/**
 * Compute a stable sha256 key over the feature's content + phase shas +
 * plan body + reviewer role. Two /build invocations with identical
 * inputs produce identical keys; any change invalidates.
 *
 * Returns empty string when any phase is missing committedSha — caller
 * MUST treat empty string as "no cache available, fall through to spawn".
 */
export function computeCacheKey(args: CacheKeyInputs): string {
  const phaseShas = args.feature.phaseIndexes
    .map((i) => args.phaseStates[i]?.committedSha ?? "")
    .sort();
  // If ANY phase is missing a committedSha, refuse to compute a key
  // (the cache would be unsafe — caller falls through to normal spawn).
  if (phaseShas.some((s) => !s)) {
    return "";
  }
  const material = [
    `feature:${args.feature.number}|${args.feature.name}`,
    `body:${args.feature.body}`,
    `phases:${phaseShas.join(",")}`,
    `plan:${args.planBody}`,
    `reviewer:${args.reviewerRoleLabel}`,
  ].join("\n");
  return crypto.createHash("sha256").update(material).digest("hex");
}

/**
 * Returns the directory where cache entries for a given slug live.
 *
 * Path layout: when GSTACK_BUILD_STATE_DIR is set (tests + custom installs),
 * we go up one level then into projects/<slug>/feature-review-cache so the
 * cache sits alongside other per-project artifacts. When unset, defaults
 * to ~/.gstack/projects/<slug>/feature-review-cache.
 *
 * The dedicated feature-review-cache/ subdir namespaces this data away
 * from CEO plans, designs, and other per-project content under projects/.
 */
function cacheDir(slug: string): string {
  const base = process.env.GSTACK_BUILD_STATE_DIR
    ? path.resolve(process.env.GSTACK_BUILD_STATE_DIR, "..", "projects", slug)
    : path.join(os.homedir(), ".gstack", "projects", slug);
  return path.join(base, "feature-review-cache");
}

/**
 * Read a cached PASS verdict for `key` under `slug`. Returns null on
 * miss, parse error, or any non-PASS entry (defensive — we never want
 * to surface a cached non-PASS even if a future writer drifts).
 */
export function lookupCache(key: string, slug: string): CachedVerdict | null {
  if (!key) return null;
  const file = path.join(cacheDir(slug), `${key}.json`);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed.verdict === "FEATURE_PASS" &&
      typeof parsed.iteration === "number"
    ) {
      return parsed as CachedVerdict;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a PASS verdict to the cache. Best-effort: any I/O failure
 * (ENOSPC, EPERM, missing parent dir we can't create) is swallowed.
 * The cache is a latency optimization, not a correctness invariant —
 * a missed write just means the next /build re-runs the reviewer.
 */
export function storeCache(
  key: string,
  slug: string,
  value: CachedVerdict,
): void {
  if (!key) return;
  try {
    const dir = cacheDir(slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify(value, null, 2),
    );
  } catch {
    // Best-effort: cache write failures don't block the run.
  }
}
