/**
 * Per-spawn JSONL instrumentation for the pre-merge feature verifier (T12).
 *
 * Mirrors feature-review-metrics.ts. Exists to answer the open question from
 * the featureReview-vs-featureVerifier overlap analysis: does T12 ever earn
 * its keep? T12 runs right after F3 (featureReview) and audits the same
 * feature against acceptance criteria, so T12 is non-redundant in two cases,
 * BOTH of which the schema must distinguish (a flat `featureReviewVerdict`
 * alone cannot — it collapses "F3 passed it" with "F3 never looked at it"):
 *
 *   1. T12 flags GAPS on a feature F3 RAN and PASSED:
 *        select(.verdict=="GAPS" and .featureReviewRan and
 *               .featureReviewVerdict=="FEATURE_PASS")
 *   2. T12 flags GAPS on a feature F3 SKIPPED entirely (heuristic skip,
 *      --skip-feature-review, or not configured) — arguably the STRONGEST
 *      keep-signal, since F3 never even looked:
 *        select(.verdict=="GAPS" and (.featureReviewRan | not))
 *
 * `featureReviewRan` is the disambiguator. Without it, case 2 hides under a
 * null verdict and the demote decision under-counts T12's value.
 *
 * Schema is intentionally flat. One row per verifier spawn, appended JSONL.
 * Best-effort write: never throws into the caller; failures only surface
 * under GSTACK_BUILD_DEBUG.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FeatureVerifierMetricsRow {
  ts: string;
  feature: string;
  /** Run-level slug (one value per build run) so all of a run's feature rows group together. */
  slug: string;
  /** Verifier verdict for this feature. */
  verdict: "PASS" | "GAPS" | "UNCLEAR";
  /** Number of distinct gaps the verifier listed (0 for PASS / UNCLEAR). */
  gapsCount: number;
  /**
   * Whether F3 (featureReview) actually ran for this feature. False when F3
   * was skipped by the shouldSkipFeatureReview heuristic (the common fast
   * path for small clean features), by --skip-feature-review, or because the
   * role is not configured. This is the disambiguator: a null
   * featureReviewVerdict means BOTH "F3 ran but recorded nothing" and "F3
   * never ran" unless you also read this flag. GAPS && !featureReviewRan is
   * the strongest keep-signal — T12 caught a feature F3 never looked at.
   */
  featureReviewRan: boolean;
  /**
   * The featureReview (F3) finalVerdict recorded for this same feature, or
   * null if F3 did not run (skipped by heuristic, or not configured). Read
   * together with featureReviewRan: verdict==="GAPS" && featureReviewRan &&
   * featureReviewVerdict==="FEATURE_PASS" is the population that proves T12
   * caught something F3 RAN and passed.
   */
  featureReviewVerdict: string | null;
  /** True when the feature carried an Increment-3 Verification Spec (structured probes). */
  structured: boolean;
  /** True when the run used --strict-pre-merge-verify (UNCLEAR halts ship). */
  strictMode: boolean;
  /** Reason string for UNCLEAR verdicts (timeout, missing sentinel, etc.); null otherwise. */
  reason: string | null;
  wallMs: number;
  outputBytes: number;
}

function metricsDir(): string {
  // GSTACK_BUILD_STATE_DIR is used by tests as `<tmpdir>/build-state`.
  // Put metrics in a sibling `analytics/` so tests can inspect without
  // polluting ~/.gstack/.
  if (process.env.GSTACK_BUILD_STATE_DIR) {
    return path.resolve(process.env.GSTACK_BUILD_STATE_DIR, "..", "analytics");
  }
  return path.join(os.homedir(), ".gstack", "analytics");
}

export function writeFeatureVerifierMetrics(
  row: FeatureVerifierMetricsRow,
): void {
  try {
    const dir = metricsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "feature-verifier-metrics.jsonl"),
      JSON.stringify(row) + "\n",
    );
  } catch (err) {
    if (process.env.GSTACK_BUILD_DEBUG) {
      console.warn(
        `feature-verifier-metrics: write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
