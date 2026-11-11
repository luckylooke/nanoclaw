import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { answerText, computePromptVersion, replyIndexHook, type ReplyIndexDeps } from './reply-index.js';
import type { AgentMessageInput } from '../../gateway-db.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import type { Session } from '../../types.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

function outbound(content: Record<string, unknown>, extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'out-1',
    kind: 'chat',
    channelType: 'slack',
    platformId: 'slack:C1',
    threadId: null,
    inReplyTo: 'in-1',
    content: JSON.stringify(content),
    ...extra,
  } as OutboundMessage;
}

function harness(inbound: string | null = JSON.stringify({ text: 'what is QNH?' })) {
  const rows: AgentMessageInput[] = [];
  const deps: ReplyIndexDeps = {
    inboundContent: async () => inbound,
    groupFolder: async () => 'learning',
    record: (row) => rows.push(row),
    promptVersion: (folder) => (folder ? 'pv-' + folder : null),
  };
  return { rows, hook: replyIndexHook(deps) };
}

describe('answerText', () => {
  it('takes markdown, then text, then content', () => {
    expect(answerText({ markdown: 'm', text: 't' })).toBe('m');
    expect(answerText({ text: 't' })).toBe('t');
    expect(answerText({ content: 'c' })).toBe('c');
  });

  it('skips edits, reactions, cards, questions and file-only replies', () => {
    expect(answerText({ operation: 'edit', text: 'x' })).toBeNull();
    expect(answerText({ operation: 'reaction', text: 'x' })).toBeNull();
    expect(answerText({ type: 'card', text: 'x' })).toBeNull();
    expect(answerText({ type: 'ask_question', text: 'x' })).toBeNull();
    expect(answerText({ files: ['a.png'] })).toBeNull();
  });
});

describe('replyIndexHook', () => {
  it('indexes a delivered text reply with its user turn', async () => {
    const { rows, hook } = harness();
    await hook(outbound({ text: 'Pressure at sea level.' }), session, { firstDelivery: true, platformMsgId: '1.23' });
    expect(rows).toEqual([
      {
        channel_type: 'slack',
        platform_id: 'slack:C1',
        message_ts: '1.23',
        group_slug: 'learning',
        session_id: 'sess-1',
        prompt_version: 'pv-learning',
        input_text: 'what is QNH?',
        output_text: 'Pressure at sea level.',
      },
    ]);
  });

  it('records nothing without a platform message id', async () => {
    const { rows, hook } = harness();
    await hook(outbound({ text: 'hi' }), session, { firstDelivery: false, platformMsgId: null });
    expect(rows).toEqual([]);
  });

  it('records nothing for a card', async () => {
    const { rows, hook } = harness();
    await hook(outbound({ type: 'card', text: 'hi' }), session, { firstDelivery: false, platformMsgId: '1.2' });
    expect(rows).toEqual([]);
  });

  it('still indexes when the user turn cannot be read', async () => {
    const { rows, hook } = harness('not json');
    await hook(outbound({ text: 'hi' }), session, { firstDelivery: false, platformMsgId: '1.2' });
    expect(rows[0]?.input_text).toBeNull();
    expect(rows[0]?.output_text).toBe('hi');
  });
});

describe('computePromptVersion', () => {
  it('matches eval.js computeIdentityVersion: sha256(CLAUDE.md + \\n + CLAUDE.local.md)[0:16]', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
    fs.mkdirSync(path.join(dir, 'g'));
    fs.writeFileSync(path.join(dir, 'g', 'CLAUDE.md'), 'base');
    fs.writeFileSync(path.join(dir, 'g', 'CLAUDE.local.md'), 'local');
    const expected = createHash('sha256').update('base\nlocal').digest('hex').slice(0, 16);
    expect(computePromptVersion('g', dir)).toBe(expected);
    expect(computePromptVersion(null, dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
