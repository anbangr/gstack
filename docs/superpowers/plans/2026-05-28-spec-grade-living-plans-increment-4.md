# Spec-Grade Living Plans — Increment 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Wire cross-skill integration so `/build` can SKIP Phase A spec drafting when the source plan already references existing `/spec` archives (or matching ones can be auto-detected by `spec_id`), and add a one-command CLI for promoting any `/build`-generated spec into a GitHub issue.

**Architecture:** Additive only. No behavior change to Phase B / synthesizer / validator. Phase 0 outline gains a detection step that, per feature, populates `existing_spec_path` when a match is found. Phase A consumes that field and skips drafting+gate for matched features. New subcommand `gstack-build spec-to-issue <path>` reads any spec archive and calls `gh issue create --body-file <path>`, then updates the archive's frontmatter with the new issue number.

**Tech Stack:** TypeScript / Bun; `gh` CLI; existing `bin/gstack-build`.

---

## Scope and out-of-scope

**In scope (Increment 4):**

- Helper `discoverSpecArchives(targetSlug, opts)` that scans `~/.gstack/projects/<slug>/specs/` and returns sentineled archives within 30 days
- Phase 0 outline gains explicit-reference detection (`spec_archives:` in source-plan frontmatter) + auto-match by `spec_id` slug
- Phase A skips draft + gate for features with `existing_spec_path` set
- New `gstack-build spec-to-issue <archive-path>` subcommand
- SKILL template note describing both flows
- Version bump

**Out of scope:**

- Per-feature spec versioning
- Cross-skill cache for verified-current-state
- Subjective-review role
- Modifications to validator (no new checks — only the synthesizer's input changes)

## File structure

```text
build/
  configure.cm                                # unchanged
  SKILL.md.tmpl                               # MODIFY — Phase 0 detection logic; Phase A skip note
  SKILL.md                                    # REGENERATE
  orchestrator/
    spec-archive-discovery.ts                 # NEW — scan archives, match by spec_id
    cli.ts                                    # MODIFY — add spec-to-issue subcommand
    __tests__/
      spec-archive-discovery.test.ts          # NEW — covers discovery + match rules
      cli-spec-to-issue.test.ts               # NEW — covers promotion command
```

---

## Task 1: spec-archive-discovery helper

**Files:**

- Create: `build/orchestrator/spec-archive-discovery.ts`
- Create: `build/orchestrator/__tests__/spec-archive-discovery.test.ts`

### Step 1: Create the helper

```typescript
#!/usr/bin/env bun
/**
 * Discover existing spec archives that match features being planned
 * for /build. Two detection modes:
 *   1. Explicit: caller passes a list of paths from the source-plan
 *      `spec_archives:` frontmatter; we verify each path exists and
 *      has the sentinel.
 *   2. Auto-match: scan ~/.gstack/projects/<slug>/specs/ for files
 *      whose frontmatter spec_id matches the requested slug, written
 *      within the last 30 days, and ending with the sentinel.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SENTINEL = "<!-- gstack-spec-complete";
const MAX_AGE_DAYS = 30;

export interface SpecArchiveCandidate {
  path: string;
  spec_id: string;
  spec_filed_at?: string;
  feature_number?: number;
}

export interface DiscoverOpts {
  projectSlug: string;
  /** Override for tests; defaults to ~/.gstack */
  gstackHome?: string;
  /** Override max-age in days; defaults to 30 */
  maxAgeDays?: number;
}

function readFrontmatter(filePath: string): Record<string, string> | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.includes(SENTINEL)) return null;
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const out: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  } catch {
    return null;
  }
}

export function explicitArchives(paths: string[]): SpecArchiveCandidate[] {
  const out: SpecArchiveCandidate[] = [];
  for (const p of paths) {
    const fm = readFrontmatter(p);
    if (!fm) continue;
    out.push({
      path: p,
      spec_id: fm.spec_id ?? "",
      spec_filed_at: fm.spec_filed_at,
      feature_number: fm.feature_number ? Number(fm.feature_number) : undefined,
    });
  }
  return out;
}

export function discoverArchives(opts: DiscoverOpts): SpecArchiveCandidate[] {
  const home = opts.gstackHome ?? path.join(os.homedir(), ".gstack");
  const specDir = path.join(home, "projects", opts.projectSlug, "specs");
  if (!fs.existsSync(specDir)) return [];
  const maxAgeMs = (opts.maxAgeDays ?? MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const out: SpecArchiveCandidate[] = [];
  for (const name of fs.readdirSync(specDir)) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(specDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > maxAgeMs) continue;
    const fm = readFrontmatter(full);
    if (!fm || !fm.spec_id) continue;
    out.push({
      path: full,
      spec_id: fm.spec_id,
      spec_filed_at: fm.spec_filed_at,
      feature_number: fm.feature_number ? Number(fm.feature_number) : undefined,
    });
  }
  return out;
}

export function matchBySpecId(
  candidates: SpecArchiveCandidate[],
  targetSpecId: string,
): SpecArchiveCandidate | null {
  const match = candidates.find((c) => c.spec_id === targetSpecId);
  return match ?? null;
}

if (import.meta.main) {
  const slug = process.argv[2];
  if (!slug) {
    process.stderr.write(
      "usage: spec-archive-discovery.ts <project-slug> [spec-id]\n",
    );
    process.exit(1);
  }
  const targetSpecId = process.argv[3];
  const candidates = discoverArchives({ projectSlug: slug });
  if (targetSpecId) {
    const m = matchBySpecId(candidates, targetSpecId);
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    process.exit(m ? 0 : 1);
  }
  process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
}
```

### Step 2: Create tests

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverArchives,
  explicitArchives,
  matchBySpecId,
} from "../spec-archive-discovery";

