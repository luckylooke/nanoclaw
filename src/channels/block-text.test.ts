/**
 * What this pins: a Slack list reaches the agent one item per line, and the
 * text is touched ONLY when it is exactly the SDK's glued flattening of the
 * tree — anything else (a mention or link rendered differently, no tree, a
 * single paragraph) is left byte-identical.
 */
import { describe, expect, it } from 'vitest';

import { blockText } from './block-text.js';

const t = (value: string) => ({ type: 'text', value });
const p = (...children: object[]) => ({ type: 'paragraph', children });
const li = (...children: object[]) => ({ type: 'listItem', children });

describe('blockText', () => {
  it('puts each item of a numbered list on its own line (the 2026-10-04 answer)', () => {
    const formatted = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: true,
          start: 1,
          children: [li(p(t('paticka'))), li(p(t('ok kontakt'))), li(p(t('ano secondary')))],
        },
      ],
    };
    expect(blockText('patickaok kontaktano secondary', formatted)).toBe('1. paticka\n2. ok kontakt\n3. ano secondary');
  });

  it('separates paragraphs and keeps bullet lists as bullets', () => {
    const formatted = {
      type: 'root',
      children: [p(t('Two things:')), { type: 'list', ordered: false, children: [li(p(t('red'))), li(p(t('big')))] }],
    };
    expect(blockText('Two things:redbig', formatted)).toBe('Two things:\n- red\n- big');
  });

  it('leaves the text alone when it is not exactly the glued leaves', () => {
    const formatted = {
      type: 'root',
      children: [{ type: 'list', ordered: true, start: 1, children: [li(p(t('a'))), li(p(t('b')))] }],
    };
    expect(blockText('a b', formatted)).toBeNull();
    expect(blockText('<@U1> ab', formatted)).toBeNull();
  });

  it('keeps an answer that was only a list marker ("1." reached the agent empty, 2026-10-12)', () => {
    const formatted = {
      type: 'root',
      children: [{ type: 'list', ordered: true, start: 1, children: [{ type: 'listItem', children: [] }] }],
    };
    expect(blockText('', formatted)).toBe('1.');
    expect(blockText('', { type: 'root', children: [] })).toBeNull();
  });

  it('leaves a single paragraph, a missing tree and empty text alone', () => {
    expect(blockText('hello world', { type: 'root', children: [p(t('hello world'))] })).toBeNull();
    expect(blockText('hello', undefined)).toBeNull();
    expect(blockText('', { type: 'root', children: [] })).toBeNull();
  });
});
