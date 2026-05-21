import { describe, it, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  flipCheckbox,
  flipPhaseCheckboxes,
  setCheckboxState,
  setCheckboxStatusNote,
  unflipPhaseCheckboxes,
  _testWritePlan,
} from "../plan-mutator";

/** Insert lines before 1-based lineNumber, shifting everything down. */
function insertBefore(content: string, lineNumber: number, text: string): string {
  const lines = content.split(/\r?\n/);
  const newLines = text.split(/\r?\n/);
  lines.splice(lineNumber - 1, 0, ...newLines);
  const trailing = content.endsWith("\n") ? "\n" : "";
  return lines.join("\n") + trailing;
}

describe("plan-mutator re-parse on stale line numbers", () => {
  // ---------------------------------------------------------------------------
  // T1: Externally-edited plan with shifted lines
  // ---------------------------------------------------------------------------
  it("T1: re-parses and flips at the new line after external edit shifts lines", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Schema
- [ ] **Implementation**: do the work
- [ ] **Review**: review the work
`;
    const p = _testWritePlan(md);
    // Insert a comment between heading and checkbox; old line 3 becomes line 4
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3, // stale — now points to the inserted comment
      expectedMarker: "**Implementation",
    });

    // Should re-parse, locate the checkbox at its new line, and flip.
    expect(r.flipped).toBe(true);
    expect(r.error).toBeUndefined();
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after[3]).toBe("- [x] **Implementation**: do the work");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("T1: uses phase identity when inserted lines move the stale line above the target phase", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: First
- [ ] **Implementation**: first work
- [ ] **Review**: first review

### Phase 1.2: Target
- [ ] **Implementation**: target work
- [ ] **Review**: target review
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(
      fs.readFileSync(p, "utf8"),
      6,
      "<!-- inserted above target phase -->\n<!-- still above target phase -->",
    );
    fs.writeFileSync(p, edited);

    const r = flipPhaseCheckboxes({
      planFile: p,
      implementationLine: 7,
      reviewLine: 8,
      kind: "code",
      phase: {
        featureNumber: "1",
        number: "1.2",
        name: "Target",
      },
    });

    expect(r.implementation.error).toBeUndefined();
    expect(r.review.error).toBeUndefined();
    expect(r.implementation.flipped).toBe(true);
    expect(r.review.flipped).toBe(true);
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after).toContain("- [ ] **Implementation**: first work");
    expect(after).toContain("- [ ] **Review**: first review");
    expect(after).toContain("- [x] **Implementation**: target work");
    expect(after).toContain("- [x] **Review**: target review");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // T2: Genuinely deleted marker
  // ---------------------------------------------------------------------------
  it("T2: returns an error when the marker checkbox is genuinely deleted", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Schema
- [ ] **Implementation**: do the work
- [ ] **Review**: review the work
`;
    const p = _testWritePlan(md);
    // Remove the implementation checkbox entirely
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    lines.splice(2, 1); // delete line 3 (0-based index 2)
    fs.writeFileSync(p, lines.join("\n") + "\n");

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(false);
    expect(r.error).toBeDefined();
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // T4: Atomic write rollback
  // ---------------------------------------------------------------------------
  it("T4: leaves original plan unchanged when atomic write fails after re-parse", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Schema
- [ ] **Implementation**: do the work
- [ ] **Review**: review the work
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);
    const original = fs.readFileSync(p, "utf8");

    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      const e = new Error("ENOSPC: no space left on device") as any;
      e.code = "ENOSPC";
      throw e;
    });

    let thrown: any;
    try {
      flipCheckbox({
        planFile: p,
        lineNumber: 3,
        expectedMarker: "**Implementation",
      });
    } catch (e) {
      thrown = e;
    } finally {
      renameSpy.mockRestore();
    }

    // After implementation the re-parse path attempts an atomic write;
    // when rename fails the error should be the write failure, not the
    // stale-line "edited externally" message.
    expect(thrown).toBeDefined();
    expect(thrown.message).toContain("ENOSPC");

    const after = fs.readFileSync(p, "utf8");
    expect(after).toBe(original);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // T5: Three call sites covered
  // ---------------------------------------------------------------------------
  describe("T5: all three call sites re-parse identically on stale lines", () => {
    it("setCheckboxState re-parses and flips", () => {
      const md = `### Phase 1.1: Foo
- [ ] **Implementation**: work
`;
      const p = _testWritePlan(md);
      const edited = insertBefore(fs.readFileSync(p, "utf8"), 2, "<!-- shift -->");
      fs.writeFileSync(p, edited);

      const r = setCheckboxState({
        planFile: p,
        lineNumber: 2,
        checked: true,
        expectedMarker: "**Implementation",
      });

      expect(r.flipped).toBe(true);
      expect(r.error).toBeUndefined();
      fs.rmSync(path.dirname(p), { recursive: true });
    });

    it("setCheckboxStatusNote re-parses and updates", () => {
      const md = `### Phase 1.1: Foo
- [ ] **Test Specification**: spec
`;
      const p = _testWritePlan(md);
      const edited = insertBefore(fs.readFileSync(p, "utf8"), 2, "<!-- shift -->");
      fs.writeFileSync(p, edited);

      const r = setCheckboxStatusNote({
        planFile: p,
        lineNumber: 2,
        expectedMarker: "**Test Specification",
        note: "running",
      });

      expect(r.updated).toBe(true);
      expect(r.error).toBeUndefined();
      fs.rmSync(path.dirname(p), { recursive: true });
    });

    it("unflipPhaseCheckboxes re-parses and unflips all targets", () => {
      const md = `### Phase 1.1: Foo
- [x] **Implementation**: work
- [x] **Review**: rev
`;
      const p = _testWritePlan(md);
      const edited = insertBefore(fs.readFileSync(p, "utf8"), 2, "<!-- shift -->");
      fs.writeFileSync(p, edited);

      const r = unflipPhaseCheckboxes(p, {
        testSpecCheckboxLine: -1,
        implementationCheckboxLine: 2,
        reviewCheckboxLine: 3,
        kind: "code",
      } as any);

      expect(r.unflipped).toBe(2);
      expect(r.errors).toHaveLength(0);
      fs.rmSync(path.dirname(p), { recursive: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Edge: Phase numbering jumps (Phase 1, Phase 3)
  // ---------------------------------------------------------------------------
  it("handles non-sequential phase numbering when re-parsing", () => {
    const md = `## Feature 1: Auth
### Phase 3.1: Schema
- [ ] **Implementation**: work
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- shift -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("matches parser-supported phase ids with subletters, review suffixes, and kind brackets", () => {
    const md = `## Feature 1.2: Auth
### Phase 2.1a [code]: Sublettered
- [ ] **Implementation**: first
- [ ] **Review**: first review

### Phase 2.review-1 [code]: Reviewer Follow-up
- [ ] **Implementation**: follow-up
- [ ] **Review**: follow-up review
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 6, "<!-- shift -->");
    fs.writeFileSync(p, edited);

    const r = flipPhaseCheckboxes({
      planFile: p,
      implementationLine: 7,
      reviewLine: 8,
      kind: "code",
      phase: {
        featureNumber: "1.2",
        number: "2.review-1",
        name: "Reviewer Follow-up",
      },
    });

    expect(r.implementation.error).toBeUndefined();
    expect(r.review.error).toBeUndefined();
    expect(r.implementation.flipped).toBe(true);
    expect(r.review.flipped).toBe(true);
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after).toContain("- [ ] **Implementation**: first");
    expect(after).toContain("- [x] **Implementation**: follow-up");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: Same phase number with different names is not a duplicate
  // ---------------------------------------------------------------------------
  it("succeeds when two phases share a number but have different names", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Foo
- [ ] **Implementation**: work

### Phase 1.1: Bar
- [ ] **Implementation**: work2
`;
    const p = _testWritePlan(md);
    // Shift the first phase only
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- shift -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(true);
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    const flipped = after.filter((l) => l.includes("[x] **Implementation"));
    expect(flipped).toHaveLength(1);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: Re-parse reads from disk, not a stale in-memory buffer
  // ---------------------------------------------------------------------------
  it("reads fresh content from disk for re-parse, not stale memory", () => {
    const md = `### Phase 1.1: Foo
- [ ] **Implementation**: work
`;
    const p = _testWritePlan(md);
    // Simulate that the caller has a stale in-memory view
    const stale = fs.readFileSync(p, "utf8");
    // Meanwhile, an external editor writes new content
    const edited = insertBefore(stale, 2, "<!-- shift -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 2,
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});
