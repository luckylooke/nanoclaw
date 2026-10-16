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
 * messages without a marker are ignored.
 * Two more markers serve the clarification detour (Ctibor, 2026-10-04: the
 * person and the agent settle open decisions in the agent's thread, with no
 * round limit, and only the end reaches the flow): `[[flow:ask <key>]]` tells
 * the flow the agent asked the person something — the job stays running and the
 * discussion continues in the thread without the flow; `[[flow:clarified <key>]]`
 * closes a clarification job with the confirmed decisions.
 * A failed callback is recorded on the job
 * and visible via /flow-agent/job, never retried blindly.
 *
 * On the job thread the marker's key is optional and a wrong one is logged, not fatal: the thread
 * already names the job (Ctibor, 2026-10-16). A message without a marker starts the silence watch
 * (sweepSilentJobs, every 5 min from index.ts): quiet SILENT_MS after it, the agent is reminded once
 * how to finish; quiet SILENT_MS more, the person is told in the task thread. Nothing during maintenance.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { FlowJob, FlowTaskStore } from './tasks.js';

export const FLOW_AGENT_CALLBACK_URL =
  process.env.FLOW_AGENT_CALLBACK_URL || 'http://127.0.0.1:8000/process-income-msg/agent-done/fJXu7oW1cW61f/';
export const AGENTS = ['dev-web', 'dev-game'];
// "<id>" or "<id>-<readable-suffix>" (agent-system stages.taskKeyFor, 2026-10-15).
const KEY = /^[a-z0-9]{4,32}(?:-[a-z0-9]+){0,8}$/;
const KEY_MAX = 64;
/** The identity part of a key: markers match on it, so a typo in the readable suffix still closes the job. */
export const keyId = (key: string) => key.toLowerCase().split('-')[0];
const MAX_BRIEF = 20_000;
// The key is optional and a wrong one is not fatal: the thread already names the job (Ctibor, 2026-10-16) —
// a marker the agent mistyped would otherwise leave the task waiting for ever.
const MARKER = /\[\[flow:(done|blocked|ask|clarified)(?:\s+([a-z0-9]{1,32}(?:-[a-z0-9]+)*))?\s*\]\]/i;

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
  if (!KEY.test(key) || key.length > KEY_MAX)
    throw new DispatchError('key must be 4–32 lowercase letters or digits, optionally with -suffix words', 400);
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
    const previous = deps.store().getJob(key);
    if (previous?.status === 'running') {
      throw new DispatchError(`job ${key} is still running; continue it instead`, 409);
    }
    if (previous && previous.agent === agent && previous.platform_id === channel.platform_id) {
      // One task, one thread in the agent's channel: every later step of the task
      // (the next clarification, the implementation) goes where the earlier ones
      // are. A new thread per step made Ctibor read the same context again and
      // again, and answer in the wrong one (2026-10-12).
      threadId = previous.thread_id;
      ts = await adapter.deliver(
        channel.channel_type,
        channel.platform_id,
        threadId,
        'chat',
        JSON.stringify({ text: `🔧 *Flow task \`${key}\`* — next step.\n\n${text}` }),
        undefined,
        channel.instance,
      );
    } else {
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
        // Marks the flow's own hand-off, so the continuation interceptor never
        // mistakes a job's first brief for a reply after a session reset.
        flowDispatch: true,
      }),
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: true,
    },
  });
  log.info('Flow agent job dispatched', { key, agent, thread: threadId });
  return { thread_id: threadId, platform_id: channel.platform_id, message_id: ts ?? null };
}

/**
 * The person cancelled the task while the agent was on it: say so in the job's
 * thread and close the job. Two test threads on the same topic got answered in
 * the wrong one (2026-10-11/12) because nothing in the old thread said it was over.
 */
export async function cancelJob(
  body: { key?: unknown },
  deps: Pick<DispatchDeps, 'store' | 'getAdapter' | 'agentChannel'>,
): Promise<{ cancelled: boolean; thread_id?: string }> {
  const key = typeof body.key === 'string' ? body.key : '';
  if (!KEY.test(key) || key.length > KEY_MAX)
    throw new DispatchError('key must be 4–32 lowercase letters or digits, optionally with -suffix words', 400);
  const job = deps.store().getJob(key);
  if (!job || job.status !== 'running') return { cancelled: false };
  const channel = await deps.agentChannel(job.agent);
  const adapter = deps.getAdapter();
  if (channel && adapter && channel.platform_id === job.platform_id) {
    await adapter.deliver(
      channel.channel_type,
      channel.platform_id,
      job.thread_id,
      'chat',
      JSON.stringify({
        text: `❌ *Flow task \`${key}\` was cancelled* by the project manager. Stop working on it; nothing more is needed in this thread.`,
      }),
      undefined,
      channel.instance,
    );
  }
  deps.store().finishJob(key, 'cancelled', 'cancelled by the person');
  log.info('Flow agent job cancelled', { key, thread: job.thread_id });
  return { cancelled: true, thread_id: job.thread_id };
}

/**
 * The silence watch (Ctibor, 2026-10-16): an agent whose last message on a job thread carried no marker
 * and that has been quiet for SILENT_MS is reminded once how to finish; quiet SILENT_MS more, the person
 * is told in the task thread. Nothing during maintenance; a question ([[flow:ask]]) is not silence.
 */
