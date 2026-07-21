/**
 * Model-gateway persistence + cost accounting (T1.1).
 *
 * A SEPARATE SQLite file (`data/gateway.db`) owned entirely by the credential
 * proxy — deliberately NOT wired into nanoclaw's central DB / migration runner
 * so gateway logging can never interfere with app migrations. Opened with its
 * own better-sqlite3 handle.
 *
 * Responsibilities:
 *   - `api_calls` schema (per-call: tokens, EUR cost, latency, model, status).
 *   - Pricing map (USD per-MTok) → EUR cost.
 *   - group folder → budget bucket mapping + month-to-date cap checks, with a
 *     small in-proxy cache so we don't hit SQLite on every request.
 *
 * All functions are best-effort and swallow their own errors (logging a warn):
 * gateway bookkeeping must NEVER break the proxied request path.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

// --- Pricing -------------------------------------------------------------

// USD → EUR. Coarse fixed rate; adjust here when it drifts materially.
const USD_EUR = 0.92;

interface Price {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
  cacheRead: number; // USD per 1M cache-read tokens
  cacheWrite: number; // USD per 1M cache-creation (5m) tokens
}

// Matched by substring against the request `model` string so alias/date
// suffixes (e.g. claude-sonnet-4-6, claude-3-5-haiku-...) still resolve.
// Order matters: first match wins.
const PRICING: Array<{ match: string; price: Price }> = [
  { match: 'haiku', price: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: 'sonnet', price: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 } },
];

const _warnedModels = new Set<string>();

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export function computeCostEur(model: string | null, u: Usage): number {
  if (!model) return 0;
  const entry = PRICING.find((p) => model.includes(p.match));
  if (!entry) {
    if (!_warnedModels.has(model)) {
      _warnedModels.add(model);
      log.warn('Gateway: no pricing for model, cost recorded as 0', { model });
    }
    return 0;
  }
  const p = entry.price;
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_tokens * p.cacheRead +
      u.cache_creation_tokens * p.cacheWrite) /
    1_000_000;
  return usd * USD_EUR;
}

// --- Budget buckets ------------------------------------------------------

export type Bucket = 'personal' | 'dev';

// group `folder` slug → budget bucket. No such mapping exists elsewhere in the
// codebase; this is the single source of truth. Unlisted slugs (e.g.
// `_ping-test`, `dm-with-ignac` test group is listed, anything unknown) are
// uncapped (fail-open) so a missing/typo'd header can never brick an agent.
const GROUP_BUCKET: Record<string, Bucket> = {
  'dev-game': 'dev',
  'dev-web': 'dev',
  admin: 'dev',
  'personal-assistant': 'personal',
  learning: 'personal',
  health: 'personal',
  home: 'personal',
  'dm-with-ignac': 'personal',
};

const BUCKET_CAP_EUR: Record<Bucket, number> = { personal: 30, dev: 300 };

export function bucketForGroup(slug: string | null): Bucket | null {
  if (!slug) return null;
  return GROUP_BUCKET[slug] ?? null;
}

// --- DB handle + schema --------------------------------------------------

let _gw: Database.Database | null = null;
let _insertStmt: Database.Statement | null = null;

export function initGatewayDb(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const dbPath = path.join(DATA_DIR, 'gateway.db');
    _gw = new Database(dbPath);
    _gw.pragma('journal_mode = WAL');
    _gw.exec(`
      CREATE TABLE IF NOT EXISTS api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        trace_id TEXT,
        group_slug TEXT,
        model TEXT,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        cost_eur REAL,
        latency_ms INTEGER,
        status INTEGER,
        stop_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls(ts);
      CREATE INDEX IF NOT EXISTS idx_api_calls_group ON api_calls(group_slug);
    `);
    _insertStmt = _gw.prepare(`
      INSERT INTO api_calls
        (ts, trace_id, group_slug, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_eur, latency_ms, status, stop_reason)
      VALUES
        (@ts, @trace_id, @group_slug, @model, @input_tokens, @output_tokens,
         @cache_read_tokens, @cache_creation_tokens, @cost_eur, @latency_ms, @status, @stop_reason)
    `);
    refreshBucketTotals();
    log.info('Gateway DB initialized', { path: dbPath });
  } catch (err) {
    _gw = null;
    _insertStmt = null;
    log.error('Gateway DB init failed — logging/caps disabled', { err: String(err) });
  }
}

export interface ApiCallRow {
  ts: string;
  trace_id: string | null;
  group_slug: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_eur: number | null;
  latency_ms: number | null;
  status: number | null;
  stop_reason: string | null;
}

export function recordApiCall(row: ApiCallRow): void {
  if (!_gw || !_insertStmt) return;
  try {
    _insertStmt.run(row);
    // Keep the in-memory bucket cache tight between refreshes.
    const bucket = bucketForGroup(row.group_slug);
    if (bucket && row.cost_eur) _bucketTotals[bucket] += row.cost_eur;
  } catch (err) {
    log.warn('Gateway: recordApiCall failed', { err: String(err) });
  }
}

// --- Month-to-date cap checks (cached) -----------------------------------

const REFRESH_MS = 30_000;
let _bucketTotals: Record<Bucket, number> = { personal: 0, dev: 0 };
let _lastRefresh = 0;

function startOfMonthISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function refreshBucketTotals(): void {
  if (!_gw) return;
  const rows = _gw
    .prepare('SELECT group_slug AS slug, SUM(cost_eur) AS total FROM api_calls WHERE ts >= ? GROUP BY group_slug')
    .all(startOfMonthISO()) as Array<{ slug: string | null; total: number | null }>;
  const totals: Record<Bucket, number> = { personal: 0, dev: 0 };
  for (const r of rows) {
    const bucket = bucketForGroup(r.slug);
    if (bucket) totals[bucket] += r.total ?? 0;
  }
  _bucketTotals = totals;
  _lastRefresh = Date.now();
}

export interface BudgetStatus {
  bucket: Bucket;
  spent_eur: number;
  cap_eur: number;
  overCap: boolean;
}

/**
 * Returns the bucket budget status for a group slug, or null when there is no
 * cap to enforce (unknown/absent slug → fail-open, or DB unavailable).
 */
export function checkBudget(slug: string | null): BudgetStatus | null {
  if (!_gw) return null;
  const bucket = bucketForGroup(slug);
  if (!bucket) {
    if (slug) log.warn('Gateway: no budget bucket for group, uncapped', { group: slug });
    return null;
  }
  if (Date.now() - _lastRefresh > REFRESH_MS) {
    try {
      refreshBucketTotals();
    } catch (err) {
      log.warn('Gateway: bucket-total refresh failed', { err: String(err) });
    }
  }
  const spent = _bucketTotals[bucket] ?? 0;
  const cap = BUCKET_CAP_EUR[bucket];
  return { bucket, spent_eur: spent, cap_eur: cap, overCap: spent >= cap };
}
