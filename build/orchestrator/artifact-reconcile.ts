/**
 * Reconcile JSON build-state against on-disk codex review artifacts.
 *
 * Why this module exists: gstack-build writes `phase-N-{review|qa}-K-output.md`
 * artifacts to the per-slug log dir as Codex review iterations land. The JSON
 * state file is updated in a SEPARATE write (see applyResult in cli.ts and
 * phase-runner.ts), so a manual edit that nulls `phases[i].codexReview` does
 * not delete the artifacts — they survive on disk as the ground truth.
 *
 * This module reads that ground truth back into a CodexReviewState, used by
 * the `gstack-build reconcile --from-artifacts` path and the
 * `backfill-checkboxes.ts --from-artifacts` CLI flag.
 *
 * Pure functions only — no fs writes, no state.json writes. Callers compose
 * us with their existing lock + atomic-write pipeline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { BuildState, CodexReviewState, PhaseState } from "./types";

/** Output of a per-phase artifact scan. */
export interface PhaseArtifactSet {
  /** `phase-N-review-K-output.md` paths, sorted by K ascending. */
  reviewLogs: string[];
  /** `phase-N-qa-K-output.md` paths, sorted by K ascending. */
  qaLogs: string[];
  /** `phase-N-review-merged-K.md` paths, sorted by K ascending. */
  mergedFiles: string[];
  /** Max K across review+qa+merged. 0 when no artifacts found. */
  iterations: number;
}

const REVIEW_OUTPUT_RE = /^phase-(.+?)-review-(\d+)-output\.md$/;
const QA_OUTPUT_RE = /^phase-(.+?)-qa-(\d+)-output\.md$/;
const REVIEW_MERGED_RE = /^phase-(.+?)-review-merged-(\d+)\.md$/;

/**
 * Scan `logDirPath` for codex review artifacts belonging to `phaseNumber`.
 * Returns an empty set (iterations=0) if the directory does not exist or
 * holds no matching files. Never throws on missing-directory.
 */
