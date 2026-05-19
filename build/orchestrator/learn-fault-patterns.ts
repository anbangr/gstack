/**
 * Learn fault patterns: drain `pending-patterns.jsonl` (written by PR 5's
 * investigator) into `learned-patterns.json` (consumed by the detector).
 *
 * Pipeline:
 *   investigator → pending-patterns.jsonl → [curator gate] → learned-patterns.json
 *
 * The curator gate is exposed two ways:
 *   1. AskUserQuestion in the `build` skill's Step M3.7 (interactive promotion).
 *   2. `gstack-build learn-fault-patterns` CLI subcommand with `--dry-run`
 *      to preview, `--promote <ids>` to commit, and `--auto-promote` for
 *      spawned sessions that can't surface UI prompts.
 *
 * File layout (all under `~/.gstack/skill-faults/` by default; respects
 * `GSTACK_HOME` env var):
 *
 *   pending-patterns.jsonl   investigator-proposed candidates, append-only.
 *                            Each line is: {ts, faultId, proposal}
 *   learned-patterns.json    curated registry, atomic tmp+rename writes.
 *                            Array of LearnedPattern objects.
 *   rejected-patterns.jsonl  audit trail of deferred/rejected proposals,
 *                            append-only. Each line: {ts, faultId, proposal, reason}
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  LearnedPattern,
  LearnedMatcherKind,
} from "./skill-fault-detector";

export interface PendingProposal {
  /** ISO 8601 timestamp the investigator queued the proposal. */
  ts?: string;
  /** Source halt event id (for traceability). */
  faultId: string;
  proposal: {
    category: string;
    matcherKind: LearnedMatcherKind;
    pattern: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM";
    description: string;
  };
}

export interface LearnFaultPatternsOpts {
  /** Override `~/.gstack/skill-faults/` for tests. */
  skillFaultsDir?: string;
}

function defaultSkillFaultsDir(): string {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  return path.join(home, "skill-faults");
}

function dir(opts?: LearnFaultPatternsOpts): string {
  return opts?.skillFaultsDir ?? defaultSkillFaultsDir();
}

/**
 * Load all proposals from `pending-patterns.jsonl`. Skips malformed lines
 * silently — a corrupt row should never block legitimate promotions.
 */
export function loadPendingProposals(
  opts?: LearnFaultPatternsOpts,
): PendingProposal[] {
  const file = path.join(dir(opts), "pending-patterns.jsonl");
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const out: PendingProposal[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed &&
        typeof parsed.faultId === "string" &&
        parsed.proposal &&
        typeof parsed.proposal.category === "string"
      ) {
        out.push(parsed as PendingProposal);
      }
    } catch {
      // skip malformed row
    }
  }
  return out;
}

/**
 * Dedupe proposals against the curated registry. A proposal is dropped if
 * its category is already learned, OR if its (matcherKind, pattern) pair is
 * already learned. Same-category-different-pattern would shadow the
 * existing entry; same-pair-different-category would create a noop dupe.
 */
export function dedupeAgainstLearned(
  proposals: PendingProposal[],
  learned: LearnedPattern[],
): { keep: PendingProposal[]; drop: PendingProposal[] } {
  const learnedCats = new Set(learned.map((l) => l.category));
  const learnedPairs = new Set(
    learned.map((l) => `${l.matcherKind}::${l.pattern}`),
  );
  const keep: PendingProposal[] = [];
  const drop: PendingProposal[] = [];
  for (const p of proposals) {
    const pair = `${p.proposal.matcherKind}::${p.proposal.pattern}`;
    if (learnedCats.has(p.proposal.category) || learnedPairs.has(pair)) {
      drop.push(p);
    } else {
      keep.push(p);
    }
  }
  return { keep, drop };
}

export interface PromoteOpts extends LearnFaultPatternsOpts {
  /** Mark deferred proposals (not promoted, not duplicates). */
  defer?: PendingProposal[];
}

/**
 * Atomically promote selected proposals into `learned-patterns.json`.
 *
 *   - Promoted: appended to learned-patterns.json with `hitCount: 0` and a
 *     `source: "investigator:<faultId>"` provenance tag. Write is atomic
 *     via tmp+rename (mode 0o600).
 *   - Rejected (`toReject`): each row appended to `rejected-patterns.jsonl`
 *     with the reason. Append-only audit trail.
 *   - `pending-patterns.jsonl` is truncated last (write-empty + rename) so
 *     a crash between promote and truncate leaves the source file intact.
 */
export function promoteProposals(
  toPromote: PendingProposal[],
  toReject: Array<{ proposal: PendingProposal; reason: string }>,
  opts?: LearnFaultPatternsOpts,
): void {
  const d = dir(opts);
  fs.mkdirSync(d, { recursive: true });

  // Phase 1: promote.
  const learnedFile = path.join(d, "learned-patterns.json");
  const learned: LearnedPattern[] = fs.existsSync(learnedFile)
    ? safeReadLearned(learnedFile)
    : [];
  const now = new Date().toISOString();
  for (const p of toPromote) {
    learned.push({
      ...p.proposal,
      source: `investigator:${p.faultId}`,
      learnedAt: now,
      hitCount: 0,
    });
  }
  const tmp = `${learnedFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(learned, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, learnedFile);

  // Phase 2: archive rejected/deferred to rejected-patterns.jsonl (append-only).
  if (toReject.length > 0) {
    const rejectedFile = path.join(d, "rejected-patterns.jsonl");
    const rows = toReject
      .map((r) =>
        JSON.stringify({
          ts: now,
          faultId: r.proposal.faultId,
          proposal: r.proposal.proposal,
          reason: r.reason,
        }),
      )
      .join("\n");
    fs.appendFileSync(rejectedFile, rows + "\n");
  }

  // Phase 3: truncate pending-patterns.jsonl atomically.
  const pendingFile = path.join(d, "pending-patterns.jsonl");
  const pendingTmp = `${pendingFile}.tmp.${process.pid}`;
  fs.writeFileSync(pendingTmp, "");
  fs.renameSync(pendingTmp, pendingFile);
}

function safeReadLearned(file: string): LearnedPattern[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as LearnedPattern[];
  } catch {
    // Corrupt or missing file → start fresh. Don't lose pending promotions.
  }
  return [];
}

/**
 * Decide which proposals to auto-promote in spawned sessions
 * (`OPENCLAW_SESSION=true` or similar). The rule mirrors the
 * recommendation in the interactive AskUserQuestion: promote all
 * "root-cause-identified" proposals at HIGH+ severity, defer the rest.
 *
 * Since `pending-patterns.jsonl` doesn't carry the investigator's outcome
 * (only the proposal), the auto-promote rule degenerates to: promote
 * everything at HIGH+ severity, defer MEDIUM. Operators who want stricter
 * gates run the interactive flow.
 */
export function autoPromoteDecision(proposals: PendingProposal[]): {
  promote: PendingProposal[];
  defer: PendingProposal[];
} {
  const promote: PendingProposal[] = [];
  const defer: PendingProposal[] = [];
  for (const p of proposals) {
    if (p.proposal.severity === "HIGH" || p.proposal.severity === "CRITICAL") {
      promote.push(p);
    } else {
      defer.push(p);
    }
  }
  return { promote, defer };
}
