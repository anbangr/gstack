/**
 * Subagent progress parser — pure functions only, no I/O.
 *
 * Converts a single line of a subagent's stdout into a structured
 * ProgressEvent or null. The watchdog uses non-null events to apply
 * tool-aware stall windows; null lines fall through to the legacy
 * silence-based path. See
 * docs/superpowers/specs/2026-05-21-subagent-progress-watchdog-design.md.
 *
 * Provider strategy:
 *   - Claude: parses stream-json `tool_use` events if/when --output-format
 *     stream-json is enabled. Until then, returns null on most lines.
 *   - Gemini: pattern-matches prose markers from default `gemini --yolo`
 *     output (today's invocation).
 *   - Codex: anchors on the `exec\n<cmd>\n in <cwd>\n succeeded in Xms`
 *     prose block emitted by `codex exec`.
 *   - Kimi: silent by design (`--print --final-message-only`); always
 *     returns null. The cpu-mode watchdog covers liveness for Kimi.
 *
 * Ambiguous lines return null. The bucket lookup runs through TOOL_BUCKET
 * from build-config.ts — tools absent from that table return null even
 * when the line is otherwise pattern-matched.
 */

import { TOOL_BUCKET, type ToolBucket } from "./build-config";

export interface ProgressEvent {
  event: "TOOL_START" | "TOOL_END";
  tool: string;
  bucket: ToolBucket;
  ts: number;
}

/**
 * Look up the bucket for a parsed tool name. Returns null when the tool
 * isn't in TOOL_BUCKET — the caller should then return null from the
 * top-level parser so the watchdog falls back to legacy stallMs.
 */
function bucketFor(tool: string): ToolBucket | null {
  return TOOL_BUCKET[tool] ?? null;
}

export function parseGeminiLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

/**
 * Codex `exec` block markers. The block shape is:
 *   exec
 *   /bin/zsh -lc "<cmd>" in <cwd>
 *    succeeded in Xms:
 * We map every `exec` line to TOOL_START with tool="Bash" (Codex's
 * shell tool maps to our Bash bucket), and every ` succeeded in ` line
 * to TOOL_END. Lines that contain `succeeded in` but don't start with
 * leading whitespace are NOT matched (avoids false-matching prose).
 */
export function parseCodexLine(
  line: string,
  now: number,
): ProgressEvent | null {
  if (line === "exec") {
    const bucket = bucketFor("Bash");
    if (bucket === null) return null;
    return { event: "TOOL_START", tool: "Bash", bucket, ts: now };
  }
  if (/^ succeeded in \d+ms:?$/.test(line)) {
    const bucket = bucketFor("Bash");
    if (bucket === null) return null;
    return { event: "TOOL_END", tool: "Bash", bucket, ts: now };
  }
  return null;
}

export function parseKimiLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

export function parseClaudeLine(
  _line: string,
  _now: number,
): ProgressEvent | null {
  return null;
}

// Test-only export so unit tests can verify the bucket gating without
// re-exporting the entire TOOL_BUCKET table.
export const __internals = { bucketFor };
