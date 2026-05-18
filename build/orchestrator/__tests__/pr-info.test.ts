import { describe, expect, it } from "bun:test";
import { findOpenPrForBranch } from "../pr-info";

describe("findOpenPrForBranch", () => {
  it("returns the open PR number and URL when gh lists one", () => {
    const run = (() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          baseRefName: "main",
          headRefName: "feat/x",
        },
      ]),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(findOpenPrForBranch("/repo", "feat/x", run)).toEqual({
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
    });
  });

  it("returns null when gh returns an empty array (no PR exists for branch)", () => {
    const run = (() => ({
      status: 0,
      stdout: "[]",
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(findOpenPrForBranch("/repo", "feat/missing", run)).toBeNull();
  });

  it("returns null when gh exits non-zero", () => {
    const run = (() => ({
      status: 1,
      stdout: "",
      stderr: "gh: not authenticated",
      signal: null,
      output: [],
    })) as never;
    expect(findOpenPrForBranch("/repo", "feat/x", run)).toBeNull();
  });

  it("returns null when gh stdout is malformed JSON", () => {
    const run = (() => ({
      status: 0,
      stdout: "{not json",
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(findOpenPrForBranch("/repo", "feat/x", run)).toBeNull();
  });

  it("passes the exact branch to gh pr list --head", () => {
    const branches: string[] = [];
    const run = ((_cmd: string, args: string[]) => {
      const headIdx = args.indexOf("--head");
      if (headIdx >= 0) branches.push(args[headIdx + 1]);
      return {
        status: 0,
        stdout: "[]",
        stderr: "",
        signal: null,
        output: [],
      };
    }) as never;
    const branch =
      "feat/agnt2-prototype-deferred-code-only-20260518-104300-c4ecd19e5932-3-g-c3-http-rpc-layer";
    findOpenPrForBranch("/repo", branch, run);
    expect(branches).toEqual([branch]);
  });
});
