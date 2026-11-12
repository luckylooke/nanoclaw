import { beforeEach, describe, expect, it } from 'bun:test';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import type { RoutingContext } from '../formatter.js';
import {
  _resetContainerSeamsForTest,
  contributedQuery,
  registerQueryContributor,
  registerTurnEndObserver,
  turnEnded,
  withContributedHooks,
} from './seams.js';
import { traceEnv } from './otel-trace.js';
import { _resetUsageFooterForTest, footerRequest } from './usage-footer.js';

const cb = (async () => ({})) as HookCallback;
const cb2 = (async () => ({})) as HookCallback;

// The feature modules register at import; start every test from empty registries.
beforeEach(() => {
  _resetContainerSeamsForTest();
  _resetUsageFooterForTest();
});

describe('query contributions', () => {
  it('merge env and append hooks after core, skipping a contributor that throws', () => {
    registerQueryContributor('a', () => ({ env: { A: '1' }, hooks: { PostToolUse: [cb] } }));
    registerQueryContributor('boom', () => {
      throw new Error('boom');
    });
    registerQueryContributor('b', () => ({ env: { B: '2' }, hooks: { Stop: [cb2] } }));
    const ext = contributedQuery();
    expect(ext.env).toEqual({ A: '1', B: '2' });
    const hooks = withContributedHooks(ext, { PostToolUse: [{ hooks: [cb2] }] });
    expect(hooks.PostToolUse).toEqual([{ hooks: [cb2] }, { hooks: [cb] }]);
    expect(hooks.Stop).toEqual([{ hooks: [cb2] }]);
  });
});

describe('turn end', () => {
  it('runs every observer even when one throws', async () => {
    const seen: string[] = [];
    registerTurnEndObserver('boom', () => {
      throw new Error('boom');
    });
    registerTurnEndObserver('ok', () => {
      seen.push('ok');
    });
    await turnEnded({ routing: {} as RoutingContext, delivered: true });
    expect(seen).toEqual(['ok']);
  });
});

describe('traceEnv', () => {
  it('keeps the launcher x-agent-group header and adds the trace id', () => {
    const env = traceEnv('a'.repeat(32), 'x-agent-group: learning');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`x-agent-group: learning\nx-trace-id: ${'a'.repeat(32)}`);
    expect(env.TRACEPARENT).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
  });
});

describe('footerRequest', () => {
  const slack: RoutingContext = {
    platformId: 'slack:C1',
    channelType: 'slack',
    threadId: '1.2',
    inReplyTo: null,
    taskRun: false,
  };
  const T = 'b'.repeat(32);
  const U = 'c'.repeat(32);

  it('asks for a footer after a delivered Slack chat turn, then only since the last footer', () => {
    expect(footerRequest({ routing: slack, delivered: true }, T, 't1')).toEqual({
      action: 'usage_footer',
      traces: [{ traceId: T, since: null }],
      threadId: '1.2',
    });
    expect(footerRequest({ routing: slack, delivered: true }, T, 't2')?.traces).toEqual([{ traceId: T, since: 't1' }]);
  });

  it('carries a silent turn into the next footer, also across a new trace', () => {
    expect(footerRequest({ routing: slack, delivered: true }, T, 't1')).not.toBeNull();
    expect(footerRequest({ routing: slack, delivered: false }, T, 't2')).toBeNull();
    expect(footerRequest({ routing: slack, delivered: true }, U, 't3')?.traces).toEqual([
      { traceId: T, since: 't1' },
      { traceId: U, since: null },
    ]);
  });

  it('asks for nothing when nothing went out, on task runs or off Slack', () => {
    expect(footerRequest({ routing: slack, delivered: false }, T, 't1')).toBeNull();
    expect(footerRequest({ routing: { ...slack, taskRun: true }, delivered: true }, T, 't1')).toBeNull();
    expect(footerRequest({ routing: { ...slack, channelType: 'telegram' }, delivered: true }, T, 't1')).toBeNull();
    expect(footerRequest({ routing: slack, delivered: true }, null, 't1')).toBeNull();
  });
});
