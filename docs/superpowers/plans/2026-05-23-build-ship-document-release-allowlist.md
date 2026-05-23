# Build Ship `/document-release` Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allowlist the `Task` and `Agent` subagent-dispatch tool in the build orchestrator's Claude `/ship` spawn so `/ship` Step 18 can dispatch `/document-release` and stop silently skipping docs reconciliation in autonomous builds.

**Architecture:** Plumb an optional `allowedTools?: readonly string[]` field through the build's Claude spawn chain (`runSlashCommand` → `runConfiguredRoleTask` → `runClaudeTask` → `buildClaudeTaskArgv`). When set, `buildClaudeTaskArgv` emits `--allowedTools <name1> <name2> …` at the end of the argv. The only call site that sets a non-undefined value is `runShip`, and only on the ship-role call (`/land-and-deploy` does not get the field). The change is strictly additive: every existing caller continues to pass undefined and gets byte-for-byte identical argv.

**Tech Stack:** Bun + bun:test, TypeScript, the orchestrator at `build/orchestrator/sub-agents.ts`, and the existing argv-shape test suite at `build/orchestrator/__tests__/sub-agents.test.ts:1242`.

**Spec:** `docs/superpowers/specs/2026-05-23-build-ship-document-release-allowlist-design.md`

**Working directory for all tasks:** `/Users/anbang/Documents/Antigravity/claude-workspace/gstack`

**Branch:** create a fresh feat branch from current main before Task 1 (`feat/build-ship-docrelease-allowlist`). Every commit lands on that branch.

```bash
git checkout main
git pull --ff-only origin main
git checkout -b feat/build-ship-docrelease-allowlist
```

---

## File map (locked before any task)

- **`build/orchestrator/sub-agents.ts`** — modify in place. Four edit points:
  1. `buildClaudeTaskArgv` opts signature gains `allowedTools?: readonly string[]`.
  2. `buildClaudeTaskArgv` return value emits `--allowedTools` and the names when present.
  3. `runClaudeTask` opts signature gains the same field and forwards to `buildClaudeTaskArgv`.
  4. `runConfiguredRoleTask`'s `RunConfiguredRoleTaskOpts` interface gains the same field; the `provider === "claude"` branch forwards it to `runClaudeTask`; other branches ignore it.
  5. `runSlashCommand` opts signature gains the same field; spreads it through to `runConfiguredRoleTask`.
  6. `runShip` body: at the ship `runSlashCommand` call (currently at `sub-agents.ts:1782`), add `allowedTools: ["Task", "Agent"]`. The `/land-and-deploy` call (currently at `sub-agents.ts:1830`) is left exactly as it is — no field passed.

- **`build/orchestrator/__tests__/sub-agents.test.ts`** — add six new free unit tests:
  - Four go inside the existing `describe("buildClaudeTaskArgv (claude role invocation shape)")` block at line 1242.
  - One new `describe("runShip allowlist propagation")` block at the end of the file with two tests (functional + static-grep invariant).

No other files are touched. No new files are created. No imports change beyond the existing test file's `runShip` import.

---

## Task 1: Extend `buildClaudeTaskArgv` to accept and emit `allowedTools`

**Files:**

- Modify: `build/orchestrator/sub-agents.ts:1577-1604` (the `buildClaudeTaskArgv` function only)
- Test: `build/orchestrator/__tests__/sub-agents.test.ts:1242-1276` (the existing `buildClaudeTaskArgv` describe block)

- [ ] **Step 1.1: Add the first failing test — "no flag when allowedTools omitted"**

Add inside the existing `describe("buildClaudeTaskArgv (claude role invocation shape)")` block (around line 1276, after the existing two `it(...)` blocks, before the closing `});`):

```ts
it("emits no --allowedTools flag when allowedTools is omitted", () => {
  const argv = buildClaudeTaskArgv({
    inputFilePath: "/tmp/ship-in.md",
    outputFilePath: "/tmp/ship-out.md",
    command: "/gstack-ship",
    model: "role-model-under-test",
    reasoning: "high",
  });
  expect(argv).not.toContain("--allowedTools");
});
```

