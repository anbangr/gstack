/**
 * Shared types for the gstack-build orchestrator.
 *
 * Three domain objects:
 *   Feature     — parsed from the plan markdown (groups executable phases)
 *   Phase       — parsed from the plan markdown (immutable after parse)
 *   PhaseState  — runtime state of executing a phase (mutates as we go)
 *
 * Plus the top-level BuildState that the persistence layer reads/writes.
 */

import type { RoleConfigs } from "./role-config";
import type { SkillFault } from "./skill-fault-detector";

export interface SkillFaultDetectedEvent {
  event: "SKILL_FAULT_DETECTED";
  timestamp: string;
  runId: string;
  stateSlug: string;
  stateFile: string;
  manifestPath: string;
  faults: SkillFault[];
}

/**
 * Emitted by the monitor when a previously-detected fault (matched by
 * runId + faultId) is no longer firing on the current tick. Closes the
 * DETECTED → RESOLVED session that started with the earlier
 * SkillFaultDetectedEvent. Consumers (e.g. drain-faults) use this to
 * suppress investigator dispatches for already-resolved transient faults.
 *
 * Only emitted when the caller passes activeFaultRegistryDir to
 * evaluateMonitorOnce; without that opt, the monitor stays append-only
 * (back-compat with existing log readers).
 */
