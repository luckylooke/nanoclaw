/**
 * Flow reply — lets a Total.js Flow process answer on the channel a message
 * came from, without the flow ever holding a channel credential.
 *
 *   POST http://127.0.0.1:3006/flow-reply        (FLOW_REPLY_PORT overrides)
 *   { "channel_type": "slack", "platform_id": "slack:C0…", "thread_id": null,
 *     "instance": "slack", "text": "…" }
 *
 * The flow gets the address fields with the inbound message and hands them
 * back unchanged, so the same flow answers Slack, the CLI or any future
 * channel: the channel adapter already registered with delivery does the
 * sending. That is the point — a Slack bot token inside a flow would be a
 * secret in a file the Flow UI can read and export.
 *
 * Its own server, bound to 127.0.0.1 — NOT a route on the webhook server. The
 * first version was registered there, and the webhook server's port is what
 * Tailscale Funnel publishes to the internet. Funnel proxies from loopback, so
 * the loopback check passed for an internet caller: a probe from outside got a
 * 404 "no known messaging group" from this handler (2026-10-03, rolled back
 * within three minutes, nothing delivered). Nothing publishes this port.
 *
 * Guards, each for a way this endpoint could be abused:
 * - Loopback callers only, and no proxy headers at all (X-Forwarded-For,
 *   Forwarded, Tailscale-*): if anything ever does front this port, a proxied
 *   request is refused rather than mistaken for a local one.
 * - Only to a messaging group the system already knows and has not denied or
 *   detached. A flow cannot be talked into messaging an arbitrary channel the
 *   bot happens to be in.
 * - Bounded body and text, so a runaway flow cannot post a novel.
 */
import http from 'http';

import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';

export const FLOW_REPLY_PATH = '/flow-reply';
export const FLOW_REPLY_PORT = Number(process.env.FLOW_REPLY_PORT || 3006);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 12_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface FlowReplyDeps {
  getAdapter: () => ChannelDeliveryAdapter | null;
  lookupGroup: (channelType: string, platformId: string, instance?: string) => Promise<MessagingGroup | undefined>;
}

interface FlowReplyBody {
  channel_type?: unknown;
  platform_id?: unknown;
  thread_id?: unknown;
  instance?: unknown;
  text?: unknown;
}

function send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function makeFlowReplyHandler(deps: FlowReplyDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if ((req.url || '').split('?')[0] !== FLOW_REPLY_PATH) return send(res, 404, { ok: false, error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
    const proxied = Object.keys(req.headers).some(
      (h) => h === 'x-forwarded-for' || h === 'forwarded' || h.startsWith('tailscale-'),
    );
    if (!LOOPBACK.has(req.socket.remoteAddress || '') || proxied) {
      log.warn('Flow reply: refused caller', { ip: req.socket.remoteAddress, proxied });
      return send(res, 403, { ok: false, error: 'local, unproxied callers only' });
    }

    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { ok: false, error: `body over ${MAX_BODY_BYTES} bytes` });
    let body: FlowReplyBody;
    try {
      body = JSON.parse(raw) as FlowReplyBody;
    } catch {
      return send(res, 400, { ok: false, error: 'body is not JSON' });
    }

    const channelType = str(body.channel_type);
    const platformId = str(body.platform_id);
    const text = str(body.text);
    const instance = str(body.instance) ?? undefined;
    const threadId = str(body.thread_id);
    if (!channelType || !platformId || !text) {
      return send(res, 400, { ok: false, error: 'channel_type, platform_id and text are required' });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return send(res, 413, { ok: false, error: `text over ${MAX_TEXT_CHARS} characters` });
    }

    const group = await deps.lookupGroup(channelType, platformId, instance);
    if (!group) return send(res, 404, { ok: false, error: `no known messaging group ${channelType} ${platformId}` });
    if (group.denied_at || group.detached_at) {
      return send(res, 403, { ok: false, error: `messaging group ${group.id} is denied or detached` });
    }

    const adapter = deps.getAdapter();
    if (!adapter) return send(res, 503, { ok: false, error: 'delivery adapter not ready' });

    try {
      const platformMsgId = await adapter.deliver(
        channelType,
        platformId,
        threadId,
        'chat',
        JSON.stringify({ text }),
        undefined,
        group.instance,
      );
      log.info('Flow reply delivered', { channelType, platformId, threadId, platformMsgId, chars: text.length });
      return send(res, 200, { ok: true, platform_message_id: platformMsgId ?? null });
    } catch (err) {
      log.error('Flow reply: delivery failed', { channelType, platformId, err: String(err) });
      return send(res, 502, { ok: false, error: `delivery failed: ${String(err)}` });
    }
  };
}

let server: http.Server | null = null;

/** Start the loopback-only reply server. Idempotent; a busy port is logged, not fatal. */
export function startFlowReplyServer(port = FLOW_REPLY_PORT): http.Server {
  if (server) return server;
  const handler = makeFlowReplyHandler({ getAdapter: getDeliveryAdapter, lookupGroup: getMessagingGroupByPlatform });
  server = http.createServer((req, res) => void handler(req, res));
  server.on('error', (err) => log.error('Flow reply server error', { port, err: String(err) }));
  server.listen(port, '127.0.0.1', () => log.info('Flow reply server listening', { host: '127.0.0.1', port }));
  return server;
}

// Modules self-register at import time; tests import the handler only.
if (!process.env.VITEST) startFlowReplyServer();
