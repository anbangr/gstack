import * as fs from "node:fs";

export interface RecentErrorRef {
  timestamp: string;
  summary?: string;
}

export interface TailStdoutLogArgs {
  stdoutPath: string;
  recentErrors: RecentErrorRef[];
  tailLines: number;
  windowLines: number;
}

export function tailStdoutLog(args: TailStdoutLogArgs): string {
  const { stdoutPath, recentErrors, tailLines, windowLines } = args;
  if (!fs.existsSync(stdoutPath)) return "";
  const content = fs.readFileSync(stdoutPath, "utf8");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;
  const include = new Set<number>();

  for (let i = Math.max(0, total - tailLines); i < total; i++) include.add(i);

  const lineTimestamps = lines.map((line) => parseLineTimestamp(line));
  for (const err of recentErrors) {
    const errMs = Date.parse(err.timestamp);
    if (Number.isNaN(errMs)) continue;
    let anchor = -1;
    for (let i = 0; i < total; i++) {
      const t = lineTimestamps[i];
      if (t !== null && t >= errMs) {
        anchor = i;
        break;
      }
    }
    if (anchor < 0) continue;
    for (
      let i = Math.max(0, anchor - windowLines);
      i < Math.min(total, anchor + windowLines + 1);
      i++
    ) {
      include.add(i);
    }
  }

  const sorted = [...include].sort((a, b) => a - b);
  return sorted.map((i) => lines[i]).join("\n");
}

function parseLineTimestamp(line: string): number | null {
  const match = line.match(/^\[([^\]]+)\]/);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? null : ms;
}
