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
 *   - `agent_messages` outbound index + `feedback` capture (T1.3). The Slack
 *     `ts` of an agent reply is otherwise only stored per-session in each
 *     session's `inbound.db`, which the 00:01 daily reset wipes; this central
 *     index lets a late reaction attribute back to its group/session/prompt.
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

export type Bucket = 'personal' | 'dev' | 'eval';

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
  // Host-side eval runs get their own bucket so a month of prompt tuning
  // cannot eat the dev agents' allowance. Unlike every other bucketed slug
  // it ALSO keeps the daily backstop below — see DAILY_GUARDED.
  eval: 'eval',
};

const BUCKET_CAP_EUR: Record<Bucket, number> = { personal: 30, dev: 300, eval: 50 };

export function bucketForGroup(slug: string | null): Bucket | null {
  if (!slug) return null;
  return GROUP_BUCKET[slug] ?? null;
}

// --- DB handle + schema --------------------------------------------------

let _gw: Database.Database | null = null;
let _insertStmt: Database.Statement | null = null;
let _agentMsgInsertStmt: Database.Statement | null = null;
let _agentMsgLookupStmt: Database.Statement | null = null;
let _feedbackInsertStmt: Database.Statement | null = null;

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
        resolved_model TEXT,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        cost_eur REAL,
        latency_ms INTEGER,
        status INTEGER,
        stop_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls(ts);
      CREATE INDEX IF NOT EXISTS idx_api_calls_group ON api_calls(group_slug);

      -- T1.3 outbound index: one row per delivered agent chat reply, keyed by
      -- the platform message id (Slack ts). Carries the (input, output) pair so
      -- a downvote can seed eval candidates even after the session's inbound.db
      -- has been wiped by the daily reset. message_ts is globally unique per
      -- Slack workspace; channel_type/platform_id kept for cross-platform safety.
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        channel_type TEXT,
        platform_id TEXT,
        message_ts TEXT,
        group_slug TEXT,
        session_id TEXT,
        prompt_version TEXT,
        input_text TEXT,
        output_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_msgts ON agent_messages(message_ts);

      -- T1.3 feedback capture: explicit reactions (and, phase-2, implicit
      -- corrections) on an agent message. Attribution comes from agent_messages.
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        group_slug TEXT, session_id TEXT,
        message_ts TEXT, channel TEXT,
        signal TEXT,          -- 'up' | 'down' | 'raw:<emoji>'
        kind TEXT,            -- 'explicit_reaction' | 'implicit_correction'
        prompt_version TEXT,  -- hash of the agent's identity files at reply time (T7; NULL stub)
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts);
      CREATE INDEX IF NOT EXISTS idx_feedback_group ON feedback(group_slug);

      -- Per-task budget gate: one row each time a task was told to stop and ask
      -- (action='gate') or was hard-stopped (action='hard'). Without this the
      -- feature is invisible — you would only ever see the agent's question and
      -- have no way to tell it was the gate that produced it.
      CREATE TABLE IF NOT EXISTS task_gates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        trace_id TEXT,
        group_slug TEXT,
        action TEXT,          -- 'gate' | 'hard'
        spent_eur REAL,
        gate_eur REAL
      );
      CREATE INDEX IF NOT EXISTS idx_task_gates_ts ON task_gates(ts);
      CREATE INDEX IF NOT EXISTS idx_task_gates_trace ON task_gates(trace_id);
    `);
    // Migration: resolved_model column for DBs created before T2 #7 (exact
    // model-id logging). CREATE TABLE IF NOT EXISTS won't add it to an existing table.
    try {
      _gw.exec('ALTER TABLE api_calls ADD COLUMN resolved_model TEXT');
    } catch {
      /* column already present */
    }
    _insertStmt = _gw.prepare(`
      INSERT INTO api_calls
        (ts, trace_id, group_slug, model, resolved_model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_eur, latency_ms, status, stop_reason)
      VALUES
        (@ts, @trace_id, @group_slug, @model, @resolved_model, @input_tokens, @output_tokens,
         @cache_read_tokens, @cache_creation_tokens, @cost_eur, @latency_ms, @status, @stop_reason)
    `);
    _agentMsgInsertStmt = _gw.prepare(`
      INSERT INTO agent_messages
        (ts, channel_type, platform_id, message_ts, group_slug, session_id,
         prompt_version, input_text, output_text)
      VALUES
        (@ts, @channel_type, @platform_id, @message_ts, @group_slug, @session_id,
         @prompt_version, @input_text, @output_text)
    `);
    // Most-recent match wins if a ts somehow recurs (it shouldn't for Slack).
    _agentMsgLookupStmt = _gw.prepare('SELECT * FROM agent_messages WHERE message_ts = ? ORDER BY id DESC LIMIT 1');
    _feedbackInsertStmt = _gw.prepare(`
      INSERT INTO feedback
        (ts, group_slug, session_id, message_ts, channel, signal, kind, prompt_version, note)
      VALUES
        (@ts, @group_slug, @session_id, @message_ts, @channel, @signal, @kind, @prompt_version, @note)
    `);
    refreshBucketTotals();
    log.info('Gateway DB initialized', { path: dbPath });
  } catch (err) {
    _gw = null;
    _insertStmt = null;
    _agentMsgInsertStmt = null;
    _agentMsgLookupStmt = null;
    _feedbackInsertStmt = null;
    log.error('Gateway DB init failed — logging/caps disabled', { err: String(err) });
  }
}

export interface ApiCallRow {
  ts: string;
  trace_id: string | null;
  group_slug: string | null;
  model: string | null;
  resolved_model?: string | null; // exact model id served (may be absent on error/429 paths)
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
    // Normalize: the named-param insert needs resolved_model present on every row
    // (error/429 call sites omit it).
    _insertStmt.run({ ...row, resolved_model: row.resolved_model ?? null });
    // Keep the in-memory bucket cache tight between refreshes.
    const bucket = bucketForGroup(row.group_slug);
    if (bucket && row.cost_eur) _bucketTotals[bucket] += row.cost_eur;
    // Same for the per-task tally. Only traces already being tracked are
    // updated; an untracked one is seeded from the DB when it is first checked,
    // so nothing is lost by skipping it here.
    if (row.trace_id && row.cost_eur) {
      const st = _traceSpend.get(row.trace_id);
      if (st) {
        st.spent += row.cost_eur;
        st.seen = Date.now();
      }
    }
  } catch (err) {
    log.warn('Gateway: recordApiCall failed', { err: String(err) });
  }
}

// --- Month-to-date cap checks (cached) -----------------------------------

const REFRESH_MS = 30_000;
let _bucketTotals: Record<Bucket, number> = { personal: 0, dev: 0, eval: 0 };
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
  const totals: Record<Bucket, number> = { personal: 0, dev: 0, eval: 0 };
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

// --- Per-task budget gate ------------------------------------------------
//
// A "task" is one `x-trace-id`. The container's claude provider mints one per
// query() and puts it in ANTHROPIC_CUSTOM_HEADERS on that process's env, so it
// rides on EVERY request the turn makes — tool rounds, sub-agents, the lot —
// and on nothing outside the turn. That is exactly the unit a person means by
// "one thing I asked for", as opposed to the sub-steps the agent chooses.
//
// WHY A SOFT GATE, NOT A 429. Rejecting mid-turn kills the turn, throws away
// reasoning already paid for, and reaches the user as an API error rather than
// a question. Instead the proxy appends a directive to the request's system
// prompt telling the agent to stop and ask. The turn then ends normally with a
// summary and a question. The user's reply is a NEW turn with a NEW trace, so
// it starts a fresh allowance — which is also how "ask again at every further
// €3" falls out without any approval-token plumbing.
//
// The hard stop at 2× is the backstop for an agent that ignores the directive
// and keeps calling tools: within ONE trace nothing may ever exceed it.
//
// Occasion: 2026-08-09, when a single admin turn spent €1.01 over 28 calls
// re-deriving the same answer, and nothing in the system could notice.

export const TASK_GATE_EUR = Number(process.env.TASK_GATE_EUR || 3);
export const TASK_HARD_EUR = TASK_GATE_EUR * Number(process.env.TASK_GATE_HARD_MULTIPLE || 2);
const TRACE_TTL_MS = 6 * 60 * 60 * 1000; // forget a trace long after any turn can still be live
const TRACE_MAX = 5000; // hard ceiling on the map, in case TTL pruning never runs

interface TraceState {
  spent: number;
  gatedTier: number; // highest €3 tier already announced to the agent
  hardStopped: boolean; // whether the hard stop has already been recorded once
  seen: number; // last touch, for pruning
}
const _traceSpend = new Map<string, TraceState>();

function pruneTraces(): void {
  const cutoff = Date.now() - TRACE_TTL_MS;
  for (const [id, st] of _traceSpend) {
    if (st.seen < cutoff) _traceSpend.delete(id);
  }
  if (_traceSpend.size > TRACE_MAX) {
    // Oldest-first eviction; Map preserves insertion order.
    const excess = _traceSpend.size - TRACE_MAX;
    let i = 0;
    for (const id of _traceSpend.keys()) {
      if (i++ >= excess) break;
      _traceSpend.delete(id);
    }
  }
}

/** Seed a trace's spend from the DB — covers a proxy restart mid-turn. */
function traceState(traceId: string): TraceState {
  let st = _traceSpend.get(traceId);
  if (st) {
    st.seen = Date.now();
    return st;
  }
  let spent = 0;
  if (_gw) {
    try {
      const row = _gw.prepare('SELECT SUM(cost_eur) AS total FROM api_calls WHERE trace_id = ?').get(traceId) as
        | { total: number | null }
        | undefined;
      spent = row?.total ?? 0;
    } catch (err) {
      log.warn('Gateway: trace-spend seed failed', { err: String(err) });
    }
  }
  st = { spent, gatedTier: Math.floor(spent / TASK_GATE_EUR), hardStopped: false, seen: Date.now() };
  _traceSpend.set(traceId, st);
  if (_traceSpend.size % 500 === 0) pruneTraces();
  return st;
}

export type TaskGateAction = 'ok' | 'gate' | 'hard';
export interface TaskBudgetStatus {
  spent_eur: number;
  gate_eur: number;
  hard_eur: number;
  tier: number;
  action: TaskGateAction;
  /** First time this decision was reached for this trace — the caller logs only these. */
  record: boolean;
}

/**
 * Where this task stands against its allowance.
 *
 * 'gate' is returned ONCE per €3 tier — calling this marks the tier announced,
 * so a turn is not told to stop on every request after it crosses. Returns null
 * when there is nothing to enforce (no trace id, DB down): the fail-open path.
 *
 * A task is NEVER hard-stopped without having been asked to stop nicely first.
 * Measured 2026-08-09: with the gate at €0.05 for a test, a single first call
 * cost €0.15 and cleared the soft gate AND the hard limit at once, so the turn
 * was killed before it could say anything and the user got "On it — running
 * health check…" as the final answer. That is precisely the truncated non-answer
 * the soft gate exists to prevent, so crossing both at once now yields a gate,
 * and only the request after it can be hard-stopped.
 */
export function checkTaskBudget(traceId: string | null): TaskBudgetStatus | null {
  if (!_gw || !traceId || !(TASK_GATE_EUR > 0)) return null;
  try {
    const st = traceState(traceId);
    const tier = Math.floor(st.spent / TASK_GATE_EUR);
    const base = { spent_eur: st.spent, gate_eur: TASK_GATE_EUR, hard_eur: TASK_HARD_EUR, tier };
    if (st.spent >= TASK_HARD_EUR) {
      if (st.gatedTier === 0) {
        // Blew past everything on one call and was never warned — warn now.
        st.gatedTier = tier;
        return { ...base, action: 'gate', record: true };
      }
      const first = !st.hardStopped;
      st.hardStopped = true;
      // Claude Code retries a 429, so without `record` one hard stop would
      // write a row per retry (five, when this was measured).
      return { ...base, action: 'hard', record: first };
    }
    if (tier > st.gatedTier) {
      st.gatedTier = tier;
      return { ...base, action: 'gate', record: true };
    }
    return { ...base, action: 'ok', record: false };
  } catch (err) {
    log.warn('Gateway: task-budget check failed', { err: String(err) });
    return null;
  }
}

/** Audit row so a gate that fired is visible afterwards, not just in the log. */
export function recordTaskGate(row: {
  trace_id: string | null;
  group_slug: string | null;
  action: TaskGateAction;
  spent_eur: number;
  gate_eur: number;
}): void {
  if (!_gw) return;
  try {
    _gw
      .prepare(
        `INSERT INTO task_gates (ts, trace_id, group_slug, action, spent_eur, gate_eur)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), row.trace_id, row.group_slug, row.action, row.spent_eur, row.gate_eur);
  } catch (err) {
    log.warn('Gateway: recordTaskGate failed', { err: String(err) });
  }
}

