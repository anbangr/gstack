/**
 * Tests for validateShipCompletion — Bug 6 (mitosis-control-plane
 * cancel-api-followups-v1-20 2026-05-20 SHIP_ROLE_HALLUCINATED_SUCCESS).
 */
import { describe, it, expect } from "bun:test";
import {
  parsePrReference,
  validateShipCompletion,
  type RunCommandFn,
} from "../ship-validation";

describe("parsePrReference", () => {
  it("extracts PR number from canonical GitHub URL", () => {
    expect(
      parsePrReference("Created https://github.com/foo/bar/pull/42 for review."),
    ).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/foo/bar/pull/42",
    });
  });

  it("extracts PR number from 'PR #N' reference", () => {
    expect(parsePrReference("Opened PR #1234. Ready to land.")).toEqual({
      prNumber: 1234,
      prUrl: null,
    });
  });

  it("prefers URL over bare number when both are present", () => {
    const out = parsePrReference(
      "PR #99 — see https://github.com/foo/bar/pull/100 for diff.",
    );
    expect(out.prNumber).toBe(100);
    expect(out.prUrl).toBe("https://github.com/foo/bar/pull/100");
  });

  it("returns nulls when no PR reference is present", () => {
    expect(parsePrReference("All tests passed. READY TO LAND.")).toEqual({
      prNumber: null,
      prUrl: null,
    });
  });

  it("ignores PR-like text inside other domains", () => {
    expect(
      parsePrReference("see https://example.com/foo/bar/pull/9 not GH"),
    ).toEqual({ prNumber: null, prUrl: null });
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
});
