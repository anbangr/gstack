/**
 * Tests for validateShipCompletion — Bug 6 (mitosis-control-plane
 * cancel-api-followups-v1-20 2026-05-20 SHIP_ROLE_HALLUCINATED_SUCCESS).
 */
import { describe, it, expect } from "bun:test";
import {
  parseGithubOwnerRepo,
  parsePrReference,
  validateShipCompletion,
  type RunCommandFn,
} from "../ship-validation";

describe("parsePrReference", () => {
  it("extracts PR number + owner + repo from canonical GitHub URL", () => {
    expect(
      parsePrReference("Created https://github.com/foo/bar/pull/42 for review."),
    ).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/foo/bar/pull/42",
      prOwner: "foo",
      prRepo: "bar",
    });
  });

  it("extracts PR number from 'PR #N' reference (no owner/repo)", () => {
    expect(parsePrReference("Opened PR #1234. Ready to land.")).toEqual({
      prNumber: 1234,
      prUrl: null,
      prOwner: null,
      prRepo: null,
    });
  });

  it("prefers URL over bare number when both are present", () => {
    const out = parsePrReference(
      "PR #99 — see https://github.com/foo/bar/pull/100 for diff.",
    );
    expect(out.prNumber).toBe(100);
    expect(out.prUrl).toBe("https://github.com/foo/bar/pull/100");
    expect(out.prOwner).toBe("foo");
    expect(out.prRepo).toBe("bar");
  });

  it("returns nulls when no PR reference is present", () => {
    expect(parsePrReference("All tests passed. READY TO LAND.")).toEqual({
      prNumber: null,
      prUrl: null,
      prOwner: null,
      prRepo: null,
    });
  });

  it("ignores PR-like text inside other domains", () => {
    expect(
      parsePrReference("see https://example.com/foo/bar/pull/9 not GH"),
    ).toEqual({ prNumber: null, prUrl: null, prOwner: null, prRepo: null });
  });

  // T6 /review LOW finding (deferred from PR #96; addressed here):
  // PR #0 is not a valid GitHub PR. parsePrReference must reject it at
  // the parser layer rather than letting `gh pr view 0` surface as
  // pr_not_found_on_github (a misleading reason for what is actually a
  // parser-input problem).
  it("rejects PR #0 (not a valid GitHub PR number)", () => {
    expect(parsePrReference("Opened PR #0 for review")).toEqual({
      prNumber: null,
      prUrl: null,
      prOwner: null,
      prRepo: null,
    });
    expect(parsePrReference("see https://github.com/foo/bar/pull/0")).toEqual(
      { prNumber: null, prUrl: null, prOwner: null, prRepo: null },
    );
  });

  it("rejects leading-zero numbers that parse to 0", () => {
    // Number("0000") === 0 → reject
    expect(parsePrReference("see PR #0000 here")).toEqual({
      prNumber: null,
      prUrl: null,
      prOwner: null,
      prRepo: null,
    });
  });
});

function mockRun(
  responses: Array<{
    cmd: string;
    argMatch?: (args: string[]) => boolean;
    status: number;
    stdout?: string;
    stderr?: string;
  }>,
): RunCommandFn {
  let idx = 0;
  return (cmd, args) => {
    const r = responses[idx++];
    if (!r) {
      throw new Error(
        `mock-runCommand: unexpected call ${cmd} ${args.join(" ")} (idx=${idx})`,
      );
    }
    if (r.cmd !== cmd) {
      throw new Error(
        `mock-runCommand: expected ${r.cmd}, got ${cmd} ${args.join(" ")}`,
      );
    }
    if (r.argMatch && !r.argMatch(args)) {
      throw new Error(
        `mock-runCommand: argMatch failed for ${cmd} ${args.join(" ")}`,
      );
    }
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };
}

