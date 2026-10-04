/**
 * What this pins: a run's trace comes back in the order the messages were
 * sent, labelled with what the person wrote, and old runs are pruned so a
 * debugging aid cannot grow into a disk alert.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FlowTaskStore, TRACE_KEEP_DAYS } from './tasks.js';

let tmp: string;
let store: FlowTaskStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-trace-'));
  store = new FlowTaskStore(path.join(tmp, 'flow-tasks.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ev = (
  run: string,
  from: string,
  out: string,
  to: string,
  inp: string,
  data: unknown,
  ts = '2026-10-03T16:06:00.000Z',
) => ({
  run,
  ts,
  from,
  out,
  to,
  in: inp,
  data: JSON.stringify(data),
});

describe('flow traces', () => {
  it('keeps send order across batches and labels the run with the entry text', () => {
    store.appendTrace('fJX', [ev('r1', 'n_route', 'output', 'n_find_task', 'input', { text: 'ikonu chcem ako SVG' })]);
    store.appendTrace('fJX', [
      ev('r1', 'n_find_task', 'output', 'n_find_req', 'payload', { thread_id: 't' }),
      ev('r1', 'n_has_task', 'output2', 'n_accept_resume', 'input', { text: 'x' }),
    ]);
    const r = store.getRun('r1')!;
    expect(r.run.label).toBe('ikonu chcem ako SVG');
    expect(r.run.events).toBe(3);
    expect(r.events.map((e) => [e.seq, e.from_id, e.from_port, e.to_id])).toEqual([
      [1, 'n_route', 'output', 'n_find_task'],
      [2, 'n_find_task', 'output', 'n_find_req'],
      [3, 'n_has_task', 'output2', 'n_accept_resume'],
    ]);
  });

  it('lists the newest runs first, per flow', () => {
    store.appendTrace('fJX', [ev('old', 'a', 'output', 'b', 'input', {}, '2026-10-03T10:00:00.000Z')]);
    store.appendTrace('fJX', [ev('new', 'a', 'output', 'b', 'input', {}, '2026-10-03T11:00:00.000Z')]);
    store.appendTrace('other', [ev('x', 'a', 'output', 'b', 'input', {})]);
    expect(store.listRuns('fJX').map((r) => r.run_id)).toEqual(['new', 'old']);
  });

  it(`prunes runs older than ${TRACE_KEEP_DAYS} days on append`, () => {
    store.appendTrace(
      'fJX',
      [ev('ancient', 'a', 'output', 'b', 'input', {}, '2026-09-01T00:00:00.000Z')],
      new Date('2026-09-01T00:00:01Z'),
    );
    store.appendTrace('fJX', [ev('fresh', 'a', 'output', 'b', 'input', {})], new Date('2026-10-03T16:06:00Z'));
    expect(store.getRun('ancient')).toBeNull();
    expect(store.getRun('fresh')).not.toBeNull();
  });

  it('truncates oversized data and rejects an event without a run id', () => {
    store.appendTrace('fJX', [{ run: 'big', from: 'a', to: 'b', data: 'x'.repeat(20_000) }]);
    expect(store.getRun('big')!.events[0].data!.length).toBe(16_000);
    expect(() => store.appendTrace('fJX', [{ from: 'a' }])).toThrow(/run id/);
  });
});
