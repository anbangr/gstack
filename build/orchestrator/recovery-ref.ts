/**
 * Recovery-ref safety net for branch/commit-destroying git ops (RC2).
 *
 * Several orchestrator code paths reset or force-delete a branch in ways that
 * CAN strand reviewed-but-unlanded commits as dangling objects, recoverable
 * only via `git fsck` until the next `git gc` reaps them:
 *
 *   - cleanupLocalMergedBranch (cli.ts): `git branch -D <branch>` when the
 *     branch has no remote counterpart (single-branch `feat/<prefix>` is never
 *     pushed, so `noRemote` is true and the force-delete drops a reviewed
 *     commit that is NOT merged into base).
 *   - ensureOriginRetryBranch (cli.ts): switches the build off the prior
 *     feature branch onto a fresh-from-origin `-followup-N` branch.
 *   - checkoutScratchWorktree's resetWorktree (release-daemon.ts):
 *     `git reset --hard origin/<featureBranch>` against a real landing
 *     worktree that may carry unpushed commits.
 *
 * Rather than change WHICH branches get deleted (which would regress the
 * intended squash-merge cleanup), this helper makes the whole class
 * non-destructive: before the destructive op, stamp a named ref under
 * `refs/gstack-recovery/` at the tip we are about to drop. A named ref keeps
 * the commit reachable, so it survives `git gc` and is recoverable by name
 * (`git branch <new> <ref>`) instead of by fsck-and-hope.
 *
 * Design contract — BEST EFFORT, NEVER BLOCKS:
 * Callers invoke stampRecoveryRef(...) then run the destructive op
 * UNCONDITIONALLY. The return value is informational; losing the recovery net
 * is strictly better than refusing a delete. The whole body is wrapped so it
 * can never throw.
 *
 * This is a LEAF module: it imports only `spawnSync` from ./child-registry
 * (which itself imports nothing from the orchestrator). Both cli.ts and
 * release-daemon.ts import it, so it must not import either of them — a helper
 * living in cli.ts would create a cli <-> release-daemon import cycle (cli.ts
 * already imports from ./release-daemon).
 *
 * Kill switch: GSTACK_DISABLE_RECOVERY_REF=1 skips stamping entirely.
 */

import { spawnSync } from "./child-registry";

const RECOVERY_REF_PREFIX = "refs/gstack-recovery";

export interface StampRecoveryRefArgs {
  /** Repo or worktree dir. `git update-ref` writes the recovery ref to the
   *  shared common dir, so a stamp from a linked worktree is recoverable from
   *  the main repo. */
  cwd: string;
  /** The ref whose tip to preserve: a branch name ("feat/foo"), a
   *  fully-qualified ref ("refs/heads/feat/foo"), or "HEAD". Resolved via
   *  `git rev-parse --verify <ref>^{commit}`. */
  ref: string;
  /** Short reason for the log line + recovery hint, e.g.
   *  "branch -D feat/foo (cleanupLocalMergedBranch)". */
  reason: string;
  /** Optional pre-resolved 40-hex SHA. Pass it when the caller already knows
   *  the pre-op tip (the release-daemon captures HEAD before the reset) so the
   *  PRE-op commit is stamped even if `ref` is about to move. */
  sha?: string;
  /** Logger; defaults to console.warn. Tests inject a capture fn. */
  warn?: (msg: string) => void;
}

export interface StampRecoveryRefResult {
  /** true when a recovery ref now points at the preserved commit. */
  stamped: boolean;
  /** Full refs/gstack-recovery/... name, on success. */
  recoveryRef?: string;
  /** The preserved commit SHA, on success. */
  sha?: string;
  /** true when GSTACK_DISABLE_RECOVERY_REF=1 short-circuited the stamp. */
  skipped?: boolean;
}

const HEX40 = /^[0-9a-f]{40}$/i;

/** Sanitize a ref string into a single check-ref-format-safe path component.
 *  The recovery ref is a backup name, not the original, so lowercasing and
 *  slash->dash flattening is fine — the SHA is what carries the work.
 *
 *  Intentionally a SIMPLIFIED subset of cli.ts's `safeBranchPart`: it does NOT
 *  apply the 72-char head+tail truncation or the post-`.lock` edge-dash
 *  re-strip. That's acceptable here because (a) this is a throwaway backup
 *  name, not a branch a human types, and (b) the composed ref is always run
 *  through `git check-ref-format` before use, so any residual invalidity
 *  degrades to a no-op stamp rather than a bad ref. Duplicated rather than
 *  imported to keep this a leaf module (see header: avoids a cli<->release-
 *  daemon import cycle). */
