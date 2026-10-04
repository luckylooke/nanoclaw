/**
 * Flow bridge — what a Total.js Flow process needs from nanoclaw, on one
 * loopback-only server (127.0.0.1:3006, FLOW_REPLY_PORT overrides):
 *
 *   POST /flow-reply          answer on the channel a message came from
 *   POST /flow-task/create    save a task that waits (for a person or an agent)
 *   POST /flow-task/find-open the open task on a thread, if any
 *   POST /flow-task/update    move a task on: status, step, attempt, data, event
 *   POST /flow-task/find-key  the open task carrying a flow key (an agent finished)
 *   POST /flow-agent/dispatch hand a phase to a dev agent (agent.ts)
 *   POST /flow-agent/job      the state of that hand-off
 *
 * Reply: the flow gets the inbound message with its address — channel_type,
 * platform_id, thread_id, instance — and hands it back with the text. The
 * registered channel adapter delivers it, exactly as it delivers agent
 * replies, so the flow never holds a Slack token. The answer carries
 * `reply_thread_id`: the thread a person's answer to this message will
 * arrive on, which is what a waiting task is keyed by.
 *
 * Tasks: see tasks.ts — a flow's state between messages, so a step can wait
 * hours for a person and a loop can count its rounds.
 *
 * Its own server, NOT a route on the webhook server. The first version was a
 * webhook route, and the webhook server's port is what Tailscale Funnel
 * publishes; Funnel proxies from loopback, so the loopback check passed for an
 * internet caller (2026-10-03, rolled back within three minutes, nothing
 * delivered). Guards on every path:
 * - loopback callers only, and no proxy headers at all (X-Forwarded-For,
 *   Forwarded, Tailscale-*), in case anything ever fronts this port;
 * - replies only to a messaging group the system knows and has not denied or
 *   detached; bounded body and text.
 */
import http from 'http';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, registerPostDeliveryHook, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { getOwners } from '../permissions/db/user-roles.js';
import { dispatch, DispatchError, onAgentMessage, type AgentChannel, type DispatchDeps } from './agent.js';
import type { MessagingGroup } from '../../types.js';
import { registerFlowInbound } from './inbound.js';
import { FlowTaskStore, TaskInputError, type TraceEvent } from './tasks.js';

export const FLOW_REPLY_PATH = '/flow-reply';
export const FLOW_REPLY_PORT = Number(process.env.FLOW_REPLY_PORT || 3006);
const MAX_BODY_BYTES = 64 * 1024;
// A trace batch carries model answers (up to 16 KB each, truncated by the recorder).
const MAX_TRACE_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface FlowReplyDeps {
  getAdapter: () => ChannelDeliveryAdapter | null;
  lookupGroup: (channelType: string, platformId: string, instance?: string) => Promise<MessagingGroup | undefined>;
}

type Json = Record<string, unknown>;

function send(res: http.ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
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

/** Method, caller and body checks shared by every path. Returns the parsed body or null (response sent). */
async function admit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limit = MAX_BODY_BYTES,
): Promise<Json | null> {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'POST only' });
    return null;
  }
  const proxied = Object.keys(req.headers).some(
    (h) => h === 'x-forwarded-for' || h === 'forwarded' || h.startsWith('tailscale-'),
  );
  if (!LOOPBACK.has(req.socket.remoteAddress || '') || proxied) {
    log.warn('Flow bridge: refused caller', { ip: req.socket.remoteAddress, proxied, url: req.url });
    send(res, 403, { ok: false, error: 'local, unproxied callers only' });
    return null;
  }
  const raw = await readBody(req, limit);
  if (raw === null) {
    send(res, 413, { ok: false, error: `body over ${limit} bytes` });
    return null;
  }
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as Json;
  } catch {
    send(res, 400, { ok: false, error: 'body is not a JSON object' });
    return null;
  }
}

/**
 * The thread a person's answer to a just-delivered message arrives on. A reply
 * already in a thread stays there; a top-level post starts a thread keyed by
 * its own message id — the chat-sdk thread id is `<platformId>:<messageTs>`
 * (e.g. slack:C0B69CZRS9Y:1789985626.319219 in v2.db sessions).
 */
