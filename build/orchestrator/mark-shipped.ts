import {
  deriveStateSlug,
  loadState,
  saveState,
} from "./state";
import {
  isPidAlive,
  readActiveRunRecords,
} from "./active-runs";
import { findMergedPRForBranch, readMergedPRInfo } from "./pr-info";
import type { FeatureState } from "./types";

export interface MarkShippedArgs {
  /** Path to the plan markdown file (used to derive the state slug). */
  planFile: string;
  /** Feature number as it appears in the plan heading (e.g. "1", "2.3"). */
  feature: string;
  /** Optional PR number override. Auto-resolved via `gh pr list` if omitted. */
  pr?: number;
  /** Optional merge SHA override. Auto-resolved via `gh pr view` if omitted. */
  mergeSha?: string;
  /** Don't push state to gbrain (local-only write). */
  noGbrain: boolean;
  /** Active-run registry directory (matches the orchestrator's --active-run-registry). */
  activeRunRegistry: string;
  /** Optional explicit run id (matches the orchestrator's --run-id). */
  runId?: string;
}

export interface MarkShippedDeps {
  /** Working directory the gh subprocess should run in (defaults to process.cwd()). */
  cwd?: string;
  /** Override for the gh binary path (used by tests). */
  ghBinary?: string;
  /** Test-only injection of the merged-PR resolver. */
  findMergedPRForBranch?: typeof findMergedPRForBranch;
  /** Test-only injection of the merge-info reader. */
  readMergedPRInfo?: typeof readMergedPRInfo;
  /** Test-only override of "now". */
  now?: () => Date;
  /** Test-only logger. */
  log?: (msg: string) => void;
  /** Test-only error logger. */
  err?: (msg: string) => void;
}

export interface MarkShippedResult {
  exitCode: number;
  /** Index of the feature that was acted on (or attempted). -1 on early failure. */
  featureIndex: number;
  /** True when the feature was already in the canonical terminal shape (no write happened). */
  noop: boolean;
}

/**
 * `gstack-build mark-shipped` — the operator escape hatch.
 *
 * Use case: a feature was merged outside the orchestrator's normal pipeline
 * (manual ship from another lane, parallel merge, recovery after a killed
 * orchestrator) and the orchestrator's anti-tamper detector is now refusing
 * to skip it on the next run. This subcommand writes the canonical terminal
 * state shape that `isFeatureTerminal()` trusts:
 *   status = "committed"
 *   completedAt = <now>
 *   shippedAt = <now> (if not already set)
 *   prNumber = <resolved>
 *   mergeSha = <mergeCommit.oid from gh pr view>
 *
 * Safety guards (in order):
 *   1. Refuse if an active orchestrator with the same stateSlug is alive.
 *   2. Refuse if the feature index is out of range.
 *   3. Refuse if `gh pr view` reports state != "MERGED".
 *   4. If --merge-sha was passed, refuse if it doesn't match `mergeCommit.oid`.
 *
 * Does NOT touch `currentFeatureIndex`. That stays the orchestrator's
 * responsibility — `findNextFeatureIndex()` will naturally advance past
 * this feature on the next orchestrator launch because `isFeatureTerminal`
 * now returns true for it.
 */
