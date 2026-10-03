/**
 * Flow inbound — sends a chat message to the incoming-message flow instead of
 * an agent, when it is meant for the flow:
 *
 *   - it starts with "[flow]" (the prefix is stripped before the flow sees it), or
 *   - it is posted on a thread where a flow task is waiting for an answer.
 *
 * Everything else routes exactly as before: this is opt-in per message while
 * the flow is being built, not a switch of all traffic.
 *
 * Fail-open by construction. If the flow is down, slow (FLOW_INBOUND_TIMEOUT_MS),
 * errors, or answers handled:false ("not a task"), the message continues to
 * normal routing untouched — a flow outage must never eat a message. Only an
 * explicit handled:true consumes it.
 *
 * Who may drive it: the owner and global admins. The interceptor runs before
 * the router's sender checks, and a flow run costs model calls and posts on
 * the channel, so anyone else's "[flow]" message routes normally (and is
 * logged with the sender id, so a mis-identified owner is diagnosable).
 *
 * Maintenance mode: skipped, so the message takes the normal path where the
 * maintenance gate holds it — no flow turns while the operator is editing.
 */
import { isMaintenance } from '../../maintenance.js';
import { log } from '../../log.js';
import { isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { registerMessageInterceptor } from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { FlowTaskStore } from './tasks.js';

export const FLOW_INBOUND_URL =
  process.env.FLOW_INBOUND_URL || 'http://127.0.0.1:8000/process-income-msg/inbound/fJXu7oW1cW61f/';
const TIMEOUT_MS = Number(process.env.FLOW_INBOUND_TIMEOUT_MS || 20_000);
const PREFIX = /^\s*\[flow\]\s*/i;

interface Content {
  text?: unknown;
  senderId?: unknown;
  sender?: unknown;
  author?: { userId?: unknown };
}

function parse(event: InboundEvent): Content {
  try {
    return JSON.parse(event.message.content) as Content;
  } catch {
    return {};
  }
}

/** Same resolution the permissions module uses: chat-sdk nests the author. */
export function senderUserId(event: InboundEvent, c: Content = parse(event)): string | null {
  const raw =
    (typeof c.senderId === 'string' && c.senderId) ||
    (typeof c.sender === 'string' && c.sender) ||
    (typeof c.author?.userId === 'string' && c.author.userId) ||
    null;
  if (!raw) return null;
  return raw.includes(':') ? raw : `${event.channelType}:${raw}`;
}

export interface FlowInboundDeps {
  store: () => FlowTaskStore;
  maintenance: () => boolean;
  mayDrive: (userId: string) => Promise<boolean>;
  post: (url: string, body: unknown, timeoutMs: number) => Promise<{ handled?: unknown } | null>;
}

export function makeFlowInterceptor(deps: FlowInboundDeps) {
  return async (event: InboundEvent): Promise<boolean> => {
    const c = parse(event);
    const text = typeof c.text === 'string' ? c.text : '';
    const prefixed = PREFIX.test(text);
    let waiting = false;
    if (!prefixed && event.threadId) {
      try {
        waiting = !!deps.store().findOpen(event.channelType, event.platformId, event.threadId);
      } catch (err) {
        log.warn('Flow inbound: task lookup failed — routing normally', { err: String(err) });
        return false;
      }
    }
    if (!prefixed && !waiting) return false;

    if (deps.maintenance()) {
      log.info('Flow inbound: maintenance mode — routing normally', { platformId: event.platformId });
      return false;
    }
    const userId = senderUserId(event, c);
    if (!userId || !(await deps.mayDrive(userId))) {
      log.info('Flow inbound: sender may not drive the flow — routing normally', { userId, prefixed, waiting });
      return false;
    }

    const body = {
      text: prefixed ? text.replace(PREFIX, '') : text,
      channel_type: event.channelType,
      platform_id: event.platformId,
      thread_id: event.threadId,
      instance: event.instance ?? event.channelType,
      sender: userId,
      message_id: event.message.id,
    };
    try {
      const res = await deps.post(FLOW_INBOUND_URL, body, TIMEOUT_MS);
      const handled = res?.handled === true;
      log.info('Flow inbound: sent to flow', { prefixed, waiting, handled, thread: event.threadId });
      return handled;
    } catch (err) {
      log.warn('Flow inbound: flow unreachable — routing normally', { err: String(err) });
      return false;
    }
  };
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ handled?: unknown } | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`flow answered HTTP ${res.status}`);
  return (await res.json()) as { handled?: unknown };
}

export function registerFlowInbound(store: () => FlowTaskStore): void {
  registerMessageInterceptor(
    makeFlowInterceptor({
      store,
      maintenance: isMaintenance,
      mayDrive: async (u) => (await isOwner(u)) || (await isGlobalAdmin(u)),
      post: postJson,
    }),
  );
}