function refNamePart(ref: string): string {
  let part = ref
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Git-ref hardening: no `..`, no leading/trailing `.`, no `.lock` suffix.
  while (part.includes("..")) part = part.replace(/\.\.+/g, ".");
  part = part.replace(/^\.+|\.+$/g, "");
  if (part.endsWith(".lock")) part = part.slice(0, -".lock".length);
  return part || "ref";
}

/** A check-ref-format-valid, monotonic, human-readable timestamp suffix.
 *  ISO-8601 with `:` and `.` (both illegal mid-component in git refs)
 *  rewritten to `-`, e.g. 2026-06-06t14-22-09-481z. */
function recoveryTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
}

function git(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { cwd, encoding: "utf8" });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
}

/**
 * Stamp a recovery ref at the tip of `ref` (or `sha`) before a destructive op.
 * Best-effort: returns { stamped:false } on any failure, never throws.
 */
export function stampRecoveryRef(
  args: StampRecoveryRefArgs,
): StampRecoveryRefResult {
  // Logging that can NEVER throw out of this helper, even if a caller passes a
  // non-function or throwing `warn`, or passes null/undefined args entirely.
  // The whole contract is "never crash the caller's destructive op", so every
  // path that touches the caller-supplied logger is itself wrapped. (Reading
  // `args?.warn` per-call keeps this safe even when `args` is nullish.)
  const safeWarn = (msg: string): void => {
    try {
      const w = args?.warn;
      if (typeof w === "function") w(msg);
      else console.warn(msg);
    } catch {
      // A broken logger must not escape the safety net.
    }
  };
  const debug = (): boolean => Boolean(process.env.GSTACK_BUILD_DEBUG);
  try {
    if (!args) return { stamped: false };
    if (process.env.GSTACK_DISABLE_RECOVERY_REF === "1") {
      return { stamped: false, skipped: true };
    }

    // 1. Resolve the SHA to preserve.
    let sha = args.sha && HEX40.test(args.sha.trim()) ? args.sha.trim() : "";
    if (!sha) {
      const rev = git(args.cwd, [
        "rev-parse",
        "--verify",
        `${args.ref}^{commit}`,
      ]);
      const candidate = rev.stdout.trim();
      if (rev.status !== 0 || !HEX40.test(candidate)) {
        // Unresolvable/empty ref → nothing to preserve. A no-op, not an error
        // worth surfacing to operators.
        if (debug()) {
          safeWarn(
            `[recovery] skip: could not resolve ${args.ref} in ${args.cwd}` +
              (rev.stderr.trim() ? `: ${rev.stderr.trim()}` : ""),
          );
        }
        return { stamped: false };
      }
      sha = candidate;
    }

    // 2. Compose + validate the recovery ref name. The short SHA is part of
    //    the name so two stamps of the SAME ref at DIFFERENT commits never
    //    collide (distinct commits → distinct refs). A same-ref/same-commit
    //    re-stamp within the same millisecond resolves to the identical name
    //    and update-ref rewrites it to the identical SHA — a harmless no-op,
    //    never a lost commit.
    const recoveryRef = `${RECOVERY_REF_PREFIX}/${refNamePart(args.ref)}-${sha.slice(0, 12)}-${recoveryTimestamp()}`;
    const fmt = git(args.cwd, ["check-ref-format", recoveryRef]);
    if (fmt.status !== 0) {
      if (debug())
        safeWarn(`[recovery] skip: invalid recovery ref name ${recoveryRef}`);
      return { stamped: false };
    }

    // 3. Create the ref. This is what makes `sha` survive the subsequent
    //    branch -D / reset --hard AND a later `git gc`.
    const upd = git(args.cwd, ["update-ref", recoveryRef, sha]);
    if (upd.status !== 0) {
      if (debug()) {
        safeWarn(
          `[recovery] skip: update-ref ${recoveryRef} failed` +
            (upd.stderr.trim() ? `: ${upd.stderr.trim()}` : ""),
        );
      }
      return { stamped: false };
    }

    // 4. One operator-visible line with the recovery command. NOT gated —
    //    the operator must be able to recover after a wrong delete.
    safeWarn(
      `[recovery] stamped ${recoveryRef} -> ${sha} before ${args.reason}. ` +
        `Recover with: git branch <new-branch> ${recoveryRef}`,
    );
    return { stamped: true, recoveryRef, sha };
  } catch (err) {
    // Best-effort contract: a failed stamp must never block the caller's
    // destructive op. Swallow everything; surface only under debug. safeWarn
    // can itself never throw, so the catch can't escape the helper.
    if (debug()) {
      safeWarn(
        `[recovery] stamp threw (ignored): ${(err as Error)?.message ?? String(err)}`,
      );
    }
    return { stamped: false };
  }
}
