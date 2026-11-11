import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  text: null as string | null,
  throwRead: false,
  compactWindow: null as number | null,
}));
vi.mock('../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, _s: string, fn: (m: unknown) => unknown) => {
    if (state.throwRead) throw new Error('mailbox gone');
    return fn({ getLatestTriggerText: () => state.text });
  },
}));
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: async () => (state.compactWindow === null ? undefined : { compact_window: state.compactWindow }),
}));

import { adaptiveTuning } from './adaptive-tuning.js';
import { _resetSeamsForTest, contributedSpawnTuning, registerSpawnTuning } from './seams.js';
import { DEFAULT_STATIC_WINDOW } from '../complexity-tier.js';
import type { AgentGroup, Session } from '../types.js';

const ctx = { agentGroup: { id: 'ag-1' } as AgentGroup, session: { id: 'sess-1' } as Session };

beforeEach(() => {
  _resetSeamsForTest();
  Object.assign(state, { text: null, throwRead: false, compactWindow: null });
});

describe('adaptive tuning (complexity-tier)', () => {
  it('maps a trivial message to the small window and low effort', async () => {
    state.text = 'ok';
    expect(await adaptiveTuning(ctx)).toEqual({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '30000' },
      overrides: { effort: 'low' },
    });
  });

  it('falls back to the DB window, then the static default, with no text and no effort override', async () => {
    state.compactWindow = 90_000;
    expect(await adaptiveTuning(ctx)).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' } });
    state.compactWindow = null;
    state.throwRead = true;
    expect(await adaptiveTuning(ctx)).toEqual({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(DEFAULT_STATIC_WINDOW) },
    });
  });
});

describe('spawn tuning seam', () => {
  it('merges env in order, keeps the first effort, and skips a throwing contribution', async () => {
    registerSpawnTuning('a', () => ({ env: { A: '1', X: 'a' }, overrides: { effort: 'low' } }));
    registerSpawnTuning('broken', () => {
      throw new Error('boom');
    });
    registerSpawnTuning('b', async () => ({ env: { X: 'b' }, overrides: { effort: 'high' } }));
    expect(await contributedSpawnTuning(ctx)).toEqual({ env: { A: '1', X: 'b' }, overrides: { effort: 'low' } });
  });

  it('returns empty tuning with no contributions', async () => {
    expect(await contributedSpawnTuning(ctx)).toEqual({ env: {}, overrides: {} });
  });
});
