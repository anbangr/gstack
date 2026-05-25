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

import { spawnSync } from "node:child_process";

export type ShipValidationFailure =
  | "branch_not_pushed"
  | "no_pr_reference_in_output"
  | "pr_not_found_on_github"
  | "pr_branch_mismatch"
  | "git_unavailable"
  | "ship_hallucinated_success";

export type ShipValidationResult =
  | {
      ok: true;
      sha: string;
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

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i;
const PR_NUMBER_RE = /\bPR\s*#(\d+)\b/i;

/**
 * Extract a PR number from ship-output prose. Accepts the canonical
 * GitHub PR URL or a "PR #N" reference. Returns null if no number found.
 */
export function parsePrReference(outputText: string): {
  prNumber: number | null;
  prUrl: string | null;
} {
  const urlMatch = outputText.match(PR_URL_RE);
  if (urlMatch) {
    const n = Number(urlMatch[1]);
    return {
      prNumber: Number.isFinite(n) ? n : null,
      prUrl: urlMatch[0],
    };
  }
  const numMatch = outputText.match(PR_NUMBER_RE);
  if (numMatch) {
    const n = Number(numMatch[1]);
    return { prNumber: Number.isFinite(n) ? n : null, prUrl: null };
  }
  return { prNumber: null, prUrl: null };
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
}): ShipValidationResult {
  const run = args.runCommand ?? defaultRunCommand;
  const evidence: string[] = [];

  // (1) Branch must exist on origin with a SHA.
  const lsRemote = run(
    "git",
    ["ls-remote", "origin", `refs/heads/${args.branch}`],
    { cwd: args.cwd, timeoutMs: 15_000 },
  );
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
  const sha = shaMatch[1].toLowerCase();
  evidence.push(`branch ${args.branch} present on origin at ${sha.slice(0, 8)}`);

  // (2) Output must reference a PR.
  const { prNumber, prUrl } = parsePrReference(args.outputText);
  if (prNumber == null) {
    return {
      ok: false,
      reason: "no_pr_reference_in_output",
      evidence: [
        ...evidence,
        "ship-output prose mentions no PR URL nor PR #<N> reference",
        `output sample: ${args.outputText.slice(0, 300).replace(/\n/g, " · ")}`,
      ],
    };
  }
  evidence.push(`output references PR #${prNumber}`);

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
  if (parsed.headRefName && parsed.headRefName !== args.branch) {
    return {
      ok: false,
      reason: "pr_branch_mismatch",
      evidence: [
        ...evidence,
        `PR #${prNumber} has headRefName "${parsed.headRefName}", expected "${args.branch}"`,
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
