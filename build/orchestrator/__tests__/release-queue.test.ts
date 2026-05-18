import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertReleaseQueueTransition,
  discoverBuildQueuedPullRequests,
  markPrQueued,
  parseShipOutput,
  parseQueuedMarker,
  queuedMarker,
  readReleaseQueueRecords,
  releaseQueueRecordId,
  resolveShipPr,
  updateReleaseQueueRecord,
  verifyPrQueued,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../release-queue";

describe("release queue registry", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-queue-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(
    overrides: Partial<ReleaseQueueRecord> = {},
  ): ReleaseQueueRecord {
    return {
      runId: "run-1",
      repoPath: "/repo",
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 10,
      version: "1.2.3.4",
      livingPlanPath: "/plans/living.md",
      worktreePath: "/worktrees/a",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  it("writes, sorts, updates, and ignores corrupt records", () => {
    writeReleaseQueueRecord(
      dir,
      record({ prNumber: 12, queuedAt: "2026-05-09T00:02:00.000Z" }),
    );
    writeReleaseQueueRecord(
      dir,
      record({ prNumber: 11, queuedAt: "2026-05-09T00:01:00.000Z" }),
    );
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");

    const records = readReleaseQueueRecords(dir);
    expect(records.map((item) => item.prNumber)).toEqual([11, 12]);

    const updated = updateReleaseQueueRecord(dir, records[0], {
      status: "claiming",
    });
    expect(updated.status).toBe("claiming");
    expect(readReleaseQueueRecords(dir)[0].status).toBe("claiming");
  });

  it("enforces the typed state machine", () => {
    expect(() =>
      assertReleaseQueueTransition("queued", "claiming"),
    ).not.toThrow();
    expect(() => assertReleaseQueueTransition("landed", "queued")).toThrow(
      "invalid release queue transition",
    );
  });

  it("parses PR number, URL, and version from /ship output", () => {
    const parsed = parseShipOutput(
      "Created PR #42: https://github.com/acme/repo/pull/42\nTitle: v1.2.3.4 feat: queue",
    );
    expect(parsed).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      version: "1.2.3.4",
    });
  });

  // Prose-drift failure modes that the regex MUST NOT pretend to match. When
  // these come back empty, cli.ts must verify against gh — not pause with
  // "PR number could not be parsed" as if the ship succeeded.
  it("returns empty for hyphen-form 'PR-42' (no '#', no URL)", () => {
    expect(parseShipOutput("Successfully created PR-42 on origin")).toEqual({});
  });

  it("returns empty for label-form 'Number: 42'", () => {
    expect(parseShipOutput("Pushed branch.\nNumber: 42\nDone.")).toEqual({});
  });

  it("returns empty for unnumbered narrative ('Created PR' with no number anywhere)", () => {
    expect(
      parseShipOutput("Pushed branch to origin. PR creation skipped."),
    ).toEqual({});
  });

  it("returns empty for empty input", () => {
    expect(parseShipOutput("")).toEqual({});
  });

  it("round-trips the hidden queued PR marker", () => {
    const parsed = parseQueuedMarker(
      `body\n\n${queuedMarker(
        record({
          repoIdentity: "github.com/acme/repo",
        }),
      )}`,
    );
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.repoIdentity).toBe("github.com/acme/repo");
    expect(parsed?.livingPlanPath).toBe("/plans/living.md");
    expect(parsed?.worktreePath).toBe("/worktrees/a");
  });

  it("uses canonical repo identity for queue record ids across different local paths", () => {
    const left = releaseQueueRecordId(
      record({
        repoPath: "/Users/alice/repo",
        repoIdentity: "github.com/acme/repo",
        prNumber: 42,
      }),
    );
    const right = releaseQueueRecordId(
      record({
        repoPath: "/home/bob/repo",
        repoIdentity: "github.com/acme/repo",
        prNumber: 42,
      }),
    );
    expect(left).toBe(right);
    expect(left).toContain("github.com-acme-repo-main-pr-42");
  });

  it("discovers only build-queued same-repo PRs from GitHub labels and markers", () => {
    const queued = queuedMarker(
      record({
        prNumber: 5,
        queuedAt: "2026-05-09T00:05:00.000Z",
      }),
    );
    const older = queuedMarker(
      record({
        runId: "run-older",
        prNumber: 4,
        queuedAt: "2026-05-09T00:04:00.000Z",
      }),
    );
    const run = (() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 5,
          url: "https://github.com/acme/repo/pull/5",
          baseRefName: "main",
          headRefName: "feat/a",
          body: queued,
          isCrossRepository: false,
        },
        {
          number: 4,
          url: "https://github.com/acme/repo/pull/4",
          baseRefName: "main",
          headRefName: "feat/b",
          body: older,
          isCrossRepository: false,
        },
        {
          number: 3,
          url: "https://github.com/acme/repo/pull/3",
          baseRefName: "main",
          headRefName: "fork/branch",
          body: queued,
          isCrossRepository: true,
        },
        {
          number: 2,
          url: "https://github.com/acme/repo/pull/2",
          baseRefName: "main",
          headRefName: "manual",
          body: "no gstack marker",
          isCrossRepository: false,
        },
      ]),
      stderr: "",
    })) as never;

    const result = discoverBuildQueuedPullRequests("/local/repo", run);
    expect(result.error).toBeUndefined();
    expect(result.records.map((item) => item.prNumber)).toEqual([4, 5]);
    expect(result.records[0].repoPath).toBe("/local/repo");
    expect(result.records[0].featureBranch).toBe("feat/b");
  });

  it("verifies the queued PR label and hidden marker before daemon landing", () => {
    const body = queuedMarker(record({ prNumber: 42 }));
    const okRun = (() => ({
      status: 0,
      stdout: JSON.stringify({
        body,
        labels: [{ name: "gstack-release-queued" }],
      }),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(verifyPrQueued("/repo", { prNumber: 42 }, okRun).ok).toBe(true);

    const missingMarker = (() => ({
      status: 0,
      stdout: JSON.stringify({
        body: "plain body",
        labels: [{ name: "gstack-release-queued" }],
      }),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(verifyPrQueued("/repo", { prNumber: 42 }, missingMarker).ok).toBe(
      false,
    );

    const missingLabel = (() => ({
      status: 0,
      stdout: JSON.stringify({ body, labels: [] }),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(verifyPrQueued("/repo", { prNumber: 42 }, missingLabel).ok).toBe(
      false,
    );
  });

  it("does not overwrite a PR body when reading the current body fails", () => {
    const calls: string[][] = [];
    const run = ((_cmd, args) => {
      calls.push(args);
      if (args[0] === "label") {
        return { status: 0, stdout: "", stderr: "", signal: null, output: [] };
      }
      if (
        args[0] === "pr" &&
        args[1] === "edit" &&
        args.includes("--add-label")
      ) {
        return { status: 0, stdout: "", stderr: "", signal: null, output: [] };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 1,
          stdout: "",
          stderr: "body unavailable",
          signal: null,
          output: [],
        };
      }
      return { status: 0, stdout: "", stderr: "", signal: null, output: [] };
    }) as never;

    const marked = markPrQueued("/repo", record({ prNumber: 77 }), run);
    expect(marked.ok).toBe(false);
    expect(marked.error).toContain("body unavailable");
    expect(
      calls.some(
        (args) =>
          args[0] === "pr" && args[1] === "edit" && args.includes("--body"),
      ),
    ).toBe(false);
  });
});

describe("resolveShipPr", () => {
  it("happy path: parseShipOutput hits, returns prNumber and prUrl", () => {
    const ghCalls: string[][] = [];
    const run = ((_cmd: string, args: string[]) => {
      ghCalls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 42,
            url: "https://github.com/acme/repo/pull/42",
          },
        ]),
        stderr: "",
        signal: null,
        output: [],
      };
    }) as never;
    const result = resolveShipPr({
      outputText: "Created PR #42: https://github.com/acme/repo/pull/42",
      branch: "feat/x",
      cwd: "/repo",
      run,
    });
    expect(result).toEqual({
      ok: true,
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      version: undefined,
    });
  });

  it("falls back to findOpenPrForBranch when parse returns no number", () => {
    const run = (() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 77,
          url: "https://github.com/acme/repo/pull/77",
        },
      ]),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    const result = resolveShipPr({
      outputText: "Pushed branch. Number: 77. Done.",
      branch: "feat/x",
      cwd: "/repo",
      run,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prNumber).toBe(77);
      expect(result.prUrl).toBe("https://github.com/acme/repo/pull/77");
    }
  });

  it("returns descriptive error when parse fails AND no open PR exists for branch (mode C)", () => {
    const run = (() => ({
      status: 0,
      stdout: "[]",
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    const result = resolveShipPr({
      outputText: "Pushed branch to origin. PR creation skipped.",
      branch: "feat/c3-http-rpc-layer",
      cwd: "/repo",
      run,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no open PR");
      expect(result.error).toContain("feat/c3-http-rpc-layer");
    }
  });

  it("returns descriptive error when parse fails AND gh itself fails", () => {
    const run = (() => ({
      status: 1,
      stdout: "",
      stderr: "gh: not authenticated",
      signal: null,
      output: [],
    })) as never;
    const result = resolveShipPr({
      outputText: "Pushed branch to origin.",
      branch: "feat/x",
      cwd: "/repo",
      run,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no open PR");
    }
  });

  it("prefers gh's number when parse and gh disagree (parser was lucky)", () => {
    // Stale prose mentions PR #5 but the actual open PR on remote is #42.
    const run = (() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
        },
      ]),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    const result = resolveShipPr({
      outputText: "Earlier we created PR #5. New ship: see remote.",
      branch: "feat/x",
      cwd: "/repo",
      run,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prNumber).toBe(42);
      expect(result.prUrl).toBe("https://github.com/acme/repo/pull/42");
    }
  });

  it("returns version from parse when present", () => {
    const run = (() => ({
      status: 0,
      stdout: "[]",
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    const result = resolveShipPr({
      outputText: "Created PR #9: https://github.com/acme/repo/pull/9 v1.2.3.4",
      branch: "feat/x",
      cwd: "/repo",
      run,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe("1.2.3.4");
    }
  });
});