- [ ] **Step 1.2: Run the test and confirm it passes today (baseline)**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "emits no --allowedTools flag" 2>&1 | tail -10`

Expected: PASS, 1 test. The current code does not emit `--allowedTools`, so this passes immediately. This locks the backward-compat invariant before we change anything.

- [ ] **Step 1.3: Add the second failing test — "emits names in order when present"**

Add right after the test from Step 1.1:

```ts
it("emits --allowedTools followed by each tool name when allowedTools is non-empty", () => {
  const argv = buildClaudeTaskArgv({
    inputFilePath: "/tmp/ship-in.md",
    outputFilePath: "/tmp/ship-out.md",
    command: "/gstack-ship",
    model: "role-model-under-test",
    reasoning: "high",
    allowedTools: ["Task", "Agent"],
  });
  const idx = argv.indexOf("--allowedTools");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("Task");
  expect(argv[idx + 2]).toBe("Agent");
});
```

- [ ] **Step 1.4: Run the test and confirm it fails (TypeScript error)**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "emits --allowedTools followed by each tool name" 2>&1 | tail -15`

Expected: FAIL. The TypeScript signature of `buildClaudeTaskArgv` does not yet accept `allowedTools`, so this either errors with `Object literal may only specify known properties` (compile-time) or — because bun:test uses Bun's looser TS surface at runtime — runs and gets `idx === -1`, failing the `toBeGreaterThanOrEqual(0)` assertion. Either way, FAIL.

- [ ] **Step 1.5: Add the third failing test — "empty array is treated as omitted"**

Add right after the test from Step 1.3:

```ts
it("omits --allowedTools when allowedTools is the empty array", () => {
  const argv = buildClaudeTaskArgv({
    inputFilePath: "/tmp/ship-in.md",
    outputFilePath: "/tmp/ship-out.md",
    command: "/gstack-ship",
    model: "role-model-under-test",
    reasoning: "high",
    allowedTools: [],
  });
  expect(argv).not.toContain("--allowedTools");
});
```

- [ ] **Step 1.6: Add the fourth failing test — "flag goes AFTER -p prompt"**

Add right after the test from Step 1.5:

```ts
it("preserves --allowedTools position after -p prompt", () => {
  const argv = buildClaudeTaskArgv({
    inputFilePath: "/tmp/ship-in.md",
    outputFilePath: "/tmp/ship-out.md",
    command: "/gstack-ship",
    model: "role-model-under-test",
    reasoning: "high",
    allowedTools: ["Task", "Agent"],
  });
  const pIdx = argv.indexOf("-p");
  const allowedIdx = argv.indexOf("--allowedTools");
  expect(pIdx).toBeGreaterThanOrEqual(0);
  expect(allowedIdx).toBeGreaterThan(pIdx + 1);
});
```

- [ ] **Step 1.7: Run all four new tests and confirm three fail**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "allowedTools" 2>&1 | tail -20`

Expected: 4 tests run. The first (`emits no --allowedTools flag when allowedTools is omitted`) PASSES. The other three FAIL — either at compile time (unknown property `allowedTools`) or at runtime (flag never appears in argv).

- [ ] **Step 1.8: Edit `buildClaudeTaskArgv` signature and body**

Open `build/orchestrator/sub-agents.ts` and replace the function at lines 1577-1604 with:

```ts
export function buildClaudeTaskArgv(opts: {
  inputFilePath: string;
  outputFilePath: string;
  command?: string;
  model?: string;
  reasoning?: RoleReasoning;
  gate?: boolean;
  allowedTools?: readonly string[];
}): string[] {
  const commandLine = opts.command
    ? `Run ${opts.command}.`
    : "Do the requested work.";
  const gateLine = opts.gate
    ? `The report MUST include a final 'GATE PASS' or 'GATE FAIL' line on its own.`
    : "";
  const prompt = [
    `Use ${opts.reasoning || "high"} thinking.`,
    `Read instructions at ${opts.inputFilePath}.`,
    commandLine,
    `Write your complete output to ${opts.outputFilePath}.`,
    `Do not print the report to stdout; stdout is only for the output file path.`,
    `If you cannot write ${opts.outputFilePath}, exit non-zero.`,
    gateLine,
    `Return ONLY the output file path. No narrative.`,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    ...(opts.model ? ["--model", opts.model] : []),
    "-p",
    prompt,
    ...(opts.allowedTools && opts.allowedTools.length > 0
      ? ["--allowedTools", ...opts.allowedTools]
      : []),
  ];
}
```

The only changes vs the existing function: the opts type gains `allowedTools?: readonly string[]`, and the return array spreads the new flag at the end.

- [ ] **Step 1.9: Run all four new tests and confirm they all pass**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "allowedTools" 2>&1 | tail -10`

