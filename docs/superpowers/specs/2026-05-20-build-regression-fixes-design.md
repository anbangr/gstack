# Build Regression Fixes Design

Date: 2026-05-20

## Context

Three regressions need one focused fix plan:

1. Non-code living-plan phases can be synthesized as separate draft and review phases. The parser requires one executable phase to contain both required gates for its kind, so split `[writing]` phases are dropped with missing-checkbox warnings.
2. Primary implementor hygiene can report `changed workspace root status` even when the implementation commit is clean and complete. The guard appears to compare against a parent-workspace snapshot that may predate orchestrator-owned checkout movement.
3. The full `bun test` suite fails `test/test-isolation-lint.test.ts` because two orchestrator tests call fault-detector paths without isolating `GSTACK_HOME`.

## Goals

- Keep parser strictness: executable phases must include all required gates.
- Make non-code phase shape clear to synthesizers and operators.
- Fail malformed split non-code phase plans with actionable diagnostics before execution.
- Preserve parent-workspace hygiene protection while avoiding false attribution of orchestrator-owned state changes to subagents.
- Restore full-suite test isolation.

## Non-Goals

- Redesign the phase parser or phase-kind model.
- Loosen hygiene so real parent-workspace mutations pass unnoticed.
- Refactor unrelated build orchestration state flow.

## Approach

Use validator-centered hardening:

- Add explicit documentation and prompt text for non-code phase gate pairs.
- Add a preflight diagnostic for split non-code phases that tells the operator to merge the draft/action and review gates into one phase.
- Refresh parent-workspace hygiene snapshots around each mutable role invocation so only mutations during the subagent window are attributed to that role.
- Add isolated `GSTACK_HOME` setup to the two failing test files.

## Design

### 1. Non-Code Phase Shape

The parser keeps the current contract:

| Kind | Implementation gate | Review gate |
| --- | --- | --- |
| `code` | `**Implementation**` | `**Review**` or `**Review & QA**` |
| `writing` | `**Draft**` | `**Review**` |
| `experiment` | `**Execute**` | `**Review**` |
| `research` | `**Explore**` | `**Review**` |
| `manual` | `**Action Required**` | `**Verify Completion**` |

One phase must contain both gates. A plan like this is invalid:

```markdown
### Phase 1 [writing]: Draft
- [ ] **Draft**: write the paper

### Phase 2 [writing]: Review
- [ ] **Review**: review the paper
```

The corrected shape is:

```markdown
### Phase 1 [writing]: Draft and review
- [ ] **Draft**: write the paper
- [ ] **Review**: review the paper
```

Implementation should update `build/orchestrator/README.md` and `SYNTH_REVISION_PROMPT` so plan synthesis and re-synthesis say this explicitly. Add tests that pin the prompt text and the parser/validator diagnostic.

### 2. Plan Diagnostics

The parser already reports missing implementation/review checkboxes and `droppedPhasesCount`. The improvement should add a targeted diagnostic when adjacent same-kind non-code phases look like a split gate pair:

- first phase has the kind's implementation gate but no review gate
- next phase has the same kind's review gate but no implementation gate
- both are under the same feature

The diagnostic should mention both phase numbers and the required merged shape. This can live in parser warnings or a validator helper used by startup preflight. Prefer the smallest local place that already has phase body context.

### 3. Parent Workspace Hygiene

Parent workspace hygiene remains strict, but the snapshot window changes.

Current problem: a long-lived parent snapshot can include state before orchestrator-owned branch/checkout movement. Later, mutable-agent hygiene compares against that old snapshot and reports the role changed the parent workspace.

New behavior:

- Capture the parent workspace snapshot immediately before invoking a mutable role.
- Pass that per-role snapshot into `applyMutableAgentHygiene`.
- Keep the comparison after the role completes.
- Do the same for review/QA gate hygiene because `applyGateHygiene` also compares parent-workspace snapshots.

This preserves the real guard: if a subagent changes parent HEAD or status during its own run, hygiene fails. It removes false attribution for changes that happened before the role started.

Regression tests:

- Parent changes before the per-role snapshot, child implementation is clean: pass.
- Parent changes after the per-role snapshot: fail with the existing parent-workspace error.

### 4. Test Isolation

The lint failure names two files:

- `build/orchestrator/__tests__/halt-events-e2e.test.ts`
- `build/orchestrator/__tests__/skill-fault-detector.test.ts`

Both should isolate `GSTACK_HOME` for the full describe scope by importing the shared helper:

```ts
import { useIsolatedGstackHome } from "../../../test/helpers/test-home";
```

Update `test/test-isolation-lint.test.ts` so the canonical helper import is recognized from nested test directories as well as top-level `test/`. Then call `useIsolatedGstackHome()` at the top of each affected `describe` block. This keeps one helper-based isolation style instead of forcing nested tests to hand-roll `beforeEach` environment setup.

## Testing

Run focused tests:

```bash
bun test build/orchestrator/__tests__/parser.test.ts
bun test build/orchestrator/__tests__/plan-review-prompts.test.ts
bun test build/orchestrator/__tests__/cli.test.ts --test-name-pattern "hygiene|workspace root"
bun test build/orchestrator/__tests__/halt-events-e2e.test.ts build/orchestrator/__tests__/skill-fault-detector.test.ts test/test-isolation-lint.test.ts
```

Run the already relevant build-regression suites:

```bash
bun test \
  build/orchestrator/__tests__/drain-halt-events-audit-skip.test.ts \
  build/orchestrator/__tests__/manual-recovery-emit-site.test.ts \
  test/gstack-upgrade-migration-v1_40_5_0.test.ts
```

Then run full verification:

```bash
bun test
```

## Risks

- Parser diagnostics could become noisy if they guess too broadly. Keep the split-phase detection narrow: adjacent same-kind non-code phases under one feature, with complementary missing gates.
- Parent-workspace hygiene could be weakened if snapshots are captured after subagent work starts. Capture immediately before the role invocation, not inside post-run hygiene.
- The isolation lint currently recognizes only the top-level `./helpers/test-home` import path. Broaden that matcher to relative imports ending in `test/helpers/test-home`, and keep the call-site requirement unchanged.

## Success Criteria

- Split `[writing]` draft/review plans produce an actionable diagnostic.
- Synthesizer prompt and README both describe the one-phase/two-gate non-code contract.
- Clean implementor commits are not failed due to parent workspace changes that predate the role invocation.
- Parent workspace mutations during a role invocation still fail.
- `test/test-isolation-lint.test.ts` passes.
- Full `bun test` passes or only reports unrelated pre-existing failures with clear evidence.
