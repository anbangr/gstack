/**
 * State persistence for gstack-build.
 *
 * Phase 2: JSON-only fallback path. Phase 6 wires gbrain as the primary
 * store with this JSON path as fallback when gbrain is unavailable or
 * write fails.
 *
 * Atomicity: writes go to a temp file in the same dir, then rename. Rename
 * is atomic on POSIX, so a crash between truncate and full write can never
 * leave the state file half-written.
 *
 * Slug derivation: state slug = `build-<plan-basename-without-ext>` for
 * the gbrain page. Local JSON file path: `~/.gstack/build-state/<slug>.json`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  BuildLaunchOptions,
  BuildState,
  Feature,
  FeatureState,
  Phase,
  PhaseState,
} from "./types";
import type { RoleConfigs } from "./role-config";
import { migrateLegacyModels } from "./role-config";
import { isGbrainAvailable, gbrainPut, gbrainGet } from "./gbrain";
import { isPhaseComplete } from "./parser";
import { isPidAlive } from "./active-runs";

export interface PersistOptions {
  /** Skip gbrain entirely. Useful for tests and the --no-gbrain CLI flag. */
  noGbrain?: boolean;
  /** Optional logger. Default: silent. Used to surface gbrain warnings. */
  log?: (msg: string) => void;
}

export type DeadLockCleanupStatus =
  | "missing"
  | "removed"
  | "live"
  | "invalid"
  | "unreadable"
  | "race_lost";

export interface DeadLockCleanupResult {
  status: DeadLockCleanupStatus;
  lockFile: string;
  pid?: number;
  error?: string;
}

function stateDir(): string {
  if (process.env.GSTACK_BUILD_STATE_DIR) {
    return path.resolve(process.env.GSTACK_BUILD_STATE_DIR);
  }
  return path.join(os.homedir(), ".gstack", "build-state");
}

export function deriveSlug(planFile: string): string {
  const base = path.basename(planFile);
  const noExt = base.replace(/\.md$/i, "");
  return `build-${noExt}`;
}

export function deriveRunSlug(runId: string): string {
  const safe =
    runId
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run";
  return `build-${safe}`;
}

export function deriveStateSlug(planFile: string, runId?: string): string {
  return runId ? deriveRunSlug(runId) : deriveSlug(planFile);
}

export function statePath(slug: string): string {
  return path.join(stateDir(), `${slug}.json`);
}

export function lockPath(slug: string): string {
  return path.join(stateDir(), `${slug}.lock`);
}

export function logDir(slug: string): string {
  return path.join(stateDir(), slug);
}

function ensureStateDir(): void {
  fs.mkdirSync(stateDir(), { recursive: true });
}

function migrateState(state: BuildState): BuildState {
  state.phases = state.phases.map((ph) =>
    (ph.status as string) === "gemini_done"
      ? { ...ph, status: "impl_done" }
      : (ph.status as string) === "done"
        ? { ...ph, status: "committed" }
        : ph,
  );
  state.roleConfigs = migrateLegacyModels(state);
  if (!state.features) {
    state.features = [
      {
        index: 0,
        number: "1",
        name: "Full plan",
        phaseIndexes: state.phases.map((ph) => ph.index),
        status: state.completed ? "committed" : "pending",
        ...(state.completed ? { completedAt: state.lastUpdatedAt } : {}),
      },
    ];
    state.currentFeatureIndex =
      state.features[0].status === "committed" ? -1 : 0;
  }
  return state;
}

export function ensureLogDir(slug: string): void {
  fs.mkdirSync(logDir(slug), { recursive: true });
}

/**
 * Build an initial BuildState from parsed phases. Used when no prior
 * state file exists for this plan.
 */
