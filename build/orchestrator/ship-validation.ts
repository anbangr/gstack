/**
 * Bug 6 (mitosis-control-plane cancel-api-followups-v1-20 2026-05-20
 * SHIP_ROLE_HALLUCINATED_SUCCESS): a configured ship role that doesn't
 * actually have a /gstack-ship skill (e.g. `kimi`) can receive the literal
 * prose instruction "Run /gstack-ship" and fabricate a success report —
 * "READY TO LAND, 196 tests passed" — without ever running `git push` or
 * `gh pr create`. The orchestrator previously trusted `exitCode === 0`,
 * marked `completed: true`, and left `shippedAt: null` (a contradictory
 * state that surfaced as the fault report's headline).
 *
 * This module validates that the ship ACTUALLY happened by reading the
 * filesystem + remote, not the agent's prose:
 *
 *   1. `git ls-remote origin <branch>` must return a SHA. If the agent
 *      didn't push, the remote ref doesn't exist.
 *   2. The ship-output prose must mention a PR URL of the standard
 *      shape `https://github.com/<owner>/<repo>/pull/<N>`. The agent
 *      may also paste the PR number directly ("PR #1234"); both are
 *      accepted.
 *   3. If a PR number is parsed, `gh pr view <N>` must confirm the PR
 *      exists and its head ref matches the expected branch.
 *
 * Pure-function-ish: takes an optional `runCommand` injection point so
 * the validator can be unit-tested without touching the real git/gh.
 * The default uses node:child_process.spawnSync.
 */

import { spawnSync } from "./child-registry";

export type ShipValidationFailure =
  | "branch_not_pushed"
  | "no_pr_reference_in_output"
  | "pr_not_found_on_github"
  | "pr_branch_mismatch"
  | "pr_repo_mismatch"
  | "pr_not_open"
  | "pr_headref_missing"
  | "invalid_branch"
  | "git_unavailable"
  | "validator_timeout"
  | "ship_hallucinated_success";

export type ShipValidationResult =
  | {
      ok: true;
      /**
       * SHA on origin for the validated branch. Undefined in post-merge mode
       * where the branch may have been deleted by squash-merge.
       */
      sha?: string;
      prNumber?: number;
      prUrl?: string;
    }
  | {
      ok: false;
      reason: ShipValidationFailure;
      evidence: string[];
    };

export interface RunCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommandFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => RunCommandResult;

const defaultRunCommand: RunCommandFn = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const PR_URL_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const PR_NUMBER_RE = /\bPR\s*#(\d+)\b/i;

/**
 * Parse an `owner/repo` pair out of a `git remote get-url origin` value.
 * Handles the three URL shapes git emits:
 *   - https://github.com/<owner>/<repo>(.git)?
 *   - git@github.com:<owner>/<repo>(.git)?
 *   - ssh://git@github.com/<owner>/<repo>(.git)?
 *
 * Strips the trailing `.git` so the parsed value matches what GitHub's
 * REST/CLI return (`url` field from `gh repo view --json url` is the
 * .git-less form).
 *
 * Exported for tests.
 */
