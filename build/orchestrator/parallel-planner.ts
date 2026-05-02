import type { Feature, Phase } from "./types";

export interface PhaseDependencyHints {
  phaseIndex: number;
  phaseNumber: string;
  touches: string[];
  dependsOnNumbers: string[];
  serialReasons: string[];
}

export interface ParallelPhaseBatch {
  phaseIndexes: number[];
  reason: string;
}

export interface ParallelPhasePlan {
  maxParallel: number;
  phases: PhaseDependencyHints[];
  batches: ParallelPhaseBatch[];
  warnings: string[];
  blockers: string[];
}

const TOUCHES_LINE = /^\s*Touches\s*:\s*(.+?)\s*$/im;
const DEPENDS_LINE = /^\s*Depends on\s*:\s*(.+?)\s*$/im;
const BACKTICK_PATH = /`([^`\n]+\.[A-Za-z0-9][A-Za-z0-9._-]*)`/g;
const PROSE_DEPENDENCY =
  /\b(?:after|requires?|blocked by|depends on|dependent on)\s+(?:phase\s+)?(\d+(?:\.\d+)+)\b/gi;

const SERIAL_TOUCH_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^bun\.lockb?$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^Cargo\.lock$/,
  /^go\.sum$/,
  /^db\/migrate\//,
  /^migrations?\//,
  /^prisma\/migrations?\//,
  /^\.github\/workflows\//,
  /(^|\/)(vite|webpack|rollup|eslint|tsconfig|tailwind|postcss|babel|next|nuxt|svelte|astro)\.config\./,
];

export function phaseHasSerialTouch(filePath: string): boolean {
  const normalized = normalizeTouch(filePath);
  return SERIAL_TOUCH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function extractPhaseDependencyHints(phase: Phase): PhaseDependencyHints {
  const touches = new Set<string>();
  const hasExplicitTouches = TOUCHES_LINE.test(phase.body);
  TOUCHES_LINE.lastIndex = 0;
  const explicitTouches = phase.body.match(TOUCHES_LINE)?.[1];
  if (explicitTouches) {
    for (const token of explicitTouches.split(/[, ]+/)) {
      const touch = normalizeTouch(token);
      if (touch) touches.add(touch);
    }
  }

  for (const match of phase.body.matchAll(BACKTICK_PATH)) {
    const touch = normalizeTouch(match[1]);
    if (touch) touches.add(touch);
  }

  const dependsOnNumbers = new Set<string>();
  const dependsRaw = phase.body.match(DEPENDS_LINE)?.[1]?.trim() ?? "";
  if (dependsRaw.length > 0 && !/^none$/i.test(dependsRaw)) {
    for (const value of dependsRaw.split(/[, ]+/)) {
      const dep = normalizeDependencyNumber(value);
      if (dep) dependsOnNumbers.add(dep);
    }
  }

  for (const match of phase.body.matchAll(PROSE_DEPENDENCY)) {
    const dep = normalizeDependencyNumber(match[1]);
    if (dep) dependsOnNumbers.add(dep);
  }

  const serialReasons = [...touches]
    .filter(phaseHasSerialTouch)
    .map((touch) => `touches serial path ${touch}`);
  if (!hasExplicitTouches) {
    serialReasons.push("missing Touches metadata; unknown write set");
  }

  return {
    phaseIndex: phase.index,
    phaseNumber: phase.number,
    touches: [...touches].sort(),
    dependsOnNumbers: [...dependsOnNumbers].sort(comparePhaseNumbers),
    serialReasons,
  };
}

export function buildParallelPhasePlan(args: {
  feature: Feature;
  phases: Phase[];
  maxParallel: number;
}): ParallelPhasePlan {
  const maxParallel = Math.max(1, Math.floor(args.maxParallel));
  const featurePhases = args.feature.phaseIndexes.map((idx) => args.phases[idx]);
  const hints = featurePhases.map(extractPhaseDependencyHints);
  const hintsByNumber = new Map(hints.map((hint) => [hint.phaseNumber, hint]));
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const hint of hints) {
    for (const depNumber of hint.dependsOnNumbers) {
      if (!hintsByNumber.has(depNumber)) {
        blockers.push(`Phase ${hint.phaseNumber} references unknown dependency ${depNumber}`);
      }
    }
  }
  if (blockers.length > 0) {
    return { maxParallel, phases: hints, batches: [], warnings, blockers };
  }

  const completed = new Set<string>();
  const remaining = [...hints];
  const batches: ParallelPhaseBatch[] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((hint) =>
      hint.dependsOnNumbers.every((dep) => completed.has(dep)),
    );
    if (ready.length === 0) {
      blockers.push(`No ready phases remain for feature ${args.feature.number}; dependency cycle suspected`);
      break;
    }

    const batch: PhaseDependencyHints[] = [];
    const batchTouches = new Set<string>();
    for (const hint of ready) {
      if (batch.length >= maxParallel) break;
      if (hint.serialReasons.length > 0) {
        if (batch.length === 0) batch.push(hint);
        break;
      }
      const overlap = hint.touches.find((touch) => batchTouches.has(touch));
      if (overlap) {
        warnings.push(
          `Phase ${hint.phaseNumber} overlaps planned touches on ${overlap}; serializing to avoid conflicts`,
        );
        continue;
      }
      batch.push(hint);
      for (const touch of hint.touches) batchTouches.add(touch);
    }

    if (batch.length === 0) {
      batch.push(ready[0]);
    }

    const serialReason = batch.length === 1 && batch[0].serialReasons.length > 0
      ? batch[0].serialReasons.join("; ")
      : batch.length === 1
        ? "single ready phase or conflict-avoidance serialization"
        : "independent phases with disjoint planned touches";
    batches.push({
      phaseIndexes: batch.map((hint) => hint.phaseIndex),
      reason: serialReason,
    });

    for (const hint of batch) {
      completed.add(hint.phaseNumber);
      const idx = remaining.findIndex((candidate) => candidate.phaseIndex === hint.phaseIndex);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  }

  return { maxParallel, phases: hints, batches, warnings, blockers };
}

function normalizeTouch(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`,.;:]+$/g, "")
    .replace(/^\.\//, "");
}

function normalizeDependencyNumber(value: string): string {
  return value
    .trim()
    .replace(/^phase\s+/i, "")
    .replace(/^["'`]+|["'`,.;:]+$/g, "");
}

function comparePhaseNumbers(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number(part));
  const bParts = b.split(".").map((part) => Number(part));
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}
