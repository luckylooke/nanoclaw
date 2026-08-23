/**
 * Budget bucket enforcement, and the eval group's deliberate double guard.
 *
 * THE SUBTLETY WORTH A TEST. `checkUncappedDaily()` returned null for ANY
 * bucketed slug, on the assumption that a bucket implies a cap. So giving
 * `eval` a monthly bucket would have silently switched off the €25/day
 * backstop — the one that exists precisely because 2026-08-08 burned €40.14 in
 * seven hours, an amount no monthly figure would ever have caught. The trade
 * would have read as "eval is now capped" while making a runaway strictly
 * harder to stop.
 *
 * These tests pin both halves: eval is bucketed AND still daily-guarded, while
 * ordinary agent groups keep the monthly cap as their only gate.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ApiCallRow } from './gateway-db.js';

let tmp: string;

/**
 * DATA_DIR is resolved from the project root at import time, so the only way to
 * keep a test off the live gateway.db is to mock config and re-import.
 */
async function freshGateway() {
  vi.resetModules();
  vi.doMock('./config.js', async () => {
    const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
    return { ...actual, DATA_DIR: tmp };
  });
  const mod = await import('./gateway-db.js');
  mod.initGatewayDb();
  return mod;
}

function row(slug: string, cost: number, ts: string = new Date().toISOString()): ApiCallRow {
  return {
    ts,
    trace_id: null,
    group_slug: slug,
    model: 'claude-opus-5',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_eur: cost,
    latency_ms: 10,
    status: 200,
    stop_reason: null,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-budget-'));
});

afterEach(() => {
  vi.doUnmock('./config.js');
  vi.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('budget buckets', () => {
  it('gives eval its own bucket rather than folding it into dev', async () => {
    const gw = await freshGateway();
    expect(gw.bucketForGroup('eval')).toBe('eval');
    expect(gw.bucketForGroup('dev-web')).toBe('dev');
    expect(gw.bucketForGroup('health')).toBe('personal');
    expect(gw.bucketForGroup('rag')).toBeNull();
    expect(gw.bucketForGroup(null)).toBeNull();
  });

  it('caps eval at €50 month-to-date', async () => {
    const gw = await freshGateway();
    gw.recordApiCall(row('eval', 49.99));
    const under = gw.checkBudget('eval');
    expect(under?.bucket).toBe('eval');
    expect(under?.cap_eur).toBe(50);
    expect(under?.overCap).toBe(false);

    gw.recordApiCall(row('eval', 0.02));
    expect(gw.checkBudget('eval')?.overCap).toBe(true);
  });

  it('keeps eval spend out of the dev allowance', async () => {
    const gw = await freshGateway();
    gw.recordApiCall(row('eval', 100));
    const dev = gw.checkBudget('dev-web');
    expect(dev?.bucket).toBe('dev');
    expect(dev?.spent_eur).toBe(0);
    expect(dev?.overCap).toBe(false);
  });

  // The regression this whole change turns on.
  it('still applies the €25/day guard to eval even though it is bucketed', async () => {
    const gw = await freshGateway();
    gw.recordApiCall(row('eval', 30));
    const daily = gw.checkUncappedDaily('eval');
    expect(daily).not.toBeNull();
    expect(daily?.cap_eur).toBe(25);
    expect(daily?.overCap).toBe(true);
  });

  it('leaves ordinary agent groups on their monthly cap alone', async () => {
    const gw = await freshGateway();
    gw.recordApiCall(row('admin', 30));
    // admin is bucketed and NOT daily-guarded: a busy day must never 429 a live
    // agent that is still inside its monthly allowance.
    expect(gw.checkUncappedDaily('admin')).toBeNull();
    expect(gw.checkBudget('admin')?.overCap).toBe(false);
  });

  it('still daily-guards unbucketed host callers', async () => {
    const gw = await freshGateway();
    gw.recordApiCall(row('rag', 26));
    const daily = gw.checkUncappedDaily('rag');
    expect(daily?.group).toBe('rag');
    expect(daily?.overCap).toBe(true);
    // No bucket, so no monthly cap to report.
    expect(gw.checkBudget('rag')).toBeNull();
  });

  it('counts only today against the daily guard', async () => {
    const gw = await freshGateway();
    // Yesterday's runaway must not keep 429-ing today. 26h back is safely in the
    // previous UTC day whatever hour the suite runs at.
    const yesterday = new Date(Date.now() - 26 * 3_600_000).toISOString();
    gw.recordApiCall(row('eval', 500, yesterday));
    expect(gw.checkUncappedDaily('eval')?.overCap).toBe(false);
  });
});
