import { describe, test, expect } from "bun:test";
import { safeJsonPathEval } from "../safe-jsonpath";

describe("safeJsonPathEval", () => {
  test("$ returns root", () => {
    expect(safeJsonPathEval({ a: 1 }, "$")).toEqual([{ a: 1 }]);
  });
  test("dot access", () => {
    expect(safeJsonPathEval({ a: { b: 2 } }, "$.a.b")).toEqual([2]);
  });
  test("bracket field access with single quotes", () => {
    expect(safeJsonPathEval({ "weird key": 7 }, "$['weird key']")).toEqual([7]);
  });
  test("array wildcard", () => {
    expect(
      safeJsonPathEval({ items: [{ x: 1 }, { x: 2 }] }, "$.items[*].x"),
    ).toEqual([1, 2]);
  });
  test("filter expression with equality + string literal", () => {
    const data = {
      features: [
        { status: "committed", completedAt: "2026-05-19" },
        { status: "committed" },
      ],
    };
    const out = safeJsonPathEval(
      data,
      "$.features[*][?(@.status == 'committed' && !@.completedAt)]",
    );
    expect(out.length).toBe(1);
    expect((out[0] as any).status).toBe("committed");
  });
  test("filter expression — polis hand-merged-feature shape", () => {
    const data = {
      features: [
        {
          status: "committed",
          completedAt: "2026-05-19",
          mergeSha: "abc",
          prNumber: 1,
        },
        { status: "committed", mergeSha: "def", prNumber: 2 },
      ],
    };
    const out = safeJsonPathEval(
      data,
      "$.features[*][?(@.status == 'committed' && !@.completedAt && @.mergeSha && @.prNumber)]",
    );
    expect(out.length).toBe(1);
    expect((out[0] as any).prNumber).toBe(2);
  });
  test("filter !=", () => {
    expect(
      safeJsonPathEval(
        { items: [{ k: "a" }, { k: "b" }] },
        "$.items[*][?(@.k != 'a')]",
      ).length,
    ).toBe(1);
  });
  test("rejects function calls", () => {
    expect(safeJsonPathEval({}, "$.length()")).toEqual([]);
  });
  test("rejects script expressions", () => {
    expect(safeJsonPathEval({}, "$[(@.length-1)]")).toEqual([]);
  });
  test("rejects malformed path", () => {
    expect(safeJsonPathEval({}, "$..()malformed")).toEqual([]);
  });
  test("returns [] when path doesn't start with $", () => {
    expect(safeJsonPathEval({ a: 1 }, "a")).toEqual([]);
  });
  test("returns [] for null/undefined data on member access", () => {
    expect(safeJsonPathEval(null, "$.a")).toEqual([]);
    expect(safeJsonPathEval(undefined, "$.a")).toEqual([]);
  });
  test("wildcard on non-array returns [the scalar] (asArray semantics)", () => {
    // Implementation choice: asArray treats non-array values as [v]
    // so wildcard on a scalar returns the scalar itself.
    expect(safeJsonPathEval({ a: 5 }, "$.a[*]")).toEqual([5]);
  });
});
