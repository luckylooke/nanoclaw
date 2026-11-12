/**
 * Token-usage footer, host half (fork feature token-usage-footer).
 *
 * The container ends a chat turn that put something in a Slack channel with a
 * `usage_footer` system action (container/agent-runner/src/ext/usage-footer.ts)
 * naming the traces (and since when) not yet shown. This prices them from gateway.db api_calls — the
 * numbers the dashboard and the budget gate use, subagents included — and
 * posts one 🪙 line to the session's own channel.
 *
 * The line goes straight to the adapter, not through messages_out: it is not
 * an agent reply, so the reply index and memory extraction never see it.
 * Destination comes from the session, never from the payload; the payload only
 * picks a thread inside that channel.
 */
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../delivery.js';
import { traceUsage, type TraceUsage } from '../gateway-db.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

const TRACE_RE = /^[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function formatFooter(u: TraceUsage): string {
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  return `🪙 ${n(u.input)}↑ ${n(u.output)}↓ | cache ${n(u.cacheWrite)}✍ ${n(u.cacheRead)}📖 | €${u.eur.toFixed(4)}`;
}

/** Same cap as the container's MAX_TRACES. */
const MAX_TRACES = 20;

/** The payload's traces, or null if any entry is malformed (all or nothing). */
export function parseTraces(raw: unknown): { traceId: string; since: string | null }[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TRACES) return null;
  const out: { traceId: string; since: string | null }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null;
    const { traceId, since = null } = e as { traceId?: unknown; since?: unknown };
    if (typeof traceId !== 'string' || !TRACE_RE.test(traceId)) return null;
    if (since !== null && (typeof since !== 'string' || !ISO_RE.test(since))) return null;
    out.push({ traceId, since });
  }
  return out;
}

export interface FooterDeps {
  usage: (traceId: string, groupSlug: string, since: string | null) => TraceUsage | null;
  groupFolder: (agentGroupId: string) => Promise<string | null>;
  channel: (messagingGroupId: string) => Promise<{ channelType: string; platformId: string; instance?: string } | null>;
  send: (
    channelType: string,
    platformId: string,
    threadId: string | null,
    text: string,
    instance?: string,
  ) => Promise<void>;
}

export function usageFooterHandler(deps: FooterDeps) {
  return async (content: Record<string, unknown>, session: Session): Promise<void> => {
    const traces = parseTraces(content.traces);
    const threadId = content.threadId ?? null;
    if (!traces) return;
    if (threadId !== null && typeof threadId !== 'string') return;
    if (!session.messaging_group_id) return;

    const channel = await deps.channel(session.messaging_group_id);
    if (!channel || channel.channelType !== 'slack') return;
    const folder = await deps.groupFolder(session.agent_group_id);
    if (!folder) return;
    const u: TraceUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, eur: 0 };
    for (const { traceId, since } of traces) {
      const t = deps.usage(traceId, folder, since);
      if (!t) continue;
      u.calls += t.calls;
      u.input += t.input;
      u.output += t.output;
      u.cacheRead += t.cacheRead;
      u.cacheWrite += t.cacheWrite;
      u.eur += t.eur;
    }
    if (u.calls === 0) return;

    await deps.send(channel.channelType, channel.platformId, threadId, formatFooter(u), channel.instance);
  };
}

registerDeliveryAction(
  'usage_footer',
  usageFooterHandler({
    usage: traceUsage,
    groupFolder: async (id) => (await getAgentGroup(id))?.folder ?? null,
    channel: async (id) => {
      const mg = await getMessagingGroup(id);
      return mg ? { channelType: mg.channel_type, platformId: mg.platform_id, instance: mg.instance } : null;
    },
    send: async (channelType, platformId, threadId, text, instance) => {
      const adapter = getDeliveryAdapter();
      if (!adapter) {
        log.warn('Usage footer: no delivery adapter');
        return;
      }
      await adapter.deliver(channelType, platformId, threadId, 'chat', JSON.stringify({ text }), undefined, instance);
    },
  }),
  unguarded("reads the session's own trace cost and posts one line to the session's own channel"),
);
