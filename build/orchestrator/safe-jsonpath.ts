/**
 * Minimal, hand-written JSONPath subset evaluator. Safe by construction:
 *   - No eval, no Function constructor, no script expressions.
 *   - Supports: $, .field, [field], [*], [?(@.f == 'lit' && !@.g && @.h)]
 *   - Filter operators: ==, !=, !@.field (negation), @.field (truthiness)
 *   - Filter chains: && only (no || in this subset)
 *   - Anything outside this grammar returns []
 *
 * Used by skill-fault-detector's state_jsonpath matcherKind so investigator-
 * proposed learned patterns can target structural state shapes (e.g.
 * "committed feature without completedAt").
 */

type Path = string;

const FILTER_RE = /^\[\?\((.+)\)\]$/;
const BRACKET_FIELD_RE = /^\[(['"])([^'"]+)\1\]$/;
const WILDCARD_RE = /^\[\*\]$/;
const DOT_FIELD_RE = /^\.([A-Za-z_][A-Za-z0-9_]*)$/;
const ROOT = "$";

function tokenize(path: Path): string[] | null {
  if (!path.startsWith(ROOT)) return null;
  const rest = path.slice(1);
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === ".") {
      const m = rest.slice(i).match(/^\.([A-Za-z_][A-Za-z0-9_]*)/);
      if (!m) return null;
      tokens.push(`.${m[1]}`);
      i += m[0].length;
    } else if (rest[i] === "[") {
      // Find matching close bracket. Brackets can nest (e.g. inside a filter
      // expression a `[*]` could appear), so track depth.
      let depth = 0;
      let j = i;
      while (j < rest.length) {
        if (rest[j] === "[") depth++;
        else if (rest[j] === "]") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (j >= rest.length) return null;
      tokens.push(rest.slice(i, j + 1));
      i = j + 1;
    } else {
      return null;
    }
  }
  return tokens;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

function evalFilterExpr(expr: string, ctx: any): boolean {
  // Split top-level on " && " only — no parens, no `||`.
  const parts = expr.split(/\s*&&\s*/);
  for (const part of parts) {
    if (!evalFilterAtom(part, ctx)) return false;
  }
  return true;
}

function evalFilterAtom(atom: string, ctx: any): boolean {
  const trim = atom.trim();
  // !@.field
  let m = trim.match(/^!@\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) return !ctx?.[m[1]];
  // @.field == 'literal'
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*==\s*'([^']*)'$/);
  if (m) return ctx?.[m[1]] === m[2];
  // @.field == "literal"
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]*)"$/);
  if (m) return ctx?.[m[1]] === m[2];
  // @.field != 'literal'
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*!=\s*'([^']*)'$/);
  if (m) return ctx?.[m[1]] !== m[2];
  // @.field != "literal"
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)\s*!=\s*"([^"]*)"$/);
  if (m) return ctx?.[m[1]] !== m[2];
  // @.field (truthiness)
  m = trim.match(/^@\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) return !!ctx?.[m[1]];
  return false;
}

export function safeJsonPathEval(data: unknown, path: string): unknown[] {
  try {
    if (path === ROOT) return [data];
    const tokens = tokenize(path);
    if (!tokens) return [];
    let current: unknown[] = [data];
    for (const tok of tokens) {
      const next: unknown[] = [];
      for (const item of current) {
        let m;
        if ((m = tok.match(DOT_FIELD_RE))) {
          if (item && typeof item === "object") {
            next.push((item as any)[m[1]]);
          }
        } else if ((m = tok.match(BRACKET_FIELD_RE))) {
          if (item && typeof item === "object") {
            next.push((item as any)[m[2]]);
          }
        } else if (WILDCARD_RE.test(tok)) {
          for (const v of asArray(item)) next.push(v);
        } else if ((m = tok.match(FILTER_RE))) {
          for (const v of asArray(item)) {
            if (evalFilterExpr(m[1], v)) next.push(v);
          }
        } else {
          return [];
        }
      }
      current = next.filter((v) => v !== undefined);
    }
    return current;
  } catch {
    return [];
  }
}
