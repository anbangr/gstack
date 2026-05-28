import { describe, it, expect } from "bun:test";
import {
  extractVerificationSpec,
  tryParseStructuredVerifierOutput,
} from "../feature-verifier";

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

  it("does NOT terminate on ### inside a fenced code block (review fix CRIT#1)", () => {
    const body = `### Verification Spec

Smoke: bun test

\`\`\`bash
### a heading comment
echo hello
\`\`\`

more probes here

### Phase 2: Next`;
    const spec = extractVerificationSpec(body);
    expect(spec).not.toBeNull();
    expect(spec!).toContain("more probes here");
    expect(spec!).not.toContain("Phase 2");
  });

  it("normalizes CRLF line endings (review fix INFO#7)", () => {
    const body =
      "### Verification Spec\r\nSmoke: bun test\r\n\r\n### Phase 1.1\r\n";
    const spec = extractVerificationSpec(body);
    expect(spec).toContain("Smoke: bun test");
    expect(spec).not.toContain("\r");
    expect(spec).not.toContain("Phase 1.1");
  });
});

describe("tryParseStructuredVerifierOutput (Increment 3)", () => {
  it("returns null when the only JSON object lacks domain keys (review fix CRIT#2)", () => {
    const stdout = `Here is an example report shape: {"overall":"pass"}

Now I am running the probes... done.`;
    expect(tryParseStructuredVerifierOutput(stdout)).toBeNull();
  });

  it("accepts a JSON object with acceptance_probes domain key", () => {
    const stdout = `Done.
{"overall":"fail","acceptance_probes":[{"ac":1,"cmd":"curl /x","expected":"200","actual":"500","status":"fail"}]}`;
    const result = tryParseStructuredVerifierOutput(stdout);
    expect(result).not.toBeNull();
    expect(result?.overall).toBe("fail");
  });

  it("prefers the LAST domain-keyed report when multiple appear", () => {
    const stdout = `{"overall":"fail","acceptance_probes":[]}
{"overall":"pass","smoke_run":[]}`;
    const result = tryParseStructuredVerifierOutput(stdout);
    expect(result?.overall).toBe("pass");
  });
});
