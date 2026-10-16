/**
 * What this pins: a flow can hand a phase to a dev agent and hear back exactly
 * once, when the agent says it is done or blocked.
 * - dispatch posts the brief in the agent's channel, routes it to the agent on
 *   that thread in the owner's name, and records the job;
 * - only a message carrying the job's own marker closes the job and calls the
 *   flow back; progress messages and other keys are ignored;
 * - bad input never reaches a channel.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import {
  cancelJob,
  dispatch,
  DispatchError,
  nudgeText,
  onAgentMessage,
  SILENT_MS,
  sweepSilentJobs,
  type DispatchDeps,
} from './agent.js';
import { FlowTaskStore } from './tasks.js';

let tmp: string;
let store: FlowTaskStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-agent-'));
  store = new FlowTaskStore(path.join(tmp, 'flow-tasks.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CHANNEL = { channel_type: 'slack', platform_id: 'slack:C0B69CZRS9Y', instance: 'slack' };
function deps(over: Partial<DispatchDeps> = {}) {
  const deliver = vi.fn(async (..._a: unknown[]): Promise<string | undefined> => '1791200000.000100');
  const route = vi.fn(async (_e: InboundEvent) => {});
  const d: DispatchDeps = {
    store: () => store,
    getAdapter: () => ({ deliver }),
    agentChannel: async (a) => (a === 'dev-web' ? CHANNEL : null),
    ownerHandle: async () => 'U0B65PNMT0C',
    route,
    ...over,
  };
  return { d, deliver, route };
}

describe('dispatch', () => {
  it('posts the brief, routes it to the agent on that thread as the owner, and records the job', async () => {
    const { d, deliver, route } = deps();
    const r = await dispatch({ key: 'muu2phfhzzmk', agent: 'dev-web', text: 'Implement the Instagram link.' }, d);
    expect(r.thread_id).toBe('slack:C0B69CZRS9Y:1791200000.000100');
    expect(deliver).toHaveBeenCalledWith(
      'slack',
      'slack:C0B69CZRS9Y',
      null,
      'chat',
      expect.stringContaining('muu2phfhzzmk'),
      undefined,
      'slack',
    );
    const event = route.mock.calls[0][0];
    expect(event.threadId).toBe(r.thread_id);
    expect(event.message.isMention).toBe(true);
    expect(JSON.parse(event.message.content)).toMatchObject({
      text: 'Implement the Instagram link.',
      senderId: 'U0B65PNMT0C',
    });
    expect(store.getJob('muu2phfhzzmk')?.status).toBe('running');
  });

  it("continues only the job's own thread, and re-opens the job", async () => {
    const { d, deliver, route } = deps();
    await expect(dispatch({ key: 'abcd1234', agent: 'dev-web', text: 'fix', continue: true }, d)).rejects.toThrow(
      /no dev-web job/,
    );
    const first = await dispatch({ key: 'abcd1234', agent: 'dev-web', text: 'build it' }, d);
    await expect(dispatch({ key: 'abcd1234', agent: 'dev-web', text: 'again' }, d)).rejects.toThrow(/still running/);
    store.finishJob('abcd1234', 'done', 'report');
    const again = await dispatch({ key: 'abcd1234', agent: 'dev-web', text: 'fix the label', continue: true }, d);
    expect(again.thread_id).toBe(first.thread_id);
    expect(deliver.mock.calls[1][2]).toBe(first.thread_id);
    expect(route.mock.calls[1][0].threadId).toBe(first.thread_id);
    expect(store.getJob('abcd1234')?.status).toBe('running');
  });

  it("a later step of the same task goes into the task's existing thread, not a new one", async () => {
    const { d, deliver, route } = deps();
    const first = await dispatch({ key: 'tt66tt66', agent: 'dev-web', text: 'clarify the spec' }, d);
    store.finishJob('tt66tt66', 'done', 'decisions');
    const next = await dispatch({ key: 'tt66tt66', agent: 'dev-web', text: 'clarify the design' }, d);
    expect(next.thread_id).toBe(first.thread_id);
    expect(deliver.mock.calls[0][2]).toBeNull();
    expect(deliver.mock.calls[1][2]).toBe(first.thread_id);
    expect(String(deliver.mock.calls[1][4])).toMatch(/next step/);
    expect(route.mock.calls[1][0].threadId).toBe(first.thread_id);
    expect(store.getJob('tt66tt66')?.status).toBe('running');
  });

  it('refuses bad input before touching any channel', async () => {
    const { d, deliver } = deps();
    await expect(dispatch({ key: 'BAD KEY', agent: 'dev-web', text: 'x' }, d)).rejects.toThrow(DispatchError);
    await expect(dispatch({ key: 'abcd1234-' + 'x'.repeat(60), agent: 'dev-web', text: 'x' }, d)).rejects.toThrow(
      DispatchError,
    );
    await expect(dispatch({ key: 'abcd1234--x', agent: 'dev-web', text: 'x' }, d)).rejects.toThrow(DispatchError);
    await expect(dispatch({ key: 'abcd1234', agent: 'admin', text: 'x' }, d)).rejects.toThrow(/agent must be/);
    await expect(dispatch({ key: 'abcd1234', agent: 'dev-game', text: 'x' }, d)).rejects.toThrow(/not wired/);
    await expect(dispatch({ key: 'abcd1234', agent: 'dev-web', text: '' }, d)).rejects.toThrow(/text is required/);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('tells the agent in its thread and closes the job; nothing to do for an unknown or finished job', async () => {
    const { d, deliver } = deps();
    const r = await dispatch({ key: 'xx44xx44', agent: 'dev-web', text: 'clarify' }, d);
    expect(await cancelJob({ key: 'xx44xx44' }, d)).toEqual({ cancelled: true, thread_id: r.thread_id });
    expect(deliver.mock.calls[1][2]).toBe(r.thread_id);
    expect(String(deliver.mock.calls[1][4])).toMatch(/was cancelled/);
    expect(store.getJob('xx44xx44')?.status).toBe('cancelled');
    expect(await cancelJob({ key: 'xx44xx44' }, d)).toEqual({ cancelled: false });
    expect(await cancelJob({ key: 'nope0000' }, d)).toEqual({ cancelled: false });
  });

  it('marks its own hand-off so it is never taken for a reply after a reset', async () => {
    const { d, route } = deps();
    await dispatch({ key: 'yy55yy55', agent: 'dev-web', text: 'brief' }, d);
    expect(JSON.parse(route.mock.calls[0][0].message.content).flowDispatch).toBe(true);
  });
});

describe('completion hook', () => {
  const content = (text: string) => JSON.stringify({ text });
  it("closes the job and calls the flow back only on the job's own marker", async () => {
    store.startJob({ key: 'muu2phfhzzmk', agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:1.1' });
    const post = vi.fn(async (_u: string, _b: unknown) => 200);
    const d = { store: () => store, post };
    await onAgentMessage({ platformId: 'slack:C1', threadId: 'slack:C1:1.1', content: content('Working on it…') }, d);
    expect(post).not.toHaveBeenCalled(); // progress: no marker
    // The thread names the job: a marker with another key still closes it (2026-10-16), and only once.
    await onAgentMessage(
      { platformId: 'slack:C1', threadId: 'slack:C1:1.1', content: content('All done.\n[[flow:done otherkey1]]') },
      d,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({ key: 'muu2phfhzzmk', status: 'done', agent: 'dev-web' });
    expect(store.getJob('muu2phfhzzmk')).toMatchObject({ status: 'done', callback: 'HTTP 200' });
    // closed: a later message on the thread does nothing
    await onAgentMessage(
      { platformId: 'slack:C1', threadId: 'slack:C1:1.1', content: content('[[flow:done muu2phfhzzmk]]') },
      d,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a readable key closes on its id part, even when the agent mistypes the suffix', async () => {
    const key = 'mv8fzzfcthap-ivery-odkaz-instagram';
    store.startJob({ key, agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:2.2' });
    const post = vi.fn(async (_u: string, _b: unknown) => 200);
    const d = { store: () => store, post };
    await onAgentMessage(
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:2.2',
        content: content('[[flow:done mv8fzzfcthbb-ivery-odkaz-instagram]]'),
      },
      d,
    );
    expect(post).toHaveBeenCalledTimes(1); // a mistyped id on the job's own thread is still this job
    expect(post.mock.calls[0][1]).toMatchObject({ key, status: 'done' });
  });

  it('a question keeps the job running; a clarification closes it', async () => {
    store.startJob({ key: 'qq11qq11', agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:5.5' });
    const post = vi.fn(async (_u: string, _b: unknown) => 200);
    const d = { store: () => store, post };
    await onAgentMessage(
      { platformId: 'slack:C1', threadId: 'slack:C1:5.5', content: content('1. Which text?\n[[flow:ask qq11qq11]]') },
      d,
    );
    expect(post.mock.calls[0][1]).toMatchObject({ key: 'qq11qq11', status: 'ask' });
    expect(store.getJob('qq11qq11')?.status).toBe('running');
    await onAgentMessage(
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:5.5',
        content: content('- text Instagram\n[[flow:clarified qq11qq11]]'),
      },
      d,
    );
    expect(post.mock.calls[1][1]).toMatchObject({ status: 'clarified' });
    expect(store.getJob('qq11qq11')?.status).toBe('done');
  });

  it('a clarified marker under a question is the summary, not the confirmation', async () => {
    store.startJob({ key: 'cc33cc33', agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:6.6' });
    const post = vi.fn(async (_u: string, _b: unknown) => 200);
    const d = { store: () => store, post };
    await onAgentMessage(
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:6.6',
        content: content('- footer\n- /kontakt\nPokračujem?\n[[flow:clarified cc33cc33]]'),
      },
      d,
    );
    expect(post.mock.calls[0][1]).toMatchObject({ status: 'ask' });
    expect(store.getJob('cc33cc33')?.status).toBe('running');
    expect(store.getJob('cc33cc33')?.awaiting_confirmation).toBe(1);
    await onAgentMessage(
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:6.6',
        content: content('- footer\n- /kontakt\n[[flow:clarified cc33cc33]]'),
      },
      d,
    );
    expect(post.mock.calls[1][1]).toMatchObject({ status: 'clarified' });
    expect(store.getJob('cc33cc33')?.status).toBe('done');
  });

  it('reports blocked, and records a failed callback instead of losing it', async () => {
    store.startJob({ key: 'abcd1234', agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:2.2' });
    const post = vi.fn(async (_u: string, _b: unknown): Promise<number> => {
      throw new Error('ECONNREFUSED');
    });
    await onAgentMessage(
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:2.2',
        content: content('Cannot: working copy dirty. [[flow:blocked abcd1234]]'),
      },
      { store: () => store, post },
    );
    expect(store.getJob('abcd1234')).toMatchObject({ status: 'blocked' });
    expect(store.getJob('abcd1234')?.callback).toMatch(/failed: .*ECONNREFUSED/);
  });

  it('a marker without a key closes the job on its thread', async () => {
    store.startJob({ key: 'nokey0001', agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:5.5' });
    const post = vi.fn(async (_u: string, _b: unknown) => 200);
    await onAgentMessage(
      { platformId: 'slack:C1', threadId: 'slack:C1:5.5', content: content('Hotovo.\n[[flow:done]]') },
      { store: () => store, post },
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({ key: 'nokey0001', status: 'done' });
  });

  it('finds an open task by its flow key', () => {
    const t = store.create({
      flow: 'inbound',
      step: 'implementation',
      status: 'awaiting_agent',
      channel_type: 'slack',
      platform_id: 'slack:C2',
      thread_id: 'slack:C2:3.3',
      data: { key: 'abcd1234' },
    });
    expect(store.findOpenByKey('abcd1234')?.id).toBe(t.id);
    expect(store.findOpenByKey('nope0000')).toBeNull();
  });
});

describe('silence watch', () => {
  const content = (text: string) => JSON.stringify({ text });
  const T0 = Date.parse('2026-10-16T10:00:00Z');
  function setup(maintenance = false) {
    const { d, deliver, route } = deps();
    store.startJob({
      key: 'quiet0001',
      agent: 'dev-web',
      platform_id: CHANNEL.platform_id,
      thread_id: 'slack:C0B69CZRS9Y:7.7',
    });
    store.create({
      flow: 'inbound',
      step: 'implementation',
      status: 'awaiting_agent',
      channel_type: 'slack',
      platform_id: 'slack:C0B6B8A1MEV',
      thread_id: 'slack:C0B6B8A1MEV:8.8',
      data: { key: 'quiet0001', person_lang: 'sk' },
    });
    let now = T0;
    const sweep = () =>
      sweepSilentJobs({ store: () => store, dispatchDeps: d, maintenance: () => maintenance, now: () => now });
    return {
      deliver,
      route,
      sweep,
      at: (ms: number) => {
        now = T0 + ms;
      },
    };
  }
  const say = (text: string) =>
    onAgentMessage(
      { platformId: CHANNEL.platform_id, threadId: 'slack:C0B69CZRS9Y:7.7', content: content(text) },
      { store: () => store, post: async () => 200 },
    );

  it('nudges a quiet agent once, then tells the person in the task thread, then stays quiet', async () => {
    const s = setup();
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    await say('I changed SiteFooter.vue and ran the build.'); // a report without its marker
    vi.useRealTimers();
    s.at(SILENT_MS - 1000);
    expect(await s.sweep()).toEqual({ nudged: [], warned: [] });
    s.at(SILENT_MS + 1000);
    expect(await s.sweep()).toEqual({ nudged: ['quiet0001'], warned: [] });
    expect(s.deliver.mock.calls.at(-1)?.[4]).toContain('ended without a flow marker');
    expect(s.route).toHaveBeenCalledTimes(1); // the agent is woken with it
    expect(store.getJob('quiet0001')).toMatchObject({ status: 'running', last_marker: '' });
    s.at(SILENT_MS * 2 - 5000);
    expect((await s.sweep()).warned).toEqual([]);
    s.at(SILENT_MS * 2 + 5000);
    expect((await s.sweep()).warned).toEqual(['quiet0001']);
    const told = s.deliver.mock.calls.at(-1)!;
    expect(told[2]).toBe('slack:C0B6B8A1MEV:8.8');
    expect(told[4]).toContain('sa odmlčal bez ukončenia úlohy');
    s.at(SILENT_MS * 10);
    expect(await s.sweep()).toEqual({ nudged: [], warned: [] });
  });

  it('a question is not silence, nothing happens in maintenance, a marker ends the watch', async () => {
    const s = setup(true);
    await say('Which size? [[flow:ask quiet0001]]');
    s.at(SILENT_MS * 3);
    expect(store.silentCandidates()).toEqual([]);
    await say('still thinking');
    expect(await s.sweep()).toEqual({ nudged: [], warned: [] }); // maintenance
    expect(nudgeText('k1')).toMatch(/\[\[flow:done k1\]\][\s\S]*\[\[flow:blocked k1\]\][\s\S]*\[\[flow:ask k1\]\]/);
  });
});
describe('silence watch, failures', () => {
  it('a nudge that fails keeps the job watched for the next sweep; a warned job is no longer a candidate', async () => {
    const route = vi.fn(async (_e: InboundEvent) => {
      throw new Error('router down');
    });
    const { d } = deps({ route });
    store.startJob({
      key: 'quiet0002',
      agent: 'dev-web',
      platform_id: CHANNEL.platform_id,
      thread_id: 'slack:C0B69CZRS9Y:9.9',
    });
    store.noteAgentMessage('quiet0002', '', '2026-10-16T10:00:00.000Z');
    const now = Date.parse('2026-10-16T10:00:00Z') + SILENT_MS + 1000;
    expect(
      await sweepSilentJobs({ store: () => store, dispatchDeps: d, maintenance: () => false, now: () => now }),
    ).toEqual({ nudged: [], warned: [] });
    expect(store.getJob('quiet0002')).toMatchObject({
      status: 'running',
      last_marker: '',
      last_agent_at: '2026-10-16T10:00:00.000Z',
      nudged_at: null,
    });
    expect(store.silentCandidates().map((j) => j.key)).toEqual(['quiet0002']);
    store.markWarned('quiet0002', '2026-10-16T11:00:00.000Z');
    expect(store.silentCandidates()).toEqual([]);
  });
});