describe("validateShipCompletion", () => {
  const branch = "feat/cancel-api-followups";
  const cwd = "/tmp/whatever";

  it("returns branch_not_pushed when ls-remote returns no SHA (hallucinated ship)", () => {
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: "" }, // ls-remote returns empty
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Ship complete. READY TO LAND. 196 tests passed.",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("branch_not_pushed");
    }
  });

  it("returns no_pr_reference_in_output when branch IS pushed but output mentions no PR", () => {
    const runCommand = mockRun([
      {
        cmd: "git",
        status: 0,
        stdout: `${"a".repeat(40)}\trefs/heads/${branch}\n`,
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Pushed branch. Tests passed.",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("no_pr_reference_in_output");
    }
  });

  it("returns ok with sha + prNumber when ls-remote + PR URL + gh view all align", () => {
    const sha = "a".repeat(40);
    const runCommand = mockRun([
      {
        cmd: "git",
        status: 0,
        stdout: `${sha}\trefs/heads/${branch}\n`,
      },
      // git remote get-url origin (T6 /review repo-match check)
      {
        cmd: "git",
        status: 0,
        stdout: "https://github.com/foo/bar.git\n",
      },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/42",
          headRefName: branch,
          state: "OPEN",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sha).toBe(sha);
      expect(out.prNumber).toBe(42);
      expect(out.prUrl).toBe("https://github.com/foo/bar/pull/42");
    }
  });

  it("returns pr_branch_mismatch when gh view reports a different headRefName", () => {
    const sha = "b".repeat(40);
    const runCommand = mockRun([
      {
        cmd: "git",
        status: 0,
        stdout: `${sha}\trefs/heads/${branch}\n`,
      },
      {
        cmd: "git",
        status: 0,
        stdout: "https://github.com/foo/bar.git\n",
      },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/42",
          headRefName: "feat/totally-different",
          state: "OPEN",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("pr_branch_mismatch");
    }
  });

  it("returns pr_not_found_on_github when gh view fails (e.g. PR# fabricated)", () => {
    const sha = "c".repeat(40);
    const runCommand = mockRun([
      {
        cmd: "git",
        status: 0,
        stdout: `${sha}\trefs/heads/${branch}\n`,
      },
      {
        cmd: "gh",
        status: 1,
        stderr: "no PR found for number 99999",
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened PR #99999. Tests passed.",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("pr_not_found_on_github");
    }
  });

  it("skipGhVerify short-circuits PR existence check (test-friendly)", () => {
    const sha = "d".repeat(40);
    const runCommand = mockRun([
      {
        cmd: "git",
        status: 0,
        stdout: `${sha}\trefs/heads/${branch}\n`,
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened PR #42",
      runCommand,
      skipGhVerify: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sha).toBe(sha);
      expect(out.prNumber).toBe(42);
    }
  });

  it("returns git_unavailable when ls-remote itself errors (network/auth)", () => {
    const runCommand = mockRun([
      {
        cmd: "git",
        status: 128,
        stderr: "fatal: unable to access 'origin'",
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "any output",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("git_unavailable");
    }
  });

  // T6 /review findings — hardening tests added after adversarial review.
  it("CRITICAL /review: returns pr_headref_missing when gh JSON omits headRefName (no silent pass)", () => {
    const sha = "e".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      { cmd: "git", status: 0, stdout: "https://github.com/foo/bar.git\n" },
      {
        cmd: "gh",
        status: 0,
        // Hostile/buggy gh: JSON missing headRefName. Pre-fix this passed
        // validation silently because the check was `if (parsed.headRefName && ...)`.
        stdout: JSON.stringify({ url: "https://github.com/foo/bar/pull/42" }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("pr_headref_missing");
    }
  });

  it("HIGH /review: returns pr_not_open when gh reports a non-OPEN PR (closed/merged/draft)", () => {
    const sha = "f".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      { cmd: "git", status: 0, stdout: "https://github.com/foo/bar.git\n" },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/42",
          headRefName: branch,
          state: "MERGED",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened PR https://github.com/foo/bar/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("pr_not_open");
    }
  });

  it("MEDIUM /review: rejects empty branch name without calling git ls-remote (detached-HEAD guard)", () => {
    let gitCalls = 0;
    const runCommand: RunCommandFn = (cmd) => {
      if (cmd === "git") gitCalls++;
      return { status: 0, stdout: "", stderr: "" };
    };
    const out = validateShipCompletion({
      cwd,
      branch: "",
      outputText: "ship-out text",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("invalid_branch");
    }
    expect(gitCalls).toBe(0); // never touched git
  });

  it("MEDIUM /review: rejects branch with shell metacharacters", () => {
    const out = validateShipCompletion({
      cwd,
      branch: "feat/foo;rm -rf /",
      outputText: "any",
      runCommand: () => {
        throw new Error("should not be called");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("invalid_branch");
    }
  });

  it("HIGH /review: returns validator_timeout (not ship_hallucinated_success) when ls-remote is killed by timeout", () => {
    const runCommand = mockRun([
      {
        cmd: "git",
        status: null as unknown as number, // spawnSync timeout returns status: null
        stderr: "killed by signal SIGTERM",
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "any",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("validator_timeout");
    }
  });

  it("HIGH /review: returns validator_timeout when gh is killed by timeout (not fabrication)", () => {
    const sha = "1".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      {
        cmd: "gh",
        status: null as unknown as number,
        stderr: "killed by signal SIGTERM",
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened PR #42",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("validator_timeout");
    }
  });

  it("LOW /review: caps very large outputText to defend against OOM/regex DoS", () => {
    // 2 MB of junk + a real PR URL at the very end. Validator should still
    // find the URL because it slices from the END.
    const huge = "x".repeat(2 * 1024 * 1024);
    const sha = "2".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      { cmd: "git", status: 0, stdout: "https://github.com/foo/bar.git\n" },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/77",
          headRefName: branch,
          state: "OPEN",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: `${huge}\nOpened https://github.com/foo/bar/pull/77`,
      runCommand,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prNumber).toBe(77);
    }
  });

  // T6 /review MEDIUM finding (deferred from PR #96; addressed here).
  // PR_URL_RE accepts any github.com/<owner>/<repo>/pull/N. A sub-agent
  // could quote a real PR URL from a sibling repo (or a fork) and the
  // headRefName check would only fire if branch names happened to collide.
  // Repo-match closes that gap by binding the validator to `git remote
  // get-url origin`.

  it("MEDIUM /review: returns pr_repo_mismatch when prose URL is from a different repo", () => {
    const sha = "3".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      { cmd: "git", status: 0, stdout: "https://github.com/me/myrepo.git\n" },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/attacker/sibling/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("pr_repo_mismatch");
      expect(out.evidence.join(" ")).toContain("attacker/sibling");
      expect(out.evidence.join(" ")).toContain("me/myrepo");
    }
  });

  it("MEDIUM /review: repo-match is case-insensitive", () => {
    const sha = "4".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      { cmd: "git", status: 0, stdout: "https://github.com/Foo/Bar.git\n" },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/42",
          headRefName: branch,
          state: "OPEN",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(true);
  });

  it("MEDIUM /review: bare 'PR #N' references skip repo-match (no URL to check against)", () => {
    const sha = "5".repeat(40);
    // No git remote get-url mock — bare references don't trigger that subprocess.
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/42",
          headRefName: branch,
          state: "OPEN",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened PR #42",
      runCommand,
    });
    expect(out.ok).toBe(true);
  });

  it("MEDIUM /review: soft-fails when git remote get-url errors (no origin → skip check)", () => {
    const sha = "6".repeat(40);
    const runCommand = mockRun([
      { cmd: "git", status: 0, stdout: `${sha}\trefs/heads/${branch}\n` },
      {
        cmd: "git",
        status: 128,
        stderr: "fatal: No such remote 'origin'",
      },
      {
        cmd: "gh",
        status: 0,
        stdout: JSON.stringify({
          url: "https://github.com/foo/bar/pull/42",
          headRefName: branch,
          state: "OPEN",
        }),
      },
    ]);
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42",
      runCommand,
    });
    expect(out.ok).toBe(true);
  });
});

// T6 /review MEDIUM: auto-land mode validation wiring. post-merge mode
// skips the branch_not_pushed check (branch may be deleted by squash-
// merge + delete-branch) and accepts OPEN or MERGED for the PR state.
describe("validateShipCompletion: mode: post-merge (auto-land)", () => {
  const branch = "feat/cancel-api-followups";
  const cwd = "/tmp/whatever";

  it("does NOT call git ls-remote in post-merge mode (branch may be deleted)", () => {
    let lsRemoteCalled = false;
    const runCommand: RunCommandFn = (cmd, args) => {
      if (cmd === "git" && args[0] === "ls-remote") lsRemoteCalled = true;
      if (cmd === "git" && args[0] === "remote") {
        return { status: 0, stdout: "https://github.com/foo/bar.git\n", stderr: "" };
      }
      if (cmd === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/foo/bar/pull/42",
            headRefName: branch,
            state: "MERGED",
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42 and merged it",
      runCommand,
      mode: "post-merge",
    });
    expect(out.ok).toBe(true);
    expect(lsRemoteCalled).toBe(false);
    if (out.ok) {
      expect(out.sha).toBeUndefined();
      expect(out.prNumber).toBe(42);
    }
  });

  it("accepts state MERGED in post-merge mode (auto-land's land role squash-merged)", () => {
    const runCommand: RunCommandFn = (cmd, args) => {
      if (cmd === "git" && args[0] === "remote") {
        return { status: 0, stdout: "https://github.com/foo/bar.git\n", stderr: "" };
      }
      if (cmd === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/foo/bar/pull/42",
            headRefName: branch,
            state: "MERGED",
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42, merged.",
      runCommand,
      mode: "post-merge",
    });
    expect(out.ok).toBe(true);
  });

  it("accepts state OPEN in post-merge mode (land role hasn't merged yet)", () => {
    const runCommand: RunCommandFn = (cmd, args) => {
      if (cmd === "git" && args[0] === "remote") {
        return { status: 0, stdout: "https://github.com/foo/bar.git\n", stderr: "" };
      }
      if (cmd === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/foo/bar/pull/42",
            headRefName: branch,
            state: "OPEN",
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "PR #42 ready",
      runCommand,
      mode: "post-merge",
    });
    expect(out.ok).toBe(true);
  });

  it("rejects state CLOSED in post-merge mode (closed without merge is not success)", () => {
    const runCommand: RunCommandFn = (cmd, args) => {
      if (cmd === "git" && args[0] === "remote") {
        return { status: 0, stdout: "https://github.com/foo/bar.git\n", stderr: "" };
      }
      if (cmd === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({
            url: "https://github.com/foo/bar/pull/42",
            headRefName: branch,
            state: "CLOSED",
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Opened https://github.com/foo/bar/pull/42",
      runCommand,
      mode: "post-merge",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("pr_not_open");
    }
  });

  it("still catches the headline hallucination case: no PR reference + gh pr list empty", () => {
    // Auto-land mode: kimi-as-ship fabricated "READY TO LAND" but never
    // created a PR. ship-output.md has no PR URL or "PR #N", AND
    // gh pr list --head <branch> returns []. Validator falls back to gh
    // pr list as a discovery path (legitimate land-role outputs sometimes
    // just say "merged" without quoting a URL), but when that ALSO returns
    // empty the hallucination is confirmed.
    const runCommand: RunCommandFn = (cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      throw new Error(`unexpected mock-runCommand call: ${cmd} ${args.join(" ")}`);
    };
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Everything passed. READY TO LAND. 196 tests passed.",
      runCommand,
      mode: "post-merge",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("no_pr_reference_in_output");
    }
  });

  it("falls back to gh pr list when output has no PR ref (legitimate merged PR exists)", () => {
    // Land role just reported "merged" without quoting a URL. Validator
    // discovers the merged PR via gh pr list and accepts it.
    const runCommand: RunCommandFn = (cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 42,
              state: "MERGED",
              headRefName: branch,
              url: "https://github.com/foo/bar/pull/42",
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
    };
    const out = validateShipCompletion({
      cwd,
      branch,
      outputText: "Merged successfully.",
      runCommand,
      mode: "post-merge",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prNumber).toBe(42);
      expect(out.prUrl).toBe("https://github.com/foo/bar/pull/42");
    }
  });
});

describe("parseGithubOwnerRepo", () => {
  it("parses https URL with .git suffix", () => {
    expect(parseGithubOwnerRepo("https://github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses https URL without .git", () => {
    expect(parseGithubOwnerRepo("https://github.com/foo/bar")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses git@github.com:owner/repo.git", () => {
    expect(parseGithubOwnerRepo("git@github.com:foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses ssh://git@github.com/owner/repo", () => {
    expect(parseGithubOwnerRepo("ssh://git@github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("returns null for non-github URLs", () => {
    expect(parseGithubOwnerRepo("https://gitlab.com/foo/bar")).toBeNull();
    expect(parseGithubOwnerRepo("file:///tmp/repo")).toBeNull();
    expect(parseGithubOwnerRepo("")).toBeNull();
  });

  it("trims trailing slash", () => {
    expect(parseGithubOwnerRepo("https://github.com/foo/bar/")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });
});