export function parseGithubOwnerRepo(
  originUrl: string,
): { owner: string; repo: string } | null {
  if (!originUrl) return null;
  const trimmed = originUrl.trim();
  // https://github.com/<owner>/<repo>(.git)?  OR  http://...
  let m = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // git@github.com:<owner>/<repo>(.git)?
  m = trimmed.match(/^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // ssh://git@github.com/<owner>/<repo>(.git)?
  m = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/**
 * Extract a PR number from ship-output prose. Accepts the canonical
 * GitHub PR URL or a "PR #N" reference. Returns null if no number found.
 *
 * When a URL is parsed, also returns the owner/repo from the URL so the
 * caller can verify the URL points at the expected repository (defends
 * against a sub-agent quoting a real PR URL from an unrelated repo).
 */
export function parsePrReference(outputText: string): {
  prNumber: number | null;
  prUrl: string | null;
  prOwner: string | null;
  prRepo: string | null;
} {
  // PR numbers must be positive integers. Reject 0, negatives, leading-zero
  // junk that parses to 0, and non-finite inputs. `gh pr view 0` returns
  // non-zero with a generic "no PR found" message that would surface to
  // callers as `pr_not_found_on_github` — misleading for what is really a
  // parser-input problem (T6 /review LOW finding).
  const validPr = (n: number): boolean => Number.isFinite(n) && n > 0;
  const urlMatch = outputText.match(PR_URL_RE);
  if (urlMatch) {
    const owner = urlMatch[1];
    const repo = urlMatch[2];
    const n = Number(urlMatch[3]);
    return {
      prNumber: validPr(n) ? n : null,
      prUrl: validPr(n) ? urlMatch[0] : null,
      prOwner: validPr(n) ? owner : null,
      prRepo: validPr(n) ? repo : null,
    };
  }
  const numMatch = outputText.match(PR_NUMBER_RE);
  if (numMatch) {
    const n = Number(numMatch[1]);
    return {
      prNumber: validPr(n) ? n : null,
      prUrl: null,
      prOwner: null,
      prRepo: null,
    };
  }
  return { prNumber: null, prUrl: null, prOwner: null, prRepo: null };
}

/**
 * Validate that a ship really happened.
 *
 * Returns ok:true on success; ok:false with a discriminating reason +
 * forensic evidence lines on failure. The caller is responsible for
 * mapping the reason onto the feature/state machine (typically
 * `featureState.status = "paused"` with the reason embedded in error).
 *
 * Tests inject `runCommand` to simulate git/gh outputs without touching
 * the real filesystem or network.
 */
/**
 * Cap output prose at 1 MB before regex parsing to defend against an OOM
 * vector from a malicious / runaway sub-agent dumping megabytes of text.
 * Slice from the END since PR URLs are typically near the bottom of the
 * ship report.
 */
const OUTPUT_TEXT_CAP_BYTES = 1024 * 1024;

/**
 * A branch name must look like a real git ref. Defensive guard against the
 * detached-HEAD + missing-state-fields path where the caller might pass an
 * empty string — git ls-remote `refs/heads/` (trailing slash) returns ALL
 * heads, and the first-line SHA regex would happily accept some random
 * branch's SHA, marking the ship as valid against a branch we never
 * shipped.
 */
function isValidBranchName(b: string): boolean {
  return /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(b) && !b.includes("..");
}

export function validateShipCompletion(args: {
  cwd: string;
  branch: string;
  outputText: string;
  runCommand?: RunCommandFn;
  /**
   * When true, skip the `gh pr view` call even when a PR number was
   * parsed. Useful in test setups that don't have gh available.
   */
  skipGhVerify?: boolean;
  /**
   * Validation context (T6 /review MEDIUM follow-up). Default "pre-merge"
   * preserves the original behavior used by `shipOnly` (queued mode):
   * branch must still be pushed on origin, PR must be OPEN.
   *
   * "post-merge" relaxes both for `shipAndDeploy` (auto-land mode) where
   * by the time the validator runs the branch may already be deleted from
   * origin (squash-merge + delete-branch flow) and the PR is in MERGED
   * state. The validator still fails on no_pr_reference_in_output,
   * pr_not_found_on_github, pr_headref_missing, pr_branch_mismatch, and
   * pr_repo_mismatch — those catch the real hallucination shapes.
   */
  mode?: "pre-merge" | "post-merge";
}): ShipValidationResult {
  const run = args.runCommand ?? defaultRunCommand;
  const mode = args.mode ?? "pre-merge";
  const evidence: string[] = [];

  // (0) Branch sanity check — empty / shell-metacharacter branches are a
  // categorical input failure, not a ship hallucination.
  if (!isValidBranchName(args.branch)) {
    return {
      ok: false,
      reason: "invalid_branch",
      evidence: [
        `branch name "${args.branch}" did not match the git-ref shape`,
        "caller likely passed an empty / detached-HEAD branch; refusing to ls-remote",
      ],
    };
  }

  // (1) Branch must exist on origin with a SHA.
  // post-merge mode: skip this check entirely — the branch may already be
  // deleted by squash-merge + delete-branch. PR existence + state remain
  // the primary defenses against hallucination in that flow.
  let sha: string | undefined;
  if (mode === "pre-merge") {
    const lsRemote = run(
      "git",
      ["ls-remote", "origin", `refs/heads/${args.branch}`],
      { cwd: args.cwd, timeoutMs: 15_000 },
    );
    // Distinguish "process never ran / killed by timeout / ENOENT"
    // (status === null) from "ran and returned non-zero" (status !== 0).
    // The former is operational — git missing, remote unreachable, auth
    // timed-out — and must NOT surface as ship_hallucinated_success because
    // the user's fix is `gh auth login` or `git remote add origin`, not
    // "the agent fabricated a ship report."
    if (lsRemote.status === null) {
      return {
        ok: false,
        reason: "validator_timeout",
        evidence: [
          `git ls-remote was killed before exit (timeout, signal, or ENOENT)`,
          ...(lsRemote.stderr ? [lsRemote.stderr.split("\n")[0]] : []),
        ],
      };
    }
    if (lsRemote.status !== 0) {
      return {
        ok: false,
        reason: "git_unavailable",
        evidence: [
          `git ls-remote exit=${lsRemote.status}`,
          ...(lsRemote.stderr ? [lsRemote.stderr.split("\n")[0]] : []),
        ],
      };
    }
    const lsLine = (lsRemote.stdout || "").trim().split("\n")[0] || "";
    const shaMatch = lsLine.match(/^([0-9a-f]{40})\s/i);
    if (!shaMatch) {
      return {
        ok: false,
        reason: "branch_not_pushed",
        evidence: [
          `git ls-remote origin refs/heads/${args.branch} returned no SHA`,
          `stdout: ${lsRemote.stdout.slice(0, 200)}`,
        ],
      };
    }
    sha = shaMatch[1].toLowerCase();
    evidence.push(
      `branch ${args.branch} present on origin at ${sha.slice(0, 8)}`,
    );
  } else {
    evidence.push(
      `branch-pushed check skipped (post-merge mode: branch may already be deleted)`,
    );
  }

  // (2) Output must reference a PR. Cap input size first.
  const capped =
    args.outputText.length > OUTPUT_TEXT_CAP_BYTES
      ? args.outputText.slice(-OUTPUT_TEXT_CAP_BYTES)
      : args.outputText;
  let { prNumber, prUrl, prOwner, prRepo } = parsePrReference(capped);
  if (prNumber == null) {
    // pre-merge: missing PR reference IS a hallucination signal — the
    // sub-agent was supposed to push a branch + open a PR and report it.
    if (mode === "pre-merge") {
      return {
        ok: false,
        reason: "no_pr_reference_in_output",
        evidence: [
          ...evidence,
          "ship-output prose mentions no PR URL nor PR #<N> reference",
          `output sample: ${capped.slice(0, 300).replace(/\n/g, " · ")}`,
        ],
      };
    }
    // post-merge: legitimate land-role outputs sometimes just report
    // "merged" without quoting a URL. Fall back to `gh pr list --head
    // <branch> --state all` to discover the PR directly. If one exists,
    // continue the validation against it. If none exists, THAT is
    // hallucination.
    if (args.skipGhVerify) {
      return { ok: true, sha, prUrl: prUrl ?? undefined };
    }
    const prList = run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        args.branch,
        "--state",
        "all",
        "--json",
        "number,state,headRefName,url",
        "--limit",
        "5",
      ],
      { cwd: args.cwd, timeoutMs: 15_000 },
    );
    if (prList.status === null) {
      return {
        ok: false,
        reason: "validator_timeout",
        evidence: [
          ...evidence,
          `gh pr list --head ${args.branch} was killed before exit`,
          ...(prList.stderr ? [prList.stderr.split("\n")[0]] : []),
        ],
      };
    }
    if (prList.status !== 0) {
      return {
        ok: false,
        reason: "pr_not_found_on_github",
        evidence: [
          ...evidence,
          `gh pr list --head ${args.branch} exit=${prList.status}`,
          ...(prList.stderr ? [prList.stderr.split("\n")[0]] : []),
        ],
      };
    }
    let prs: Array<{
      number: number;
      state: string;
      headRefName?: string;
      url?: string;
    }> = [];
    try {
      prs = JSON.parse(prList.stdout || "[]");
    } catch {
      return {
        ok: false,
        reason: "pr_not_found_on_github",
        evidence: [
          ...evidence,
          `gh pr list returned unparseable JSON`,
          `stdout: ${prList.stdout.slice(0, 200)}`,
        ],
      };
    }
    if (!Array.isArray(prs) || prs.length === 0) {
      return {
        ok: false,
        reason: "no_pr_reference_in_output",
        evidence: [
          ...evidence,
          `ship-output mentions no PR AND gh pr list --head ${args.branch} returned no PRs`,
          `output sample: ${capped.slice(0, 300).replace(/\n/g, " · ")}`,
        ],
      };
    }
    // Prefer the most recently-merged PR; otherwise the first one.
    const merged = prs.find((p) => p.state === "MERGED");
    const pick = merged ?? prs[0];
    prNumber = pick.number;
    prUrl = pick.url ?? null;
    evidence.push(
      `gh pr list discovered PR #${pick.number} (${pick.state}) for branch ${args.branch}`,
    );
    // Skip the redundant `gh pr view` round-trip — gh pr list already
    // returned the same json shape we'd ask for. Synthesize a verdict
    // from the list entry and short-circuit.
    if (!pick.headRefName) {
      return {
        ok: false,
        reason: "pr_headref_missing",
        evidence: [
          ...evidence,
          `gh pr list entry for PR #${pick.number} has no headRefName field`,
        ],
      };
    }
    if (pick.headRefName !== args.branch) {
      return {
        ok: false,
        reason: "pr_branch_mismatch",
        evidence: [
          ...evidence,
          `PR #${pick.number} has headRefName "${pick.headRefName}", expected "${args.branch}"`,
        ],
      };
    }
    const allowedFromList = new Set(["OPEN", "MERGED"]);
    if (!allowedFromList.has(pick.state)) {
      return {
        ok: false,
        reason: "pr_not_open",
        evidence: [
          ...evidence,
          `PR #${pick.number} state is "${pick.state}", expected OPEN/MERGED (post-merge)`,
        ],
      };
    }
    return {
      ok: true,
      sha,
      prNumber,
      prUrl: prUrl ?? undefined,
    };
  }
  evidence.push(`output references PR #${prNumber}`);

  // (2.5) PR URL repo-match (T6 /review MEDIUM finding, deferred from
  // PR #96; addressed here). When the prose quoted a full URL we can
  // resolve the current repo's expected owner/repo from `git remote get-url
  // origin` and reject mismatches before paying for a gh round-trip.
  // Defends against a sub-agent quoting a real PR URL from a sibling repo
  // (where the headRefName check would only fire if branch names happened
  // to collide).
  //
  // Bare "PR #N" references skip this check (we don't know what repo they
  // meant) and fall through to (3) where gh pr view + headRefName provide
  // the remaining defense. Origin lookup is also skipped — saves a
  // subprocess + keeps existing tests' mock sequences shorter.
  if (prOwner && prRepo) {
    const originUrl = run("git", ["remote", "get-url", "origin"], {
      cwd: args.cwd,
      timeoutMs: 5_000,
    });
    // Soft failure: if we cannot determine the origin repo (detached
    // checkout, no remote configured) we skip the repo-match check rather
    // than fail closed — pr_branch_mismatch / pr_headref_missing remain
    // the primary defenses.
    const expectedRepo =
      originUrl.status === 0
        ? parseGithubOwnerRepo(originUrl.stdout.trim())
        : null;
    if (expectedRepo) {
      const ownerMatch =
        prOwner.toLowerCase() === expectedRepo.owner.toLowerCase();
      const repoMatch =
        prRepo.toLowerCase() === expectedRepo.repo.toLowerCase();
      if (!ownerMatch || !repoMatch) {
        return {
          ok: false,
          reason: "pr_repo_mismatch",
          evidence: [
            ...evidence,
            `quoted PR URL points at ${prOwner}/${prRepo}, but this repo's origin is ${expectedRepo.owner}/${expectedRepo.repo}`,
          ],
        };
      }
    }
  }

  // (3) gh pr view must confirm the PR.
  if (args.skipGhVerify) {
    return { ok: true, sha, prNumber, prUrl: prUrl ?? undefined };
  }
  const ghView = run(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "url,headRefName,state",
    ],
    { cwd: args.cwd, timeoutMs: 30_000 },
  );
  if (ghView.status === null) {
    return {
      ok: false,
      reason: "validator_timeout",
      evidence: [
        ...evidence,
        `gh pr view ${prNumber} was killed before exit (timeout, signal, or ENOENT)`,
        ...(ghView.stderr ? [ghView.stderr.split("\n")[0]] : []),
      ],
    };
  }
  if (ghView.status !== 0) {
    return {
      ok: false,
      reason: "pr_not_found_on_github",
      evidence: [
        ...evidence,
        `gh pr view ${prNumber} exit=${ghView.status}`,
        ...(ghView.stderr ? [ghView.stderr.split("\n")[0]] : []),
      ],
    };
  }
  let parsed: { url?: string; headRefName?: string; state?: string };
  try {
    parsed = JSON.parse(ghView.stdout || "{}");
  } catch {
    return {
      ok: false,
      reason: "pr_not_found_on_github",
      evidence: [
        ...evidence,
        `gh pr view ${prNumber} returned unparseable JSON`,
        `stdout: ${ghView.stdout.slice(0, 200)}`,
      ],
    };
  }
  // Critical (T6 /review CRITICAL): require headRefName to be present AND
  // match. A buggy / hostile `gh` returning `{}` would otherwise silently
  // pass validation. Empty/missing headRefName means we cannot confirm the
  // PR is for THIS branch — treat as a positive failure, not a free pass.
  if (!parsed.headRefName) {
    return {
      ok: false,
      reason: "pr_headref_missing",
      evidence: [
        ...evidence,
        `gh pr view ${prNumber} returned no headRefName field; cannot verify branch ownership`,
        `parsed: ${JSON.stringify(parsed).slice(0, 200)}`,
      ],
    };
  }
  if (parsed.headRefName !== args.branch) {
    return {
      ok: false,
      reason: "pr_branch_mismatch",
      evidence: [
        ...evidence,
        `PR #${prNumber} has headRefName "${parsed.headRefName}", expected "${args.branch}"`,
      ],
    };
  }
  // T6 /review HIGH: require a recent PR state. A sub-agent could quote a
  // long-closed PR URL on the same branch (e.g. main) and the headRefName
  // check would pass against it.
  //
  // pre-merge mode (default for shipOnly / queued): require "OPEN" — the
  //   ship just ran, the PR should still be open awaiting merge.
  // post-merge mode (shipAndDeploy / auto-land): accept "OPEN" or "MERGED"
  //   since the land role may have squash-merged the PR by the time the
  //   validator runs. Reject DRAFT / CLOSED — neither is a valid success
  //   shape for an auto-land ship that "just ran."
  const allowedStates =
    mode === "post-merge"
      ? new Set(["OPEN", "MERGED"])
      : new Set(["OPEN"]);
  if (parsed.state && !allowedStates.has(parsed.state)) {
    return {
      ok: false,
      reason: "pr_not_open",
      evidence: [
        ...evidence,
        `PR #${prNumber} state is "${parsed.state}", expected one of ${[...allowedStates].join("/")} (mode=${mode})`,
      ],
    };
  }
  return {
    ok: true,
    sha,
    prNumber,
    prUrl: parsed.url ?? prUrl ?? undefined,
  };
}