// --- Daily cap for host-side callers -------------------------------------
//
// `rag` and any future host CLI tool are uncapped by design (fail-open:
// an unknown slug must never brick an agent). That is also how 2026-08-08 saw
// €40.14 of eval traffic in seven hours with nothing to notice it. These calls
// carry no trace id, so the per-task gate cannot see them; this is their
// backstop — deliberately generous, meant to stop a runaway, not to police a
// normal day of prompt tuning.
//
// `eval` is bucketed now (€50/mo) but keeps this daily guard as well, because
// a month-to-date cap cannot stop the failure that actually happened: €40.14
// burned in seven hours, comfortably inside any monthly figure. Slugs listed
// in DAILY_GUARDED are checked here even though bucketForGroup() knows them.
const UNCAPPED_DAILY_EUR = Number(process.env.UNCAPPED_DAILY_EUR || 25);
const DAILY_GUARDED = new Set(['eval', 'rag']);

export interface DailyStatus {
  group: string;
  spent_eur: number;
  cap_eur: number;
  overCap: boolean;
}

export function checkUncappedDaily(slug: string | null): DailyStatus | null {
  if (!_gw || !slug || !(UNCAPPED_DAILY_EUR > 0)) return null;
  if (bucketForGroup(slug) && !DAILY_GUARDED.has(slug)) return null;
  try {
    const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const row = _gw
      .prepare('SELECT SUM(cost_eur) AS total FROM api_calls WHERE group_slug = ? AND ts >= ?')
      .get(slug, dayStart) as { total: number | null } | undefined;
    const spent = row?.total ?? 0;
    return { group: slug, spent_eur: spent, cap_eur: UNCAPPED_DAILY_EUR, overCap: spent >= UNCAPPED_DAILY_EUR };
  } catch (err) {
    log.warn('Gateway: uncapped-daily check failed', { err: String(err) });
    return null;
  }
}