export interface SkillFaultResolvedEvent {
  event: "SKILL_FAULT_RESOLVED";
  timestamp: string;
  runId: string;
  faultId: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

export type SkillFaultEvent = SkillFaultDetectedEvent | SkillFaultResolvedEvent;

export type PhaseKind =
  | "code"
  | "writing"
  | "experiment"
  | "research"
  | "manual";

export type PhaseStatus =
  | "pending"
  | "test_spec_running"
  | "test_spec_done"
  | "tests_red"
  | "gemini_running"
  | "impl_done"
  | "test_fix_running"
  | "tests_green"
  | "codex_running"
  | "review_clean"
  | "committed"
  | "failed"
  // Dual-implementor states (--dual-impl flag)
  | "dual_impl_running"
  | "dual_impl_done"
  | "dual_tests_running"
  | "dual_judge_pending"
  | "dual_judge_running"
  | "dual_winner_pending";

export type FeatureStatus =
  | "pending"
  | "running"
  | "phases_done"
  | "feature_review_pending"
  | "feature_review_running"
  | "feature_redo_pending"
  | "feature_blocked"
  | "shipping"
  | "release_queued"
  | "landed"
  | "origin_verifying"
  | "origin_verified"
  | "committed"
  | "failed"
  | "paused";

/**
 * Named gates for a single build phase. Each gate corresponds to one
 * checkbox in the plan markdown. Gate presence in the plan is optional
 * (legacy plans may only have implementation + review).
 */
export type PhaseGate =
  | "test_spec"
  | "verify_red"
  | "implementation"
  | "green_tests"
  | "review_qa";

/**
 * Named gates for a feature (across all its phases). These appear under
 * the feature heading in the plan, not under individual phase headings.
 */
export type FeatureGate =
  | "feature_review"
  | "ship_land"
  | "origin_verification";

/** State of a single plan-file gate checkbox. */
export interface PlanGateState {
  /** True when the checkbox is [x]. */
  done: boolean;
  /** 1-based line number of this checkbox in the plan file. */
  line: number;
  /** Optional status note parsed from _(note)_ suffix on the line. */
  note?: string;
}

export interface Feature {
  /** Zero-based index in the order features appear in the plan file. */
  index: number;
  /** Feature number as written in the heading, e.g. "1", "2". */
  number: string;
  /** Feature name (everything after `## Feature N: `). */
  name: string;
  /** Free-form body between the feature heading and its first phase. */
  body: string;
  /** Phase indexes that belong to this feature. */
  phaseIndexes: number[];
  /** Parsed gate state for feature-level checkboxes (feature_review, ship_land, origin_verification). */
  gates?: Partial<Record<FeatureGate, PlanGateState>>;
}

export interface Phase {
  /** Zero-based index in the order phases appear in the plan file. */
  index: number;
  /** Phase number as written in the heading, e.g. "1", "2.1". */
  number: string;
  /** Phase name (everything after `### Phase N: `). */
  name: string;
  /** Zero-based feature index that owns this phase. */
  featureIndex: number;
  /** Feature number as written in the heading, e.g. "1". */
  featureNumber: string;
  /** Feature name. */
  featureName: string;
  /** True if `[x] **Implementation` appears in the parsed plan. */
  implementationDone: boolean;
  /** True if `[x] **Review` appears in the parsed plan. */
  reviewDone: boolean;
  /** True if `[x] **Test Specification` appears in the parsed plan, or if the phase has no test spec checkbox (legacy plan backward compat). */
  testSpecDone: boolean;
  /** Free-form body between the phase heading and the next phase. Used as Gemini context. */
  body: string;
  /** Line number (1-based) of the `[ ] **Implementation` checkbox in the plan file. */
  implementationCheckboxLine: number;
  /** Line number (1-based) of the `[ ] **Review` checkbox in the plan file. */
  reviewCheckboxLine: number;
  /** Line number (1-based) of the `[ ] **Test Specification` checkbox in the plan file. -1 if not present (legacy plan). */
  testSpecCheckboxLine: number;
  /** True when --dual-impl CLI flag is active; stamped by the CLI after parse. */
  dualImpl: boolean;
  /** Kind of phase — determines which checkpoint labels and subagent prompts apply.
   *  Optional so test fixtures that omit it still type-check under strict mode. */
  kind?: PhaseKind;
  /** True when the phase is a gate that may legitimately produce zero source
   *  changes (e.g. pre-submission audits, license/metadata checks that already pass).
   *  Parsed from `<!-- audit-only -->` in the phase body. Defaults to false.
   *  When true, the post-impl hygiene check skips the "must commit" assertion;
   *  the "must leave tree clean" assertion still applies. */
  auditOnly?: boolean;
  /** Per-phase test-command override, parsed from `<!-- testCmd: <cmd> -->` in
   *  the phase body. Overrides the autodetected / `--test-cmd` runner at every
   *  test-execution callsite for THIS phase only. Lets polyglot monorepos point
   *  a phase at the right language's test runner when the static heuristic in
   *  detectTestCmd would pick the wrong one (e.g. a Python feature in a repo
   *  with a sibling vitest sidecar). The value is shell-evaluated; same trust
   *  level as the CLI's --test-cmd flag. */
  testCmdOverride?: string;
  /** Parsed gate state for per-phase checkboxes (test_spec, verify_red, implementation, green_tests, review_qa). */
  gates?: Partial<Record<PhaseGate, PlanGateState>>;
}

export interface DualImplTestResult {
  worktreePath: string;
  testExitCode: number | null;
  testLogPath: string;
  timedOut: boolean;
  /** Parsed count of failing test cases from test output. */
  failureCount?: number;
}

export type DualImplCandidateKey = "primary" | "secondary";

export interface DualImplCandidateState {
  worktreePath: string;
  branch: string;
  provider?: string;
  model?: string;
  testResult?: DualImplTestResult;
  /**
   * Number of recursive fix passes this implementor needed to reach its final test state.
   * 0 = passed on first try. null = fix loop did not run (impl crashed or no test command).
   */
  fixIterations?: number | null;
  /** HEAD commit SHA in the worktree at the time tests last ran. Used to detect stale cached results on resume. */
  testedCommit?: string;
  /**
   * Formatted log of what test failures this implementor hit at each fix iteration.
   * Each entry = "--- Fix iteration N ---\n<truncated test output>".
   * Passed to the judge so it can see what bugs each model encountered and fixed.
   */
  fixHistory?: string;
}

export interface DualImplState {
  candidates: Record<DualImplCandidateKey, DualImplCandidateState>;
  baseCommit: string;
  /**
   * Hardening notes emitted by the configured judge after seeing both fix histories.
   * Lists concrete issues from EITHER implementor's failure history that the
   * final code must handle. Passed into the Codex review prompt.
   */
  judgeHardeningNotes?: string;
  judgeLogPath?: string;
  judgeVerdict?: DualImplCandidateKey;
  judgeReasoning?: string;
  selectedImplementor?: DualImplCandidateKey;
  /** 'judge' = judge decided; 'auto' = one passed/fewer failures; winner was obvious */
  selectedBy?: "judge" | "auto";
  /** ISO timestamp when worktrees were torn down. */
  worktreesTornDownAt?: string;
}

export interface SubAgentInvocation {
  startedAt: string;
  completedAt?: string;
  outputLogPath: string;
  /**
   * Path to the structured output file the sub-agent wrote (the artifact —
   * a clean review report or implementation summary). Distinct from
   * `outputLogPath`, which is the raw spawn shell capture (command + stdout +
   * stderr) used for forensics. Consumers that want to FEED a sub-agent's
   * artifact into the next sub-agent (e.g. RUN_GEMINI_FROM_REVIEW reading the
   * prior review report) MUST read `outputFilePath`, not `outputLogPath`.
   */
  outputFilePath?: string;
  retries: number;
  exitCode?: number;
  error?: string;
}

export interface CodexReviewState {
  iterations: number;
  /**
   * Subset of `iterations` that produced a verdict-writing result (GATE
   * PASS / GATE FAIL, not transport/capacity/stall failures). Used by
   * the codex-iteration cap so a phase that's stuck on provider 529s
   * doesn't burn its convergence budget. PR1b: defaults to `iterations`
   * via migrateState() so state files written before this field load
   * cleanly. Live callers that classify a result as a provider failure
   * should bump only `iterations`, not `iterationsSuccessful`.
   */
  iterationsSuccessful?: number;
  finalVerdict?: "GATE PASS" | "GATE FAIL" | "TIMEOUT";
  outputLogPaths: string[];
  /**
   * Parallel array to `outputLogPaths`: each entry is the path to the
   * structured review report (the artifact Codex wrote to its outputFilePath).
   * Use this — NOT outputLogPaths — when feeding prior reviewer findings
   * back to a sub-agent or when building escalation reports (BLOCKED.md).
   * Optional for backwards compatibility with state files written before
   * this field existed.
   */
  outputFilePaths?: string[];
  /** Number of Gemini re-runs triggered by review feedback (RUN_GEMINI_FROM_REVIEW). */
  geminiReRunCount?: number;
  /**
   * Set when this entry was reconstructed from on-disk artifacts via
   * `gstack-build reconcile --from-artifacts` or
   * `backfill-checkboxes.ts --from-artifacts` (because the JSON state field
   * was nulled out, e.g. by a manual jq edit during workaround relaunch).
   *
   * When true: `iterations`, `outputLogPaths`, `outputFilePaths` are derived
   * from filesystem scan, and `finalVerdict` is best-effort regex-parsed
   * from the latest `phase-N-review-merged-K.md` (may be undefined when
   * no recognizable verdict appears in the file). Readers that need the
   * exact set of fields the live loop would have written should treat
   * `derivedFromArtifacts === true` as "trust the existence of review work,
   * but not the verdict precision."
   */
  derivedFromArtifacts?: boolean;
}

export interface PhaseState {
  index: number;
  number: string;
  name: string;
  status: PhaseStatus;
  /**
   * Cached from the parsed `Phase` at `freshState` time. Read by state-only
   * consumers (fault detectors, drain-faults, future tooling) when the parsed
   * plan is not available. The state machine itself reads `phase.kind` from
   * the parsed `Phase` object, not this field.
   */
  kind?: PhaseKind;
  gemini?: SubAgentInvocation;
  /** Invocation record for the test-specification Gemini call. */
  geminiTestSpec?: SubAgentInvocation;
  /**
   * Paths the test-writer added or modified during the most recent test-spec
   * iteration. Captured from `git diff --name-only` against the pre-testspec
   * HEAD. Used by `resolveTestCmdForPhase` to infer a subtree-aware testCmd
   * (e.g. `npm --prefix sidecar-v2 test` when all touched paths share the
   * `sidecar-v2/` prefix) — generalises the synthesizer's PR #95 Go cmd-dir
   * hint to TypeScript/Python subtrees. Empty array or absent field means
   * fall through to existing static testCmd resolution.
   */
  testWriterTouchedPaths?: string[];
  /** Number of times VERIFY_RED returned exit==0 (tests too easy). Capped by GSTACK_BUILD_RED_MAX_ITER. */
  redSpecAttempts?: number;
  /** State of the post-testspec / post-impl test runs. */
  testRun?: {
    iterations: number;
    finalStatus: "red" | "green" | "timeout";
  };
  /** State of the recursive Gemini fix calls when tests fail post-impl. */
  testFix?: {
    iterations: number;
    outputLogPaths: string[];
  };
  codexReview?: CodexReviewState;
  /**
   * PR1b: count of provider-retry attempts (capacity / overloaded / quota
   * / transport / stall) made for this phase, summed across role steps
   * and codex iterations. Hard-capped at `PROVIDER_RETRY_SESSION_CAP`
   * (default 6) to bound autonomous churn when the provider is having a
   * prolonged bad day. Reset only on phase recovery via --reset-phase.
   */
  providerRetryAttempts?: number;
  /** Origin-plan verification issue report that must be fixed during the next review loop. */
  originIssueLogPath?: string;
  /** Dual-implementor tournament state (populated when --dual-impl is active). */
  dualImpl?: DualImplState;
  /** Coverage measured after GREEN tests pass. Set when phase body contains `#### Test Spec`. */
  coverageResult?: {
    actual: number;
    target: number;
  };
  committedAt?: string;
  /**
   * Git SHA of HEAD at the moment this phase committed. Captured by the
   * orchestrator immediately before flipping status → "committed". Used
   * by per-phase diff blocks (T8) to compute `git diff <prev-sha>..<this-sha>`
   * for review prompts. Optional and best-effort: if `git rev-parse HEAD`
   * fails at commit time (detached HEAD, no commits, transient I/O), the
   * field stays undefined and downstream consumers must tolerate that.
   */
  committedSha?: string;
  error?: string;
  /**
   * Structured failure evidence by role name. Populated when a role subprocess
   * fails so the final FAIL handler can classify provider/auth/quota/stall
   * failures for any role, not only Codex review.
   */
  failureRender?: Record<string, Record<string, unknown>>;
}

/**
 * Per-feature meta-review state. Populated when --skip-feature-review is
 * NOT set and the feature has more than one phase OR any phase needed
 * more than one Codex iteration to converge. Tracks the configurable
 * post-implementation review cycle that runs after `phases_done` and
 * before `shipping`.
 */
export interface FeatureReviewState {
  /** Number of review cycles run so far for this feature. */
  iterations: number;
  /** Spawn shell logs for each review invocation (forensics). */
  outputLogPaths: string[];
  /**
   * Parallel array of clean review report paths. Use these — NOT
   * outputLogPaths — when feeding the prior verdict into the next loop
   * iteration or building the BLOCKED-feature-N.md report.
   */
  outputFilePaths: string[];
  /** Verdict from the most recent invocation.
   *
   * Successful reviewer outcomes:
   *   FEATURE_PASS / FEATURE_NEEDS_PHASES / FEATURE_REDO — parsed from
   *   the reviewer's `## VERDICT` sentinel.
   *
   * Operator-set outcomes:
   *   FEATURE_BLOCKED — feature failed to converge within the cap and the
   *   user (or CI) was offered no extension. The orchestrator wrote
   *   BLOCKED-feature-<N>.md and halted.
   *
   * Reviewer subprocess failures (kept distinct so dashboards can
   * tell the failure modes apart — they have different fix paths):
   *   TIMEOUT          — the stall watchdog SIGTERM'd the subprocess
   *                      (no CPU + no stdout for the stall window).
   *                      Genuine deadlock or runaway silent agent.
   *   HYGIENE_FAULT    — the subprocess exited but the post-agent hygiene
   *                      gate caught a worktree mutation. The reviewer
   *                      edited files it shouldn't have. Same-shape
   *                      repeats should halt the loop, not retry.
   *   EXEC_ERROR       — non-zero exit with no hygiene log. Provider
   *                      transport failure, quota exhaustion, CLI crash.
   *   MISSING_VERDICT  — exit 0 but the artifact contained no `## VERDICT`
   *                      sentinel. The reviewer produced output but didn't
   *                      follow the contract — usually a routing/prompting
   *                      bug (e.g. wrong prompt template). */
  finalVerdict?:
    | "FEATURE_PASS"
    | "FEATURE_NEEDS_PHASES"
    | "FEATURE_REDO"
    | "FEATURE_BLOCKED"
    | "TIMEOUT"
    | "HYGIENE_FAULT"
    | "EXEC_ERROR"
    | "MISSING_VERDICT";
  /** Set when a timed-out review artifact had pass-like test/no-findings evidence but no parseable sentinel. */
  timeoutEvidence?: "pass";
  /**
   * Shape-fingerprint of the most recent failure (when finalVerdict is one of
   * the reviewer-subprocess failure states: HYGIENE_FAULT, EXEC_ERROR,
   * MISSING_VERDICT, TIMEOUT). Used by the outer loop's same-shape repeat
   * detector to halt rather than retry when two consecutive iterations fail
   * in exactly the same way (e.g. reviewer keeps editing the same audit
   * file). For HYGIENE_FAULT this is the sorted set of dirty paths; for the
   * others it's just the state name.
   *
   * Cleared on successful PASS/REDO/NEEDS_PHASES. Optional for back-compat
   * with state files that pre-date this field.
   */
  lastFailureShape?: string;
  /**
   * Number of consecutive iterations that produced `lastFailureShape`.
   * Resets on shape change or success. Optional for back-compat.
   */
  sameShapeStreak?: number;
  /** Phase indexes the reviewer asked us to reset (FEATURE_REDO). */
  phasesReset?: number[];
  /** Count of phases the reviewer appended to the plan (FEATURE_NEEDS_PHASES). */
  phasesAdded?: number;
  /**
   * True after the user explicitly opted in to a 4th+ cycle past the
   * convergence cap. Resets when the verdict becomes FEATURE_PASS.
   */
  userApprovedExtension?: boolean;
}

export interface FeatureState {
  index: number;
  number: string;
  name: string;
  phaseIndexes: number[];
  status: FeatureStatus;
  branch?: string;
  shippedAt?: string;
  /** PR number set at queue time; required for release_queued to be trusted as terminal. */
  prNumber?: number;
  /**
   * Merge commit SHA on the base branch (origin/main). Hard-to-fake evidence
   * the feature actually landed: must match a real commit. Set by the real
   * release pipeline when ship lands the PR, and by the operator-facing
   * `gstack-build mark-shipped` escape hatch. Optional for back-compat with
   * older state files that pre-date the field.
   */
  mergeSha?: string;
  landedAt?: string;
  originVerifiedAt?: string;
  completedAt?: string;
  issueLogPath?: string;
  originIssueLogPaths?: string[];
  originVerificationAttempts?: number;
  /** Files that conflicted while syncing the owned feature branch with base before shipping. */
  baseSyncConflictFiles?: string[];
  /** Meta-review state (populated when feature-level review fires). */
  featureReview?: FeatureReviewState;
  error?: string;
}

export interface BuildLaunchOptions {
  /** Raw argv passed to gstack-build, excluding the node/bun executable. */
  argv: string[];
  /** Resolved target repository root for this invocation. */
  projectRoot: string;
  /** Original checkout root when this run executes inside a private worktree. */
  baseProjectRoot?: string;
  /** Durable run identity. When present, state slug is build-<runId>. */
  runId?: string;
  /** Prefix used for branches owned by this run. */
  branchPrefix?: string;
  /** Active-run registry directory used to protect branches owned by sibling runs. */
  activeRunRegistry?: string;
  /** Persisted state slug for wrong-run resume detection. */
  stateSlug?: string;
  /** Source/origin plan path, when this run was launched with --origin-plan. */
  originPlan?: string;
  /** True when this invocation is a simulation and must not write/ship. */
  dryRun: boolean;
  /** True only when --skip-ship was explicitly passed. */
  skipShip: boolean;
  /** True only when --skip-feature-review was explicitly passed. */
  skipFeatureReview: boolean;
  /** ISO timestamp for this specific launch/resume attempt. */
  launchedAt: string;
}

export interface BuildRunManifestRun {
  runId: string;
  repoPath: string;
  repoSlug: string;
  sourcePlanPath?: string;
  livingPlanPath: string;
  originPlanPath?: string;
  worktreePath: string;
  stateSlug: string;
  branchPrefix: string;
  pidFile: string;
  stdoutLog: string;
  /** Exact argv used to launch or resume this run. Executable is element 0. */
  launchCommand: string[];
  /** Explicit environment overrides for launchCommand. */
  launchEnv?: Record<string, string>;
}

export interface BuildRunManifest {
  manifestId: string;
  runGroupId: string;
  tmpDir: string;
  workspaceRoot?: string;
  gstackRepo?: string;
  runs: BuildRunManifestRun[];
}

export type PlanReviewSeverity = "APPROVE" | "REVISE";

export interface PlanReviewObjection {
  severity: "CRITICAL" | "IMPORTANT" | "SUGGESTION";
  /** e.g. "Feature 2, Phase 1" */
  location: string;
  issue: string;
  suggestion: string;
}

export interface PlanReviewVerdict {
  verdict: PlanReviewSeverity;
  objections: PlanReviewObjection[];
  assessment: string;
  /** Model name, e.g. "gpt-5.5". "skipped-unavailable" when review was bypassed. */
  reviewedBy: string;
  /** 1-based round counter; survives cross-launch resume via readPlanReviewRound. */
  round: number;
  /** Per-objection user triage decisions for this round. Absent on APPROVE rounds. */
  triageDecisions?: TriageDecision[];
  /** Absolute path to the append-only per-build history JSONL. */
  roundHistoryPath?: string;
  /** Convergence snapshot for this round. */
  convergence?: ConvergenceSnapshot;
  /** When set, the user interrupted triage mid-round at this objection (0-based). */
  interruptedAtObjection?: number;
}

export interface TriageDecision {
  /** Index into the round's objections array. */
  objectionIndex: number;
  /** User disposition: accept feeds into convergence count, reject/defer do not. */
  decision: "accept" | "reject" | "defer";
  /** Optional one-line user rationale. Empty string when not provided. */
  rationale?: string;
}

export interface ConvergenceSnapshot {
  /** CRITICAL count returned by reviewer before triage. */
  objectionCountRaw: number;
  /** CRITICAL count the user accepted in this round's triage. */
  objectionCountAccepted: number;
  /** Accepted CRITICAL count from round k-1. null on round 1. */
  priorRoundAccepted: number | null;
  /** objectionCountAccepted - priorRoundAccepted. null on round 1. */
  delta: number | null;
  /** Count of round-k accepted objections matching a round-(k-1) accepted-and-resolved entry by (location, severity). */
  reRaises: number;
  /** Count of round-k objections that don't match any prior-round annotation. */
  newObjections: number;
  /** True when adaptive-cap rule fires (see plan-review-loop.ts). */
  noForwardProgress: boolean;
}

export interface BuildState {
  /** Absolute path to the plan markdown. */
  planFile: string;
  /** Plan basename without extension — used for the state slug. */
  planBasename: string;
  /** Slug used for state files and gbrain pages. */
  slug: string;
  /** Git branch active when the build started. */
  branch: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601, updated on every state write. */
  lastUpdatedAt: string;
  /** Last CLI launch/resume options, persisted for audit/recovery. */
  launch?: BuildLaunchOptions;
  /** Zero-based index of the next phase to run. */
  currentPhaseIndex: number;
  /** Zero-based index of the next feature to run. */
  currentFeatureIndex?: number;
  /** Per-feature runtime state, parallel array to parsed features. */
  features?: FeatureState[];
  /** Per-phase runtime state, parallel array to the parsed phases. */
  phases: PhaseState[];
  /** True after the ship step completes. */
  completed: boolean;
  /** Set when a phase fails terminally. */
  failedAtPhase?: number;
  /** Human-readable failure description. */
  failureReason?: string;
  /** Model used for Gemini (Implementor A). Stored for resume mismatch detection. */
  geminiModel?: string;
  /** Model used for Codex (Implementor B, dual-impl). Stored for resume mismatch detection. */
  codexModel?: string;
  /** Model used for Codex review pass. Stored for resume mismatch detection. */
  codexReviewModel?: string;
  /** Role-based provider/model/reasoning/command routing. */
  roleConfigs?: RoleConfigs;
  /** Result of the planReviewer second-opinion pass. undefined = not yet reviewed or skipped. */
  planReview?: PlanReviewVerdict;
}