Expected: 4 pass / 0 fail.

- [ ] **Step 1.10: Run the entire `buildClaudeTaskArgv` describe block to confirm no regression**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "buildClaudeTaskArgv" 2>&1 | tail -10`

Expected: 6 pass / 0 fail (2 pre-existing + 4 new).

- [ ] **Step 1.11: Commit**

```bash
git add build/orchestrator/sub-agents.ts build/orchestrator/__tests__/sub-agents.test.ts
git commit -m "feat(build): buildClaudeTaskArgv accepts allowedTools and emits --allowedTools flag"
```

---

## Task 2: Forward `allowedTools` through `runClaudeTask`

**Files:**

- Modify: `build/orchestrator/sub-agents.ts:1709-1743` (the `runClaudeTask` function)

This task has no dedicated unit test of its own — `runClaudeTask`'s only behavior is "spawn `CLAUDE_BIN` with argv from `buildClaudeTaskArgv` and merge the output file." The argv shape is fully covered by Task 1's tests. The forwarding is then covered end-to-end by Task 5's `runShip` test. So this task is a pure type-and-spread change; verification is "Bun's TypeScript compile still passes."

- [ ] **Step 2.1: Add `allowedTools` to the `runClaudeTask` opts type**

Open `build/orchestrator/sub-agents.ts` at the function signature (currently lines 1709-1722) and add the field:

```ts
export async function runClaudeTask(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  command?: string;
  model?: string;
  reasoning?: RoleReasoning;
  gate?: boolean;
  timeoutMs?: number;
  allowedTools?: readonly string[];
}): Promise<SubAgentResult> {
```

- [ ] **Step 2.2: Forward `allowedTools` to `buildClaudeTaskArgv`**

In the same function body, the line that currently reads `const argv = buildClaudeTaskArgv(opts);` works automatically because `opts` is a superset of `buildClaudeTaskArgv`'s opts. No change to the body is needed — TypeScript's structural typing handles it.

Confirm by re-reading the function body: it passes `opts` to `buildClaudeTaskArgv`, then forwards other fields to `spawnCaptured` by destructuring. Since `allowedTools` is now a known property of `opts`, it flows through the existing `buildClaudeTaskArgv(opts)` call automatically.

- [ ] **Step 2.3: Type-check the file**

Run: `bun build build/orchestrator/sub-agents.ts --target=node --outfile=/tmp/sub-agents-check.js 2>&1 | tail -10`

Expected: no errors. (The `bun build` smoke check is faster than `tsc` and exercises the same type system.)

- [ ] **Step 2.4: Re-run the buildClaudeTaskArgv tests to confirm nothing broke**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "buildClaudeTaskArgv" 2>&1 | tail -10`

Expected: 6 pass / 0 fail.

- [ ] **Step 2.5: Commit**

```bash
git add build/orchestrator/sub-agents.ts
git commit -m "feat(build): runClaudeTask accepts and forwards allowedTools"
```

---

## Task 3: Forward `allowedTools` through `runConfiguredRoleTask`

**Files:**

- Modify: `build/orchestrator/sub-agents.ts` — both the `RunConfiguredRoleTaskOpts` interface (around line 1870) and the `runConfiguredRoleTask` function body's `provider === "claude"` branch (around line 2005)

- [ ] **Step 3.1: Add `allowedTools` to `RunConfiguredRoleTaskOpts`**

Locate the interface (currently around line 1870-1893) and add the field at the end:

```ts
export interface RunConfiguredRoleTaskOpts {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  role: RoleConfig;
  timeoutMs?: number;
  gate?: boolean;
  sandbox?: CodexSandbox;
  codexDefaultCommand?: string;
  /**
   * Run identifier matching wrap-console.ts's keying
   * (`state.launch?.runId ?? state.slug`). Threaded from cli.ts call sites
   * that have access to state.launch.runId so the Class 4 RESOLVED emit's
   * pair key matches the DETECTED row wrap-console wrote. When undefined
   * (older callers, direct test fixtures), fall back to opts.slug — same
   * default helperCtxFor uses.
   */
  runId?: string;
  /**
   * Optional tool allowlist forwarded to the Claude provider only.
   * Gemini, Kimi, and Codex branches ignore this field. Used to grant the
   * inner /ship session access to the Task/Agent subagent-dispatch tool
   * so /ship Step 18 can run /document-release.
   */
  allowedTools?: readonly string[];
}
```

- [ ] **Step 3.2: Forward `allowedTools` to `runClaudeTask` in the `provider === "claude"` branch**

Locate the `provider === "claude"` branch of `runConfiguredRoleTask` (currently at lines 2005-2019). The call passes a destructured object to `runClaudeTask`. Add `allowedTools` to that destructured object:

```ts
if (opts.role.provider === "claude") {
  result = await runClaudeTask({
    inputFilePath: opts.inputFilePath,
    outputFilePath: opts.outputFilePath,
    cwd: opts.cwd,
    slug: opts.slug,
    phaseNumber: opts.phaseNumber,
    iteration: opts.iteration,
    logPrefix: opts.logPrefix,
    command: opts.role.command,
    model: opts.role.model,
    reasoning: opts.role.reasoning,
    gate: opts.gate,
    timeoutMs: effectiveTimeoutMs,
    allowedTools: opts.allowedTools,
  });
}
```

Leave the `gemini` / `kimi` / `codex` branches exactly as they are. Allowlist is a Claude-specific concept; the other providers must not receive it.

- [ ] **Step 3.3: Type-check the file**

Run: `bun build build/orchestrator/sub-agents.ts --target=node --outfile=/tmp/sub-agents-check.js 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 3.4: Re-run argv tests to confirm nothing broke**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "buildClaudeTaskArgv" 2>&1 | tail -10`

Expected: 6 pass / 0 fail.

- [ ] **Step 3.5: Commit**

```bash
git add build/orchestrator/sub-agents.ts
git commit -m "feat(build): runConfiguredRoleTask forwards allowedTools to Claude branch only"
```

---

## Task 4: Forward `allowedTools` through `runSlashCommand`

**Files:**

- Modify: `build/orchestrator/sub-agents.ts:1842-1869` (the `runSlashCommand` function)

- [ ] **Step 4.1: Add `allowedTools` to the `runSlashCommand` opts type**

Open `build/orchestrator/sub-agents.ts` and update the signature (currently lines 1842-1863) to add the field at the end of the opts type:

```ts
export async function runSlashCommand(opts: {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  phaseNumber?: string;
  iteration?: number;
  logPrefix: string;
  role: {
    provider: RoleProvider;
    model: string;
    reasoning: RoleReasoning;
    command: string;
    backupProvider?: RoleProvider;
    backupModel?: string;
    timeoutMs?: number;
    backupTimeoutMs?: number;
  };
  timeoutMs?: number;
  gate?: boolean;
  sandbox?: CodexSandbox;
  allowedTools?: readonly string[];
}): Promise<SubAgentResult> {
  return runConfiguredRoleTask({
    ...opts,
    codexDefaultCommand: "/gstack-review",
  });
}
```

The body does NOT change — the existing `...opts` spread already forwards every property to `runConfiguredRoleTask`, including the new `allowedTools` field, because `RunConfiguredRoleTaskOpts` (extended in Task 3) now accepts it.

- [ ] **Step 4.2: Type-check the file**

Run: `bun build build/orchestrator/sub-agents.ts --target=node --outfile=/tmp/sub-agents-check.js 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 4.3: Commit**

```bash
git add build/orchestrator/sub-agents.ts
git commit -m "feat(build): runSlashCommand accepts and forwards allowedTools"
```

---

## Task 5: Set `allowedTools: ["Task", "Agent"]` on the ship call in `runShip`

**Files:**

- Modify: `build/orchestrator/sub-agents.ts:1749-1840` (the `runShip` function, specifically the FIRST `runSlashCommand` call around line 1782)
- Test: `build/orchestrator/__tests__/sub-agents.test.ts` — new describe block at end of file

- [ ] **Step 5.1: Write the failing test — `runShip` passes `allowedTools` to ship call, not land call**

Open `build/orchestrator/__tests__/sub-agents.test.ts`. Read the bottom of the file to confirm the existing import list includes `runShip`:

```bash
grep -n "^import\|^} from" build/orchestrator/__tests__/sub-agents.test.ts | head -10
```

If `runShip` is not yet imported, add it to the existing destructured import from `"../sub-agents"`. If `runClaudeTask` is not yet imported, add it too — the test will mock it via `spyOn`.

Then append this describe block at the END of the file (after the final closing `});`):

```ts
describe("runShip allowlist propagation", () => {
  it("passes allowedTools to the ship call but not to land-and-deploy", async () => {
    // Capture every runClaudeTask call's opts. The full forwarding chain
    // runShip → runSlashCommand → runConfiguredRoleTask → runClaudeTask
    // gets exercised; runClaudeTask is the boundary where allowedTools
    // becomes a real argv flag.
    const calls: Array<{
      logPrefix: string;
      allowedTools: readonly string[] | undefined;
    }> = [];

    const subAgents = await import("../sub-agents");
    const spy = spyOn(subAgents, "runClaudeTask").mockImplementation(
      async (opts: Parameters<typeof subAgents.runClaudeTask>[0]) => {
        calls.push({
          logPrefix: opts.logPrefix,
          allowedTools: opts.allowedTools,
        });
        // Write a non-empty output file so runShip doesn't trip its
        // empty-file guard.
        fs.writeFileSync(opts.outputFilePath, "ok\n");
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          stallKilled: false,
          logPath: "",
          durationMs: 0,
          retries: 0,
        };
      },
    );

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-runship-"));
      await subAgents.runShip({
        cwd: tmp,
        slug: "test-slug",
        ship: {
          provider: "claude",
          model: "test-model",
          reasoning: "high",
          command: "/gstack-ship",
        },
        land: {
          provider: "claude",
          model: "test-model",
          reasoning: "high",
          command: "/land-and-deploy",
        },
      });
    } finally {
      spy.mockRestore();
    }

    // Two runClaudeTask invocations: ship first, land second.
    expect(calls.length).toBe(2);

    const shipCall = calls.find((c) => c.logPrefix === "ship");
    const landCall = calls.find((c) => c.logPrefix === "land-and-deploy");

    expect(shipCall).toBeDefined();
    expect(landCall).toBeDefined();

    // Ship gets the allowlist. Land does NOT.
    expect(shipCall!.allowedTools).toEqual(["Task", "Agent"]);
    expect(landCall!.allowedTools).toBeUndefined();
  });

  it("allowlists the Task subagent tool by literal name in runShip body (static-grep invariant)", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "..", "sub-agents.ts"),
      "utf8",
    );
    const runShipMatch = source.match(
      /export async function runShip\([\s\S]*?\n\}\n/,
    );
    expect(runShipMatch).not.toBeNull();
    expect(runShipMatch![0]).toContain('allowedTools: ["Task", "Agent"]');
  });
});
```

If `fs`, `os`, `path`, or `spyOn` are not yet imported at the top of the test file, add the imports. The other tests in this file already use Bun's `bun:test` `spyOn`; confirm with `grep -n spyOn build/orchestrator/__tests__/sub-agents.test.ts | head -3`.

- [ ] **Step 5.2: Run the new tests and confirm both fail**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "runShip allowlist propagation" 2>&1 | tail -20`

