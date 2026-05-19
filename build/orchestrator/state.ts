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

// Gemini's --yolo workspace policy auto-derives its tmp allowlist from the
// spawn cwd basename. The key gets stored in ~/.gemini/projects.json with
// a specific sanitization: lowercase, every non-[a-z0-9] run collapsed to
// a single `-`, leading/trailing `-` stripped. Empirically verified across
// 100+ keys in projects.json — keys are always `[a-z0-9-]+` with no double
// dashes. Examples observed: `v3_1` → `v3-1`, `MyObs` → `myobs`,
// `the-Big-Paper` → `the-big-paper`.
//
// Staging dirs we create under ~/.gemini/tmp/<dir>/ must match that exact
// shape; otherwise Gemini's sandbox rejects every read_file as "Path not
// in workspace" and the agent runs blind (silent inference fallback).
// Callers must derive the input to this function from `path.basename(cwd)`,
// NOT the state slug — single-impl and dual-impl pass different `cwd`
// values, and only `cwd` matches what Gemini sees.
//
// Empty-result guard: if sanitization yields "" (e.g. input was all
// punctuation like `_` or `...`), fall back to a fixed "gstack-run" key.
// Without this, `path.join(HOME, ".gemini", "tmp", "")` would stage
// directly in the shared tmp root and collide with everything else. The
// fallback is intentionally a literal so collisions are debuggable and
// never escalate to "this run wrote to the tmp root."
//
// The leading `^build-` strip is retained for callers that still pass a
// state slug (e.g. the existing unit tests that pin the contract on slug
// shapes; safe because the strip is the first step of sanitization that
// Gemini itself does NOT do — Gemini's input is already `cwd` basename).
// Idempotent: running twice produces the same result.
export function deriveGeminiSlug(slug: string): string {
  const sanitized = slug
    .replace(/^build-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "gstack-run";
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

/**
 * Cheap predicate: does `state` already agree with the parser's view on
 * both phases AND features?
 *
 * Used by the resume-time fail-closed guard in cli.ts to decide whether
 * to abort with a remediation message. Disagreement on any dimension
 * (phase count, per-index phase number, feature count, per-index feature
 * number) proves desync. The reconciler is wired only on the in-run
 * FEATURE_NEEDS_PHASES path; on resume, by-number merging would
 * silently re-attribute runtime artifacts (gemini outputs, codexReview
 * records) on slots whose stale `.number` no longer matches the parsed
 * plan — same silent-corruption shape as the bug PR #42 fixed.
 *
 * Pure; safe to call repeatedly.
 */
export function arePhasesAligned(
  state: BuildState,
  reparsed: { phases: Phase[]; features: Feature[] },
): boolean {
  if (state.phases.length !== reparsed.phases.length) return false;
  for (let i = 0; i < state.phases.length; i++) {
    if (state.phases[i].number !== reparsed.phases[i].number) return false;
  }
  if ((state.features?.length ?? 0) !== reparsed.features.length) return false;
  for (let i = 0; i < reparsed.features.length; i++) {
    const sf = state.features?.[i];
    if (!sf || sf.number !== reparsed.features[i].number) return false;
  }
  return true;
}

/**
 * Reconcile state.phases against a freshly re-parsed plan after the
 * orchestrator mutates the plan mid-run (FEATURE_NEEDS_PHASES verdict
 * path). The plan-mutator inserts new phase headings under the named
 * feature, which lives anywhere in the plan — not necessarily at the
 * end. That insertion shifts the parser-assigned `Phase.index` of every
 * downstream phase by the number of newly inserted entries.
 *
 * The old strategy was "slice the tail of reparsed.phases and push" — it
 * assumed new phases land at the end of the array. For any non-last
 * feature that assumption silently aliased the new review phase onto
 * an existing PhaseState slot, leaving the new phase un-executed and
 * corrupting the downstream feature's runtime state.
 *
 * The fix is to rebuild state.phases by joining against reparsed.phases
 * on phase number (PhaseState.number, Phase.number). The parser does NOT
 * dedupe headings, so the reconciler defends here: duplicate numbers in
 * either side throw before any mutation. Without that defense, a `Map`
 * keyed by `.number` would silently last-write-wins on one side and
 * orphan the loser, and on the parser side it would alias the same
 * PhaseState into two array slots so a status write on one would mutate
 * both.
 *
 *   - Existing phases: keep their PhaseState (status, gemini/codex
 *     iteration counts, etc.) and re-key the in-memory `index` to the
 *     new array position.
 *   - New phases: append a fresh `{status: "pending"}` PhaseState.
 *   - Dropped phases: fail closed. The plan was edited out-of-band
 *     and continuing would silently lose runtime state.
 *   - Duplicate numbers (either side): fail closed. Whoever produced
 *     them (LLM verdict, hand-edited plan, malformed state.json) needs
 *     to fix it before we touch state.
 *
 * Also rebuilds every `feature.phaseIndexes` from the reparsed Feature
 * objects so downstream readers (the inner phase loop, parallel
 * planner, mark-shipped, monitor) see indexes that match the new
 * `state.phases` positions.
 *
 * `state.currentPhaseIndex` is rechased by the original phase's
 * `.number`. If the in-flight phase was somehow dropped (shouldn't
 * happen — the fail-closed branch above would have thrown), the
 * pointer is cleared.
 */
export function reconcileStatePhasesAfterReparse(
  state: BuildState,
  reparsedPhases: Phase[],
  reparsedFeatures: Feature[],
): { addedNumbers: string[] } {
  // Defend against duplicate phase numbers on the parser side. The parser
  // does not dedupe — if an LLM verdict emits `### Phase 1.review-1` twice
  // or a hand-edited plan introduces a duplicate, the by-number Map below
  // would alias the same PhaseState into two array slots and a status
  // write on one would silently mutate both. Fail fast.
  const parserSeen = new Set<string>();
  for (const p of reparsedPhases) {
    if (parserSeen.has(p.number)) {
      throw new Error(
        `reconcileStatePhasesAfterReparse: re-parsed plan contains duplicate ` +
          `phase number "${p.number}". The parser does not dedupe headings — ` +
          `look for two "### Phase ${p.number}" entries in the plan and fix one ` +
          `(rename to a unique number or delete the duplicate).`,
      );
    }
    parserSeen.add(p.number);
  }

  // Defend against duplicate phase numbers on the state side. A pre-fix
  // gstack version's slice-tail merge could push a duplicate of the
  // actually-last phase onto state.phases. `byNumber.set` would
  // last-write-wins and silently drop the earlier entry's runtime
  // state (status, gemini outputs, committedAt). Refuse to recover
  // — the caller's BLOCKED-feature-N.md path can surface the
  // corruption to a human.
  const stateSeen = new Set<string>();
  for (const ps of state.phases) {
    if (stateSeen.has(ps.number)) {
      throw new Error(
        `reconcileStatePhasesAfterReparse: state.phases contains duplicate ` +
          `phase number "${ps.number}". This usually means state.json was ` +
          `written by a pre-fix gstack version. Refusing to merge — inspect ` +
          `state.json or rerun with --no-resume.`,
      );
    }
    stateSeen.add(ps.number);
  }

  const byNumber = new Map<string, PhaseState>();
  for (const ps of state.phases) {
    byNumber.set(ps.number, ps);
  }

  // Snapshot currentPhaseIndex → number BEFORE we mutate state.phases.
  let currentPhaseNumber: string | undefined;
  if (state.currentPhaseIndex != null) {
    currentPhaseNumber = state.phases[state.currentPhaseIndex]?.number;
  }

  const next: PhaseState[] = [];
  const added: string[] = [];
  for (const p of reparsedPhases) {
    const existing = byNumber.get(p.number);
    if (existing) {
      existing.index = p.index;
      existing.name = p.name;
      if (!existing.kind && p.kind) existing.kind = p.kind;
      next.push(existing);
      byNumber.delete(p.number);
    } else {
      next.push({
        index: p.index,
        number: p.number,
        name: p.name,
        status: "pending",
        kind: p.kind ?? "code",
      });
      added.push(p.number);
    }
  }

  const dropped = [...byNumber.keys()];
  if (dropped.length > 0) {
    throw new Error(
      `reconcileStatePhasesAfterReparse: ${dropped.length} phase(s) ` +
        `present in state but missing from re-parsed plan: ${dropped.join(", ")}. ` +
        `Refusing to drop runtime state. Inspect the plan file and resume with ` +
        `--no-resume if the drop was intentional.`,
    );
  }

  state.phases = next;

  // Rebuild every feature.phaseIndexes from the reparsed Feature objects.
  // The parser already populated reparsed Feature.phaseIndexes with the
  // correct new positions; we just copy.
  // Loop var is `featureState` (not `fs`) to avoid shadowing the module-level
  // `import * as fs from "fs"`.
  for (const featureState of state.features ?? []) {
    const refreshed = reparsedFeatures.find(
      (f) => f.number === featureState.number,
    );
    featureState.phaseIndexes = refreshed ? [...refreshed.phaseIndexes] : [];
  }

  // Chase currentPhaseIndex forward by number.
  if (currentPhaseNumber != null) {
    const refreshed = next.find((ps) => ps.number === currentPhaseNumber);
    state.currentPhaseIndex = refreshed?.index;
  }

  return { addedNumbers: added };
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
