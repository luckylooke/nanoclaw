/**
 * What this pins: a thread a module declares isolated drops out of the echo
 * hot set, so it is neither a fan target nor a backfill source, while every
 * other sibling still is.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { selectEchoTargets } from './fan.js';
import { isIsolatedThread, registerIsolatedThreads, resetIsolatedThreadsForTest } from './isolation.js';

const now = Date.parse('2026-10-04T20:00:00Z');
const s = (id: string, thread_id: string | null) => ({
  id,
  thread_id,
  messaging_group_id: 'mg1',
  last_active: '2026-10-04T19:59:00Z',
  status: 'active',
});

afterEach(() => resetIsolatedThreadsForTest());

describe('isolated threads', () => {
  it('drop out of the echo targets; other siblings stay', () => {
    registerIsolatedThreads((t) => t === 'slack:C1:2.2');
    const targets = selectEchoTargets(
      [s('a', 'slack:C1:1.1'), s('b', 'slack:C1:2.2'), s('top', null)],
      'src',
      'mg1',
      now,
    );
    expect(targets.map((t) => t.id).sort()).toEqual(['a', 'top']);
  });

  it('a throwing predicate isolates nothing; no thread id is never isolated', () => {
    registerIsolatedThreads(() => {
      throw new Error('db gone');
    });
    expect(isIsolatedThread('slack:C1:2.2')).toBe(false);
    expect(isIsolatedThread(null)).toBe(false);
  });
});
