# Living Implementation Plan: Build Skill Fault Investigator

Source plan: /Users/anbang/.claude/plans/now-i-want-the-virtual-minsky.md
Run ID: gstack-now-i-want-the-virtual-minsky-20260511-074503-fabe4c3f
Target repo: /Users/anbang/Documents/Antigravity/claude-workspace/gstack

## Test Plan Strategy

**Framework:** bun:test (existing framework in gstack)
**Test locations:**

- Unit tests for `skill-fault-detector.ts`: in `test/skill-fault-detector.test.ts` (new)
- Integration tests for `monitor.ts` event emission: in `test/skill-validation.test.ts` or new test file
- E2E test: `test/skill-e2e-build-fault-investigator.test.ts` (new, periodic tier)

**Key invariants to test:**

1. `detectSkillFaults()` never throws -- wraps all I/O in try/catch
2. Returns correct `SkillFault[]` for each of the 9 detection categories
3. `SKILL_FAULT_DETECTED` JSON line emitted by monitor (NOT a MonitorEventName terminal event) when faults detected, does not change exit code
4. Step M3.5 in SKILL.md deduplicates by run+category before spawning investigator
5. E2E: `PLAN_SYNTHESIS_INVALID` fault causes report to appear in fault inbox

---

<!-- gstack-plan-review
reviewed: REVISE-SUGGESTIONS
reviewer: gpt-5.5
round: 1
ts: 2026-05-11T00:28:25.503Z
objections_critical: 0
objections_important: 0
objections_suggestion: 0
resolution: approved
-->
## Feature 1: Skill-Fault Detector Module

Origin trace: Source plan §"Files to Change" (skill-fault-detector.ts), §"Skill-Fault Detector (build/orchestrator/skill-fault-detector.ts)", §"Fault Categories", §"Implementation Approach"
Acceptance: `build/orchestrator/skill-fault-detector.ts` exports `detectSkillFaults(input: DetectorInput): SkillFault[]` covering exactly 9 first-pass categories: CODEX_CONVERGENCE, TEST_FIXER_LOOP, PREMATURE_COMPLETION, PLAN_SYNTHESIS_INVALID, WORKTREE_LEAK, RED_SPEC_TRIVIAL, PLAN_MUTATOR_MISMATCH, PLAN_REVIEW_STALEMATE, FEATURE_VERIFIER_SCOPE. Analytics append to `skill-faults.jsonl` is a side effect of detection, not a category. `SkillFault` and `DetectorInput` interfaces exported. Detector never throws.

### Phase 1.1: Fault Detector Implementation

