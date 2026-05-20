import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPendingProposals,
  dedupeAgainstLearned,
  promoteProposals,
  autoPromoteDecision,
  type PendingProposal,
} from "../learn-fault-patterns";
import type { LearnedPattern } from "../skill-fault-detector";

const sampleProposal = (
  faultId: string,
  category: string,
  pattern = "x",
  severity: "CRITICAL" | "HIGH" | "MEDIUM" = "HIGH",
): PendingProposal => ({
  faultId,
  proposal: {
    category,
    matcherKind: "stdout_contains",
    pattern,
    severity,
    description: `desc for ${category}`,
  },
});

const sampleLearned = (
  category: string,
  pattern = "x",
): LearnedPattern => ({
  category,
  severity: "HIGH",
  description: `existing ${category}`,
  matcherKind: "stdout_contains",
  pattern,
  source: "test",
  learnedAt: "2026-01-01T00:00:00Z",
  hitCount: 0,
});

describe("loadPendingProposals", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("missing file → empty array", () => {
    expect(loadPendingProposals({ skillFaultsDir: tmp })).toEqual([]);
  });

  test("loads one proposal per JSONL line", () => {
    const file = path.join(tmp, "pending-patterns.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: "2026-05-19T00:00:00Z",
        faultId: "F1",
        proposal: {
          category: "A",
          matcherKind: "stdout_contains",
          pattern: "x",
          severity: "HIGH",
          description: "x",
        },
      }) + "\n",
    );
    const out = loadPendingProposals({ skillFaultsDir: tmp });
    expect(out.length).toBe(1);
    expect(out[0].proposal.category).toBe("A");
    expect(out[0].faultId).toBe("F1");
  });

  test("skips malformed JSONL lines without throwing", () => {
    const file = path.join(tmp, "pending-patterns.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify(sampleProposal("F1", "GOOD")),
        "{this is not json",
        JSON.stringify(sampleProposal("F2", "ALSO_GOOD")),
        "",
        '{"missing":"required-fields"}',
      ].join("\n"),
    );
    const out = loadPendingProposals({ skillFaultsDir: tmp });
    expect(out.length).toBe(2);
    expect(out.map((p) => p.proposal.category).sort()).toEqual([
      "ALSO_GOOD",
      "GOOD",
    ]);
  });
});

describe("dedupeAgainstLearned", () => {
  test("drops proposals with already-known category", () => {
    const proposals = [
      sampleProposal("F1", "KNOWN"),
      sampleProposal("F2", "NEW"),
    ];
    const learned = [sampleLearned("KNOWN", "different-pattern")];
    const { keep, drop } = dedupeAgainstLearned(proposals, learned);
    expect(keep.map((p) => p.proposal.category)).toEqual(["NEW"]);
    expect(drop.map((p) => p.proposal.category)).toEqual(["KNOWN"]);
  });

  test("drops proposals with already-known (matcherKind, pattern) pair", () => {
    const proposals = [
      sampleProposal("F1", "NEW1", "duplicate-pattern"),
      sampleProposal("F2", "NEW2", "fresh-pattern"),
    ];
    const learned = [sampleLearned("OLD", "duplicate-pattern")];
    const { keep, drop } = dedupeAgainstLearned(proposals, learned);
    expect(keep.length).toBe(1);
    expect(keep[0].proposal.category).toBe("NEW2");
    expect(drop.length).toBe(1);
    expect(drop[0].proposal.category).toBe("NEW1");
  });

  test("empty learned → keep everything", () => {
    const proposals = [
      sampleProposal("F1", "A"),
      sampleProposal("F2", "B"),
    ];
    const { keep, drop } = dedupeAgainstLearned(proposals, []);
    expect(keep.length).toBe(2);
    expect(drop.length).toBe(0);
  });
});

