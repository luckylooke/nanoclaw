/**
 * What this pins: only messages meant for the flow reach it, and nothing the
 * flow does can lose a message. A flow that is down, slow, failing or says
 * "not a task" leaves the message on its normal route; only handled:true
 * consumes it. Opt-in is "[flow]" or a reply on a thread with a waiting task,
 * and only the owner/admins may drive it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../router.js', () => ({ registerMessageInterceptor: vi.fn() }));
vi.mock('../../maintenance.js', () => ({ isMaintenance: vi.fn(() => false) }));
vi.mock('../permissions/db/user-roles.js', () => ({ isOwner: vi.fn(), isGlobalAdmin: vi.fn() }));

import type { InboundEvent } from '../../channels/adapter.js';
import { makeFlowInterceptor, senderUserId, type FlowInboundDeps } from './inbound.js';
import { FlowTaskStore } from './tasks.js';

let tmp: string;
let store: FlowTaskStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-inbound-'));
  store = new FlowTaskStore(path.join(tmp, 'flow-tasks.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const OWNER = 'U0B65PNMT0C';
const event = (text: string, threadId: string | null = 'slack:C0B6B8A1MEV:1.1', author = OWNER): InboundEvent => ({
  channelType: 'slack',
  instance: 'slack',
  platformId: 'slack:C0B6B8A1MEV',
  threadId,
  message: {
    id: 'm1',
    kind: 'chat-sdk',
    content: JSON.stringify({ text, author: { userId: author } }),
    timestamp: 't',
  },
});

function deps(over: Partial<FlowInboundDeps> = {}) {
  const post = vi.fn(async () => ({ handled: true }));
  return {
    post,
    d: {
      store: () => store,
      maintenance: () => false,
      mayDrive: async (u: string) => u === `slack:${OWNER}`,
      post,
      ...over,
    } as FlowInboundDeps,
  };
}

describe('flow inbound interceptor', () => {
  it('ignores ordinary messages without touching the flow', async () => {
    const { d, post } = deps();
    expect(await makeFlowInterceptor(d)(event('ahoj'))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('sends a [flow] message with the prefix stripped and the full address', async () => {
    const { d, post } = deps();
    expect(await makeFlowInterceptor(d)(event('[flow] pridaj odkaz na Instagram'))).toBe(true);
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: 'pridaj odkaz na Instagram',
        channel_type: 'slack',
        platform_id: 'slack:C0B6B8A1MEV',
        thread_id: 'slack:C0B6B8A1MEV:1.1',
        instance: 'slack',
        sender: `slack:${OWNER}`,
      }),
      expect.any(Number),
    );
  });

  it('sends an unprefixed reply on a thread where a task is waiting', async () => {
    store.create({
      flow: 'inbound',
      step: 'proposal',
      channel_type: 'slack',
      platform_id: 'slack:C0B6B8A1MEV',
      thread_id: 'slack:C0B6B8A1MEV:1.1',
    });
    const { d, post } = deps();
    expect(await makeFlowInterceptor(d)(event('ok, súhlasím'))).toBe(true);
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'ok, súhlasím' }),
      expect.any(Number),
    );
  });

  it('leaves the message on its normal route when the flow says "not a task"', async () => {
    const { d } = deps({ post: vi.fn(async () => ({ handled: false })) });
    expect(await makeFlowInterceptor(d)(event('[flow] ahoj'))).toBe(false);
  });

  it('fails open when the flow is down or slow', async () => {
    const { d } = deps({
      post: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    expect(await makeFlowInterceptor(d)(event('[flow] pridaj odkaz'))).toBe(false);
  });

  it('lets only the owner/admins drive it', async () => {
    const { d, post } = deps();
    expect(await makeFlowInterceptor(d)(event('[flow] pridaj odkaz', 'slack:C:1', 'USTRANGER'))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('stands aside in maintenance mode', async () => {
    const { d, post } = deps({ maintenance: () => true });
    expect(await makeFlowInterceptor(d)(event('[flow] pridaj odkaz'))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('a top-level message never resumes a waiting task', async () => {
    store.create({
      flow: 'inbound',
      step: 'proposal',
      channel_type: 'slack',
      platform_id: 'slack:C0B6B8A1MEV',
      thread_id: null,
    });
    const { d, post } = deps();
    expect(await makeFlowInterceptor(d)(event('ok', null))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('senderUserId', () => {
  it('reads the chat-sdk author and prefixes the channel type', () => {
    expect(senderUserId(event('x'))).toBe(`slack:${OWNER}`);
  });
});
