/**
 * Resolve the actual git directory for a given cwd.
 * Handles regular repos (".git" is a directory), worktrees (".git" is a file
 * pointing to the real gitdir), and bare repos (".git" is the cwd itself).
 *
 * Uses git rev-parse --git-dir so git resolves all the edge cases for us:
 * - subdirectories inside a repo or worktree
 * - worktrees whose .git file contains a gitdir: link
 * - bare repos where rev-parse --git-dir returns "."
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./child-registry";

const cache = new Map<string, string>();

export function clearResolveGitDirCache(): void {
  cache.clear();
}

export async function resolveGitDir(cwd: string): Promise<string> {
  const cached = cache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }

  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const err = result.stderr?.trim() || "git rev-parse --git-dir failed";
    throw new Error(
      `resolveGitDir: cwd "${cwd}" is not a git repo (${err})`,
    );
  }

  const raw = result.stdout.trim();
  // git-dir may be relative (e.g. "." in a bare repo or "../.git/modules/foo"
  // in a submodule); resolve it absolutely against cwd.
  let absolute = path.resolve(cwd, raw);

  // On macOS, git resolves symlinks (e.g. /var → /private/var) while the
  // caller's cwd may use the non-resolved path. Normalize back to the
  // logical path when both point to the same inode so tests and callers
  // get path prefixes they expect.
  if (absolute.startsWith("/private/")) {
    const withoutPrivate = absolute.slice("/private".length);
    try {
      if (
        fs.statSync(withoutPrivate).ino === fs.statSync(absolute).ino
      ) {
        absolute = withoutPrivate;
      }
    } catch {
      // Leave absolute as-is if the shorter path doesn't exist or isn't
      // the same inode.
    }
  }

  cache.set(cwd, absolute);
  return absolute;
}
