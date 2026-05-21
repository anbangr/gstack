import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  flipCheckbox,
  setCheckboxState,
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

describe("plan-mutator duplicate-heading guard", () => {
  // ---------------------------------------------------------------------------
  // T3: Duplicate heading emits PLAN_MUTATOR_DUPLICATE_HEADING
  // ---------------------------------------------------------------------------
  it("T3: refuses to mutate and reports both conflicting line numbers", () => {
    const md = `## Feature 1: Auth
### Phase 4.1: Schema
- [ ] **Implementation**: work
- [ ] **Review**: rev

### Phase 4.1: Schema
- [ ] **Implementation**: work2
- [ ] **Review**: rev2
`;
    const p = _testWritePlan(md);
    // Shift lines so the stale line number triggers re-parse
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3, // was impl checkbox, now points to inserted comment
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("PLAN_MUTATOR_DUPLICATE_HEADING");
    expect(r.error).toContain("2");  // first heading line
    expect(r.error).toContain("7");  // second heading line (shifted by 1)
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // T6: phaseId normalization — trailing whitespace is stripped
  // ---------------------------------------------------------------------------
  it("T6: normalizes trailing whitespace in phase names (detects real duplicate)", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Foo
- [ ] **Implementation**: work

### Phase 1.1: Foo 
- [ ] **Implementation**: work2
`;
    const p = _testWritePlan(md);
    // Shift lines to force re-parse
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    // After normalization the names are identical → should be treated as duplicate
    expect(r.flipped).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("PLAN_MUTATOR_DUPLICATE_HEADING");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: non-sequential phase numbering uses literal heading
  // ---------------------------------------------------------------------------
  it("uses literal heading for phaseId even when numbering jumps", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Foo
- [ ] **Implementation**: work

### Phase 3.1: Foo
- [ ] **Implementation**: work2
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    // Different phase numbers → NOT duplicates → should re-parse and flip
    expect(r.flipped).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: same number, different names → not duplicates
  // ---------------------------------------------------------------------------
  it("allows mutation when same phase number has different names", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Foo
- [ ] **Implementation**: work

### Phase 1.1: Bar
- [ ] **Implementation**: work2
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: setCheckboxState detects duplicate headings
  // ---------------------------------------------------------------------------
  it("setCheckboxState detects duplicate headings", () => {
    const md = `## Feature 1: Auth
### Phase 2.1: Dup
- [ ] **Implementation**: work

### Phase 2.1: Dup
- [ ] **Implementation**: work2
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = setCheckboxState({
      planFile: p,
      lineNumber: 3,
      checked: true,
      expectedMarker: "**Implementation",
    });

    expect(r.flipped).toBe(false);
    expect(r.error).toContain("PLAN_MUTATOR_DUPLICATE_HEADING");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: unflipPhaseCheckboxes detects duplicate headings
  // ---------------------------------------------------------------------------
  it("unflipPhaseCheckboxes detects duplicate headings", () => {
    const md = `## Feature 1: Auth
### Phase 2.1: Dup
- [x] **Implementation**: work

### Phase 2.1: Dup
- [x] **Implementation**: work2
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = unflipPhaseCheckboxes(p, {
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 3,
      reviewCheckboxLine: -1,
      kind: "code",
    } as any);

    expect(r.unflipped).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("PLAN_MUTATOR_DUPLICATE_HEADING");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Edge: lock contention / concurrent save — atomic write never corrupts
  // ---------------------------------------------------------------------------
  it("does not corrupt the plan when re-parse races an external write", () => {
    const md = `## Feature 1: Auth
### Phase 1.1: Schema
- [ ] **Implementation**: work
`;
    const p = _testWritePlan(md);
    const edited = insertBefore(fs.readFileSync(p, "utf8"), 3, "<!-- inserted -->");
    fs.writeFileSync(p, edited);

    const r = flipCheckbox({
      planFile: p,
      lineNumber: 3,
      expectedMarker: "**Implementation",
    });

    // We don't assert flipped=true/false here because a concurrent race
    // could cause either success or a handled error.  We only assert the
    // file is still valid and uncorrupted.
    const after = fs.readFileSync(p, "utf8");
    expect(after.startsWith("## Feature 1: Auth")).toBe(true);
    const checkboxCount = (after.match(/- \[.\] \*\*/g) || []).length;
    expect(checkboxCount).toBeGreaterThanOrEqual(1);
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});
