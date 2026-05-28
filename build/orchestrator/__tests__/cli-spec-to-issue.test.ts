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
