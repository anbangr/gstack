import { describe, expect, it } from "bun:test";
import { parsePlan } from "../parser";
import {
  buildParallelPhasePlan,
  extractPhaseDependencyHints,
  phaseHasSerialTouch,
} from "../parallel-planner";

const phaseMd = `
## Feature 1: Profile

### Phase 1.1: API schema
Touches: src/api/schema.ts, test/api/schema.test.ts
Depends on: none
- [ ] **Test Specification (test-writer role)**: tests
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review

### Phase 1.2: UI shell
Touches: src/ui/ProfileShell.tsx
Depends on: none
- [ ] **Test Specification (test-writer role)**: tests
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review

### Phase 1.3: Wire UI to API
Touches: src/ui/ProfilePage.tsx
Depends on: 1.1, 1.2
- [ ] **Test Specification (test-writer role)**: tests
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review
`;

describe("parallel phase planner", () => {
  it("extracts explicit dependencies and touch paths from phase body", () => {
    const { phases } = parsePlan(phaseMd);
    const hints = extractPhaseDependencyHints(phases[2]);

    expect(hints.dependsOnNumbers).toEqual(["1.1", "1.2"]);
    expect(hints.touches).toEqual(["src/ui/ProfilePage.tsx"]);
    expect(hints.serialReasons).toEqual([]);
  });

  it("infers dependencies from common prose when Depends on metadata is missing", () => {
    const { phases } = parsePlan(`
## Feature 1: Prose dep

### Phase 1.1: Producer
Touches: src/producer.ts
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review

### Phase 1.2: Consumer
Touches: src/consumer.ts
- [ ] **Implementation (primary-impl role)**: Implement this after Phase 1.1 is complete.
- [ ] **Review & QA (review roles)**: review
`);
    const hints = extractPhaseDependencyHints(phases[1]);

    expect(hints.dependsOnNumbers).toEqual(["1.1"]);
  });

  it("batches independent phases together and waits for declared dependencies", () => {
    const { features, phases } = parsePlan(phaseMd);
    const plan = buildParallelPhasePlan({
      feature: features[0],
      phases,
      maxParallel: 2,
    });

    expect(plan.batches.map((batch) => batch.phaseIndexes)).toEqual([[0, 1], [2]]);
    expect(plan.blockers).toEqual([]);
  });

  it("serializes phases with overlapping touches to avoid patch conflicts", () => {
    const { features, phases } = parsePlan(`
## Feature 1: Shared file

### Phase 1.1: First edit
Touches: src/shared.ts
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review

### Phase 1.2: Second edit
Touches: src/shared.ts
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review
`);
    const plan = buildParallelPhasePlan({
      feature: features[0],
      phases,
      maxParallel: 2,
    });

    expect(plan.batches.map((batch) => batch.phaseIndexes)).toEqual([[0], [1]]);
    expect(plan.warnings.join("\n")).toContain("overlaps planned touches");
  });

  it("serializes phases with no touch metadata instead of guessing they are independent", () => {
    const { features, phases } = parsePlan(`
## Feature 1: Unknown writes

### Phase 1.1: Unknown first
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review

### Phase 1.2: Known second
Touches: src/known.ts
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review
`);
    const plan = buildParallelPhasePlan({
      feature: features[0],
      phases,
      maxParallel: 2,
    });

    expect(plan.batches.map((batch) => batch.phaseIndexes)).toEqual([[0], [1]]);
    expect(plan.phases[0].serialReasons).toEqual([
      "missing Touches metadata; unknown write set",
    ]);
  });

  it("serializes phases without Touches metadata even when body mentions file paths", () => {
    const { features, phases } = parsePlan(`
## Feature 1: Inferred writes are unsafe

### Phase 1.1: Inferred first
- [ ] **Implementation (primary-impl role)**: Update \`src/inferred.ts\`.
- [ ] **Review & QA (review roles)**: review

### Phase 1.2: Known second
Touches: src/known.ts
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review
`);
    const plan = buildParallelPhasePlan({
      feature: features[0],
      phases,
      maxParallel: 2,
    });

    expect(plan.batches.map((batch) => batch.phaseIndexes)).toEqual([[0], [1]]);
    expect(plan.phases[0].touches).toEqual(["src/inferred.ts"]);
    expect(plan.phases[0].serialReasons).toEqual([
      "missing Touches metadata; unknown write set",
    ]);
  });

  it("serializes migration, workflow, lockfile, and package-manager touches", () => {
    expect(phaseHasSerialTouch("db/migrate/20260502000000_add_users.sql")).toBe(true);
    expect(phaseHasSerialTouch(".github/workflows/test.yml")).toBe(true);
    expect(phaseHasSerialTouch("package.json")).toBe(true);
    expect(phaseHasSerialTouch("bun.lock")).toBe(true);
    expect(phaseHasSerialTouch("src/api/users.ts")).toBe(false);
  });

  it("fails closed when a dependency references an unknown phase", () => {
    const { features, phases } = parsePlan(`
## Feature 1: Bad dep

### Phase 1.1: Consumer
Depends on: 9.9
Touches: src/consumer.ts
- [ ] **Implementation (primary-impl role)**: impl
- [ ] **Review & QA (review roles)**: review
`);
    const plan = buildParallelPhasePlan({
      feature: features[0],
      phases,
      maxParallel: 2,
    });

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain("unknown dependency 9.9");
  });
});
