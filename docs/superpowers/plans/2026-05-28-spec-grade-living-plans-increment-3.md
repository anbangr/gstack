# Spec-Grade Living Plans — Increment 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Consolidate `featureReview` and `featureVerifier` into a single role (`featureVerifier`) that reads the pre-designed Verification Spec from the living plan and runs it deterministically. Replaces the invent-at-runtime behavior that caused instability in feature-completion verification.

**Architecture:** `featureReview` role and limits/timeouts rename to `featureVerify`. The `featureVerifier` role's prompt + parser are extended to consume the verbatim `### Verification Spec` block from each feature in the living plan (added in Increment 2). On probe failure, the test-fixer dispatch payload becomes a structured `{ac, cmd, expected, actual, halt_at}` record instead of free-text. One-time `configure.cm` migration backfills the rename for users upgrading mid-stream.

**Tech Stack:** TypeScript / Bun; existing `configure.cm` JSON config + `gstack-upgrade/migrations/`.

---

## Scope and out-of-scope

**In scope (Increment 3):**

- Add `featureVerify` to `limits` + `timeoutsMs` in `configure.cm` (rename of `featureReview`)
- Make `featureReview` optional in `RoleConfigs` type; keep migration backfill that maps old `featureReview` config to `featureVerifier` for users mid-stream
- Update `featureVerifier` prompt template to read `### Verification Spec` from the feature block and emit structured pass/fail report
- Test-fixer dispatch payload becomes structured `{ac, cmd, expected, actual, halt_at}`
- `gstack-upgrade/migrations/` script that renames legacy config keys
- Update SKILL template notes
- Bump skill version

**Out of scope (defer to follow-up):**

- Full deterministic-probe execution rewrite of `feature-verifier.ts` (the existing subagent dispatch shape stays; we just feed it richer input + parse richer output)
- Removing all `featureReview` call sites in `cli.ts` and `phase-runner.ts` — those remain as the consumer of `featureVerifier`'s output (one less role, same plumbing)
- `subjectiveReview` role (not requested; deferred)

## File structure

```text
build/
  configure.cm                                      # MODIFY — add featureVerify limit/timeout
  SKILL.md.tmpl                                     # MODIFY — note consolidation; document Verification Spec contract
  SKILL.md                                          # REGENERATE
  orchestrator/
    feature-verifier.ts                             # MODIFY — read Verification Spec, emit structured report
    role-config.ts                                  # MODIFY — featureReview becomes optional
    build-config.ts                                 # MODIFY — featureVerify migration backfill
    phase-runner.ts                                 # MODIFY — parse structured featureVerifier output if present
    __tests__/
      feature-verifier-structured-output.test.ts    # NEW — covers structured contract

gstack-upgrade/
  migrations/
    2026-05-28-featureverify-rename.ts              # NEW — rename featureReview → featureVerify in user configs
```

---

## Task 1: configure.cm — add featureVerify limit + timeout

- [ ] **Step 1**: read `build/configure.cm`. Add to `limits`:
  ```json
      "featureVerifyMaxIterations": 3,
  ```
  next to `featureReviewMaxIterations` (keep both).
- [ ] **Step 2**: add to `timeoutsMs`:
  ```json
      "featureVerify": 1200000,
  ```
  next to `featureReview` (keep both).
- [ ] **Step 3**: `jq . build/configure.cm > /dev/null && echo "valid"` — expect "valid".
- [ ] **Step 4**: commit:
  ```bash
  git add build/configure.cm
  git commit -m "feat(build): add featureVerifyMaxIterations limit + featureVerify timeout (Increment 3 prep)"
  ```

## Task 2: BuildLimits + BuildTimeoutsMs type extension

**File:** `build/orchestrator/build-config.ts`

- [ ] **Step 1**: add `featureVerifyMaxIterations: number;` to `BuildLimits` interface.
- [ ] **Step 2**: add `featureVerify: number;` to `BuildTimeoutsMs` interface.
- [ ] **Step 3**: add `"featureVerifyMaxIterations"` to the `withMigratedNumberSection` newKeys list for `limits` and `"featureVerify"` to the list for `timeoutsMs` so older user configs auto-backfill from the in-tree default.
- [ ] **Step 4**: add `"featureVerifyMaxIterations"` to the validation key list in the `limits` validateNumberSection call; add `"featureVerify"` to the `timeoutsMs` list.
- [ ] **Step 5**: run `bun test build/orchestrator/__tests__/role-config.test.ts build/orchestrator/__tests__/build-config.test.ts 2>&1 | tail -5`. Expect all pass (or just the ones tied to these helpers). If a test names featureReview specifically and now expects featureVerify, update to expect both for back-compat during the transition.
- [ ] **Step 6**: commit:
  ```bash
  git add build/orchestrator/build-config.ts
  git commit -m "feat(build/orchestrator): extend BuildLimits + BuildTimeoutsMs with featureVerify keys (back-compat)"
  ```

