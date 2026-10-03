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
    `);
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

  close(): void {
    this.db.close();
  }
}
