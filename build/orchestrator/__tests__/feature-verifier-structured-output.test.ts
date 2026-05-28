import { describe, it, expect } from "bun:test";
import { extractVerificationSpec } from "../feature-verifier";

describe("extractVerificationSpec (Increment 3)", () => {
  it("extracts a Verification Spec block bounded by next ###", () => {
    const body = `### Verification Spec
Smoke: bun test
| AC# | Probe | Expected | If fails |
|---|---|---|---|
| 1 | curl /x | HTTP 200 | broken |

### Phase 1.1: Build it
- [ ] **Implementation**`;
    const spec = extractVerificationSpec(body);
    expect(spec).not.toBeNull();
    expect(spec!).toContain("Smoke: bun test");
    expect(spec!).toContain("HTTP 200");
    expect(spec!).not.toContain("Phase 1.1");
  });

  it("extracts when Verification Spec is the last section", () => {
    const body = `### Phase 1.1: Build
- [ ] x

### Verification Spec
Smoke: ok
`;
    const spec = extractVerificationSpec(body);
    expect(spec).not.toBeNull();
    expect(spec!).toContain("Smoke: ok");
  });

  it("returns null when missing", () => {
    expect(extractVerificationSpec("### Some other section\n")).toBeNull();
  });
});