describe("spec-archive-discovery", () => {
  let tmpHome: string;
  let specDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sad-"));
    specDir = path.join(tmpHome, "projects", "test-slug", "specs");
    fs.mkdirSync(specDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeSpec(
    name: string,
    frontmatter: string,
    withSentinel = true,
  ): string {
    const p = path.join(specDir, name);
    const body = `---\n${frontmatter}\n---\n\n# Spec body\n\n${
      withSentinel ? "<!-- gstack-spec-complete\nts: now\n-->\n" : ""
    }`;
    fs.writeFileSync(p, body);
    return p;
  }

  it("discoverArchives finds sentineled specs in the project specs dir", () => {
    writeSpec("a.md", "spec_id: foo\nfeature_number: 1");
    writeSpec("b.md", "spec_id: bar\nfeature_number: 2");
    const out = discoverArchives({
      projectSlug: "test-slug",
      gstackHome: tmpHome,
    });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.spec_id).sort()).toEqual(["bar", "foo"]);
  });

  it("discoverArchives skips files missing the sentinel", () => {
    writeSpec("a.md", "spec_id: foo", false);
    const out = discoverArchives({
      projectSlug: "test-slug",
      gstackHome: tmpHome,
    });
    expect(out).toHaveLength(0);
  });

  it("discoverArchives skips files older than maxAgeDays", () => {
    const p = writeSpec("old.md", "spec_id: stale");
    const oldTime = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(p, oldTime, oldTime);
    const out = discoverArchives({
      projectSlug: "test-slug",
      gstackHome: tmpHome,
      maxAgeDays: 30,
    });
    expect(out).toHaveLength(0);
  });

  it("matchBySpecId returns the matching candidate", () => {
    writeSpec("a.md", "spec_id: order-expiry");
    writeSpec("b.md", "spec_id: order-refund");
    const all = discoverArchives({
      projectSlug: "test-slug",
      gstackHome: tmpHome,
    });
    const match = matchBySpecId(all, "order-expiry");
    expect(match?.spec_id).toBe("order-expiry");
  });

  it("matchBySpecId returns null on no match", () => {
    writeSpec("a.md", "spec_id: foo");
    const all = discoverArchives({
      projectSlug: "test-slug",
      gstackHome: tmpHome,
    });
    expect(matchBySpecId(all, "bar")).toBeNull();
  });

  it("explicitArchives reads frontmatter from explicit paths", () => {
    const p = writeSpec("x.md", "spec_id: explicit-one");
    const out = explicitArchives([p]);
    expect(out).toHaveLength(1);
    expect(out[0].spec_id).toBe("explicit-one");
  });

  it("explicitArchives ignores paths without sentinel", () => {
    const p = writeSpec("y.md", "spec_id: nope", false);
    expect(explicitArchives([p])).toHaveLength(0);
  });

  it("explicitArchives silently skips missing files", () => {
    const out = explicitArchives([
      path.join(tmpHome, "nope-does-not-exist.md"),
    ]);
    expect(out).toHaveLength(0);
  });
});
```

### Step 3: Run + commit

```bash
bun test build/orchestrator/__tests__/spec-archive-discovery.test.ts
```

Expected: 8/8 pass.

```bash
git add build/orchestrator/spec-archive-discovery.ts build/orchestrator/__tests__/spec-archive-discovery.test.ts
git commit -m "feat(build/orchestrator): add spec-archive discovery + spec_id matching (Increment 4)"
```

---

## Task 2: `gstack-build spec-to-issue` subcommand

**File:** `build/orchestrator/cli.ts`

### Step 1: Add the subcommand

Find the CLI dispatch (grep for `'merge'`, `'monitor'`, `'plan-status'` to see the subcommand pattern). Add a new `spec-to-issue` case:

```typescript
if (cmd === "spec-to-issue") {
  const archivePath = process.argv[3];
  if (!archivePath) {
    process.stderr.write("usage: gstack-build spec-to-issue <archive-path>\n");
    process.exit(2);
  }
  await runSpecToIssue(archivePath);
  return;
}
```

Then implement `runSpecToIssue`:

```typescript
async function runSpecToIssue(archivePath: string): Promise<void> {
  if (!fs.existsSync(archivePath)) {
    process.stderr.write(`spec archive not found: ${archivePath}\n`);
    process.exit(2);
  }
  const content = fs.readFileSync(archivePath, "utf8");
  if (!content.includes("<!-- gstack-spec-complete")) {
    process.stderr.write(
      `spec archive missing <!-- gstack-spec-complete --> sentinel: ${archivePath}\n` +
        `Refusing to promote a work-in-progress spec.\n`,
    );
    process.exit(2);
  }
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    process.stderr.write(`spec archive lacks frontmatter: ${archivePath}\n`);
    process.exit(2);
  }
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (fm.spec_issue_number && fm.spec_issue_number !== "null") {
    process.stderr.write(
      `spec already filed as issue #${fm.spec_issue_number} (per frontmatter).\n` +
        `Refusing to file a duplicate.\n`,
    );
    process.exit(0);
  }
  // Read body (everything after the frontmatter) and prepend a promoted-from note.
  const body = fmMatch[2];
  const promotionNote = `> Promoted from /build-generated spec at \`${archivePath}\`.\n\n`;
  const issueBody = promotionNote + body;
  const title = (fm.spec_id || path.basename(archivePath, ".md"))
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const tmpBody = archivePath + ".issue-body.tmp";
  fs.writeFileSync(tmpBody, issueBody);
  try {
    const result = spawnSync(
      "gh",
      ["issue", "create", "--title", title, "--body-file", tmpBody],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      process.stderr.write(
        `gh issue create failed: ${result.stderr || result.stdout}\n`,
      );
      process.exit(1);
    }
    const urlMatch = (result.stdout || "").match(
      /https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/,
    );
    if (!urlMatch) {
      process.stderr.write(
        `gh issue create succeeded but couldn't parse issue number from: ${result.stdout}\n`,
      );
      process.exit(1);
    }
    const issueNumber = urlMatch[1];
    // Update the archive's frontmatter (atomic write).
    const updated = content.replace(
      /^spec_issue_number:\s*.+$/m,
      `spec_issue_number: ${issueNumber}`,
    );
    const tmpArchive = archivePath + ".tmp." + process.pid;
    fs.writeFileSync(tmpArchive, updated);
    fs.renameSync(tmpArchive, archivePath);
    process.stdout.write(`${urlMatch[0]}\n`);
  } finally {
    try {
      fs.unlinkSync(tmpBody);
    } catch {
      /* best-effort */
    }
  }
}
```

### Step 2: Add a unit test

`build/orchestrator/__tests__/cli-spec-to-issue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(__dirname, "..", "cli.ts");

