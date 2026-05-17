import { spawnSync } from "./child-registry";

/**
 * Look up the most recent merged PR for a given head branch. Used by the
 * `mark-shipped` escape hatch to auto-resolve `--pr` when the operator
 * doesn't pass it. Returns null on any failure — caller must surface a
 * clear error to the operator.
 */
export function findMergedPRForBranch(
  cwd: string,
  branch: string,
  ghBinary = "gh",
): number | null {
  const r = spawnSync(
    ghBinary,
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--head",
      branch,
      "--json",
      "number,mergedAt",
      "--limit",
      "5",
    ],
    { cwd, encoding: "utf8", timeout: 15_000 },
  );
  if (r.error || r.status !== 0) return null;
  try {
    const prs = JSON.parse(r.stdout || "[]") as Array<{
      number: number;
      mergedAt: string | null;
    }>;
    if (!Array.isArray(prs) || prs.length === 0) return null;
    // Most-recently-merged wins.
    const sorted = prs
      .filter(
        (pr) => pr.mergedAt && Number.isInteger(pr.number) && pr.number > 0,
      )
      .sort((a, b) => (a.mergedAt! < b.mergedAt! ? 1 : -1));
    return sorted[0]?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a single PR's merge state. Returns the canonical merge SHA on success
 * (used by mark-shipped to seed FeatureState.mergeSha from gh's response
 * rather than guessing at origin/main HEAD). Returns null if the PR is not
 * merged, doesn't exist, or gh fails.
 */
export function readMergedPRInfo(
  cwd: string,
  prNumber: number,
  ghBinary = "gh",
): { mergeSha: string; mergedAt: string } | null {
  const r = spawnSync(
    ghBinary,
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "state,mergeCommit,mergedAt",
    ],
    { cwd, encoding: "utf8", timeout: 15_000 },
  );
  if (r.error || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout || "{}") as {
      state?: string;
      mergeCommit?: { oid?: string } | null;
      mergedAt?: string | null;
    };
    if (parsed.state !== "MERGED") return null;
    const sha = parsed.mergeCommit?.oid;
    const at = parsed.mergedAt;
    if (typeof sha !== "string" || sha.length === 0) return null;
    if (typeof at !== "string" || at.length === 0) return null;
    return { mergeSha: sha, mergedAt: at };
  } catch {
    return null;
  }
}