## Task 3: featureVerifier reads Verification Spec from living plan

**File:** `build/orchestrator/feature-verifier.ts`

The current verifier dispatch builds a free-text prompt that asks the subagent to audit a feature's acceptance criteria. We want to:

1. Locate the `### Verification Spec` block in the living plan feature.
2. Pass it verbatim into the verifier prompt with explicit instructions: "Run the smoke commands and acceptance probes in order. Report structured pass/fail per probe. Do NOT invent additional probes."
3. Extend the output parser to recognize a structured JSON report (with `smoke_run`, `acceptance_probes`, `verification_artifacts`, `overall`, `halt_at`, `notes` fields) and fall back to the existing free-text parse for backward compatibility.

- [ ] **Step 1**: read `build/orchestrator/feature-verifier.ts` (~450 lines) to understand the dispatch shape — locate the prompt construction and the output parser.
- [ ] **Step 2**: add a helper `extractVerificationSpec(featureBody: string): string | null` near the top of the file. Implementation: match the section between `### Verification Spec` and the next H3 or end-of-block. Return the raw text (preserve formatting) or null when missing.
- [ ] **Step 3**: in the prompt construction, when `extractVerificationSpec` returns content, prepend it as the PRIMARY contract: "VERIFICATION SPEC FOR THIS FEATURE (run verbatim, do NOT invent probes):\n<spec>\nAfter running, output a JSON object on its own line: `{smoke_run, acceptance_probes, verification_artifacts, overall, halt_at, notes}`." When null, fall back to the existing prompt unchanged.
- [ ] **Step 4**: in the output parser, scan the verifier's response for a line matching `/^\{[\s\S]*"overall"[\s\S]*\}$/` (the structured JSON). Parse it. If parse fails OR no JSON line is present, fall back to the existing free-text parse.
- [ ] **Step 5**: ensure the existing `FeatureVerifierResult` type supports both shapes (extend it with optional structured-output fields).
- [ ] **Step 6**: commit:
  ```bash
  git add build/orchestrator/feature-verifier.ts
  git commit -m "feat(build/orchestrator): featureVerifier reads Verification Spec from living plan; parses structured pass/fail JSON"
  ```

## Task 4: structured fix-payload to test-fixer

**File:** `build/orchestrator/feature-verifier.ts` + the test-fixer dispatch site (likely in `cli.ts` or `phase-runner.ts`).

When `featureVerifier` returns a structured failure (a probe failed), the test-fixer should receive `{ac, cmd, expected, actual, halt_at}` instead of a free-text summary.

- [ ] **Step 1**: grep for the test-fixer dispatch when featureVerifier fails: `grep -n "testFixer\|test-fixer\|FEATURE_NEEDS_PHASES" build/orchestrator/*.ts`. Locate the function that builds the fixer's input prompt.
- [ ] **Step 2**: when the verifier's result contains structured probe failures, format them into the fixer prompt as: "Acceptance criterion AC{ac} failed.\nCommand: {cmd}\nExpected: {expected}\nActual: {actual}\nFailure occurred at: {halt_at}\nFix the production code to make this probe pass without modifying the probe."
- [ ] **Step 3**: when the result is free-text (old format), pass the free-text as before.
- [ ] **Step 4**: add a test in `build/orchestrator/__tests__/feature-verifier-structured-output.test.ts` that constructs a fake structured result and asserts the fixer prompt contains the AC + cmd + expected + actual fields.
- [ ] **Step 5**: commit:
  ```bash
  git add build/orchestrator/feature-verifier.ts build/orchestrator/cli.ts build/orchestrator/phase-runner.ts build/orchestrator/__tests__/feature-verifier-structured-output.test.ts
  git commit -m "feat(build/orchestrator): test-fixer dispatch receives structured probe-failure payload from featureVerifier"
  ```

## Task 5: featureReview role becomes optional; migration script

**File:** `build/orchestrator/role-config.ts` + `gstack-upgrade/migrations/`

