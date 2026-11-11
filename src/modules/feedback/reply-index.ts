/**
 * Reply index for reaction feedback (T1.3).
 *
 * A reaction can only be attributed if the reacted message is in the gateway
 * `agent_messages` index. This writes that index: every delivered user-facing
 * text reply, keyed by its platform message id, with the triggering user turn
 * and a prompt fingerprint. Attaches through upstream's post-delivery hook, so
 * it runs after the row is marked delivered and can never affect delivery.
 *
 * Edits, reactions, cards, ask_question cards and file-only replies are not
 * answers and are skipped. task_log and agent-to-agent rows never reach a
 * post-delivery hook.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerPostDeliveryHook, type PostDeliveryHook } from '../../delivery.js';
import { recordAgentMessage, type AgentMessageInput } from '../../gateway-db.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';

/** Best-effort text extraction from an inbound/outbound content JSON object. */
export function extractText(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  for (const key of ['markdown', 'text', 'content']) {
    if (typeof c[key] === 'string' && (c[key] as string).length > 0) return c[key] as string;
  }
  return null;
}

/** The answer text of an outbound content object, or null if it is not an answer. */
export function answerText(content: Record<string, unknown>): string | null {
  if (content.operation === 'edit' || content.operation === 'reaction') return null;
  if (content.type === 'ask_question' || content.type === 'card') return null;
  return extractText(content);
}

/**
 * T7 prompt_version: a stable fingerprint of the agent's identity at reply time,
 * so a downvote can be tied to a concrete prompt and joined to an eval
 * snapshot. sha256(CLAUDE.md + '\n' + CLAUDE.local.md).slice(0,16). Must stay
 * byte-identical to agent-system tools/eval/eval.js computeIdentityVersion(),
 * so eval `identity_version` == feedback `prompt_version`. Never throws.
 */
export function computePromptVersion(folder: string | null, groupsDir: string = GROUPS_DIR): string | null {
  if (!folder) return null;
  try {
    const base = join(groupsDir, folder);
    const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
    const material = readIf(join(base, 'CLAUDE.md')) + '\n' + readIf(join(base, 'CLAUDE.local.md'));
    return createHash('sha256').update(material).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export interface ReplyIndexDeps {
  inboundContent: (agentGroupId: string, sessionId: string, messageId: string) => Promise<string | null>;
  groupFolder: (agentGroupId: string) => Promise<string | null>;
  record: (row: AgentMessageInput) => void;
  promptVersion: (folder: string | null) => string | null;
}

export function replyIndexHook(deps: ReplyIndexDeps): PostDeliveryHook {
  return async (msg, session, { platformMsgId }) => {
    if (!platformMsgId || !msg.channelType || !msg.platformId) return;
    // deliverMessage already parsed this; if it throws here the wrapper logs it.
    const outputText = answerText(JSON.parse(msg.content) as Record<string, unknown>);
    if (!outputText) return;

    let inputText: string | null = null;
    if (msg.inReplyTo) {
      try {
        const raw = await deps.inboundContent(session.agent_group_id, session.id, msg.inReplyTo);
        inputText = raw ? extractText(JSON.parse(raw)) : null;
      } catch {
        inputText = null;
      }
    }

    const folder = await deps.groupFolder(session.agent_group_id);
    deps.record({
      channel_type: msg.channelType,
      platform_id: msg.platformId,
      message_ts: platformMsgId,
      group_slug: folder,
      session_id: session.id,
      prompt_version: deps.promptVersion(folder),
      input_text: inputText,
      output_text: outputText,
    });
  };
}

const indexReply = replyIndexHook({
  // Read through the mailbox seam: a post-delivery hook holds no session on this key.
  inboundContent: async (agentGroupId, sessionId, messageId) =>
    (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      mailbox.getInboundContentById(messageId),
    )) ?? null,
  groupFolder: async (agentGroupId) => (await getAgentGroup(agentGroupId))?.folder ?? null,
  record: recordAgentMessage,
  promptVersion: (folder) => computePromptVersion(folder),
});

registerPostDeliveryHook(async (msg, session, info) => {
  try {
    await indexReply(msg, session, info);
  } catch (err) {
    log.warn('Feedback index: recordReply failed', { id: msg.id, err: String(err) });
  }
});