export function replyThreadId(channelType: string, platformId: string, threadId: string | null, msgId?: string) {
  if (threadId) return threadId;
  if (!msgId || channelType === 'cli') return null;
  return `${platformId}:${msgId}`;
}

export function makeFlowReplyHandler(deps: FlowReplyDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if ((req.url || '').split('?')[0] !== FLOW_REPLY_PATH) return send(res, 404, { ok: false, error: 'not found' });
    const body = await admit(req, res);
    if (!body) return;

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
      return send(res, 200, {
        ok: true,
        platform_message_id: platformMsgId ?? null,
        reply_thread_id: replyThreadId(channelType, platformId, threadId, platformMsgId),
      });
    } catch (err) {
      log.error('Flow reply: delivery failed', { channelType, platformId, err: String(err) });
      return send(res, 502, { ok: false, error: `delivery failed: ${String(err)}` });
    }
  };
}

export function makeFlowTaskHandler(getStore: () => FlowTaskStore) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const route = (req.url || '').split('?')[0];
    const ROUTES = [
      '/flow-task/create',
      '/flow-task/find-open',
      '/flow-task/update',
      '/flow-task/find-key',
      '/flow-agent/job',
      '/flow-trace/append',
      '/flow-trace/runs',
      '/flow-trace/run',
    ];
    if (!ROUTES.includes(route)) return send(res, 404, { ok: false, error: 'not found' });
    const body = await admit(req, res, route === '/flow-trace/append' ? MAX_TRACE_BODY_BYTES : MAX_BODY_BYTES);
    if (!body) return;
    try {
      const store = getStore();
      if (route === '/flow-trace/append') {
        const flow = str(body.flow);
        if (!flow || !Array.isArray(body.events))
          return send(res, 400, { ok: false, error: 'flow and events[] are required' });
        return send(res, 200, { ok: true, appended: store.appendTrace(flow, body.events as TraceEvent[]) });
      }
      if (route === '/flow-trace/runs') {
        return send(res, 200, { ok: true, runs: store.listRuns(str(body.flow), Number(body.limit) || 50) });
      }
      if (route === '/flow-trace/run') {
        const runId = str(body.run_id);
        if (!runId) return send(res, 400, { ok: false, error: 'run_id is required' });
        const r = store.getRun(runId);
        return r ? send(res, 200, { ok: true, ...r }) : send(res, 404, { ok: false, error: `no run ${runId}` });
      }
      if (route === '/flow-task/find-key' || route === '/flow-agent/job') {
        const key = str(body.key);
        if (!key) return send(res, 400, { ok: false, error: 'key is required' });
        return route === '/flow-agent/job'
          ? send(res, 200, { ok: true, job: store.getJob(key) })
          : send(res, 200, { ok: true, task: store.findOpenByKey(key) });
      }
      if (route === '/flow-task/find-open') {
        const channelType = str(body.channel_type);
        const platformId = str(body.platform_id);
        if (!channelType || !platformId)
          return send(res, 400, { ok: false, error: 'channel_type and platform_id are required' });
        return send(res, 200, { ok: true, task: store.findOpen(channelType, platformId, str(body.thread_id)) });
      }
      if (route === '/flow-task/create') {
        const flow = str(body.flow);
        const step = str(body.step);
        const channelType = str(body.channel_type);
        const platformId = str(body.platform_id);
        if (!flow || !step || !channelType || !platformId) {
          return send(res, 400, { ok: false, error: 'flow, step, channel_type and platform_id are required' });
        }
        const task = store.create({
          flow,
          step,
          status: body.status,
          channel_type: channelType,
          platform_id: platformId,
          instance: str(body.instance),
          thread_id: str(body.thread_id),
          data: body.data,
          event: body.event && typeof body.event === 'object' ? (body.event as Json) : undefined,
        });
        log.info('Flow task created', { id: task.id, flow, step, status: task.status, thread: task.thread_id });
        return send(res, 200, { ok: true, task });
      }
      const id = str(body.id);
      if (!id) return send(res, 400, { ok: false, error: 'id is required' });
      const task = store.update(id, {
        status: body.status,
        step: body.step,
        attempt: body.attempt,
        thread_id: body.thread_id,
        data: body.data,
        event: body.event && typeof body.event === 'object' ? (body.event as Json) : undefined,
      });
      log.info('Flow task updated', { id, status: task.status, step: task.step, attempt: task.attempt });
      return send(res, 200, { ok: true, task });
    } catch (err) {
      if (err instanceof TaskInputError) return send(res, 400, { ok: false, error: err.message });
      log.error('Flow task request failed', { route, err: String(err) });
      return send(res, 500, { ok: false, error: String(err) });
    }
  };
}

