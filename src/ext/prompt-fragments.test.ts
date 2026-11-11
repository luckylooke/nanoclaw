import { beforeEach, describe, expect, it } from 'vitest';

import { _resetSeamsForTest, contributedPromptFragments, registerPromptFragment } from './seams.js';
import { readForkInstructions } from './prompt-fragments.js';

describe('fork house rules (container/fork-instructions.md)', () => {
  const text = readForkInstructions();

  it('carries the policies agents depend on', () => {
    for (const heading of [
      '## Source of truth & acting on requests',
      '## Language',
      '## Voice vs text',
      '## Tool execution (secrets proxy)',
      '## SECURITY: Strict secrets isolation',
    ]) {
      expect(text).toContain(heading);
    }
  });

  it('drops the maintainer comment, which is not for the model', () => {
    expect(text.startsWith('## Source of truth')).toBe(true);
    expect(text).not.toContain('<!--');
  });
});

describe('prompt-fragment seam', () => {
  beforeEach(() => _resetSeamsForTest());

  it('returns fragments in order, skipping empty and failing ones', () => {
    registerPromptFragment({ name: 'A', body: () => 'a' });
    registerPromptFragment({ name: 'Empty', body: () => '  ' });
    registerPromptFragment({
      name: 'Broken',
      body: () => {
        throw new Error('ENOENT');
      },
    });
    registerPromptFragment({ name: 'B', body: () => 'b' });
    expect(contributedPromptFragments()).toEqual([
      { name: 'A', body: 'a' },
      { name: 'B', body: 'b' },
    ]);
  });
});