describe("promoteProposals", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("appends to learned-patterns.json atomically + truncates pending", () => {
    fs.writeFileSync(path.join(tmp, "learned-patterns.json"), JSON.stringify([]));
    fs.writeFileSync(
      path.join(tmp, "pending-patterns.jsonl"),
      JSON.stringify(sampleProposal("F1", "NEW")) + "\n",
    );
    promoteProposals(
      [sampleProposal("F1", "NEW")],
      [],
      { skillFaultsDir: tmp },
    );
    const learned = JSON.parse(
      fs.readFileSync(path.join(tmp, "learned-patterns.json"), "utf8"),
    );
    expect(learned.length).toBe(1);
    expect(learned[0].category).toBe("NEW");
    expect(learned[0].hitCount).toBe(0);
    expect(learned[0].source).toBe("investigator:F1");
    expect(typeof learned[0].learnedAt).toBe("string");

    const pending = fs.readFileSync(
      path.join(tmp, "pending-patterns.jsonl"),
      "utf8",
    );
    expect(pending).toBe("");
  });

  test("preserves existing learned-patterns.json entries", () => {
    const existing = [sampleLearned("OLD_A"), sampleLearned("OLD_B", "y")];
    fs.writeFileSync(
      path.join(tmp, "learned-patterns.json"),
      JSON.stringify(existing),
    );
    promoteProposals(
      [sampleProposal("F1", "NEW_C", "z")],
      [],
      { skillFaultsDir: tmp },
    );
    const learned = JSON.parse(
      fs.readFileSync(path.join(tmp, "learned-patterns.json"), "utf8"),
    );
    expect(learned.length).toBe(3);
    expect(learned.map((l: LearnedPattern) => l.category).sort()).toEqual([
      "NEW_C",
      "OLD_A",
      "OLD_B",
    ]);
  });

  test("rejected proposals appended to rejected-patterns.jsonl", () => {
    fs.writeFileSync(path.join(tmp, "learned-patterns.json"), JSON.stringify([]));
    const rejected = sampleProposal("F1", "DUPLICATE");
    promoteProposals(
      [],
      [{ proposal: rejected, reason: "duplicate-of OLD_A" }],
      { skillFaultsDir: tmp },
    );
    const rejFile = path.join(tmp, "rejected-patterns.jsonl");
    expect(fs.existsSync(rejFile)).toBe(true);
    const lines = fs
      .readFileSync(rejFile, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.faultId).toBe("F1");
    expect(row.reason).toBe("duplicate-of OLD_A");
    expect(row.proposal.category).toBe("DUPLICATE");
  });

  test("missing learned-patterns.json → creates fresh", () => {
    fs.writeFileSync(
      path.join(tmp, "pending-patterns.jsonl"),
      JSON.stringify(sampleProposal("F1", "FIRST")) + "\n",
    );
    promoteProposals(
      [sampleProposal("F1", "FIRST")],
      [],
      { skillFaultsDir: tmp },
    );
    const learned = JSON.parse(
      fs.readFileSync(path.join(tmp, "learned-patterns.json"), "utf8"),
    );
    expect(learned.length).toBe(1);
  });

  test("no temp files left behind on success", () => {
    fs.writeFileSync(path.join(tmp, "learned-patterns.json"), JSON.stringify([]));
    fs.writeFileSync(
      path.join(tmp, "pending-patterns.jsonl"),
      JSON.stringify(sampleProposal("F1", "X")) + "\n",
    );
    promoteProposals(
      [sampleProposal("F1", "X")],
      [],
      { skillFaultsDir: tmp },
    );
    const stray = fs
      .readdirSync(tmp)
      .filter((n) => n.includes(".tmp."));
    expect(stray.length).toBe(0);
  });
});

describe("autoPromoteDecision", () => {
  test("HIGH+ proposals → promote, MEDIUM → defer", () => {
    const proposals = [
      sampleProposal("F1", "A", "x", "CRITICAL"),
      sampleProposal("F2", "B", "y", "HIGH"),
      sampleProposal("F3", "C", "z", "MEDIUM"),
    ];
    const { promote, defer } = autoPromoteDecision(proposals);
    expect(promote.map((p) => p.proposal.category)).toEqual(["A", "B"]);
    expect(defer.map((p) => p.proposal.category)).toEqual(["C"]);
  });

  test("empty input → empty outputs", () => {
    const { promote, defer } = autoPromoteDecision([]);
    expect(promote.length).toBe(0);
    expect(defer.length).toBe(0);
  });
});
