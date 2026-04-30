/**
 * Plan file parser for gstack-build.
 *
 * Input: markdown plan file with phases shaped like:
 *
 *   ### Phase 1: Skeleton + parser
 *   - [ ] **Implementation (Gemini Sub-agent)**: ...
 *   - [ ] **Review & QA (Codex Sub-agent)**: ...
 *
 * Output: array of Phase objects with checkbox state and line numbers
 * (so the plan-mutator can flip checkboxes without re-parsing).
 *
 * Robust against:
 *   - blank lines between heading and checkboxes
 *   - extra prose between heading and checkboxes
 *   - text inside fenced code blocks (```...```) — never matched
 *   - BOM, trailing whitespace
 */

import type { Feature, Phase } from './types';

const FEATURE_HEADING = /^##\s+Feature\s+(\d+(?:\.\d+)?)\s*:\s*(.+?)\s*$/i;
const PHASE_HEADING = /^###\s+Phase\s+(\d+(?:\.\d+)?)\s*:\s*(.+?)\s*$/;
const IMPL_CHECKBOX = /^\s*-\s+\[([ xX])\]\s+\*\*Implementation\b/;
const REVIEW_CHECKBOX = /^\s*-\s+\[([ xX])\]\s+\*\*Review\b/;
const TESTSPEC_CHECKBOX = /^\s*-\s*\[([xX ])\]\s*\*\*Test Specification/i;
const FENCE = /^```/;

export interface ParseResult {
  features: Feature[];
  phases: Phase[];
  /** Diagnostics for phases that look broken — missing checkboxes etc. */
  warnings: string[];
}

export interface ParseOpts {
  /** When true, stamps dualImpl=true on all phases (set by --dual-impl CLI flag). */
  dualImpl?: boolean;
}

export function parsePlan(content: string, opts: ParseOpts = {}): ParseResult {
  // Strip BOM.
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const lines = content.split(/\r?\n/);

  const phases: Phase[] = [];
  const features: Feature[] = [];
  const warnings: string[] = [];

  let inFence = false;
  let currentFeature: (Feature & { bodyLines: string[] }) | null = null;
  let currentPhase: Partial<Phase> & { bodyLines: string[] } | null = null;
  let currentPhaseStartLine = 0;

  const ensureFeature = () => {
    if (currentFeature) return currentFeature;
    currentFeature = {
      index: features.length,
      number: '1',
      name: 'Full plan',
      body: '',
      bodyLines: [],
      phaseIndexes: [],
    };
    features.push(currentFeature);
    return currentFeature;
  };

  const finalize = (endLineExclusive: number) => {
    if (!currentPhase) return;
    const p = currentPhase;
    if (p.implementationCheckboxLine == null) {
      warnings.push(
        `Phase ${p.number} ("${p.name}") at line ${currentPhaseStartLine + 1} is missing an Implementation checkbox`
      );
    }
    if (p.reviewCheckboxLine == null) {
      warnings.push(
        `Phase ${p.number} ("${p.name}") at line ${currentPhaseStartLine + 1} is missing a Review checkbox`
      );
    }

    // Test specification checkbox is optional for legacy plans
    if (p.testSpecCheckboxLine == null) {
      p.testSpecCheckboxLine = -1;
      p.testSpecDone = true;
    }

    // Only emit phases with both core checkboxes — the orchestrator can't run a half-shaped phase.
    if (p.implementationCheckboxLine != null && p.reviewCheckboxLine != null) {
      const feature = ensureFeature();
      const phaseIndex = phases.length;
      feature.phaseIndexes.push(phaseIndex);
      phases.push({
        index: phaseIndex,
        number: p.number!,
        name: p.name!,
        featureIndex: feature.index,
        featureNumber: feature.number,
        featureName: feature.name,
        testSpecDone: !!p.testSpecDone,
        implementationDone: !!p.implementationDone,
        reviewDone: !!p.reviewDone,
        body: p.bodyLines.join('\n'),
        testSpecCheckboxLine: p.testSpecCheckboxLine,
        implementationCheckboxLine: p.implementationCheckboxLine,
        reviewCheckboxLine: p.reviewCheckboxLine,
        dualImpl: !!opts.dualImpl,
      });
    }
    currentPhase = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fence state. A fence toggles on its own line.
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      if (currentPhase) currentPhase.bodyLines.push(line);
      continue;
    }

    if (inFence) {
      // Inside a code block — never match phase syntax.
      if (currentPhase) currentPhase.bodyLines.push(line);
      continue;
    }

    const headingMatch = line.match(PHASE_HEADING);
    if (headingMatch) {
      // Close out previous phase.
      finalize(i);
      currentPhaseStartLine = i;
      ensureFeature();
      currentPhase = {
        number: headingMatch[1],
        name: headingMatch[2],
        bodyLines: [],
      };
      continue;
    }

    const featureMatch = line.match(FEATURE_HEADING);
    if (featureMatch) {
      finalize(i);
      currentFeature = {
        index: features.length,
        number: featureMatch[1],
        name: featureMatch[2],
        body: '',
        bodyLines: [],
        phaseIndexes: [],
      };
      features.push(currentFeature);
      continue;
    }

    if (!currentPhase) {
      if (currentFeature) currentFeature.bodyLines.push(line);
      continue;
    }

    // We're inside a phase body. Look for checkboxes.
    const testSpecMatch = line.match(TESTSPEC_CHECKBOX);
    if (testSpecMatch) {
      currentPhase.testSpecCheckboxLine = i + 1; // 1-based
      currentPhase.testSpecDone = testSpecMatch[1].toLowerCase() === 'x';
      currentPhase.bodyLines.push(line);
      continue;
    }
    const implMatch = line.match(IMPL_CHECKBOX);
    if (implMatch) {
      currentPhase.implementationCheckboxLine = i + 1; // 1-based
      currentPhase.implementationDone = implMatch[1].toLowerCase() === 'x';
      currentPhase.bodyLines.push(line);
      continue;
    }
    const reviewMatch = line.match(REVIEW_CHECKBOX);
    if (reviewMatch) {
      currentPhase.reviewCheckboxLine = i + 1; // 1-based
      currentPhase.reviewDone = reviewMatch[1].toLowerCase() === 'x';
      currentPhase.bodyLines.push(line);
      continue;
    }

    currentPhase.bodyLines.push(line);
  }

  // Close out the last phase.
  finalize(lines.length);
  for (const f of features) {
    f.body = f.bodyLines.join('\n');
    delete (f as any).bodyLines;
  }

  const executableFeatures = features.filter((f) => f.phaseIndexes.length > 0);
  if (executableFeatures.length !== features.length) {
    for (const f of features) {
      if (f.phaseIndexes.length === 0) {
        warnings.push(`Feature ${f.number} ("${f.name}") has no executable phases and was ignored`);
      }
    }
    const featureIndexByOldIndex = new Map<number, number>();
    executableFeatures.forEach((f, index) => {
      featureIndexByOldIndex.set(f.index, index);
      f.index = index;
    });
    for (const phase of phases) {
      const newIndex = featureIndexByOldIndex.get(phase.featureIndex);
      if (newIndex == null) continue;
      const feature = executableFeatures[newIndex];
      phase.featureIndex = newIndex;
      phase.featureNumber = feature.number;
      phase.featureName = feature.name;
    }
  }

  return { features: executableFeatures, phases, warnings };
}

/**
 * Returns true when both checkboxes are checked.
 */
export function isPhaseComplete(phase: Phase): boolean {
  return phase.testSpecDone && phase.implementationDone && phase.reviewDone;
}

/**
 * Find the next phase needing work, or null if everything is done.
 * "In progress" phases (one box checked, one not) are returned and the
 * orchestrator runs only the unchecked half — that's how we resume from
 * a crash that happened between Gemini completing and Codex starting.
 */
export function findNextPhase(phases: Phase[]): Phase | null {
  for (const p of phases) {
    if (!isPhaseComplete(p)) return p;
  }
  return null;
}
