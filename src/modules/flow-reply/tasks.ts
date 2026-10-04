/**
 * Flow tasks — the state a Total.js Flow process keeps between messages.
 *
 * A flow message lives in memory: a Flow restart drops it, and a person may
 * answer hours later. So a step that waits — for a human to confirm, or for
 * an agent to finish — ends by saving its state here and stopping; the next
 * inbound message on the same thread finds the open task and the flow
 * resumes it. Every loop in a flow (repeat a step until the user is happy,
 * implement → review → implement) is this store plus a counter.
 *
 * Its own SQLite file (data/flow-tasks.db), like gateway.db: nothing in the
 * central schema depends on it, and a broken flow cannot corrupt v2.db. It
 * lives under data/, so the nightly backups carry it and no agent container
 * can write it.
 *
 * Correlation is by (channel_type, platform_id, thread_id) and a thread is
 * REQUIRED to resume: a top-level message never resumes a task, so ordinary
 * chat in a channel can never be swallowed by a waiting flow.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import Database from 'better-sqlite3';

export const TASK_STATUSES = [
  'awaiting_user',
  'awaiting_agent',
  'approved',
  'done',
  'cancelled',
  'stalled',
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const OPEN: TaskStatus[] = ['awaiting_user', 'awaiting_agent'];
const MAX_DATA_BYTES = 64 * 1024;
const MAX_HISTORY = 50;

export interface FlowTask {
  id: string;
  flow: string;
  status: TaskStatus;
  step: string;
  attempt: number;
  channel_type: string;
  platform_id: string;
  instance: string | null;
  thread_id: string | null;
  data: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

interface Row extends Omit<FlowTask, 'data' | 'history'> {
  data: string;
  history: string;
}

const fromRow = (r: Row): FlowTask => ({ ...r, data: JSON.parse(r.data), history: JSON.parse(r.history) });

function isStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

function boundedJson(value: unknown, what: string): string {
  const json = JSON.stringify(value ?? {});
  if (Buffer.byteLength(json) > MAX_DATA_BYTES) throw new TaskInputError(`${what} over ${MAX_DATA_BYTES} bytes`);
  return json;
}

export class TaskInputError extends Error {}

export class FlowTaskStore {
  private db: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flow_tasks (
        id           TEXT PRIMARY KEY,
        flow         TEXT NOT NULL,
        status       TEXT NOT NULL,
        step         TEXT NOT NULL,
        attempt      INTEGER NOT NULL DEFAULT 1,
        channel_type TEXT NOT NULL,
        platform_id  TEXT NOT NULL,
        instance     TEXT,
        thread_id    TEXT,
        data         TEXT NOT NULL DEFAULT '{}',
        history      TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_flow_tasks_thread
        ON flow_tasks(channel_type, platform_id, thread_id, status);

      -- Run traces: every message one node sent to another, so a run can be
      -- laid back over the diagram (which nodes, which ports, what went in and
      -- out). Written by the Trace recorder component inside the flow.
      CREATE TABLE IF NOT EXISTS flow_runs (
        run_id     TEXT PRIMARY KEY,
        flow       TEXT NOT NULL,
        label      TEXT,
        started_at TEXT NOT NULL,
        last_at    TEXT NOT NULL,
        events     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_flow_runs_last ON flow_runs(flow, last_at);
      CREATE TABLE IF NOT EXISTS flow_trace (
        run_id    TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        ts        TEXT NOT NULL,
        from_id   TEXT,
        from_port TEXT,
        to_id     TEXT,
        to_port   TEXT,
        data      TEXT,
        PRIMARY KEY (run_id, seq)
      );
    `);
    // msg_id / prev_id (2026-10-04): the recorder stamps each delivered message
    // with an id, and Flow copies a message's id into the previd of every message
    // a node derives from it — so an output can be tied to the exact run of the
    // node that produced it, which a node run several times in one flow needs.
    // Agent jobs: work a flow hands to a dev agent (implementation…). The agent
    // works in a real thread of its own channel; the job row ties that thread to
    // the flow task, so the agent's final message can call the flow back.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flow_jobs (
        key         TEXT PRIMARY KEY,
        agent       TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        finished_at TEXT,
        result      TEXT,
        callback    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_flow_jobs_thread ON flow_jobs(platform_id, thread_id, status);
    `);
    const cols = (this.db.prepare('PRAGMA table_info(flow_trace)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('msg_id')) this.db.exec('ALTER TABLE flow_trace ADD COLUMN msg_id TEXT');
    if (!cols.includes('prev_id')) this.db.exec('ALTER TABLE flow_trace ADD COLUMN prev_id TEXT');
  }

  get(id: string): FlowTask | null {
    const r = this.db.prepare('SELECT * FROM flow_tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  create(input: {
    flow: string;
    step: string;
    status?: unknown;
    channel_type: string;
    platform_id: string;
    instance?: string | null;
    thread_id?: string | null;
    data?: unknown;
    event?: Record<string, unknown>;
  }): FlowTask {
    const status = input.status === undefined ? 'awaiting_user' : input.status;
    if (!isStatus(status)) throw new TaskInputError(`status must be one of ${TASK_STATUSES.join(', ')}`);
    const now = new Date().toISOString();
    const history = input.event ? [{ ts: now, ...input.event }] : [];
    const id = `ft-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO flow_tasks (id, flow, status, step, attempt, channel_type, platform_id, instance, thread_id, data, history, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.flow,
        status,
        input.step,
        input.channel_type,
        input.platform_id,
        input.instance ?? null,
        input.thread_id ?? null,
        boundedJson(input.data, 'data'),
        boundedJson(history, 'history'),
        now,
        now,
      );
    return this.get(id) as FlowTask;
  }

  /** The newest open task on this exact thread, or null. No thread → never a match. */
  findOpen(channelType: string, platformId: string, threadId: string | null): FlowTask | null {
    if (!threadId) return null;
    const r = this.db
      .prepare(
        `SELECT * FROM flow_tasks
          WHERE channel_type = ? AND platform_id = ? AND thread_id = ? AND status IN (${OPEN.map(() => '?').join(',')})
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(channelType, platformId, threadId, ...OPEN) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** Shallow-merges `data`, appends `event` to the history (newest 50 kept). */
  update(
    id: string,
    patch: {
      status?: unknown;
      step?: unknown;
      attempt?: unknown;
      thread_id?: unknown;
      data?: unknown;
      event?: Record<string, unknown>;
    },
  ): FlowTask {
    const cur = this.get(id);
    if (!cur) throw new TaskInputError(`no task ${id}`);
    if (patch.status !== undefined && !isStatus(patch.status)) {
      throw new TaskInputError(`status must be one of ${TASK_STATUSES.join(', ')}`);
    }
    if (patch.attempt !== undefined && !(Number.isInteger(patch.attempt) && (patch.attempt as number) >= 1)) {
      throw new TaskInputError('attempt must be a positive integer');
    }
    if (
      patch.data !== undefined &&
      (typeof patch.data !== 'object' || patch.data === null || Array.isArray(patch.data))
    ) {
      throw new TaskInputError('data must be an object');
    }
    const now = new Date().toISOString();
    const history = patch.event ? [...cur.history, { ts: now, ...patch.event }].slice(-MAX_HISTORY) : cur.history;
    const next = {
      status: (patch.status as TaskStatus | undefined) ?? cur.status,
      step: typeof patch.step === 'string' && patch.step ? patch.step : cur.step,
      attempt: (patch.attempt as number | undefined) ?? cur.attempt,
      thread_id: typeof patch.thread_id === 'string' && patch.thread_id ? patch.thread_id : cur.thread_id,
      data: patch.data ? { ...cur.data, ...(patch.data as Record<string, unknown>) } : cur.data,
    };
    this.db
      .prepare(
        'UPDATE flow_tasks SET status = ?, step = ?, attempt = ?, thread_id = ?, data = ?, history = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.status,
        next.step,
        next.attempt,
        next.thread_id,
        boundedJson(next.data, 'data'),
        boundedJson(history, 'history'),
        now,
        id,
      );
    return this.get(id) as FlowTask;
  }

  /**
   * Append recorder events. Each event: { run, ts, from, out, to, in, data } where
   * data is already a (truncated) JSON string. A run's label is the first event's
   * data.text, which for the entry message is what the person wrote. Runs older
   * than TRACE_KEEP_DAYS are pruned on the way in — a trace is for debugging, and
   * a debugging aid that grows without bound becomes a disk alert.
   */
  appendTrace(flow: string, events: TraceEvent[], now = new Date()): number {
    const insertRun = this.db.prepare(
      `INSERT INTO flow_runs (run_id, flow, label, started_at, last_at, events) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(run_id) DO NOTHING`,
    );
    const bump = this.db.prepare(
      'UPDATE flow_runs SET last_at = ?, events = events + 1 WHERE run_id = ? RETURNING events',
    );
    const insertEvent = this.db.prepare(
      'INSERT OR IGNORE INTO flow_trace (run_id, seq, ts, from_id, from_port, to_id, to_port, data, msg_id, prev_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const run = this.db.transaction((evs: TraceEvent[]) => {
      let n = 0;
      for (const e of evs) {
        if (typeof e?.run !== 'string' || !e.run) throw new TaskInputError('every event needs a run id');
        const ts = typeof e.ts === 'string' ? e.ts : now.toISOString();
        const data = typeof e.data === 'string' ? e.data.slice(0, MAX_TRACE_DATA) : null;
        insertRun.run(e.run, flow, labelOf(data), ts, ts);
        const { events: seq } = bump.get(ts, e.run) as { events: number };
        insertEvent.run(e.run, seq, ts, str(e.from), str(e.out), str(e.to), str(e.in), data, str(e.mid), str(e.prev));
        n++;
      }
      return n;
    });
    const n = run(events);
    const cutoff = new Date(now.getTime() - TRACE_KEEP_DAYS * 86400_000).toISOString();
    const old = this.db.prepare('SELECT run_id FROM flow_runs WHERE last_at < ?').all(cutoff) as { run_id: string }[];
    for (const { run_id } of old) {
      this.db.prepare('DELETE FROM flow_trace WHERE run_id = ?').run(run_id);
      this.db.prepare('DELETE FROM flow_runs WHERE run_id = ?').run(run_id);
    }
    return n;
  }

  listRuns(flow: string | null, limit = 50): FlowRun[] {
    const lim = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    return (
      flow
        ? this.db.prepare('SELECT * FROM flow_runs WHERE flow = ? ORDER BY last_at DESC LIMIT ?').all(flow, lim)
        : this.db.prepare('SELECT * FROM flow_runs ORDER BY last_at DESC LIMIT ?').all(lim)
    ) as FlowRun[];
  }

  getRun(runId: string): { run: FlowRun; events: TraceRow[] } | null {
    const run = this.db.prepare('SELECT * FROM flow_runs WHERE run_id = ?').get(runId) as FlowRun | undefined;
    if (!run) return null;
    const events = this.db.prepare('SELECT * FROM flow_trace WHERE run_id = ? ORDER BY seq').all(runId) as TraceRow[];
    return { run, events };
  }

  /** The newest open task whose data.key is this flow key (an agent job's callback carries only the key). */
  findOpenByKey(key: string): FlowTask | null {
    const r = this.db
      .prepare(
        `SELECT * FROM flow_tasks WHERE json_extract(data, '$.key') = ? AND status IN (${OPEN.map(() => '?').join(',')})
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(key, ...OPEN) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** One running job per key: a new dispatch for the same key replaces the old (a re-implementation round). */
  startJob(job: { key: string; agent: string; platform_id: string; thread_id: string }): FlowJob {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO flow_jobs (key, agent, platform_id, thread_id, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)
         ON CONFLICT(key) DO UPDATE SET agent = excluded.agent, platform_id = excluded.platform_id, thread_id = excluded.thread_id,
           status = 'running', created_at = excluded.created_at, finished_at = NULL, result = NULL, callback = NULL`,
      )
      .run(job.key, job.agent, job.platform_id, job.thread_id, now);
    return this.getJob(job.key) as FlowJob;
  }

  getJob(key: string): FlowJob | null {
    return (this.db.prepare('SELECT * FROM flow_jobs WHERE key = ?').get(key) as FlowJob | undefined) ?? null;
  }

  runningJobOnThread(platformId: string, threadId: string): FlowJob | null {
    return (
      (this.db
        .prepare("SELECT * FROM flow_jobs WHERE platform_id = ? AND thread_id = ? AND status = 'running' LIMIT 1")
        .get(platformId, threadId) as FlowJob | undefined) ?? null
    );
  }

  finishJob(key: string, status: 'done' | 'blocked', result: string): void {
    this.db
      .prepare("UPDATE flow_jobs SET status = ?, result = ?, finished_at = ? WHERE key = ? AND status = 'running'")
      .run(status, result.slice(0, 20000), new Date().toISOString(), key);
  }

  noteCallback(key: string, outcome: string): void {
    this.db.prepare('UPDATE flow_jobs SET callback = ? WHERE key = ?').run(outcome.slice(0, 500), key);
  }

  close(): void {
    this.db.close();
  }
}

export interface FlowJob {
  key: string;
  agent: string;
  platform_id: string;
  thread_id: string;
  status: 'running' | 'done' | 'blocked';
  created_at: string;
  finished_at: string | null;
  result: string | null;
  callback: string | null;
}

export const TRACE_KEEP_DAYS = 7;
const MAX_TRACE_DATA = 16_000;

export interface TraceEvent {
  run?: unknown;
  ts?: unknown;
  from?: unknown;
  out?: unknown;
  to?: unknown;
  in?: unknown;
  data?: unknown;
  /** id the recorder stamped on the delivered message */
  mid?: unknown;
  /** id of the message the sender was handling when it sent this one */
  prev?: unknown;
}
export interface FlowRun {
  run_id: string;
  flow: string;
  label: string | null;
  started_at: string;
  last_at: string;
  events: number;
}
export interface TraceRow {
  run_id: string;
  seq: number;
  ts: string;
  from_id: string | null;
  from_port: string | null;
  to_id: string | null;
  to_port: string | null;
  data: string | null;
  msg_id: string | null;
  prev_id: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : null);

function labelOf(data: string | null): string | null {
  if (!data) return null;
  try {
    const d = JSON.parse(data) as { text?: unknown };
    return typeof d?.text === 'string' ? d.text.slice(0, 160) : null;
  } catch {
    return null;
  }
}
