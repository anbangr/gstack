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
