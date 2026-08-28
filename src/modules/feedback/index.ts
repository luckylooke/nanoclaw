/**
 * Slack reaction feedback capture (T1.3).
 *
 * A reaction on an agent's Slack reply is attributed back to the agent via the
 * gateway `agent_messages` index (written at delivery time), mapped to an
 * up/down/raw signal, and logged to the gateway `feedback` table. A downvote
 * additionally appends the offending (input, output) pair to the group's
 * `eval/candidates.jsonl` — closing the flywheel into the T1.2 eval harness.
 *
 * Deliberate constraints (Ch10 sycophancy / degenerate-loop caveat):
 *   - Feedback is a MONITORING + eval-seeding signal only. Nothing here changes
 *     a prompt, MEMORY, or model. Any such change goes through the existing
 *     human-review gate.
 *   - Only reactions from KNOWN users count (sender_scope='known'): the reactor
 *     must be a member of, or hold admin/owner privilege over, the reacted
 *     message's agent group. Unknown reactors are ignored (fail-closed).
 *   - Reactions on messages we didn't send (not in the index) are ignored.
 *   - Removals are not forwarded by the bridge (phase-2).
 *
 * Registers a reaction handler at import time; the barrel loads this after the
 * permissions module so the known-user helpers are available.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { lookupAgentMessage, recordFeedback } from '../../gateway-db.js';
import { log } from '../../log.js';
import { registerReactionHandler } from '../../response-registry.js';
import type { InboundReaction } from '../../channels/adapter.js';
import { isMember } from '../permissions/db/agent-group-members.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

// Emoji → signal. Matched against BOTH the normalized name (e.g. `thumbsup`)
// and the raw platform emoji (e.g. `+1`), case-insensitively.
const UP = new Set(['thumbsup', '+1', 'white_check_mark', 'heavy_check_mark']);
const DOWN = new Set(['thumbsdown', '-1', 'x']);

export function emojiToSignal(reaction: InboundReaction): string {
  const names = [reaction.emoji, reaction.rawEmoji]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.toLowerCase());
  if (names.some((n) => UP.has(n))) return 'up';
  if (names.some((n) => DOWN.has(n))) return 'down';
  return `raw:${reaction.emoji ?? reaction.rawEmoji ?? 'unknown'}`;
}

/** sender_scope='known': member of, or admin/owner over, the reacted group. */
async function isKnownReactor(reaction: InboundReaction, agentGroupId: string): Promise<boolean> {
  if (!reaction.userId) return false;
  const nsId = `${reaction.channelType}:${reaction.userId}`;
  return (await isMember(nsId, agentGroupId)) || (await hasAdminPrivilege(nsId, agentGroupId));
}

/** Append a downvoted (input, output) case for human promotion into golden.jsonl. */
function appendCandidate(folder: string, entry: Record<string, unknown>): void {
  const dir = path.join(GROUPS_DIR, folder, 'eval');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'candidates.jsonl'), JSON.stringify(entry) + '\n');
}

async function handleReaction(reaction: InboundReaction): Promise<void> {
  const agentMsg = lookupAgentMessage(reaction.messageTs);
  if (!agentMsg) {
    // Not one of our agent replies (or predates the index) — nothing to attribute.
    log.debug('Feedback: reaction on unknown/unindexed message, ignored', {
      messageTs: reaction.messageTs,
    });
    return;
  }

  const folder = agentMsg.group_slug;
  const group = folder ? await getAgentGroupByFolder(folder) : undefined;
  if (!group) {
    log.debug('Feedback: reacted message has no resolvable agent group, ignored', { folder });
    return;
  }
  if (!(await isKnownReactor(reaction, group.id))) {
    log.debug('Feedback: reaction from unknown user, ignored (sender_scope=known)', {
      channelType: reaction.channelType,
      group: folder,
    });
    return;
  }

  const signal = emojiToSignal(reaction);
  recordFeedback({
    group_slug: folder,
    session_id: agentMsg.session_id,
    message_ts: reaction.messageTs,
    channel: reaction.channel,
    signal,
    kind: 'explicit_reaction',
    prompt_version: agentMsg.prompt_version, // NULL until T7 lands
    note: reaction.rawEmoji ?? reaction.emoji ?? null,
  });
  log.info('Feedback captured', { group: folder, signal, messageTs: reaction.messageTs });

  // Downvotes seed the eval set. Do NOT act on it automatically.
  if (signal === 'down' && folder) {
    try {
      appendCandidate(folder, {
        ts: new Date().toISOString(),
        input: agentMsg.input_text,
        output: agentMsg.output_text,
        signal,
        emoji: reaction.rawEmoji ?? reaction.emoji,
        message_ts: reaction.messageTs,
        channel: reaction.channel,
        source: 'reaction',
      });
      log.info('Feedback: eval candidate appended', { group: folder });
    } catch (err) {
      log.warn('Feedback: failed to append eval candidate', { group: folder, err: String(err) });
    }
  }
}

registerReactionHandler((reaction) =>
  handleReaction(reaction).catch((err) =>
    log.error('Feedback handler error', { messageTs: reaction.messageTs, err: String(err) }),
  ),
);
