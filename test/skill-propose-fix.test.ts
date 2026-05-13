import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const PROPOSE_SCRIPT = join(process.cwd(), "bin", "gstack-skill-propose-fix");
const LEARNED_FAULTS_SCRIPT = join(
  process.cwd(),
  "bin",
  "gstack-skill-learned-faults",
);

function makeTmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "gstack-pfix-"));
  mkdirSync(join(dir, "skill-faults", "fix-proposals"), { recursive: true });
  return dir;
}

function writeReport(
  faultDir: string,
  runId: string,
  category: string,
  content: string,
): void {
  writeFileSync(
    join(faultDir, `skill-fault-${runId}-${category}.md`),
    content,
    "utf8",
  );
}

function writePatterns(faultDir: string, patterns: object[]): void {
  writeFileSync(
    join(faultDir, "learned-patterns.json"),
    JSON.stringify(patterns, null, 2),
    "utf8",
  );
}

const PATTERN = {
  category: "MISSING_ENV_VAR",
  severity: "HIGH",
  description: "Missing environment variable",
  matcherKind: "stdout_contains",
  pattern: "env var not set",
  source: "investigator:skill-fault-discovery-abc.md",
  learnedAt: "2026-05-01T14:22:00Z",
  hitCount: 3,
};

describe("gstack-skill-propose-fix", () => {
  test("no args → usage message and non-zero exit", () => {
    const dir = makeTmpHome();
    try {
      const r = spawnSync(PROPOSE_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).not.toBe(0);
      expect((r.stderr ?? "") + (r.stdout ?? "")).toMatch(/[Uu]sage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("category with no reports → error on stderr and non-zero exit", () => {
    const dir = makeTmpHome();
    try {
      const r = spawnSync(PROPOSE_SCRIPT, ["MISSING_CAT"], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(
        "No investigation reports found for category: MISSING_CAT",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("category with matching report → output path printed and exit 0", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    try {
      writeReport(
        faultDir,
        "run123",
        "TEST_FIXER_LOOP",
        "# Investigation\nLoop did not converge.",
      );
      const r = spawnSync(PROPOSE_SCRIPT, ["TEST_FIXER_LOOP"], {
        env: {
          ...process.env,
          GSTACK_HOME: dir,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: "true",
        },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Fix proposer spawned for TEST_FIXER_LOOP");
      expect(r.stdout).toContain("fix-proposals/TEST_FIXER_LOOP-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--all with 2 categories, 1 already proposed → spawns only 1", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writeReport(faultDir, "run1", "CAT_A", "Investigation A");
      writeReport(faultDir, "run2", "CAT_B", "Investigation B");
      writeFileSync(
        join(proposalsDir, "CAT_B-20260101T000000Z.md"),
        "existing",
        "utf8",
      );

      const r = spawnSync(PROPOSE_SCRIPT, ["--all"], {
        env: {
          ...process.env,
          GSTACK_HOME: dir,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: "true",
        },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("CAT_A");
      expect(r.stdout).not.toContain("CAT_B");
      expect(r.stdout).toContain("1 fix proposer(s) spawned in background.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--all with all categories already proposed → no unfixed found", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writeReport(faultDir, "run1", "CAT_A", "Investigation A");
      writeFileSync(
        join(proposalsDir, "CAT_A-20260101T000000Z.md"),
        "existing",
        "utf8",
      );

      const r = spawnSync(PROPOSE_SCRIPT, ["--all"], {
        env: {
          ...process.env,
          GSTACK_HOME: dir,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: "true",
        },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("No unfixed categories found.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gstack-skill-learned-faults FIX column", () => {
  test("no proposal file → FIX column shows —", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    try {
      writePatterns(faultDir, [PATTERN]);
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/MISSING_ENV_VAR.*—/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("proposal file exists, no .applied → FIX shows proposed", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writePatterns(faultDir, [PATTERN]);
      writeFileSync(
        join(proposalsDir, "MISSING_ENV_VAR-20260501T000000Z.md"),
        "proposal",
        "utf8",
      );
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/MISSING_ENV_VAR.*proposed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".applied marker present → FIX shows applied", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    const proposalsDir = join(faultDir, "fix-proposals");
    try {
      writePatterns(faultDir, [PATTERN]);
      writeFileSync(
        join(proposalsDir, "MISSING_ENV_VAR-20260501T000000Z.md"),
        "proposal",
        "utf8",
      );
      writeFileSync(
        join(proposalsDir, "MISSING_ENV_VAR-20260501T000000Z.md.applied"),
        "",
        "utf8",
      );
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/MISSING_ENV_VAR.*applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("footer includes propose-fix --all hint", () => {
    const dir = makeTmpHome();
    const faultDir = join(dir, "skill-faults");
    try {
      writePatterns(faultDir, [PATTERN]);
      const r = spawnSync(LEARNED_FAULTS_SCRIPT, [], {
        env: { ...process.env, GSTACK_HOME: dir },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("gstack skill:propose-fix --all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
