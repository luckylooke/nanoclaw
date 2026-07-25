/**
 * Adaptive per-spawn tuning: classify the triggering inbound message into a
 * complexity tier and map it to a compact-window + effort pair. Host-side,
 * zero LLM calls — see container-runner.ts spawnContainer() for the caller.
 */
export type ComplexityTier = 'trivial' | 'medium' | 'complex';

export interface TierTuning {
  window: number;
  effort: 'low' | 'medium' | 'high';
}

const TIER_TUNING: Record<ComplexityTier, TierTuning> = {
  trivial: { window: 30_000, effort: 'low' },
  medium: { window: 70_000, effort: 'medium' },
  complex: { window: 165_000, effort: 'high' },
};

/** User keyword override — forces tier=complex regardless of heuristic. */
const OVERRIDE_RE = /(^|\s)deep:|think hard(er)?|ultrathink/i;

const COMPLEX_RE =
  /\b(deep dive|analyz\w*|architect\w*|refactor\w*|migrat\w*|debug\w*|investigat\w*|research|comprehensive|strategy|audit|multi-?step|design doc)\b/i;

const TRIVIAL_RE = /^\s*(hi|hey|hello|thanks?|thank you|ok|okay|sure|yes|no|cool|nice|great|got it)[\s!.?]*$/i;

/** Pure — unit-testable without DB/filesystem. */
export function classifyComplexity(text: string): ComplexityTier {
  const trimmed = text.trim();
  if (OVERRIDE_RE.test(trimmed)) return 'complex';
  if (trimmed.length === 0) return 'medium';
  if (trimmed.length < 50 && TRIVIAL_RE.test(trimmed)) return 'trivial';
  if (trimmed.length > 500 || COMPLEX_RE.test(trimmed)) return 'complex';
  return 'medium';
}

export function tuningForTier(tier: ComplexityTier): TierTuning {
  return TIER_TUNING[tier];
}

/** Fallback when no inbound text signal is available at all. */
export const DEFAULT_STATIC_WINDOW = 165_000;
