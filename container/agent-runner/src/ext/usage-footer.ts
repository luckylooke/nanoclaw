/**
 * Token-usage footer, container half (fork feature token-usage-footer).
 *
 * At the end of a chat turn that put something in a Slack channel, ask the host
 * for a 🪙 cost line under it. The container knows when a turn ends and its
 * trace id; only the host knows what the turn cost (gateway.db api_calls, the
 * same numbers the dashboard and the budget gate use, subagents included). So
 * this writes a `usage_footer` system action and the host's handler
 * (src/ext/usage-footer.ts) prices it and posts the line.
 *
 * Cost not yet shown is tracked per trace: a turn that delivered nothing (a
 * wrap-nudge retry, a silent turn) rolls into the next footer, also when the
 * next turn runs on a new query and so a new trace.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { currentTraceId } from './otel-trace.js';
import { registerTurnEndObserver, type TurnEnd } from './seams.js';

/** The host refuses more; older entries are dropped first. */
export const MAX_TRACES = 20;

export interface TraceSince {
  traceId: string;
  /** ISO time; calls on this trace before it were already in a footer. Null = the whole trace. */
  since: string | null;
}

export interface UsageFooterRequest {
  action: 'usage_footer';
  traces: TraceSince[];
  threadId: string | null;
}

/** Traces with cost not yet in a footer, oldest first. */
let pending: TraceSince[] = [];

/** The request to write for this turn end, or null when no footer belongs under it. */
export function footerRequest(t: TurnEnd, traceId: string | null, now: string): UsageFooterRequest | null {
  if (traceId && !pending.some((p) => p.traceId === traceId)) pending.push({ traceId, since: null });
  if (pending.length > MAX_TRACES) pending = pending.slice(-MAX_TRACES);

  const { routing } = t;
  if (!t.delivered || routing.taskRun || !traceId) return null;
  if (routing.channelType !== 'slack' || !routing.platformId) return null;
  const traces = pending;
  // Everything up to now is in this footer; the live trace may still run on.
  pending = [{ traceId, since: now }];
  return { action: 'usage_footer', traces, threadId: routing.threadId };
}

export function _resetUsageFooterForTest(): void {
  pending = [];
}

registerTurnEndObserver('usage-footer', async (t) => {
  const req = footerRequest(t, currentTraceId(), new Date().toISOString());
  if (!req) return;
  await writeMessageOut({
    id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    content: JSON.stringify(req),
  });
});