describe("gstack-build spec-to-issue", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sti-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses an archive missing the sentinel", () => {
    const p = path.join(tmpDir, "spec.md");
    fs.writeFileSync(
      p,
      "---\nspec_id: foo\nspec_issue_number: null\n---\n\nBody without sentinel.\n",
    );
    const r = spawnSync("bun", ["run", CLI, "spec-to-issue", p], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sentinel/i);
  });

  it("refuses an archive that's already filed", () => {
    const p = path.join(tmpDir, "spec.md");
    fs.writeFileSync(
      p,
      "---\nspec_id: foo\nspec_issue_number: 42\n---\n\nBody\n\n<!-- gstack-spec-complete\nts: now\n-->\n",
    );
    const r = spawnSync("bun", ["run", CLI, "spec-to-issue", p], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/already filed/i);
  });

  it("refuses a missing path", () => {
    const r = spawnSync(
      "bun",
      ["run", CLI, "spec-to-issue", "/tmp/does-not-exist-sti.md"],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not found/i);
  });
});
```

(We can't easily test the actual `gh issue create` path without a real GitHub repo + auth. The three guard cases above are the parts most likely to regress.)

### Step 3: Run + commit

```bash
bun test build/orchestrator/__tests__/cli-spec-to-issue.test.ts
```

Expected: 3/3 pass.

```bash
git add build/orchestrator/cli.ts build/orchestrator/__tests__/cli-spec-to-issue.test.ts
git commit -m "feat(build/orchestrator): add gstack-build spec-to-issue <path> promotion subcommand"
```

---

## Task 3: SKILL template notes

**File:** `build/SKILL.md.tmpl`

### Step 1: Phase 0 detection note

In the Phase 0 section (Step 4.5), after the outline JSON example, append:

```markdown
**Cross-skill spec-archive detection (Increment 4+):** Phase 0 also detects
whether each outlined feature has a matching `/spec`-generated archive on
disk. Two modes:

1.  **Explicit:** If the source plan's YAML frontmatter contains
    `spec_archives: [/abs/path/1.md, /abs/path/2.md, ...]`, each path is
    validated (must exist + sentinel) and matched to a feature whose
    `spec_id` equals the archive's frontmatter `spec_id`.
2.  **Auto-match:** For features without an explicit reference, scan
    `~/.gstack/projects/<slug>/specs/` for sentineled archives written
    within the last 30 days whose `spec_id` exactly matches the feature's
    derived `spec_id` slug.

When a match is found, attach `existing_spec_path: <absolute path>` to that
feature's outline entry. The match is exact (not fuzzy) — no partial-slug
guessing.

Failures (path not found, missing sentinel, no match): silently skip; the
feature falls through to Phase A as usual.
```

### Step 2: Phase A skip note

In the Phase A section (Step 4.6), near step 1 ("Draft the enriched spec inline"), prepend:

```markdown
**Skip drafting when an existing spec archive matches (Increment 4+):**
If the feature's outline entry has `existing_spec_path: <path>`, the parent
SKIPS drafting AND the codex gate for this feature. Instead, the existing
archive is treated as if Phase A had just produced it: the parent records
the feature's spec record in `$BUILD_TMP_DIR/phase-a-specs.json` with
`spec_path` = `existing_spec_path`, `quality_score` read from the archive's
frontmatter, and `interrogation: "reused"`. No new sentinel is appended
(the existing one is preserved). Phase B reads the archive normally.
```

### Step 3: spec-to-issue subcommand note

Find a good home for documenting subcommands (likely near where merge/monitor/plan-status are described). Add:

```markdown
**`gstack-build spec-to-issue <archive-path>` (Increment 4+):** Promote any
`/build`-generated spec archive into a GitHub issue. Reads the sentineled
archive, prepends a `Promoted from /build-generated spec at <path>` note,
calls `gh issue create --body-file`, then updates the archive's frontmatter
with the new `spec_issue_number`. Refuses to promote: missing sentinel,
already-filed (`spec_issue_number` set), or missing path.
```

### Step 4: Version bump + regen

Bump `version: 1.33.0` → `1.34.0`.

```bash
bun run gen:skill-docs
bun test test/gen-skill-docs.test.ts 2>&1 | tail -3
```

### Step 5: Commit

```bash
git add build/SKILL.md.tmpl build/SKILL.md
git commit -m "feat(build): document Phase 0 spec-archive detection + Phase A skip + spec-to-issue; bump to 1.34.0"
```

---

## Task 4: full test pass

```bash
bun test 2>&1 | tail -5
```

EXIT 0 expected. Pre-existing failures unrelated to Increment 4 are acceptable (note them).

---

## What comes next

After Increment 4 lands, the full spec-grade living plans design is shipped. Follow-ups (out of scope):

- Per-feature spec versioning
- Cross-skill cache for verified-current-state lookups
- Subjective-review role
- Spec-quality dashboard in /retro