- [x] **Test Specification (test-writer role)**: Write tests in `test/skill-fault-detector.test.ts`. Tests MUST fail before implementation. Cover:
  - `detectSkillFaults()` returns empty array when `input.state` is null or no faults apply
  - CODEX_CONVERGENCE detected when `phase.codexReview.iterations >= DEFAULT_MAX_CODEX_ITERATIONS` (import from `./phase-runner`)
  - TEST_FIXER_LOOP detected when `phase.testFix.iterations >= DEFAULT_MAX_TEST_ITERATIONS` (import from `./phase-runner`)
  - PREMATURE_COMPLETION detected when living plan contains `- [x] **Implementation**` or `- [x] **Review & QA**` task-level checkbox for a phase whose state.status !== 'committed'
  - PLAN_SYNTHESIS_INVALID detected when any phase block (split on `### Phase`) is missing 'Origin trace:' or 'Acceptance:'
  - WORKTREE_LEAK detected when `input.state.completed=true` but `input.worktreePath` directory exists on disk
  - RED_SPEC_TRIVIAL detected when `input.state.failureReason` contains 'trivially' or 'without implementation'
  - PLAN_MUTATOR_MISMATCH detected when `input.state.failureReason` contains 'line not found' or 'checkbox'
  - PLAN_REVIEW_STALEMATE detected when plan-review-report.json in `input.stateDir` has `round >= 3` AND at least one entry in `objections[]` has `severity === 'CRITICAL'` (the real report shape: no top-level severity field; severity is per-objection in `objections[].severity`)
  - FEATURE_VERIFIER_SCOPE detected when the file at `input.stdoutLogPath` (the run's stdout log) contains a line matching "VERIFICATION: GAPS"
  - Function never throws on bad input (null state, non-existent paths, malformed files)
  - Analytics failures do not block fault return (test with unwritable GSTACK_HOME/analytics path)
  - Analytics line appended to `skill-faults.jsonl` under `${process.env.GSTACK_HOME}` (set GSTACK_HOME to a temp dir in tests)
    Do NOT write any implementation code yet.
- [x] **Implementation (primary-impl role)**: Create `build/orchestrator/skill-fault-detector.ts` with:
  - `export interface DetectorInput { state: BuildState | null; livingPlanPath: string; worktreePath: string; stateDir: string; stdoutLogPath: string; }`
  - `export interface SkillFault { category: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'; description: string; sourceFiles: string[]; evidence: { phaseIndex?: number; iterationCount?: number; stateValue?: string; planReviewRound?: number; } }`
  - `export function detectSkillFaults(input: DetectorInput): SkillFault[]`
  - Import `DEFAULT_MAX_CODEX_ITERATIONS`, `DEFAULT_MAX_TEST_ITERATIONS` from `./phase-runner` (NOT build-config.ts)
  - PREMATURE_COMPLETION: scan living plan for `- [x] **Implementation**` and `- [x] **Review & QA**` patterns
  - WORKTREE_LEAK: use `input.worktreePath` directly (provided by caller, do not re-derive from state.slug)
  - FEATURE_VERIFIER_SCOPE: read `input.stdoutLogPath`, search for "VERIFICATION: GAPS" (stdoutLogPath is `snapshot.run.stdoutLog` from the manifest -- the process's captured output file)
  - All I/O in try/catch; analytics append failures are swallowed without hiding fault return
  - Analytics appended to `${process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack')}/analytics/skill-faults.jsonl`
- [x] **Review & QA (review roles)**: Run primary /review, /qa; verify no unused imports, no raw stdout in evidence fields, analytics errors swallowed separately from detection errors.

---

## Feature 2: Monitor Event Integration

Origin trace: Source plan §"Monitor Integration (build/orchestrator/monitor.ts)", §"Files to Change" (monitor.ts, types.ts), §"What Already Exists"
Acceptance: `build/orchestrator/types.ts` gains `SkillFaultDetectedEvent` interface (shape: `{ event: 'SKILL_FAULT_DETECTED'; timestamp: string; runId: string; stateSlug: string; stateFile: string; manifestPath: string; faults: SkillFault[] }`). `SKILL_FAULT_DETECTED` is NOT added to `MonitorEventName` union and NOT added to `MONITOR_EXIT_CODES`. `MonitorEvaluation` (in monitor.ts) gains a new field `skillFaultEvents: SkillFaultDetectedEvent[]` (always present, empty array when no faults). Inside `evaluateMonitorOnce()` (where snapshots and state are already in scope), `detectSkillFaults()` is called per snapshot with data extracted from the snapshot (state, run.stdoutLog, run.worktreePath, stateDir, livingPlanPath), wrapped in try/catch; resulting faults are added to `skillFaultEvents`. Callers of `evaluateMonitorOnce()` (in cli.ts or runMonitorMode) print each `skillFaultEvents` entry as a JSON line via `process.stdout.write` before printing the terminal event. `MonitorRunSnapshot` does NOT need to be exported.

### Phase 2.1: Types and Monitor Wiring

- [x] **Test Specification (test-writer role)**: Write tests covering:
  - `SkillFaultDetectedEvent` type exists in `types.ts` with correct shape
  - `SKILL_FAULT_DETECTED` is NOT in `MonitorEventName` union (not a terminal event)
  - `SKILL_FAULT_DETECTED` is NOT a key in `MONITOR_EXIT_CODES`
  - `MonitorEvaluation` type has `skillFaultEvents: SkillFaultDetectedEvent[]` field
  - When `detectSkillFaults()` returns non-empty array, `evaluateMonitorOnce()` returns `skillFaultEvents` with those faults
  - Callers print a JSON line with `"event":"SKILL_FAULT_DETECTED"` before the terminal event line
  - When `detectSkillFaults()` throws inside `evaluateMonitorOnce()`, monitor continues normally and `skillFaultEvents` is empty
  - Monitor process exit code is unaffected by presence or absence of `skillFaultEvents`
    Do NOT write any implementation code yet.
- [x] **Implementation (primary-impl role)**: In `build/orchestrator/types.ts`, add `SkillFaultDetectedEvent` interface (importing `SkillFault` from `./skill-fault-detector`). Do NOT modify `MonitorEventName` or `MONITOR_EXIT_CODES`. In `build/orchestrator/monitor.ts`, add `skillFaultEvents: SkillFaultDetectedEvent[]` to `MonitorEvaluation` interface. Inside `evaluateMonitorOnce()`, for each snapshot (where `snapshot.state`, `snapshot.run.worktreePath`, `snapshot.run.stdoutLog`, `snapshot.stateDir`, `snapshot.livingPlanPath` are accessible), call `try { const faults = detectSkillFaults({ state: snapshot.state, worktreePath: snapshot.run.worktreePath, stdoutLogPath: snapshot.run.stdoutLog, stateDir: snapshot.stateDir, livingPlanPath: snapshot.livingPlanPath }); if (faults.length > 0) skillFaultEvents.push({ event: 'SKILL_FAULT_DETECTED', timestamp: new Date().toISOString(), runId: snapshot.run.runId, stateSlug: snapshot.stateSlug, stateFile: snapshot.stateFile, manifestPath, faults }); } catch(e) { /* swallow */ }`. Callers of `evaluateMonitorOnce()` print each `evaluation.skillFaultEvents` entry via `process.stdout.write(JSON.stringify(ev) + '\n')` before printing the terminal event.
- [x] **Review & QA (review roles)**: Run primary /review, /qa; verify try/catch correct, `MonitorEvaluation.skillFaultEvents` always initialized, no circular imports, SKILL_FAULT_DETECTED not in MonitorEventName.

---

## Feature 3: SKILL.md Step M3.5 -- Investigator Logic

Origin trace: Source plan §"Step M3.5 in build/SKILL.md.tmpl", §"Fault Inbox Paths (revised from D3)", §"Architecture" diagram
Acceptance: `build/SKILL.md.tmpl` has Step M3.5 after Step M3. Step M3's monitor launch is updated to capture monitor stdout to `$BUILD_TMP_DIR/monitor-output.log` using `pipefail` + `${PIPESTATUS[0]}` to preserve the real monitor exit code (e.g., `set -o pipefail; gstack-build monitor ... 2>&1 | tee "$BUILD_TMP_DIR/monitor-output.log"; _MONITOR_EXIT=${PIPESTATUS[0]}`). Step M3.5 reads `$BUILD_TMP_DIR/monitor-output.log`, parses ALL `SKILL_FAULT_DETECTED` JSON lines (using `grep '"event":"SKILL_FAULT_DETECTED"'`), loops over each fault, dedupes each individually by `*-<runId>-<CATEGORY>.md` glob check in `~/.gstack/skill-faults/`, resolves primary (`~/.gstack/skill-faults/`) and secondary (`$(readlink ~/.claude/skills/gstack)/inbox/faults/` when symlink) fault inbox paths, reads `fault_investigator_model` config (default: sonnet), checks `GSTACK_FAULT_INVESTIGATOR_COMMAND` env var: if set, invokes it as a shell command instead of spawning an agent (passing fault context via env vars FAULT_PRIMARY, FAULT_SECONDARY, FAULT_EVENT, FAULT_CATEGORY, FAULT_RUN_ID, FAULT_REPORT_NAME); if not set, spawns one `general-purpose` background agent per non-duplicate fault with read-only investigation + single write constraint. `bun run gen:skill-docs` regenerates `build/SKILL.md` cleanly.

### Phase 3.1: SKILL.md.tmpl Step M3.5

- [x] **Test Specification (test-writer role)**: Write a snapshot/validation test that:
  - Verifies `build/SKILL.md.tmpl` contains a `## Step M3.5` section
  - Verifies Step M3.5 references `SKILL_FAULT_DETECTED`
  - Verifies Step M3.5 references `fault_investigator_model`
  - Verifies Step M3.5 references `~/.gstack/skill-faults/`
  - Verifies Step M3.5 iterates over ALL fault lines (loop, not just one)
  - Verifies Step M3.5 references `GSTACK_FAULT_INVESTIGATOR_COMMAND`
  - Verifies Step M3's monitor launch uses `${PIPESTATUS[0]}` (not just `$?`) to capture monitor exit code
  - Verifies Step M3's monitor launch captures output to `monitor-output.log`
  - Verifies `build/SKILL.md` (generated) contains equivalent Step M3.5 content
  - Run `bun run gen:skill-docs` and verify no error exit
    Do NOT make any changes to SKILL.md.tmpl yet.
- [x] **Implementation (primary-impl role)**: In `build/SKILL.md.tmpl`, update Step M3's monitor launch block to use `set -o pipefail` and `${PIPESTATUS[0]}` to preserve the real monitor exit code while teeing output. Add Step M3.5 after Step M3 that: reads `$BUILD_TMP_DIR/monitor-output.log`; greps for `SKILL_FAULT_DETECTED` lines; loops over each; dedupes; resolves paths; reads model config; checks `GSTACK_FAULT_INVESTIGATOR_COMMAND`: if set invokes it with fault env vars, if not spawns one background agent per non-duplicate fault. Run `bun run gen:skill-docs`. Commit both `.tmpl` and generated `.md`.
- [x] **Review & QA (review roles)**: Run primary /review, /qa; verify `${PIPESTATUS[0]}` not `$?`, dedupe uses `readlink` (not `readlink -f`), investigator prompt says "ONLY" for write constraint, background spawn non-blocking, `GSTACK_FAULT_INVESTIGATOR_COMMAND` check precedes agent spawn.

---

## Feature 4: E2E Test + Touchfile Registration

Origin trace: Source plan §"E2E Test (test/skill-e2e-build-fault-investigator.test.ts)", §"Files to Change" (test file, touchfiles.ts), §"Verification"
Acceptance: `test/skill-e2e-build-fault-investigator.test.ts` exists, registered as `periodic` tier in `E2E_TIERS` in `test/helpers/touchfiles.ts` with dependencies on `build/SKILL.md`, `build/orchestrator/skill-fault-detector.ts`, `build/orchestrator/monitor.ts`. Test sets `GSTACK_BUILD_CLI` env var to a mock gstack-build shell script (so Step M1/M2 uses it), sets `GSTACK_FAULT_INVESTIGATOR_COMMAND` env var to a mock investigator shell script, sets `HOME` to a temp dir so `~/.gstack/skill-faults/` resolves to the temp dir. Mock gstack-build outputs a `SKILL_FAULT_DETECTED` JSON event to stdout and exits 0. Mock investigator writes a fixed report file to `$FAULT_PRIMARY`. Test asserts report exists in temp fault inbox with `PLAN_SYNTHESIS_INVALID` category, asserts no gstack source files were edited.

### Phase 4.1: E2E Test and Registration

- [x] **Test Specification (test-writer role)**: Write the test structure in `test/skill-e2e-build-fault-investigator.test.ts` with:
  - `describeIfSelected('Build skill fault investigator E2E', ['build-fault-investigator-e2e'], ...)` wrapper
  - `beforeAll` setup: create temp dir; write mock gstack-build script that outputs a `SKILL_FAULT_DETECTED` JSON event to stdout and exits 0; write mock investigator script that writes a fixed report containing `PLAN_SYNTHESIS_INVALID` to `$FAULT_PRIMARY`; make both scripts executable
  - Test body sets `GSTACK_BUILD_CLI`, `GSTACK_FAULT_INVESTIGATOR_COMMAND`, and `HOME` env vars so no real gstack-build or agent is invoked
  - Assertions: report file exists in resolved temp `~/.gstack/skill-faults/` path, file contains `PLAN_SYNTHESIS_INVALID`, no gstack source files edited
  - Register in `test/helpers/touchfiles.ts` under `E2E_TIERS` as `periodic`
    The test will fail initially because Feature 3 infrastructure must be present.
- [x] **Implementation (primary-impl role)**: Complete `test/skill-e2e-build-fault-investigator.test.ts` (full working test body), ensure `touchfiles.ts` correctly lists dependencies, verify `eval:select` picks this test when `build/orchestrator/skill-fault-detector.ts` is changed.
- [x] **Review & QA (review roles)**: Run `bun test test/skill-e2e-build-fault-investigator.test.ts` in dry-run (non-EVALS) mode to verify test structure is valid. Run `bun run eval:select` to confirm selection logic. Run primary /review.
