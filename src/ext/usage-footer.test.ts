import { describe, expect, it } from 'vitest';

import { formatFooter, usageFooterHandler, type FooterDeps } from './usage-footer.js';
import type { TraceUsage } from '../gateway-db.js';
import type { Session } from '../types.js';

const TRACE = '0123456789abcdef0123456789abcdef';
const session = { id: 's1', agent_group_id: 'ag1', messaging_group_id: 'mg1' } as Session;
const usage: TraceUsage = { calls: 3, input: 1234, output: 567, cacheRead: 89012, cacheWrite: 3456, eur: 0.16409 };

function harness(over: Partial<FooterDeps> = {}) {
  const sent: { platformId: string; threadId: string | null; text: string }[] = [];
  const asked: { traceId: string; group: string; since: string | null }[] = [];
  const deps: FooterDeps = {
    usage: (traceId, group, since) => {
      asked.push({ traceId, group, since });
      return usage;
    },
    groupFolder: async () => 'learning',
    channel: async () => ({ channelType: 'slack', platformId: 'slack:C1' }),
    send: async (_ct, platformId, threadId, text) => {
      sent.push({ platformId, threadId, text });
    },
    ...over,
  };
  return { sent, asked, handle: usageFooterHandler(deps) };
}

describe('formatFooter', () => {
  it('keeps the 🪙 prefix daily-reset filters on, and prices in EUR', () => {
    expect(formatFooter(usage)).toBe('🪙 1,234↑ 567↓ | cache 3,456✍ 89,012📖 | €0.1641');
  });
});

describe('usage_footer handler', () => {
  it("posts one line to the session's own channel, in the requested thread", async () => {
    const { sent, asked, handle } = harness();
    const OLD = 'f'.repeat(32);
    await handle(
      {
        action: 'usage_footer',
        traces: [
          { traceId: OLD, since: '2026-11-12T08:00:00.000Z' },
          { traceId: TRACE, since: null },
        ],
        threadId: '1.2',
      },
      session,
    );
    expect(asked).toEqual([
      { traceId: OLD, group: 'learning', since: '2026-11-12T08:00:00.000Z' },
      { traceId: TRACE, group: 'learning', since: null },
    ]);
    // Two traces, each priced once: the line is their sum.
    const twice = {
      ...usage,
      calls: 6,
      input: 2468,
      output: 1134,
      cacheRead: 178024,
      cacheWrite: 6912,
      eur: 2 * usage.eur,
    };
    expect(sent).toEqual([{ platformId: 'slack:C1', threadId: '1.2', text: formatFooter(twice) }]);
  });

  it('ignores the whole request if any trace id or since is malformed, or there are too many', async () => {
    const { sent, handle } = harness();
    await handle({ traces: [{ traceId: TRACE }, { traceId: "x' OR 1=1" }], threadId: null }, session);
    await handle({ traces: [{ traceId: TRACE, since: 'yesterday' }], threadId: null }, session);
    await handle({ traces: [], threadId: null }, session);
    await handle({ traces: Array.from({ length: 21 }, () => ({ traceId: TRACE })), threadId: null }, session);
    expect(sent).toEqual([]);
  });

  it('posts nothing for a session without a channel, a non-Slack channel or no calls', async () => {
    const noChannel = harness();
    await noChannel.handle({ traces: [{ traceId: TRACE }], threadId: null }, { ...session, messaging_group_id: null });
    const telegram = harness({ channel: async () => ({ channelType: 'telegram', platformId: 'telegram:1' }) });
    await telegram.handle({ traces: [{ traceId: TRACE }], threadId: null }, session);
    const empty = harness({ usage: () => ({ ...usage, calls: 0 }) });
    await empty.handle({ traces: [{ traceId: TRACE }], threadId: null }, session);
    expect([...noChannel.sent, ...telegram.sent, ...empty.sent]).toEqual([]);
  });
});