export const SILENT_MS = 30 * 60 * 1000;

export interface SweepDeps {
  store: () => FlowTaskStore;
  dispatchDeps: DispatchDeps;
  maintenance: () => boolean;
  now?: () => number;
}

export function nudgeText(key: string): string {
  return [
    'Your last message here ended without a flow marker, so the flow cannot tell whether you are finished.',
    `- Finished: send your final report and end it with exactly [[flow:done ${key}]]`,
    `- Cannot continue: say why in two lines and end with [[flow:blocked ${key}]]`,
    `- You need the person: ask, and end with [[flow:ask ${key}]]`,
    'Still working: carry on, nothing to do now.',
  ].join('\n');
}

function warnText(job: FlowJob, minutes: number, lang: string): string {
  const m = /^slack:(C[A-Z0-9]+):(\d+)\.(\d+)$/.exec(job.thread_id);
  const link = m ? `https://slack.com/archives/${m[1]}/p${m[2]}${m[3]}` : job.thread_id;
  return lang === 'sk'
    ? `⚠️ *${job.agent}* sa odmlčal bez ukončenia úlohy (pripomenul som mu to pred ${minutes} min, odvtedy ticho) — flow nevie, či je hotový. Pozri jeho vlákno: ${link}\nMôžeš mu napísať tu, pošlem mu to.`
    : `⚠️ *${job.agent}* went quiet without finishing (reminded ${minutes} min ago, quiet since) — the flow cannot tell whether it is done. See its thread: ${link}\nYou can write to it here; I pass it on.`;
}

export async function sweepSilentJobs(deps: SweepDeps): Promise<{ nudged: string[]; warned: string[] }> {
  const out = { nudged: [] as string[], warned: [] as string[] };
  if (deps.maintenance()) return out;
  const now = (deps.now || Date.now)();
  for (const job of deps.store().silentCandidates()) {
    const last = Date.parse(job.last_agent_at || '');
    const nudged = job.nudged_at ? Date.parse(job.nudged_at) : 0;
    const quietSince = Math.max(last || 0, nudged);
    if (!(now - quietSince >= SILENT_MS)) continue;
    if (!nudged) {
      try {
        await dispatch({ key: job.key, agent: job.agent, text: nudgeText(job.key), continue: true }, deps.dispatchDeps);
        // dispatch re-opened the job (startJob clears the watch): restore what the agent last did, then stamp the nudge
        deps.store().noteAgentMessage(job.key, '', new Date(now).toISOString());
        deps.store().markNudged(job.key, new Date(now).toISOString());
        out.nudged.push(job.key);
        log.info('Flow agent job silent: nudged', { key: job.key });
      } catch (err) {
        // dispatch may have re-opened the job before failing: put the watch back, so the next sweep tries again
        deps.store().noteAgentMessage(job.key, '', job.last_agent_at || new Date(now).toISOString());
        log.error('Flow agent job silent: nudge failed', { key: job.key, err: String(err) });
      }
      continue;
    }
    if (job.warned_at) continue;
    const task = deps.store().findOpenByKey(job.key);
    const adapter = deps.dispatchDeps.getAdapter();
    if (!task || !adapter) continue;
    const lang = (task.data as { person_lang?: string }).person_lang === 'sk' ? 'sk' : 'en';
    try {
      await adapter.deliver(
        task.channel_type,
        task.platform_id,
        task.thread_id,
        'chat',
        JSON.stringify({ text: warnText(job, Math.round((now - nudged) / 60000), lang) }),
        undefined,
        task.instance ?? undefined,
      );
      deps.store().markWarned(job.key, new Date(now).toISOString());
      out.warned.push(job.key);
      log.info('Flow agent job silent: person told', { key: job.key });
    } catch (err) {
      log.error('Flow agent job silent: telling the person failed', { key: job.key, err: String(err) });
    }
  }
  return out;
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
  if (!m) {
    deps.store().noteAgentMessage(job.key, ''); // progress, or a report that forgot its marker: the silence watch decides
    return;
  }
  if (m[2] && keyId(m[2]) !== keyId(job.key))
    log.warn('Flow marker names another key; taken for the job on this thread', { job: job.key, marker: m[2] });
  deps.store().noteAgentMessage(job.key, m[1].toLowerCase());
  let status = m[1].toLowerCase() as 'done' | 'blocked' | 'ask' | 'clarified';
  // A clarification closes only on decisions the person has already confirmed.
  // A message that still asks ("Pokračujem?") is the summary, not the
  // confirmation: twice on 2026-10-04/11 the agent put the marker under its own
  // question, so the brief alone does not hold it. Treat it as a question — the
  // job stays open and the agent sends the marker again after the yes.
  if (status === 'clarified' && /\?/.test(text.replace(MARKER, ''))) {
    status = 'ask';
    deps.store().setAwaitingConfirmation(job.key, true);
  }
  // A question keeps the job open: the answer goes to the agent, not to the flow.
  if (status !== 'ask') deps.store().finishJob(job.key, status === 'blocked' ? 'blocked' : 'done', text);
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
