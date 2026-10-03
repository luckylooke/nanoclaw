/**
 * What this pins: every model the gateway can be asked for has a price, so
 * the budget caps see its spend. Opus and Fable had none and were logged at
 * EUR 0 — invisible to every cap — until the model-class registry routed the
 * "deep" class to claude-opus-5-5 (2026-10-03).
 *
 * The expected values are the per-MTok list prices read 2026-10-03, so a
 * reordering of the first-match table that bills Opus 5.5 at the generic
 * Opus rate (or Fable 5.1 cache reads at Fable 5's) fails here.
 */
import { describe, expect, it } from 'vitest';

import { computeCostEur } from './gateway-db.js';

const MTOK_IN = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
const MTOK_OUT = { input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0 };
const MTOK_READ = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0 };

// computeCostEur returns EUR; compare in USD by dividing out the rate it applies.
const usd = (model: string, u: typeof MTOK_IN) =>
  computeCostEur(model, u) / computeCostEur('claude-haiku-4-5', MTOK_IN);

describe('gateway pricing', () => {
  it.each([
    ['claude-haiku-4-5-20251001', 1, 5],
    ['claude-opus-5-5', 4, 20],
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-fable-5-1', 10, 50],
    ['claude-fable-5', 10, 50],
  ])('%s bills $%d in / $%d out per MTok', (model, input, output) => {
    expect(usd(model, MTOK_IN)).toBeCloseTo(input, 6);
    expect(usd(model, MTOK_OUT)).toBeCloseTo(output, 6);
  });

  it("bills cache reads at each model's own rate, not its family default", () => {
    expect(usd('claude-opus-5-5', MTOK_READ)).toBeCloseTo(0.2, 6);
    expect(usd('claude-fable-5-1', MTOK_READ)).toBeCloseTo(0.25, 6);
    expect(usd('claude-fable-5', MTOK_READ)).toBeCloseTo(1.0, 6);
  });

  it('no current model falls through to EUR 0', () => {
    for (const m of [
      'claude-opus-5-5',
      'claude-opus-4-6',
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-sonnet-4-6',
    ]) {
      expect(computeCostEur(m, MTOK_IN)).toBeGreaterThan(0);
    }
  });
});