export async function runMarkShipped(
  args: MarkShippedArgs,
  deps: MarkShippedDeps = {},
): Promise<MarkShippedResult> {
  const cwd = deps.cwd ?? process.cwd();
  const ghBinary = deps.ghBinary ?? "gh";
  const resolveMergedPR =
    deps.findMergedPRForBranch ?? findMergedPRForBranch;
  const resolveMergeInfo = deps.readMergedPRInfo ?? readMergedPRInfo;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const err = deps.err ?? ((msg: string) => console.error(msg));

  const slug = deriveStateSlug(args.planFile, args.runId);

  // Guard 1: refuse if an active orchestrator owns this plan.
  const liveOwner = findLiveOwner(args.activeRunRegistry, slug);
  if (liveOwner) {
    err(
      `✗ refused: an active gstack-build run (pid ${liveOwner.pid}, runId ${liveOwner.runId}) ` +
        `is processing this plan. Stop it before marking features shipped.`,
    );
    return { exitCode: 3, featureIndex: -1, noop: false };
  }

  // Load state.
  const state = loadState(slug, { noGbrain: args.noGbrain });
  if (!state) {
    err(
      `✗ no build state found for slug "${slug}". Run gstack-build on the plan first ` +
        `(or pass --run-id if you used one on the original run).`,
    );
    return { exitCode: 2, featureIndex: -1, noop: false };
  }

  // Guard 2: resolve feature index.
  const features = state.features ?? [];
  const featureIndex = features.findIndex((f) => f.number === args.feature);
  if (featureIndex === -1) {
    const known = features.map((f) => f.number).join(", ") || "<none>";
    err(
      `✗ feature "${args.feature}" not found in plan. Known feature numbers: ${known}`,
    );
    return { exitCode: 2, featureIndex: -1, noop: false };
  }
  const featureState = features[featureIndex];

  // Fast path: already terminal. No-op + clear success message.
  // Duplicates the isFeatureTerminal logic from cli.ts:isFeatureTerminal
  // intentionally — avoids a back-import (cli → mark-shipped → cli) and
  // the rule is small enough that drift is unlikely.
  if (isAlreadyTerminal(featureState)) {
    log(
      `✓ feature ${featureState.number} (${featureState.name}) is already marked shipped ` +
        `(status=${featureState.status}, prNumber=${featureState.prNumber ?? "n/a"}). No-op.`,
    );
    return { exitCode: 0, featureIndex, noop: true };
  }

  // Resolve PR number — operator override wins; otherwise look up via gh.
  let prNumber = args.pr ?? featureState.prNumber;
  if (!prNumber) {
    const branch = featureState.branch;
    if (!branch) {
      err(
        `✗ feature ${featureState.number} has no branch recorded in state ` +
          `and no --pr was passed. Re-run with --pr <num>.`,
      );
      return { exitCode: 2, featureIndex, noop: false };
    }
    const resolved = resolveMergedPR(cwd, branch, ghBinary);
    if (!resolved) {
      err(
        `✗ no merged PR found for branch "${branch}". Pass --pr <num> if the PR was ` +
          `closed without merging via a different head branch, or merged from a fork.`,
      );
      return { exitCode: 2, featureIndex, noop: false };
    }
    prNumber = resolved;
    log(`Resolved PR #${prNumber} from branch "${branch}" via gh pr list.`);
  }

  // Guard 3 + 4: verify the PR is actually merged and seed mergeSha from
  // gh's response (single source of truth). If the operator passed
  // --merge-sha, error out on mismatch — catches typos before any write.
  const info = resolveMergeInfo(cwd, prNumber, ghBinary);
  if (!info) {
    err(
      `✗ PR #${prNumber} is not merged (or gh failed to read it). ` +
        `mark-shipped only operates on merged PRs.`,
    );
    return { exitCode: 4, featureIndex, noop: false };
  }
  if (args.mergeSha && args.mergeSha !== info.mergeSha) {
    err(
      `✗ --merge-sha mismatch: you passed "${args.mergeSha}" but PR #${prNumber} ` +
        `merged at commit "${info.mergeSha}". Re-check before retrying.`,
    );
    return { exitCode: 5, featureIndex, noop: false };
  }
  const mergeSha = info.mergeSha;

  // Write the canonical terminal-state shape.
  const nowIso = now().toISOString();
  featureState.status = "committed";
  featureState.completedAt = nowIso;
  if (!featureState.shippedAt) featureState.shippedAt = nowIso;
  featureState.prNumber = prNumber;
  featureState.mergeSha = mergeSha;
  // Clear any stale failure-state breadcrumb so the operator doesn't see
  // a "failed" error on a feature we just marked shipped.
  delete (featureState as { error?: string }).error;

  // Flip phases under this feature to a terminal status too, so the
  // orchestrator's per-phase loop doesn't try to re-enter this feature
  // for unfinished phase work. The plan tied this to status="committed"
  // (the truly terminal PhaseStatus value — review_clean is post-review
  // but pre-commit).
  const phaseIndexes = featureState.phaseIndexes ?? [];
  for (const phaseIdx of phaseIndexes) {
    const phaseState = state.phases?.[phaseIdx];
    if (!phaseState) continue;
    if (phaseState.status !== "committed") {
      phaseState.status = "committed";
    }
  }

  // Persist (atomic local + best-effort gbrain).
  saveState(state, {
    noGbrain: args.noGbrain,
    log: (msg: string) => log(msg),
  });

  log(
    `✓ Marked feature ${featureState.number} (${featureState.name}) as shipped ` +
      `via PR #${prNumber} (commit ${mergeSha.substring(0, 12)}). ` +
      `Next launch will skip this feature.`,
  );
  return { exitCode: 0, featureIndex, noop: false };
}

/**
 * Find a live run owning this stateSlug. Returns null if no live owner
 * exists (terminal records and dead PIDs are ignored).
 */
function findLiveOwner(
  registryDir: string,
  slug: string,
): { runId: string; pid: number } | null {
  const records = readActiveRunRecords(registryDir);
  for (const rec of records) {
    if (rec.stateSlug !== slug) continue;
    if (!isPidAlive(rec.pid)) continue;
    return { runId: rec.runId, pid: rec.pid };
  }
  return null;
}

/**
 * Mirror of cli.ts:isFeatureTerminal. Intentionally duplicated to avoid a
 * circular import (cli.ts dispatches to mark-shipped.ts). If you change the
 * rule, change both.
 */
function isAlreadyTerminal(f: FeatureState): boolean {
  if (f.status === "committed") return !!f.completedAt;
  if (f.status === "release_queued")
    return !!f.shippedAt && f.prNumber != null;
  return false;
}
