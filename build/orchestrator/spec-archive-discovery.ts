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