export function findCodexReviewArtifacts(
  logDirPath: string,
  phaseNumber: string,
): PhaseArtifactSet {
  const empty: PhaseArtifactSet = {
    reviewLogs: [],
    qaLogs: [],
    mergedFiles: [],
    iterations: 0,
  };
  let entries: string[];
  try {
    entries = fs.readdirSync(logDirPath);
  } catch {
    return empty;
  }

  const reviews = new Map<number, string>();
  const qas = new Map<number, string>();
  const mergeds = new Map<number, string>();

  for (const name of entries) {
    let m: RegExpExecArray | null;
    m = REVIEW_OUTPUT_RE.exec(name);
    if (m && m[1] === phaseNumber) {
      reviews.set(parseInt(m[2], 10), path.join(logDirPath, name));
      continue;
    }
    m = QA_OUTPUT_RE.exec(name);
    if (m && m[1] === phaseNumber) {
      qas.set(parseInt(m[2], 10), path.join(logDirPath, name));
      continue;
    }
    m = REVIEW_MERGED_RE.exec(name);
    if (m && m[1] === phaseNumber) {
      mergeds.set(parseInt(m[2], 10), path.join(logDirPath, name));
      continue;
    }
  }

  const allIters = [...reviews.keys(), ...qas.keys(), ...mergeds.keys()];
  const iterations = allIters.length > 0 ? Math.max(...allIters) : 0;

  const sortByKey = (m: Map<number, string>): string[] =>
    [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  return {
    reviewLogs: sortByKey(reviews),
    qaLogs: sortByKey(qas),
    mergedFiles: sortByKey(mergeds),
    iterations,
  };
}

const VERDICT_RE = /\bGATE\s+PASS\b|\bGATE\s+FAIL\b|\bTIMEOUT\b/gi;

/**
 * Best-effort verdict parse over a `phase-N-review-merged-K.md` body.
 *
 * Returns the LAST recognizable verdict in the file. Codex reviewers
 * frequently quote prior verdicts before stating their own (e.g.
 * "Last run was GATE FAIL; this run is GATE PASS"), so last-occurrence
 * wins beats first-occurrence by a wide margin in practice.
 *
 * Returns undefined when no recognizable verdict is found. Callers
 * SHOULD still set `derivedFromArtifacts: true` on the surrounding
 * CodexReviewState — the absence of a parseable verdict is information,
 * not an error.
 */
export function parseVerdictFromMerged(
  content: string,
): CodexReviewState["finalVerdict"] | undefined {
  const matches = content.match(VERDICT_RE);
  if (!matches || matches.length === 0) return undefined;
  const last = matches[matches.length - 1].toUpperCase().replace(/\s+/g, " ");
  if (last === "GATE PASS") return "GATE PASS";
  if (last === "GATE FAIL") return "GATE FAIL";
  if (last === "TIMEOUT") return "TIMEOUT";
  return undefined;
}

/** Outcome row for a single phase. */
export interface PhaseReconcileResult {
  phaseIndex: number;
  phaseNumber: string;
  /**
   * Action taken:
   *  - `derived`: state had null/missing codexReview, artifacts exist on
   *    disk, we populated codexReview from them.
   *  - `kept`: state already had a codexReview; we did NOT clobber.
   *  - `no-artifacts`: state had null codexReview, no artifacts on disk,
   *    nothing to do.
   */
  action: "derived" | "kept" | "no-artifacts";
  iterations: number;
  reviewCount: number;
  qaCount: number;
  mergedCount: number;
  finalVerdict: CodexReviewState["finalVerdict"] | undefined;
}

/**
 * Reconcile every phase in `state.phases` against on-disk artifacts under
 * `logDirPath`. Mutates `state.phases[i].codexReview` only when the field
 * was null/undefined AND artifacts exist; never overwrites a populated
 * codexReview (live data wins).
 *
 * Returns one row per phase so the caller can print or test.
 */
export function reconcileCodexReviewFromArtifacts(
  state: BuildState,
  logDirPath: string,
): PhaseReconcileResult[] {
  const out: PhaseReconcileResult[] = [];
  const phases: PhaseState[] = state.phases ?? [];

  for (let i = 0; i < phases.length; i++) {
    const ps = phases[i];
    const artifacts = findCodexReviewArtifacts(logDirPath, ps.number);

    if (ps.codexReview != null && ps.codexReview !== undefined) {
      out.push({
        phaseIndex: i,
        phaseNumber: ps.number,
        action: "kept",
        iterations: artifacts.iterations,
        reviewCount: artifacts.reviewLogs.length,
        qaCount: artifacts.qaLogs.length,
        mergedCount: artifacts.mergedFiles.length,
        finalVerdict: ps.codexReview.finalVerdict,
      });
      continue;
    }

    if (artifacts.iterations === 0) {
      out.push({
        phaseIndex: i,
        phaseNumber: ps.number,
        action: "no-artifacts",
        iterations: 0,
        reviewCount: 0,
        qaCount: 0,
        mergedCount: 0,
        finalVerdict: undefined,
      });
      continue;
    }

    let finalVerdict: CodexReviewState["finalVerdict"] | undefined;
    if (artifacts.mergedFiles.length > 0) {
      const latest = artifacts.mergedFiles[artifacts.mergedFiles.length - 1];
      try {
        const body = fs.readFileSync(latest, "utf8");
        finalVerdict = parseVerdictFromMerged(body);
      } catch {
        finalVerdict = undefined;
      }
    }

    const outputLogPaths = [...artifacts.reviewLogs, ...artifacts.qaLogs];
    const outputFilePaths = [...artifacts.reviewLogs, ...artifacts.qaLogs];

    ps.codexReview = {
      iterations: artifacts.iterations,
      finalVerdict,
      outputLogPaths,
      outputFilePaths,
      derivedFromArtifacts: true,
    };

    out.push({
      phaseIndex: i,
      phaseNumber: ps.number,
      action: "derived",
      iterations: artifacts.iterations,
      reviewCount: artifacts.reviewLogs.length,
      qaCount: artifacts.qaLogs.length,
      mergedCount: artifacts.mergedFiles.length,
      finalVerdict,
    });
  }

  return out;
}
