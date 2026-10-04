/**
 * Flow → agent hand-off: a flow phase (implementation…) is done by a dev agent,
 * not by a model call, and the flow must hear when it is finished.
 *
 * Dispatch (POST 127.0.0.1:3006/flow-agent/dispatch { key, agent, text }):
 *   1. the bot posts the brief as a top-level message in the agent's own channel
 *      (#agent-dev-web, #agent-dev-game), so the work happens in a real thread
 *      the person can follow;
 *   2. the brief is routed to the agent as an inbound message on that thread, in
 *      the owner's name — only the owner (or an admin) can start a flow task, and
 *      the router's access gates are the ones every message passes;
 *   3. a job row ties the thread to the flow key.
 * With `continue: true` the text goes into the job's existing thread instead —
 * review findings, the person's answer — so one thread holds the whole
 * implementation. Only the job's own thread can be continued.
 *
 * Completion: a post-delivery hook watches the agent's replies on job threads.
 * The brief asks the agent to end its last message with `[[flow:done <key>]]` or
 * `[[flow:blocked <key>]]`; on that marker the job is closed and the flow is
 * called back (FLOW_AGENT_CALLBACK_URL) with the agent's final message. Progress
 * messages without a marker are ignored. A failed callback is recorded on the job
 * and visible via /flow-agent/job, never retried blindly.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { FlowTaskStore } from './tasks.js';

export const FLOW_AGENT_CALLBACK_URL =
  process.env.FLOW_AGENT_CALLBACK_URL || 'http://127.0.0.1:8000/process-income-msg/agent-done/fJXu7oW1cW61f/';
export const AGENTS = ['dev-web', 'dev-game'];
const KEY = /^[a-z0-9]{4,32}$/;
const MAX_BRIEF = 20_000;
const MARKER = /\[\[flow:(done|blocked)\s+([a-z0-9]{4,32})\]\]/i;

export interface AgentChannel {
  channel_type: string;
  platform_id: string;
  instance: string;
}

export interface DispatchDeps {
  store: () => FlowTaskStore;
  getAdapter: () => ChannelDeliveryAdapter | null;
  /** The channel an agent group (by folder) is wired to, Slack-style platform id preferred. */
  agentChannel: (agent: string) => Promise<AgentChannel | null>;
  /** The owner's raw platform handle, e.g. "U0B65PNMT0C". */
  ownerHandle: () => Promise<string | null>;
  route: (event: InboundEvent) => Promise<void>;
}

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function dispatch(
  body: { key?: unknown; agent?: unknown; text?: unknown; continue?: unknown },
  deps: DispatchDeps,
): Promise<{ thread_id: string; platform_id: string; message_id: string | null }> {
  const key = typeof body.key === 'string' ? body.key : '';
  const agent = typeof body.agent === 'string' ? body.agent : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!KEY.test(key)) throw new DispatchError('key must be 4–32 lowercase letters or digits', 400);
  if (!AGENTS.includes(agent)) throw new DispatchError(`agent must be one of ${AGENTS.join(', ')}`, 400);
  if (!text.trim() || text.length > MAX_BRIEF)
    throw new DispatchError(`text is required, at most ${MAX_BRIEF} characters`, 400);

  const channel = await deps.agentChannel(agent);
  if (!channel) throw new DispatchError(`${agent} is not wired to any channel`, 404);
  const owner = await deps.ownerHandle();
  if (!owner) throw new DispatchError('no owner to hand the task over in the name of', 409);
  const adapter = deps.getAdapter();
  if (!adapter) throw new DispatchError('delivery adapter not ready', 503);

  let threadId: string;
  let ts: string | undefined;
  if (body.continue === true) {
    const job = deps.store().getJob(key);
    if (!job || job.agent !== agent || job.platform_id !== channel.platform_id) {
      throw new DispatchError(`no ${agent} job ${key} to continue`, 409);
    }
    threadId = job.thread_id;
    ts = await adapter.deliver(
      channel.channel_type,
      channel.platform_id,
      threadId,
      'chat',
      JSON.stringify({ text: `🔁 *Flow task \`${key}\`*\n\n${text}` }),
      undefined,
      channel.instance,
    );
  } else {
    // A second start while the agent still works would orphan its thread: the
    // completion marker there would no longer match any running job.
    if (deps.store().getJob(key)?.status === 'running') {
      throw new DispatchError(`job ${key} is still running; continue it instead`, 409);
    }
    const header = `🔧 *Flow task \`${key}\`* — handed over by the development flow.`;
    ts = await adapter.deliver(
      channel.channel_type,
      channel.platform_id,
      null,
      'chat',
      JSON.stringify({ text: `${header}\n\n${text}` }),
      undefined,
      channel.instance,
    );
    if (!ts) throw new DispatchError('the channel returned no message id, so there is no thread to work in', 502);
    threadId = `${channel.platform_id}:${ts}`;
  }
  deps.store().startJob({ key, agent, platform_id: channel.platform_id, thread_id: threadId });

  await deps.route({
    channelType: channel.channel_type,
    instance: channel.instance,
    platformId: channel.platform_id,
    threadId,
    message: {
      id: `flow-${key}-${Date.now()}`,
      kind: 'chat-sdk',
      content: JSON.stringify({
        text,
        author: { userId: owner, fullName: 'Flow (for the owner)' },
        senderId: owner,
        sender: 'Flow',
      }),
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
    },
  });
  log.info('Flow agent job dispatched', { key, agent, thread: threadId });
  return { thread_id: threadId, platform_id: channel.platform_id, message_id: ts ?? null };
}

export interface CompletionDeps {
  store: () => FlowTaskStore;
  post: (url: string, body: unknown) => Promise<number>;
}

/** Post-delivery hook body: close the job and call the flow back on a completion marker. */
export async function onAgentMessage(
  msg: { platformId: string | null; threadId: string | null; content: string },
  deps: CompletionDeps,
): Promise<void> {
  if (!msg.platformId || !msg.threadId) return;
  const job = deps.store().runningJobOnThread(msg.platformId, msg.threadId);
  if (!job) return;
  let text = '';
  try {
    const c = JSON.parse(msg.content) as { text?: unknown; markdown?: unknown };
    text = typeof c.text === 'string' ? c.text : typeof c.markdown === 'string' ? c.markdown : '';
  } catch {
    return;
  }
  const m = MARKER.exec(text);
  if (!m || m[2].toLowerCase() !== job.key) return;
  const status = m[1].toLowerCase() as 'done' | 'blocked';
  deps.store().finishJob(job.key, status, text);
  try {
    const code = await deps.post(FLOW_AGENT_CALLBACK_URL, {
      key: job.key,
      status,
      text,
      agent: job.agent,
      thread_id: job.thread_id,
    });
    deps.store().noteCallback(job.key, `HTTP ${code}`);
    log.info('Flow agent job finished', { key: job.key, status, callback: code });
  } catch (err) {
    deps.store().noteCallback(job.key, `failed: ${String(err)}`);
    log.error('Flow agent job: callback failed', { key: job.key, err: String(err) });
  }
}
