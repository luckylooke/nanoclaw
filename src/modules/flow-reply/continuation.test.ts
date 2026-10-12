/**
 * What this pins: a person's reply on a flow job thread whose session was
 * closed overnight wakes the agent with a short note — task key, kind, request,
 * decisions, open questions, how to finish — and is otherwise untouched. While
 * a session is active, or on a thread with no running job, nothing happens.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { continuationNote, makeContinuationInterceptor } from './continuation.js';
import { FlowTaskStore } from './tasks.js';

let tmp: string;
let store: FlowTaskStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cont-'));
  store = new FlowTaskStore(path.join(tmp, 'flow-tasks.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const event = (text: string, extra: Record<string, unknown> = {}): InboundEvent => ({
  channelType: 'slack',
  platformId: 'slack:C1',
  threadId: 'slack:C1:9.9',
  message: {
    id: 'm1',
    kind: 'chat-sdk',
    content: JSON.stringify({ text, senderId: 'U1', ...extra }),
    timestamp: 't',
    isMention: false,
  },
});

function seed() {
  store.startJob({ key: 'kk11kk11', agent: 'dev-web', platform_id: 'slack:C1', thread_id: 'slack:C1:9.9' });
  store.create({
    flow: 'inbound',
    step: 'spec',
    status: 'awaiting_agent',
    channel_type: 'slack',
    platform_id: 'slack:C0',
    thread_id: 'slack:C0:1.1',
    data: {
      key: 'kk11kk11',
      project: 'dev-web/demo',
      request: 'Add a Contact button',
      clarifying: 'spec',
      clarify_questions: ['Where?', 'What on click?'],
    },
  });
}

describe('flow job continuation', () => {
  it('re-routes the reply as a mention with the note when the session is gone', async () => {
    seed();
    const route = vi.fn(async (_e: InboundEvent) => {});
    const intercept = makeContinuationInterceptor({
      store: () => store,
      sessionState: async () => 'closed' as const,
      route,
    });
    expect(await intercept(event('1. footer\n2. /kontakt'))).toBe(true);
    const routed = route.mock.calls[0][0];
    expect(routed.message.isMention).toBe(true);
    const c = JSON.parse(routed.message.content);
    expect(c.text).toMatch(/^1\. footer\n2\. \/kontakt\n\n---/);
    expect(c.text).toMatch(/flow task `kk11kk11` — clarification before the specification, project `dev-web\/demo`/);
    expect(c.text).toMatch(/diary/);
    expect(c.text).toMatch(/1\. Where\?\n2\. What on click\?/);
    expect(c.text).toMatch(/\[\[flow:clarified kk11kk11\]\]/);
    expect(c.senderId).toBe('U1');
    // the re-routed copy is not intercepted again
    expect(await intercept(routed)).toBe(false);
  });

  it('does nothing while a session is active, without a running job, on a brand-new thread, or for the flow hand-off', async () => {
    const route = vi.fn(async (_e: InboundEvent) => {});
    const noJob = makeContinuationInterceptor({
      store: () => store,
      sessionState: async () => 'closed' as const,
      route,
    });
    expect(await noJob(event('hi'))).toBe(false);
    seed();
    const active = makeContinuationInterceptor({
      store: () => store,
      sessionState: async () => 'active' as const,
      route,
    });
    expect(await active(event('hi'))).toBe(false);
    // the first message of a new job: no session yet, and it is the flow's own hand-off
    const fresh = makeContinuationInterceptor({ store: () => store, sessionState: async () => 'none' as const, route });
    expect(await fresh(event('brief'))).toBe(false);
    const closed = makeContinuationInterceptor({
      store: () => store,
      sessionState: async () => 'closed' as const,
      route,
    });
    expect(await closed(event('brief', { flowDispatch: true }))).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });

  it('the reply after a clarification summary carries what a yes means, once', async () => {
    seed();
    store.setAwaitingConfirmation('kk11kk11', true);
    const route = vi.fn(async (_e: InboundEvent) => {});
    const intercept = makeContinuationInterceptor({
      store: () => store,
      sessionState: async () => 'active' as const,
      route,
    });
    expect(await intercept(event('áno'))).toBe(true);
    const c = JSON.parse(route.mock.calls[0][0].message.content);
    expect(c.text).toMatch(/^áno\n\n---\n_From the flow:_/);
    expect(c.text).toMatch(/do not change any code[\s\S]*/);
    expect(c.text).toMatch(/\[\[flow:clarified kk11kk11\]\]/);
    expect(c.text).not.toMatch(/session was reset/);
    // only the first reply after the summary
    expect(await intercept(event('one more thing'))).toBe(false);
  });

  it('an implementation job is told how to finish with done / ask / blocked', () => {
    const note = continuationNote({ key: 'kk22kk22' } as never, {
      project: 'p',
      request: 'r',
      notes: ['Specification: secondary'],
    });
    expect(note).toMatch(/implementation, project `p`/);
    expect(note).toMatch(/Decided so far: Specification: secondary/);
    expect(note).toMatch(
      /\[\[flow:done kk22kk22\]\][\s\S]*\[\[flow:ask kk22kk22\]\][\s\S]*\[\[flow:blocked kk22kk22\]\]/,
    );
  });
});
