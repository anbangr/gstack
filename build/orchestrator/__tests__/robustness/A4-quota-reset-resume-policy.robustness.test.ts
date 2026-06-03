/**
 * A4 — quota-reset-resume-policy.robustness.test.ts  [PIN]+[RED]  (smoke)
 *
 * Group A (provider failures). See docs/designs/BUILD_ROBUSTNESS_SUITE.md
 * §"A4. quota-reset-resume-policy" and the ranked failure-mode row
 * `quota-resetAt-parsed-never-scheduled`.
 *
 * The long-run failure this guards: an overnight build hits a multi-hour
 * cap, parses the reset time, then dead-halts until morning because the
 * reset time never reaches the supervisor in a machine-readable way.
 *
 *   [PIN] classifyProviderFailure already classifies a quota banner as
 *         kind:"quota" AND captures verdict.resetAt from "resets at 11pm".
 *         This is current correct behavior (halt-event-helpers.ts:519-526)
 *         and must never regress — a regression that drops resetAt from the
 *         verdict reopens the silent-overnight-stall class.
 *
 *   [RED] resetAt should reach the emitted HaltEvent as a STRUCTURED field
 *         (event.resetAt or event.snapshot.resetAt), not buried inside the
 *         human-readable `message` prose. Today recordProviderQuotaExhausted
 *         only string-interpolates it into `message` ("· resets at 11pm",
 *         halt-events.ts:192-195) and the HaltEvent interface has no resetAt
 *         field, so a supervisor can't read it without re-parsing prose.
 *         UNSKIP WHEN A4 IS FIXED (a structured resetAt is plumbed onto the
 *         HaltEvent and the sleep-until-reset/halt policy reads it).
 *
 * No real LLM, no network, no long-lived process. classifyProviderFailure is
 * pure; the RED block writes/reads an isolated queue dir under a temp GSTACK_HOME.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import {
  classifyProviderFailure,
  recordProviderFailureVerdict,
} from "../../halt-event-helpers";
import { loadPendingInvestigations } from "../../halt-events";
import { mkTmp } from "./helpers";

// A canned quota log shaped like a real provider weekly-cap banner with a
// near-future reset time, exactly the overnight-stall scenario A4 guards.
const QUOTA_LOG =
  "You've hit your weekly limit for this model. Try again — resets at 11pm.";

describe("[PIN] A4 quota-reset-resume-policy — verdict captures resetAt", () => {
  test("quota banner classifies as kind:quota", () => {
    const v = classifyProviderFailure({ text: QUOTA_LOG });
    expect(v).not.toBeNull();
    expect(v?.kind).toBe("quota");
  });

  test("verdict.resetAt is captured from 'resets at 11pm'", () => {
    const v = classifyProviderFailure({ text: QUOTA_LOG });
    expect(v?.resetAt).toBeDefined();
    expect(v?.resetAt).toMatch(/11pm/i);
  });

  test("evidence carries the quota banner snippet", () => {
    const v = classifyProviderFailure({ text: QUOTA_LOG });
    expect(v?.evidence).toMatch(/hit your (?:weekly )?limit/i);
  });

  test("quota wins over a co-occurring capacity banner (precedence)", () => {
    // A long run can see both banners in the same blob; quota must win so the
    // run halts-to-morning rather than churning capacity-backoff retries.
    const v = classifyProviderFailure({
      text: "You've hit your limit · resets at 11pm. (underlying: MODEL_CAPACITY_EXHAUSTED)",
    });
    expect(v?.kind).toBe("quota");
    expect(v?.resetAt).toMatch(/11pm/i);
  });
});

describe("[RED→FIXED] A4 quota-reset-resume-policy — resetAt reaches HaltEvent as a structured field", () => {
  let tmp: string;
  const savedHome = process.env.GSTACK_HOME;
  const savedStateDir = process.env.GSTACK_BUILD_STATE_DIR;

  beforeEach(() => {
    tmp = mkTmp("gstack-robustness-A4-");
    // Isolate from the developer's real ~/.gstack: even though the queue dir is
    // passed explicitly below, pin GSTACK_HOME to tmp so any default-dir resolver
    // in the emit path lands under tmp, never the real home.
    process.env.GSTACK_HOME = tmp;
    process.env.GSTACK_BUILD_STATE_DIR = tmp;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = savedHome;
    if (savedStateDir === undefined) delete process.env.GSTACK_BUILD_STATE_DIR;
    else process.env.GSTACK_BUILD_STATE_DIR = savedStateDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function fixture() {
    const stdoutLog = `${tmp}/stdout.log`;
    fs.writeFileSync(stdoutLog, "");
    return {
      state: {
        slug: "a4-quota",
        phases: [{ index: 0, number: 1, status: "running" } as any],
      } as any,
      ctx: {
        runId: "a4-quota-run",
        stateSlug: "a4-quota",
        pointers: {
          stateFile: `${tmp}/state.json`,
          stdoutLog,
          livingPlan: `${tmp}/plan.md`,
          worktreePath: tmp,
        },
        queueDir: `${tmp}/queue`,
      },
    };
  }

  test("emitted PROVIDER_QUOTA_EXHAUSTED carries a machine-readable resetAt, not just prose", () => {
    const { state, ctx } = fixture();
    const verdict = classifyProviderFailure({ text: QUOTA_LOG });
    expect(verdict?.kind).toBe("quota");

    recordProviderFailureVerdict(state, 0, "codex-review", verdict!, ctx);

    const pending = loadPendingInvestigations({ queueDir: ctx.queueDir });
    expect(pending.length).toBe(1);
    const event = pending[0];
    expect(event.kind).toBe("PROVIDER_QUOTA_EXHAUSTED");

    // DESIRED INVARIANT (does not hold today): resetAt is surfaced as a
    // structured field on the HaltEvent so a supervisor / sleep-until-reset
    // policy can read it without re-parsing the human-readable `message`.
    // Today it lives ONLY inside `message` ("· resets at 11pm").
    const structuredResetAt =
      (event as unknown as { resetAt?: string }).resetAt ??
      (event.snapshot as unknown as { resetAt?: string } | undefined)?.resetAt;
    expect(structuredResetAt).toBeDefined();
    expect(structuredResetAt).toMatch(/11pm/i);
  });
});
