/**
 * A flow job thread that outlives the agent's session.
 *
 * daily-reset closes every Slack session at 03:15 on purpose: the agent starts
 * the day fresh and gets yesterday from its diary, not from a growing
 * transcript. A flow job thread often outlives that — a clarification waits for
 * the project manager for days. On 2026-10-11 Ctibor answered such a thread a
 * week later; the reply opened a new, empty session that never woke, and even
 * woken it would not have known which flow task the thread was, so it could
 * never have sent the marker that brings the flow back.
 *
 * So the first message on a running job's thread with no active session is
 * re-routed as a mention (it wakes the agent) with a short note appended: the
 * task key, what kind of job, the request, what is decided and what was asked,
 * and how to finish. The rest comes from the diary — the agent never needs to
 * re-read the thread.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { log } from '../../log.js';
import type { FlowJob, FlowTaskStore } from './tasks.js';

export interface ContinuationDeps {
  store: () => FlowTaskStore;
  /** 'active' — a session runs; 'closed' — the thread had one, closed by the nightly reset; 'none' — never had one. */
  sessionState: (platformId: string, threadId: string) => Promise<'active' | 'closed' | 'none'>;
  route: (event: InboundEvent) => Promise<void>;
}

interface TaskData {
  project?: string;
  request?: string;
  notes?: string[];
  clarifying?: string;
  clarify_questions?: string[];
}

const STAGE_TITLES: Record<string, string> = { spec: 'specification', design: 'solution design' };

/** The note appended to the person's message: enough to continue, never the whole thread. */
export function continuationNote(job: FlowJob, data: TaskData | null): string {
  const d = data || {};
  const key = job.key;
  const kind = d.clarifying
    ? `clarification before the ${STAGE_TITLES[d.clarifying] || d.clarifying}`
    : 'implementation';
  const lines = [
    '',
    '',
    '---',
    `_Context from the flow:_ your session was reset overnight; this thread continues flow task \`${key}\` — ${kind}${d.project ? `, project \`${d.project}\`` : ''}. Take what was discussed from your diary, as at every session start; do not re-read the whole thread.`,
  ];
  if (d.request) lines.push(`Request: ${d.request}`);
  if (d.notes && d.notes.length) lines.push(`Decided so far: ${d.notes.join('; ')}`);
  if (d.clarify_questions && d.clarify_questions.length) {
    lines.push(`Open decisions you asked about:\n${d.clarify_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
  }
  lines.push(
    d.clarifying
      ? `This is only a clarification: do not change any code. When everything is settled: list the decisions, ask "Sedí to takto?", and only after a later yes reply with the decisions and end that message with [[flow:clarified ${key}]].`
      : `Finish as briefed: a short final report ending with [[flow:done ${key}]] — [[flow:ask ${key}]] when you ask the person something, [[flow:blocked ${key}]] when you cannot go on.`,
  );
  return lines.join('\n');
}

/**
 * Appended to the person's reply after the agent summarised a clarification and
 * asked. On 2026-10-12 the agent took "áno" to "Pokračujem?" as "go and build
 * it": it implemented the button on main and never sent the marker, so the flow
 * never came back. The answer now carries what a yes means.
 */
export function confirmationNote(key: string): string {
  return [
    '',
    '',
    '---',
    `_From the flow:_ you summarised the decisions of flow task \`${key}\` and asked for confirmation. If this message confirms them, reply with the final decisions as bullets and end that message with exactly [[flow:clarified ${key}]] — do not change any code; the flow writes the specification next. If it changes something, update the summary and ask again.`,
  ].join('\n');
}

export function makeContinuationInterceptor(deps: ContinuationDeps) {
  return async (event: InboundEvent): Promise<boolean> => {
    if (!event.threadId) return false;
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(event.message.content) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (content.flowContinuation) return false; // our own re-route
    // The flow's own hand-off opens the thread; it is no continuation (2026-10-11:
    // a fresh clarification brief got "your session was reset overnight … implementation").
    if (content.flowDispatch) return false;
    let job: FlowJob | null;
    try {
      job = deps.store().runningJobOnThread(event.platformId, event.threadId);
    } catch (err) {
      log.warn('Flow continuation: job lookup failed — routing normally', { err: String(err) });
      return false;
    }
    if (!job) return false;
    const closed = (await deps.sessionState(event.platformId, event.threadId)) === 'closed';
    const confirming = job.awaiting_confirmation === 1;
    if (!closed && !confirming) return false;

    const task = deps.store().findOpenByKey(job.key);
    const text = typeof content.text === 'string' ? content.text : '';
    let note = closed ? continuationNote(job, (task?.data as TaskData | undefined) ?? null) : '';
    if (confirming) note += confirmationNote(job.key);
    await deps.route({
      ...event,
      message: {
        ...event.message,
        content: JSON.stringify({ ...content, text: `${text}${note}`, flowContinuation: true }),
        isMention: true,
      },
    });
    // Cleared only once the annotated reply is routed: a failed route keeps it for the next reply (review board).
    if (confirming) deps.store().setAwaitingConfirmation(job.key, false);
    log.info('Flow continuation: annotated a reply on a job thread', {
      key: job.key,
      thread: event.threadId,
      closed,
      confirming,
    });
    return true;
  };
}