// --- T1.3: outbound message index + feedback capture ---------------------

// Cap stored transcript text so a runaway message can't bloat the index.
const TEXT_CAP = 4000;
function trunc(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) : s;
}

export interface AgentMessageInput {
  channel_type: string | null;
  platform_id: string | null;
  message_ts: string;
  group_slug: string | null;
  session_id: string | null;
  prompt_version: string | null;
  input_text: string | null;
  output_text: string | null;
}

export interface AgentMessageRow extends AgentMessageInput {
  id: number;
  ts: string;
}

/**
 * Record a delivered agent chat reply so a later reaction on it can be
 * attributed. Best-effort: never throws into the delivery path.
 */
export function recordAgentMessage(row: AgentMessageInput): void {
  if (!_gw || !_agentMsgInsertStmt) return;
  try {
    _agentMsgInsertStmt.run({
      ts: new Date().toISOString(),
      channel_type: row.channel_type,
      platform_id: row.platform_id,
      message_ts: row.message_ts,
      group_slug: row.group_slug,
      session_id: row.session_id,
      prompt_version: row.prompt_version,
      input_text: trunc(row.input_text),
      output_text: trunc(row.output_text),
    });
  } catch (err) {
    log.warn('Gateway: recordAgentMessage failed', { err: String(err) });
  }
}

/** Look up the agent message a reaction targets, by platform message id (ts). */
export function lookupAgentMessage(messageTs: string): AgentMessageRow | null {
  if (!_gw || !_agentMsgLookupStmt) return null;
  try {
    return (_agentMsgLookupStmt.get(messageTs) as AgentMessageRow | undefined) ?? null;
  } catch (err) {
    log.warn('Gateway: lookupAgentMessage failed', { err: String(err) });
    return null;
  }
}

export interface FeedbackInput {
  group_slug: string | null;
  session_id: string | null;
  message_ts: string | null;
  channel: string | null;
  signal: string; // 'up' | 'down' | 'raw:<emoji>'
  kind: string; // 'explicit_reaction' | 'implicit_correction'
  prompt_version: string | null;
  note: string | null;
}

/** Insert one feedback row. Best-effort. */
export function recordFeedback(row: FeedbackInput): void {
  if (!_gw || !_feedbackInsertStmt) return;
  try {
    _feedbackInsertStmt.run({ ts: new Date().toISOString(), ...row });
  } catch (err) {
    log.warn('Gateway: recordFeedback failed', { err: String(err) });
  }
}