export function freshState(args: {
  planFile: string;
  branch: string;
  runId?: string;
  features?: Feature[];
  phases: Phase[];
  launch?: BuildLaunchOptions;
  geminiModel?: string;
  codexModel?: string;
  codexReviewModel?: string;
  roleConfigs?: RoleConfigs;
}): BuildState {
  const slug = deriveStateSlug(args.planFile, args.runId ?? args.launch?.runId);
  const planBasename = path.basename(args.planFile).replace(/\.md$/i, "");
  const now = new Date().toISOString();
  const phaseStates: PhaseState[] = args.phases.map((p) => ({
    index: p.index,
    number: p.number,
    name: p.name,
    // Status reflects what we observe on disk:
    // - all three checked (testSpec+impl+review) → committed (skip phase)
    // - impl checked only                         → impl_done (resume at Codex review)
    // - review checked only (user manually)       → committed (trust them; legacy compat)
    // - neither / testSpec unchecked              → pending (run from scratch)
    status: isPhaseComplete(p)
      ? "committed"
      : p.implementationDone && !p.reviewDone
        ? "impl_done"
        : !p.implementationDone && p.reviewDone
          ? "committed"
          : "pending",
    // Cache the parsed kind so state-only consumers (fault detectors,
    // drain-faults, future tooling) can read kind without re-parsing the plan.
    // Fallback to "code" preserves behavior for test fixtures that build a
    // Phase by hand without setting kind explicitly.
    kind: p.kind ?? "code",
  }));
  const providedFeatures = args.features?.filter(
    (f) => f.phaseIndexes.length > 0,
  );
  const sourceFeatures =
    providedFeatures && providedFeatures.length > 0
      ? providedFeatures
      : phaseStates.length > 0
        ? [
            {
              index: 0,
              number: "1",
              name: "Full plan",
              body: "",
              phaseIndexes: phaseStates.map((p) => p.index),
            },
          ]
        : [];
  const featureStates: FeatureState[] = sourceFeatures.map((f) => {
    const done = f.phaseIndexes.every(
      (idx) => phaseStates[idx]?.status === "committed",
    );
    return {
      index: f.index,
      number: f.number,
      name: f.name,
      phaseIndexes: [...f.phaseIndexes],
      status: done ? "phases_done" : "pending",
    };
  });
  const currentFeatureIndex = featureStates.findIndex(
    (s) => s.status !== "committed",
  );
  return {
    planFile: args.planFile,
    planBasename,
    slug,
    branch: args.branch,
    startedAt: now,
    lastUpdatedAt: now,
    ...(args.launch && { launch: args.launch }),
    currentPhaseIndex: Math.max(
      0,
      phaseStates.findIndex((s) => s.status !== "committed"),
    ),
    currentFeatureIndex,
    features: featureStates,
    phases: phaseStates,
    completed: false,
    ...(args.geminiModel && { geminiModel: args.geminiModel }),
    ...(args.codexModel && { codexModel: args.codexModel }),
    ...(args.codexReviewModel && { codexReviewModel: args.codexReviewModel }),
    ...(args.roleConfigs && { roleConfigs: args.roleConfigs }),
  };
}

/**
 * Hydrate `PhaseState.kind` from the parsed plan when the loaded state was
 * written before kind was persisted (every phase has `kind: null` or
 * `undefined`). Non-destructive: existing kind values on the state are never
 * overwritten — user-set values win, plan re-parses do not.
 *
 * Index-safe: iterates `min(state.phases.length, phases.length)`. If the plan
 * has been edited mid-build to add or remove phases, length-mismatched extras
 * are left untouched.
 *
 * No-op when no parsed plan is available (e.g., gbrain-restore path before
 * parsePlan has run) — caller can pass an empty array or `undefined` and the
 * state is returned intact.
 *
 * Pair this with cli.ts's resume path: after `loadState` succeeds and the
 * plan is parsed, call `backfillKindFromPlan(state, phases)` and the next
 * `saveState` writes the populated kind to disk.
 */
export function backfillKindFromPlan(
  state: BuildState,
  phases: Phase[] | undefined,
): BuildState {
  if (!phases || phases.length === 0) return state;
  const limit = Math.min(state.phases.length, phases.length);
  for (let i = 0; i < limit; i++) {
    const ps = state.phases[i];
    const p = phases[i];
    if (ps && p && p.kind && !ps.kind) {
      ps.kind = p.kind;
    }
  }
  return state;
}

export interface MergeReparsedPhasesReport {
  /** New PhaseState entries added by this merge, keyed by phase number. */
  added: string[];
  /**
   * Phase numbers that existed in state.phases before the merge but are no
   * longer present in the reparsed plan. The current production flow never
   * removes phases (FEATURE_NEEDS_PHASES only adds), but callers should log
   * these so a future regression doesn't silently drop runtime state.
   */
  orphaned: string[];
  /** Feature numbers added to the plan (present in reparsed.features, absent in state.features). */
  addedFeatures: string[];
  /** Feature numbers no longer in the parsed plan (present in state.features, absent in reparsed.features). */
  orphanedFeatures: string[];
}

/**
 * Cheap predicate: does `state.phases` already agree with the parser's view?
 *
 * Used by the resume-time repair guard in cli.ts to decide whether to invoke
 * the full merge. Equal-length arrays with per-index `number` agreement is
 * sufficient because the merge always assigns `.index = i` and the parser
 * walks top-to-bottom — disagreement on either dimension proves desync.
 *
 * Kept here (next to `mergeReparsedPhases`) so the trigger condition and the
 * repair function stay in sync. Pure (no mutation), safe to call repeatedly.
 */