Expected: 2 fail.

- The first test fails because `runShip` does not yet pass `allowedTools` — the assertion `expect(shipCall!.allowedTools).toEqual(["Task", "Agent"])` will see `undefined`.
- The second test fails because the literal string `allowedTools: ["Task", "Agent"]` is not yet present anywhere in `sub-agents.ts`.

- [ ] **Step 5.3: Edit `runShip` to set `allowedTools` on the ship call only**

Open `build/orchestrator/sub-agents.ts` and locate the ship `runSlashCommand` call (currently at lines 1782-1793). Add `allowedTools` to the opts object:

```ts
const shipResult = await runSlashCommand({
  inputFilePath: shipInput,
  outputFilePath: shipOutput,
  cwd: opts.cwd,
  slug: opts.slug,
  logPrefix: "ship",
  role: opts.ship,
  // role.timeoutMs (set by configure.cm or env) takes precedence inside
  // runConfiguredRoleTask via resolveRoleTimeouts; caller default stays SHIP_TIMEOUT_MS.
  timeoutMs: opts.ship.timeoutMs ?? SHIP_TIMEOUT_MS,
  gate: false,
  // Grant the inner /ship session access to the Task/Agent subagent-dispatch
  // tool so /ship Step 18 can run /document-release in a fresh-context
  // subagent. Both names listed for Claude Code version-skew resilience;
  // the CLI silently ignores unknown allowlist entries. Land call below
  // intentionally does NOT get this — /land-and-deploy never dispatches
  // a subagent.
  allowedTools: ["Task", "Agent"],
});
```

