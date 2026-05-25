import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const TMPL = path.join(ROOT, "build/SKILL.md.tmpl");
const GENERATED = path.join(ROOT, "build/SKILL.md");

const ANCHOR = "Co-located tests for `package main` shims";
const FAILURE_MODE_REFERENCE = "Gemini could not produce failing tests";
const CONCRETE_EXAMPLE = "experiments/e1/cmd/polis-step";

describe("build synthesizer prompt: package-main co-located testCmd hint", () => {
  test("SKILL.md.tmpl contains the package-main co-location bullet", () => {
    const tmpl = fs.readFileSync(TMPL, "utf-8");
    expect(tmpl).toContain(ANCHOR);
    expect(tmpl).toContain(FAILURE_MODE_REFERENCE);
    expect(tmpl).toContain(CONCRETE_EXAMPLE);
  });

  test("generated SKILL.md preserves the package-main co-location bullet", () => {
    const md = fs.readFileSync(GENERATED, "utf-8");
    expect(md).toContain(ANCHOR);
    expect(md).toContain(FAILURE_MODE_REFERENCE);
    expect(md).toContain(CONCRETE_EXAMPLE);
  });

  test("bullet sits inside the plan-synthesizer prompt section", () => {
    const tmpl = fs.readFileSync(TMPL, "utf-8");
    const synthesizerIdx = tmpl.indexOf("Polyglot repo test-runner hint");
    expect(synthesizerIdx).toBeGreaterThan(0);
    const anchorIdx = tmpl.indexOf(ANCHOR);
    expect(anchorIdx).toBeGreaterThan(synthesizerIdx);
    const nextSectionIdx = tmpl.indexOf(
      "Non-Coding Phase Templates",
      anchorIdx,
    );
    expect(nextSectionIdx).toBeGreaterThan(anchorIdx);
  });

  test("bullet pins the unioned go-test command shape", () => {
    const tmpl = fs.readFileSync(TMPL, "utf-8");
    expect(tmpl).toMatch(
      /MUST include the binary's directory in the path list/,
    );
    expect(tmpl).toMatch(
      /go test \.\/experiments\/e1\/cmd\/polis-step\/\.\.\. \.\/test\/unit\/polisstep\/\.\.\./,
    );
  });

  test("bullet does not push Gemini toward Python/Rust path-union over-generalization", () => {
    const tmpl = fs.readFileSync(TMPL, "utf-8");
    const anchorIdx = tmpl.indexOf(ANCHOR);
    const nextSectionIdx = tmpl.indexOf(
      "Non-Coding Phase Templates",
      anchorIdx,
    );
    const bulletText = tmpl.slice(anchorIdx, nextSectionIdx);
    expect(bulletText).toMatch(/do not generalize/i);
    expect(bulletText).toMatch(/Python/);
    expect(bulletText).toMatch(/Rust/);
  });
});
