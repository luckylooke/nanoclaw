/**
 * Adaptive per-spawn tuning (feature `complexity-tier`), on the spawn-tuning
 * seam: the session's latest trigger message is classified into a complexity
 * tier, which maps to a compact window (container env, read by the runner at
 * startup) and an effort (a container.json override that never beats an
 * explicit admin pin). With no inbound text to classify, the window falls back
 * to the DB-configured compact_window or the static default. See
 * src/complexity-tier.ts.
 *
 * Reads through the mailbox seam: upstream v2.3.0 replaced the direct
 * openInboundDb() handle with MailboxSession, so the trigger-text read is a
 * mailbox method rather than a SQL query issued from here.
 */
import { classifyComplexity, DEFAULT_STATIC_WINDOW, tuningForTier } from '../complexity-tier.js';
import { getContainerConfig } from '../db/container-configs.js';
import { log } from '../log.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { registerSpawnTuning, type SpawnTuning, type SpawnTuningContext } from './seams.js';

export async function adaptiveTuning({ agentGroup, session }: SpawnTuningContext): Promise<SpawnTuning> {
  let text: string | null | undefined;
  try {
    text = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => mailbox.getLatestTriggerText());
  } catch (err) {
    log.debug('Adaptive tuning: failed to read inbound text', { sessionId: session.id, err });
  }
  if (!text || text.trim().length === 0) {
    const configRow = await getContainerConfig(agentGroup.id);
    return { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(configRow?.compact_window ?? DEFAULT_STATIC_WINDOW) } };
  }
  const tuning = tuningForTier(classifyComplexity(text));
  return {
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(tuning.window) },
    overrides: { effort: tuning.effort },
  };
}

registerSpawnTuning('complexity-tier', adaptiveTuning);