export function makeFlowAgentHandler(deps: DispatchDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if ((req.url || '').split('?')[0] !== '/flow-agent/dispatch')
      return send(res, 404, { ok: false, error: 'not found' });
    const body = await admit(req, res);
    if (!body) return;
    try {
      return send(res, 200, { ok: true, ...(await dispatch(body, deps)) });
    } catch (err) {
      if (err instanceof DispatchError) return send(res, err.status, { ok: false, error: err.message });
      log.error('Flow agent dispatch failed', { err: String(err) });
      return send(res, 500, { ok: false, error: String(err) });
    }
  };
}

/** The Slack channel an agent group is wired to (rows keyed "slack:C…" carry the thread format the router uses). */
async function agentChannel(agent: string): Promise<AgentChannel | null> {
  const row = await getDb().get<AgentChannel>(
    `SELECT mg.channel_type, mg.platform_id, mg.instance FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
      WHERE ag.folder = ? AND mg.platform_id LIKE 'slack:%' AND mg.denied_at IS NULL AND mg.detached_at IS NULL
      ORDER BY mg.created_at LIMIT 1`,
    agent,
  );
  return row ?? null;
}

async function ownerHandle(): Promise<string | null> {
  const owner = (await getOwners()).find((o) => o.user_id.startsWith('slack:'));
  return owner ? owner.user_id.slice('slack:'.length) : null;
}

function postJson(url: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        timeout: 20_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode || 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

let server: http.Server | null = null;
let store: FlowTaskStore | null = null;

/** The one task store this process uses — shared by the bridge and the inbound interceptor. */
export function getFlowTaskStore(): FlowTaskStore {
  return (store ??= new FlowTaskStore(path.join(DATA_DIR, 'flow-tasks.db')));
}

/** Start the loopback-only bridge. Idempotent; a busy port is logged, not fatal. */
export function startFlowReplyServer(port = FLOW_REPLY_PORT): http.Server {
  if (server) return server;
  const reply = makeFlowReplyHandler({ getAdapter: getDeliveryAdapter, lookupGroup: getMessagingGroupByPlatform });
  const tasks = makeFlowTaskHandler(getFlowTaskStore);
  const agents = makeFlowAgentHandler({
    store: getFlowTaskStore,
    getAdapter: getDeliveryAdapter,
    agentChannel,
    ownerHandle,
    route: routeInbound,
  });
  server = http.createServer((req, res) => {
    const route = (req.url || '').split('?')[0];
    if (route === '/flow-agent/dispatch') return void agents(req, res);
    const isTask = route.startsWith('/flow-task/') || route.startsWith('/flow-trace/') || route === '/flow-agent/job';
    void (isTask ? tasks(req, res) : reply(req, res));
  });
  server.on('error', (err) => log.error('Flow bridge server error', { port, err: String(err) }));
  server.listen(port, '127.0.0.1', () => log.info('Flow reply server listening', { host: '127.0.0.1', port }));
  return server;
}

// Modules self-register at import time; tests import the handlers only.
// The interceptor sends "[flow]" messages and replies on a waiting task's
// thread to the incoming-message flow (inbound.ts); everything else routes as before.
if (!process.env.VITEST) {
  startFlowReplyServer();
  registerFlowInbound(getFlowTaskStore);
  // An agent's reply carrying [[flow:done|blocked <key>]] on a job thread calls the flow back.
  registerPostDeliveryHook((msg) => onAgentMessage(msg, { store: getFlowTaskStore, post: postJson }));
}
