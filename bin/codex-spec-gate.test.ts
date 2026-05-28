import { describe, it, expect } from "bun:test";
import { scanForSecrets, runGate } from "./codex-spec-gate";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("scanForSecrets", () => {
  it("detects AWS access key", () => {
    const m = scanForSecrets(
      "foo\naws_access_key_id=AKIAIOSFODNN7EXAMPLE\nbar",
    );
    expect(m).not.toBeNull();
    expect(m?.name).toBe("aws_access_key");
    expect(m?.line).toBe(2);
  });

  it("detects GitHub token", () => {
    const m = scanForSecrets(
      "token: ghp_abcdefghij1234567890abcdefghij1234567890",
    );
    expect(m?.name).toBe("github_token");
  });

  it("detects Anthropic key", () => {
    const m = scanForSecrets(
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij1234567890",
    );
    expect(m?.name).toBe("anthropic_key");
  });

  it("returns null on clean text", () => {
    expect(
      scanForSecrets("just a normal spec\nwith file refs `src/foo.ts:42`"),
    ).toBeNull();
  });

  it("returns null on similar-but-not-matching strings", () => {
    expect(
      scanForSecrets("AKIA looks like a key but isn't full length"),
    ).toBeNull();
  });

  it("detects modern sk-proj-* OpenAI project key", () => {
    const m = scanForSecrets(
      "API key: sk-proj-abcdefghij1234567890ABCDEFGHIJ_-",
    );
    expect(m?.name).toBe("openai_project_key");
  });
});

describe("runGate (without codex)", () => {
  it("blocks when secret pattern matches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csg-"));
    const p = path.join(dir, "spec.md");
    fs.writeFileSync(
      p,
      "## Spec\n\nAWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n",
    );
    const result = runGate(p);
    expect(result.blocked).toBe(true);
    expect(result.blocked_reason).toMatch(/aws_access_key/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns read_error for missing file", () => {
    const result = runGate("/tmp/does-not-exist-csg-12345.md");
    expect(result.blocked).toBe(true);
    expect(result.blocked_reason).toMatch(/read_error/);
  });
});
