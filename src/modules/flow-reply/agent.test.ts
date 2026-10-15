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
import { cancelJob, dispatch, DispatchError, onAgentMessage, type DispatchDeps } from './agent.js';
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
    await onAgentMessage(
      { platformId: 'slack:C1', threadId: 'slack:C1:1.1', content: content('done [[flow:done otherkey1]]') },
      d,
    );
    expect(post).not.toHaveBeenCalled();
    await onAgentMessage(
      { platformId: 'slack:C1', threadId: 'slack:C1:1.1', content: content('All done.\n[[flow:done muu2phfhzzmk]]') },
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
    expect(post).not.toHaveBeenCalled(); // another id: not this job
    await onAgentMessage(
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:2.2',
        content: content('Hotovo.\n[[flow:done mv8fzzfcthap-ivery-instagram-odkaz]]'),
      },
      d,
    );
    expect(post).toHaveBeenCalledTimes(1);
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
