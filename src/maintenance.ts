import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * Maintenance mode — pause every agent without losing a single message.
 *
 * The buffer this needs already existed. `routeInbound` persists an inbound
 * message to `messages_in` and only *then*, as a separate step, wakes a
 * container; the transient-spawn-failure path has always left the row pending
 * for `host-sweep` to retry. So pausing the system is not a queueing problem —
 * it is two wake sites declining to fire, and the existing retry loop draining
 * them afterwards.
 *
 *   on   → `writeSessionMessage` still runs, `wakeContainer` does not.
 *          Messages accumulate as pending, ordered by seq, per session.
 *   off  → the next host-sweep tick (60s) wakes every session with due work
 *          and its poll-loop consumes the backlog oldest-first.
 *
 * Deliberately NOT implemented by stopping the nanoclaw service: the chat
 * adapter would stop ingesting, and Slack drops an event after a few failed
 * retries. A dropped Slack message is gone; a pending row is not. Staying up
 * and declining to wake is what makes this lossless.
 *
 * Running containers are never killed on entry — killing one mid-turn orphans
 * its work, which is the exact failure this system has already been bitten by
 * twice. `maintenance on --wait` waits for them to finish instead.
 */

const FLAG_PATH = path.join(DATA_DIR, '.maintenance');

export interface MaintenanceState {
  since: string;
  reason: string;
  by: string;
  /**
   * Sessions already told "we are in maintenance", so a user who sends five
   * messages during one window gets one notice, not five. Reset with the flag.
   */
  notified: string[];
}

/** Read the flag, or null when not in maintenance. Never throws. */
export function getMaintenance(): MaintenanceState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(FLAG_PATH, 'utf-8');
  } catch {
    return null; // absent = normal operation, the overwhelmingly common path
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceState>;
    return {
      since: parsed.since ?? new Date().toISOString(),
      reason: parsed.reason ?? '(no reason given)',
      by: parsed.by ?? 'unknown',
      notified: Array.isArray(parsed.notified) ? parsed.notified : [],
    };
  } catch {
    // A corrupt flag must fail SAFE. Treating an unparseable file as "not in
    // maintenance" would resume the fleet in the middle of a deploy; treating
    // it as "in maintenance" only delays messages, which is recoverable.
    log.warn('Maintenance flag is unparseable — staying paused', { path: FLAG_PATH });
    return { since: 'unknown', reason: 'unparseable maintenance flag', by: 'unknown', notified: [] };
  }
}

export function isMaintenance(): boolean {
  return getMaintenance() !== null;
}

/**
 * Record that a session has been sent its one-time notice.
 *
 * Read-modify-write on a file that an operator may also be editing, so a
 * failure here must never block the notice itself — worst case a session is
 * told twice.
 */
export function markNotified(sessionId: string): void {
  const state = getMaintenance();
  if (!state || state.notified.includes(sessionId)) return;
  try {
    state.notified.push(sessionId);
    fs.writeFileSync(FLAG_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    log.warn('Could not record maintenance notice', { sessionId, error: String(e) });
  }
}

export function hasBeenNotified(sessionId: string): boolean {
  return getMaintenance()?.notified.includes(sessionId) ?? false;
}

export const MAINTENANCE_FLAG_PATH = FLAG_PATH;