The `/land-and-deploy` call (currently at lines 1830-1839) is left exactly as it is — no `allowedTools` field added.

- [ ] **Step 5.4: Run the new tests and confirm both pass**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts -t "runShip allowlist propagation" 2>&1 | tail -10`

Expected: 2 pass / 0 fail.

- [ ] **Step 5.5: Run the full sub-agents test file to confirm no regression**

Run: `bun test build/orchestrator/__tests__/sub-agents.test.ts 2>&1 | tail -10`

Expected: all previously-passing tests still pass; 6 new tests (4 from Task 1 + 2 from Task 5) added; 0 fail.

- [ ] **Step 5.6: Commit**

```bash
git add build/orchestrator/sub-agents.ts build/orchestrator/__tests__/sub-agents.test.ts
git commit -m "feat(build): runShip allowlists Task/Agent for inner /ship Step 18

The inner /ship subagent uses the Task tool to dispatch /document-release
as a fresh-context subagent (ship/SKILL.md.tmpl:823). The build's spawn
previously omitted the allowlist, so Step 18 silently soft-failed and
autonomous-build PRs shipped without docs reconciliation. This grants
the ship call (and only the ship call) access to Task/Agent. The
/land-and-deploy call stays unchanged — it never dispatches a subagent."
```

---

## Task 6: Full-suite verification and worktree smoke

**Files:** none modified.

- [ ] **Step 6.1: Run the entire orchestrator test suite**

Run: `bun test build/orchestrator/__tests__/ 2>&1 | tail -10`

Expected: all pre-existing pass count + 6 new tests; 0 new failures introduced.

(Note: a pre-existing failure in `coverage-matrix.test.ts` "package build-skill gate runs the full orchestrator suite plus generated docs" is known to fail on `main` as well — verified during the v1.44.1.0 ship. If this is the only failure, it's not caused by this branch.)

- [ ] **Step 6.2: Run `bun test` for the whole project as a final sanity sweep**

Run: `bun test 2>&1 | tail -10`

Expected: same pre-existing pass count + 6 new; only the pre-existing `coverage-matrix.test.ts` build-skill-gate failure (which is unrelated to this change).

- [ ] **Step 6.3: Verify the static-grep invariant holds**

Run:

```bash
grep -nE 'allowedTools: \["Task", "Agent"\]' build/orchestrator/sub-agents.ts
```

Expected: exactly one line of output, inside the `runShip` function body, on the ship `runSlashCommand` call. If there's more than one match, or the match is in the land call, fix and re-run Step 6.1.

- [ ] **Step 6.4: Manual smoke (post-merge, optional)**

After the PR lands, in a throwaway worktree with a tiny single-feature plan, run `gstack-build`. Observe whether the `/ship` subagent's output contains one of these lines from Step 18:

- `Documentation synced: N files updated, committed as <sha>`
- `Documentation is current — no updates needed.`

Either of those proves the subagent ran. The silent skip ("warning: Step 18 subagent failed, proceeding to Step 19 without `## Documentation` section") means the spawn or allowlist is still wrong — file a follow-up.