export function arePhasesAligned(
  state: BuildState,
  reparsed: { phases: Phase[] },
): boolean {
  if (state.phases.length !== reparsed.phases.length) return false;
  for (let i = 0; i < state.phases.length; i++) {
    if (state.phases[i].number !== reparsed.phases[i].number) return false;
  }
  return true;
}

/**
 * Re-align `state.phases` and `state.features[i].phaseIndexes` to the parser's
 * view after the plan markdown is mutated mid-run (today: only by
 * `appendFeaturePhases` on the FEATURE_NEEDS_PHASES path).
 *
 * The previous implementation in cli.ts assumed new phases append to the END
 * of `reparsed.phases` (`slice(oldPhaseCount)`). That assumption breaks the
 * moment `appendFeaturePhases` inserts under a non-last feature: the new phase
 * lands mid-array and the parser shifts every downstream index. The slice
 * then captures the wrong tail, leaving `state.phases[k].number` stale for
 * every k >= insertion point AND pushing a duplicate of the actually-last
 * phase. See `__tests__/phases-added-merge.test.ts` for the deterministic
 * repro of the previous failure.
 *
 * Strategy: rebuild `state.phases` in parser order, by `number`. For each
 * `reparsed.phases[i]`:
 *   - if a PhaseState with that number already exists, reuse it and rewrite
 *     its `.index` to `i` (preserving status, codexReview, gemini outputs,
 *     committedAt, etc.);
 *   - otherwise, create a fresh `pending` PhaseState at index `i`.
 *
 * Then sync features: per-feature phaseIndexes are taken from the parser, and
 * features added/removed at the top level are surfaced in the report.
 *
 * Last-write-wins on duplicate numbers: if `state.phases` contains two
 * PhaseStates with the same `number` (e.g., corruption from a pre-fix
 * /build that pushed a duplicate of the last phase), only the LAST entry
 * survives Map insertion. The earlier entry is silently dropped — losing
 * any fields planted on it. This is intentional: the duplicate is itself
 * the corruption artifact, and there is no principled way to choose which
 * of two same-numbered entries holds the "real" runtime state. The repair
 * collapses to one canonical entry per number.
 *
 * In-place: mutates `state.phases` and `state.features[*].phaseIndexes`.
 * `state.currentPhaseIndex` and `state.currentFeatureIndex` are NOT touched
 * (callers manage cursor placement; the merge only fixes the array shape).
 * Returns a diff report so callers can log meaningfully.
 */
export function mergeReparsedPhases(
  state: BuildState,
  reparsed: { phases: Phase[]; features: Feature[] },
): MergeReparsedPhasesReport {
  const stateByNumber = new Map<string, PhaseState>();
  for (const ps of state.phases) {
    stateByNumber.set(ps.number, ps);
  }

  const added: string[] = [];
  const seenNumbers = new Set<string>();
  const nextPhases: PhaseState[] = [];

  for (let i = 0; i < reparsed.phases.length; i++) {
    const p = reparsed.phases[i];
    seenNumbers.add(p.number);
    const existing = stateByNumber.get(p.number);
    if (existing) {
      existing.index = i;
      existing.name = p.name;
      // Backfill kind on existing entries if it's missing. The new-entry
      // branch below defaults to "code" when the parser didn't supply a
      // kind; keep this branch symmetric so post-merge invariant is
      // uniform across re-aligned and freshly-added phases.
      if (!existing.kind) existing.kind = p.kind ?? "code";
      nextPhases.push(existing);
    } else {
      nextPhases.push({
        index: i,
        number: p.number,
        name: p.name,
        status: "pending",
        kind: p.kind ?? "code",
      });
      added.push(p.number);
    }
  }

  const orphaned: string[] = [];
  for (const ps of state.phases) {
    if (!seenNumbers.has(ps.number)) orphaned.push(ps.number);
  }

  state.phases = nextPhases;

  // Sync per-feature phaseIndexes from the parser. The parser is the
  // source of truth for "which phases belong to which feature." Preserve
  // FeatureState object identity (status, branch, prNumber, etc.) by
  // matching on `number`, not array position — production never removes
  // features today, but match-by-number means we'd preserve in-flight
  // state if a user reordered ## Feature headings between runs.
  const featuresByNumber = new Map<string, FeatureState>();
  for (const fs of state.features) {
    featuresByNumber.set(fs.number, fs);
  }
  const seenFeatureNumbers = new Set<string>();
  const nextFeatures: FeatureState[] = [];
  const addedFeatures: string[] = [];
  for (let f = 0; f < reparsed.features.length; f++) {
    const parsedFeature = reparsed.features[f];
    seenFeatureNumbers.add(parsedFeature.number);
    const existing = featuresByNumber.get(parsedFeature.number);
    if (existing) {
      existing.index = f;
      existing.name = parsedFeature.name;
      existing.phaseIndexes = [...parsedFeature.phaseIndexes];
      nextFeatures.push(existing);
    } else {
      nextFeatures.push({
        index: f,
        number: parsedFeature.number,
        name: parsedFeature.name,
        phaseIndexes: [...parsedFeature.phaseIndexes],
        status: "pending",
      });
      addedFeatures.push(parsedFeature.number);
    }
  }
  const orphanedFeatures: string[] = [];
  for (const fs of state.features) {
    if (!seenFeatureNumbers.has(fs.number)) orphanedFeatures.push(fs.number);
  }
  state.features = nextFeatures;

  return { added, orphaned, addedFeatures, orphanedFeatures };
}

