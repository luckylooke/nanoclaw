/**
 * What this pins: a waiting flow step resumes only on the exact thread it is
 * waiting on, and the store keeps a loop's round counter and history — the
 * two things every human-in-the-loop and implement→review loop is built from.
 *
 * The "no thread, no match" rule is the safety-critical one: a top-level
 * message in a channel must never be swallowed by a task that happens to be
 * waiting in that channel.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: vi.fn(() => null) }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroupByPlatform: vi.fn() }));

import { makeFlowTaskHandler, replyThreadId } from './index.js';
import { FlowTaskStore } from './tasks.js';

let tmp: string;
let store: FlowTaskStore;
let server: http.Server | null = null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tasks-'));
  store = new FlowTaskStore(path.join(tmp, 'flow-tasks.db'));
});
afterEach(() => {
  server?.close();
  server = null;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ADDR = { channel_type: 'slack', platform_id: 'slack:C0B6B8A1MEV', instance: 'slack' };
const THREAD = 'slack:C0B6B8A1MEV:1791026220.871429';

async function post(route: string, body: unknown) {
  server = http.createServer((req, res) => void makeFlowTaskHandler(() => store)(req, res));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  server.close();
  server = null;
  return { status: res.status, json };
}

describe('FlowTaskStore', () => {
  it('finds an open task only on its exact thread', () => {
    const t = store.create({ flow: 'inbound', step: 'proposal', ...ADDR, thread_id: THREAD, data: { text: 'x' } });
    expect(store.findOpen('slack', 'slack:C0B6B8A1MEV', THREAD)?.id).toBe(t.id);
    expect(store.findOpen('slack', 'slack:C0B6B8A1MEV', 'slack:C0B6B8A1MEV:1.2')).toBeNull();
    expect(store.findOpen('slack', 'slack:C0OTHER', THREAD)).toBeNull();
  });

  it('never matches a top-level message, even with a task waiting in the channel', () => {
    store.create({ flow: 'inbound', step: 'proposal', ...ADDR, thread_id: null });
    expect(store.findOpen('slack', 'slack:C0B6B8A1MEV', null)).toBeNull();
  });

  it('a closed task no longer resumes', () => {
    const t = store.create({ flow: 'inbound', step: 'proposal', ...ADDR, thread_id: THREAD });
    store.update(t.id, { status: 'approved', event: { decision: 'approve' } });
    expect(store.findOpen('slack', 'slack:C0B6B8A1MEV', THREAD)).toBeNull();
  });

  it('counts rounds, merges data and keeps the history of a loop', () => {
    const t = store.create({
      flow: 'inbound',
      step: 'proposal',
      ...ADDR,
      thread_id: THREAD,
      data: { a: 1 },
      event: { kind: 'proposed' },
    });
    const u = store.update(t.id, { attempt: 2, data: { b: 2 }, event: { kind: 'revise', feedback: 'use tokens' } });
    expect(u.attempt).toBe(2);
    expect(u.data).toEqual({ a: 1, b: 2 });
    expect(u.history.map((e) => e.kind)).toEqual(['proposed', 'revise']);
  });

  it('keeps only the newest 50 history events', () => {
    const t = store.create({ flow: 'inbound', step: 's', ...ADDR, thread_id: THREAD });
    for (let i = 0; i < 60; i++) store.update(t.id, { event: { i } });
    const h = store.get(t.id)!.history;
    expect(h).toHaveLength(50);
    expect(h[49].i).toBe(59);
  });

  it('a task being written is open: a reply on its thread finds it, and so does its key', () => {
    const t = store.create({
      flow: 'inbound',
      step: 'intake',
      status: 'writing',
      ...ADDR,
      thread_id: THREAD,
      data: { key: 'k1' },
    });
    expect(store.findOpen('slack', 'slack:C0B6B8A1MEV', THREAD)?.id).toBe(t.id);
    expect(store.findOpenByKey('k1')?.id).toBe(t.id);
  });

  it('lists the open tasks of a flow for triage, without closed ones or other flows', () => {
    store.create({
      flow: 'inbound',
      step: 'spec',
      ...ADDR,
      thread_id: THREAD,
      data: { key: 'a', title: 'Ikona', request: 'r', project: 'dev-web/x' },
    });
    const closed = store.create({
      flow: 'inbound',
      step: 'spec',
      ...ADDR,
      thread_id: 'slack:C0B6B8A1MEV:2.2',
      data: { key: 'b' },
    });
    store.update(closed.id, { status: 'cancelled' });
    store.create({ flow: 'other', step: 's', ...ADDR, data: { key: 'c' } });
    store.create({ flow: 'inbound', step: 'clarify_project', ...ADDR, data: {} }); // no key yet: not listed
    expect(store.listOpen('inbound')).toEqual([
      {
        key: 'a',
        title: 'Ikona',
        request: 'r',
        project: 'dev-web/x',
        step: 'spec',
        status: 'awaiting_user',
        thread_id: THREAD,
      },
    ]);
  });

  it('lists the most recently touched task first, and at most 30', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    const a = store.create({ flow: 'inbound', step: 'spec', ...ADDR, data: { key: 'a' } });
    vi.setSystemTime(new Date('2026-10-14T10:01:00Z'));
    store.create({ flow: 'inbound', step: 'spec', ...ADDR, data: { key: 'b' } });
    vi.setSystemTime(new Date('2026-10-14T10:02:00Z'));
    store.update(a.id, { event: { kind: 'touched' } });
    vi.useRealTimers();
    expect(store.listOpen('inbound').map((t) => t.key)).toEqual(['a', 'b']);
    for (let i = 0; i < 35; i++) store.create({ flow: 'inbound', step: 'spec', ...ADDR, data: { key: `k${i}` } });
    for (let i = 0; i < 40; i++) store.create({ flow: 'inbound', step: 'clarify_project', ...ADDR, data: {} }); // keyless, newest
    expect(store.listOpen('inbound')).toHaveLength(30);
  });

  it('rejects an unknown status and a bad attempt', () => {
    expect(() => store.create({ flow: 'f', step: 's', ...ADDR, status: 'waiting' })).toThrow(/status must be/);
    const t = store.create({ flow: 'f', step: 's', ...ADDR });
    expect(() => store.update(t.id, { attempt: 0 })).toThrow(/attempt/);
  });
});

describe('flow-task endpoints', () => {
  it('create → find-open → update round-trips over HTTP', async () => {
    const c = await post('/flow-task/create', {
      flow: 'inbound',
      step: 'proposal',
      ...ADDR,
      thread_id: THREAD,
      data: { text: 't' },
    });
    expect(c.status).toBe(200);
    const id = (c.json.task as { id: string }).id;
    const f = await post('/flow-task/find-open', { ...ADDR, thread_id: THREAD });
    expect((f.json.task as { id: string }).id).toBe(id);
    const u = await post('/flow-task/update', { id, status: 'approved' });
    expect((u.json.task as { status: string }).status).toBe('approved');
    const g = await post('/flow-task/find-open', { ...ADDR, thread_id: THREAD });
    expect(g.json.task).toBeNull();
  });

  it('list-open answers the open tasks of the named flow', async () => {
    store.create({ flow: 'inbound', step: 'spec', ...ADDR, thread_id: THREAD, data: { key: 'a' } });
    const r = await post('/flow-task/list-open', { flow: 'inbound' });
    expect(r.status).toBe(200);
    expect((r.json.tasks as Array<{ key: string }>).map((t) => t.key)).toEqual(['a']);
    expect((await post('/flow-task/list-open', {})).status).toBe(400);
  });

  it('answers 400 with the reason for bad input, 404 for unknown paths', async () => {
    expect((await post('/flow-task/create', { flow: 'inbound' })).status).toBe(400);
    expect((await post('/flow-task/update', { id: 'ft-missing' })).status).toBe(400);
    expect((await post('/flow-task/delete', {})).status).toBe(404);
  });
});

describe('replyThreadId', () => {
  it('keeps an existing thread, starts one from a top-level post, and has none on the CLI', () => {
    expect(replyThreadId('slack', 'slack:C1', 'slack:C1:9.9', '1.1')).toBe('slack:C1:9.9');
    expect(replyThreadId('slack', 'slack:C1', null, '1791026220.871429')).toBe('slack:C1:1791026220.871429');
    expect(replyThreadId('cli', 'local', null, 'm1')).toBeNull();
    expect(replyThreadId('slack', 'slack:C1', null, undefined)).toBeNull();
  });
});