- [ ] **Step 1**: in `role-config.ts`, change `featureReview: RoleConfig;` to `featureReview?: RoleConfig;` in `RoleConfigs` (optional). Keep it in `ROLE_DEFINITIONS` so users who still have it in configure.cm still get env-override support. The orchestrator code in `feature-review.ts` already references it; making the type optional just means callers must null-check before use.
- [ ] **Step 2**: grep for callers that dereference `config.roles.featureReview` and add null-check fallbacks: when missing, fall back to `featureVerifier`'s config. Likely one or two sites in `feature-review.ts` or wherever the role is dispatched.
- [ ] **Step 3**: create `gstack-upgrade/migrations/2026-05-28-featureverify-rename.ts`:

  ```typescript
  #!/usr/bin/env bun
  /**
   * Migration: in user configure.cm files, when limits.featureReviewMaxIterations
   * is present but limits.featureVerifyMaxIterations is absent, copy the value
   * across. Same for timeoutsMs.featureReview → timeoutsMs.featureVerify.
   * Idempotent: skips if the target keys already exist.
   */
  import * as fs from "node:fs";
  import * as path from "node:path";

  export function migrate(configPath: string): {
    migrated: boolean;
    changes: string[];
  } {
    if (!fs.existsSync(configPath)) return { migrated: false, changes: [] };
    const raw = fs.readFileSync(configPath, "utf8");
    let config: any;
    try {
      config = JSON.parse(raw);
    } catch {
      return {
        migrated: false,
        changes: [`skipped: ${configPath} not valid JSON`],
      };
    }
    const changes: string[] = [];
    if (
      config.limits?.featureReviewMaxIterations !== undefined &&
      config.limits?.featureVerifyMaxIterations === undefined
    ) {
      config.limits.featureVerifyMaxIterations =
        config.limits.featureReviewMaxIterations;
      changes.push(
        `limits.featureVerifyMaxIterations := ${config.limits.featureReviewMaxIterations} (from featureReviewMaxIterations)`,
      );
    }
    if (
      config.timeoutsMs?.featureReview !== undefined &&
      config.timeoutsMs?.featureVerify === undefined
    ) {
      config.timeoutsMs.featureVerify = config.timeoutsMs.featureReview;
      changes.push(
        `timeoutsMs.featureVerify := ${config.timeoutsMs.featureReview} (from featureReview)`,
      );
    }
    if (changes.length === 0)
      return { migrated: false, changes: ["already current"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return { migrated: true, changes };
  }

  if (import.meta.main) {
    const target =
      process.argv[2] ||
      path.join(
        process.env.HOME || "",
        ".claude/skills/gstack/build/configure.cm",
      );
    const result = migrate(target);
    console.log(JSON.stringify(result, null, 2));
  }
  ```

- [ ] **Step 4**: smoke-test:
  ```bash
  cp build/configure.cm /tmp/configure-test.cm
  bun run gstack-upgrade/migrations/2026-05-28-featureverify-rename.ts /tmp/configure-test.cm
  jq '.limits.featureVerifyMaxIterations, .timeoutsMs.featureVerify' /tmp/configure-test.cm
  rm /tmp/configure-test.cm
  ```
- [ ] **Step 5**: commit:
  ```bash
  git add build/orchestrator/role-config.ts gstack-upgrade/migrations/2026-05-28-featureverify-rename.ts
  git commit -m "feat(gstack-upgrade): featureReview→featureVerify config migration; role becomes optional"
  ```

## Task 6: SKILL template note + version bump

- [ ] **Step 1**: in `build/SKILL.md.tmpl`, locate the existing featureVerifier description (grep: `grep -n "featureVerifier\|featureReview" build/SKILL.md.tmpl | head -10`). Add a paragraph noting:
  > **Increment 3+**: `featureVerifier` now reads the pre-designed `### Verification Spec` block from each living-plan feature and runs it deterministically. The legacy `featureReview` role is being consolidated; configure.cm still accepts it for back-compat. Probe failures are surfaced to the test-fixer as structured `{ac, cmd, expected, actual, halt_at}` records.
- [ ] **Step 2**: bump version: `version: 1.32.0` → `1.33.0`.
- [ ] **Step 3**: `bun run gen:skill-docs`.
- [ ] **Step 4**: `bun test test/gen-skill-docs.test.ts 2>&1 | tail -3` — expect all pass.
- [ ] **Step 5**: commit:
  ```bash
  git add build/SKILL.md.tmpl build/SKILL.md
  git commit -m "chore(build): bump skill to 1.33.0 + note featureVerifier consolidation"
  ```

## Task 7: full test pass

- [ ] Run `bun test 2>&1 | tail -10` — expect 0 unrelated failures (the same `critical_exit_pending` pre-existing failure may show; that's fine).
- [ ] If any new failure relates to Tasks 1-6, STOP and report BLOCKED.
- [ ] No commit — verification only.