This is not a checked-in test; it's the empirical validation that the design actually closes the gap.

---

## Self-review

I checked the plan against the spec:

**Spec coverage:**

- "Goal: make /ship Step 18 fire when /ship is invoked autonomously by the build" → covered by Task 5.
- "Architecture: plumb `allowedTools?: readonly string[]` through `runSlashCommand` → `runConfiguredRoleTask` → `runClaudeTask` → `buildClaudeTaskArgv`" → covered by Tasks 1-4 (in reverse order, so each layer is testable as soon as it's added).
- "buildClaudeTaskArgv emits `--allowedTools <name…>` at end of argv when present" → covered by Task 1 Step 1.8.
- "Both `Task` and `Agent` listed for version-skew resilience" → covered by Task 5 Step 5.3.
- "Ship call only; land call unchanged" → covered by Task 5 Step 5.3 + tested in Step 5.1 (the test asserts `landCall.allowedTools === undefined`).
- "Soft-fail preservation" → not directly testable here (it lives in `/ship`'s template), but the plan does not introduce any hard-fail path. Tests in Task 5 exercise the success case; the soft-fail case is unchanged.
- "Backward compatibility: existing callers unmodified, argv byte-identical when undefined" → enforced by Task 1 Step 1.1 and verified by the full-suite run in Task 6 Step 6.1.
- All six unit tests from the spec are present: Task 1 has tests 1-4 (omitted / present-with-names / empty-array / position-after-prompt), and Task 5 has tests 5-6 (functional propagation + static-grep invariant).
- Manual verification step from the spec → covered by Task 6 Step 6.4.

**Placeholder scan:** no `TBD`, `TODO`, "implement later", "handle edge cases", or "similar to Task N" tokens in the plan. Every step shows exact code or exact commands.

**Type consistency:** the field is `allowedTools?: readonly string[]` everywhere it appears (Task 1 signature, Task 2 signature, Task 3 interface field, Task 4 signature). The literal value at the call site is `["Task", "Agent"]` consistently (Task 5 Step 5.3 and Task 5 Step 5.1's test assertion). The grep pattern in Task 6 Step 6.3 matches exactly.

**Issues fixed inline during review:**

- Task 2 originally had a separate "edit the body to forward" step; I collapsed it because TypeScript's structural typing makes the existing `buildClaudeTaskArgv(opts)` call pick up the new property automatically. No body edit needed.
- Task 4 had a similar redundant edit step; removed for the same reason.
- Task 5 Step 5.1's test originally tried to mock `runSlashCommand` itself, but per the spec's revised wording ("mock `runClaudeTask` — the boundary where the new field becomes argv"), the test now spies on `runClaudeTask` so the full forwarding chain is exercised in one assertion path.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-build-ship-document-release-allowlist.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
