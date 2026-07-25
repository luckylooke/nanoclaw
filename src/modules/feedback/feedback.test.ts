import { describe, expect, it } from 'vitest';

import { emojiToSignal } from './index.js';
import type { InboundReaction } from '../../channels/adapter.js';

function reaction(emoji: string | null, rawEmoji: string | null): InboundReaction {
  return {
    channelType: 'slack',
    channel: 'slack:C1',
    messageTs: '1.2',
    emoji,
    rawEmoji,
    userId: 'U1',
  };
}

describe('emojiToSignal', () => {
  it('maps positive emoji to up (by name or raw)', () => {
    expect(emojiToSignal(reaction('thumbsup', '+1'))).toBe('up');
    expect(emojiToSignal(reaction('white_check_mark', '✅'))).toBe('up');
    expect(emojiToSignal(reaction(null, '+1'))).toBe('up');
    expect(emojiToSignal(reaction('heavy_check_mark', null))).toBe('up');
  });

  it('maps negative emoji to down (by name or raw)', () => {
    expect(emojiToSignal(reaction('thumbsdown', '-1'))).toBe('down');
    expect(emojiToSignal(reaction('x', '❌'))).toBe('down');
    expect(emojiToSignal(reaction(null, '-1'))).toBe('down');
  });

  it('is case-insensitive', () => {
    expect(emojiToSignal(reaction('ThumbsUp', null))).toBe('up');
  });

  it('falls back to raw:<emoji> for anything else', () => {
    expect(emojiToSignal(reaction('tada', '🎉'))).toBe('raw:tada');
    expect(emojiToSignal(reaction(null, null))).toBe('raw:unknown');
  });
});
