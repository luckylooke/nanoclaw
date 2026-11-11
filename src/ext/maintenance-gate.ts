/**
 * Maintenance mode on the wake-gate seam (feature `maintenance-mode`).
 *
 * The flag logic lives in src/maintenance.ts; this file is where it attaches to
 * core. Both wake sites must hold or the pause does nothing: routeInbound for new
 * messages, and the sweep — which exists precisely to wake sessions with pending
 * rows, i.e. every session during maintenance, and would undo the inbound gate
 * within 60 seconds. Scheduled tasks are held by the sweep gate too: they stay
 * due and fire after release rather than being skipped.
 */
import { log } from '../log.js';
import { getMaintenance, hasBeenNotified, markNotified } from '../maintenance.js';
import { writeOutboundDirect } from '../session-manager.js';
import { registerWakeGate, type WakeGateContext } from './seams.js';

export function maintenanceGate(ctx: WakeGateContext): string | null {
  const maint = getMaintenance();
  if (!maint) return null;
  const { session, replyTo } = ctx;
  if (ctx.site === 'inbound') {
    // No typing indicator: core returns before starting one, and a multi-hour
    // "typing…" reads as a broken agent, not a paused one.
    if (replyTo && !hasBeenNotified(session.id)) {
      // Answered by the host, not the agent: no container is running and none
      // will start. One notice per session per window, so five messages do not
      // produce five apologies.
      void writeOutboundDirect(session.agent_group_id, session.id, {
        id: `maint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: replyTo.platformId,
        channelType: replyTo.channelType,
        threadId: replyTo.threadId,
        content: JSON.stringify({
          text:
            `🔧 The agent system is in maintenance (${maint.reason}). ` +
            'Your message is queued and will be answered in order as soon as it is back — nothing is lost.',
        }),
      }).catch((err) => log.warn('Maintenance notice failed', { sessionId: session.id, err }));
      markNotified(session.id);
    }
    log.info('Message buffered — maintenance mode', {
      sessionId: session.id,
      agentGroup: session.agent_group_id,
      since: maint.since,
    });
  }
  return `maintenance: ${maint.reason}`;
}

registerWakeGate('maintenance', maintenanceGate);