/**
 * Load state for a plan. Strategy:
 *   1. Try local JSON (fast, always-on, source of truth).
 *   2. If JSON missing AND gbrain available, try gbrain (resume on a
 *      fresh machine where the build was started elsewhere).
 *   3. Return null if neither has it.
 *
 * Throws on JSON parse error (corrupt local state is a hard stop —
 * user inspects or deletes to start fresh).
 */
export function loadState(
  slug: string,
  opts: PersistOptions = {},
): BuildState | null {
  const p = statePath(slug);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    let parsed: BuildState;
    try {
      parsed = JSON.parse(raw) as BuildState;
    } catch (err) {
      throw new Error(
        `state file at ${p} is corrupt (${(err as Error).message}). Inspect or delete to start fresh.`,
      );
    }
    return migrateState(parsed);
  }

  if (opts.noGbrain) return null;
  if (!isGbrainAvailable()) return null;

  const fromBrain = gbrainGet(slug);
  if (!fromBrain) return null;
  try {
    const parsed = migrateState(JSON.parse(fromBrain) as BuildState);
    // Mirror back to local JSON so subsequent reads are fast and the
    // local file is the canonical source.
    saveState(parsed, { noGbrain: true });
    opts.log?.(`resumed state from gbrain page "${slug}"`);
    return parsed;
  } catch {
    opts.log?.(
      `gbrain page "${slug}" exists but isn't valid state JSON; ignoring`,
    );
    return null;
  }
}

/**
 * Persist state. JSON is always written (atomic temp+rename); gbrain
 * is best-effort (failures are logged, not thrown). lastUpdatedAt is
 * updated as a side effect.
 */
export function saveState(state: BuildState, opts: PersistOptions = {}): void {
  ensureStateDir();
  state.lastUpdatedAt = new Date().toISOString();
  const finalPath = statePath(state.slug);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  const serialized = JSON.stringify(state, null, 2) + "\n";
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);

  // Best-effort gbrain mirror.
  if (opts.noGbrain) return;
  if (!isGbrainAvailable()) return;
  const ok = gbrainPut(state.slug, serialized);
  if (!ok) {
    opts.log?.(
      `warning: gbrain put for "${state.slug}" failed; local JSON is canonical`,
    );
  }
}

function createLockFile(p: string): boolean {
  try {
    const fd = fs.openSync(p, "wx");
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

export function cleanupDeadLock(slug: string): DeadLockCleanupResult {
  const p = lockPath(slug);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { status: "missing", lockFile: p };
    }
    return { status: "unreadable", lockFile: p, error: err.message };
  }

  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(firstLine)) {
    return { status: "invalid", lockFile: p };
  }
  const pid = Number(firstLine);
  if (isPidAlive(pid)) {
    return { status: "live", lockFile: p, pid };
  }

  try {
    fs.unlinkSync(p);
    return { status: "removed", lockFile: p, pid };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { status: "race_lost", lockFile: p, pid };
    }
    return { status: "unreadable", lockFile: p, pid, error: err.message };
  }
}

/**
 * Acquire a lock for this slug. Returns true on success, false if another
 * instance already holds the lock. Caller must call releaseLock on graceful
 * exit AND in any signal handler.
 *
 * Uses O_EXCL flag so two simultaneous calls can't both succeed. If an
 * existing lock points at a definitely dead PID, remove it and retry once.
 */
export function acquireLock(slug: string): boolean {
  ensureStateDir();
  const p = lockPath(slug);
  if (createLockFile(p)) return true;

  const cleanup = cleanupDeadLock(slug);
  if (cleanup.status !== "removed" && cleanup.status !== "race_lost") {
    return false;
  }
  return createLockFile(p);
}

export function releaseLock(slug: string): void {
  const p = lockPath(slug);
  try {
    fs.unlinkSync(p);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * Read the lock file's contents to surface a useful error when contention
 * blocks startup. Returns null if no lock file exists.
 */
export function readLockInfo(slug: string): string | null {
  const p = lockPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}
