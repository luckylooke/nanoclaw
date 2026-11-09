import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvent, loadHooks, matches, publish, reactionEvent, type Hook } from './index.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-events-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const event = reactionEvent({
  channelType: 'slack',
  channel: 'slack:C0B6B7FEH7T',
  messageTs: '1794206026.036009',
  emoji: 'white_check_mark',
  rawEmoji: 'white_check_mark',
  userId: 'U1',
});

function writeHooks(hooks: unknown, mode = 0o600): void {
  const f = path.join(dir, 'hooks.json');
  fs.writeFileSync(f, JSON.stringify(hooks));
  fs.chmodSync(f, mode);
}

describe('host-events', () => {
  it('matches on event type and namespaced ids', () => {
    const hook: Hook = { event: 'reaction', match: { channel: 'C0B6B7FEH7T' }, cmd: ['/bin/true'] };
    expect(matches(hook, event)).toBe(true);
    expect(matches({ ...hook, match: { channel: 'C999' } }, event)).toBe(false);
    expect(matches({ ...hook, event: 'message' }, event)).toBe(false);
    expect(matches({ ...hook, match: { emoji: 'white_check_mark' } }, event)).toBe(true);
  });

  it('ignores a missing, malformed or group-writable hooks file and relative commands', () => {
    expect(loadHooks(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'hooks.json'), '{nope');
    expect(loadHooks(dir)).toEqual([]);
    writeHooks([{ event: 'reaction', cmd: ['/bin/true'] }], 0o664);
    expect(loadHooks(dir)).toEqual([]);
    writeHooks([
      { event: 'reaction', cmd: ['true'] },
      { event: 'reaction', cmd: ['/bin/true'] },
    ]);
    expect(loadHooks(dir)).toHaveLength(1);
  });

  it('appends every event to the log', () => {
    appendEvent(event, dir);
    appendEvent(event, dir);
    const lines = fs.readFileSync(path.join(dir, 'reactions.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).messageTs).toBe('1794206026.036009');
  });

  it('runs matching hooks with the event on stdin', async () => {
    const out = path.join(dir, 'got.json');
    writeHooks([
      { name: 'cat', event: 'reaction', match: { channel: 'C0B6B7FEH7T' }, cmd: ['/bin/sh', '-c', `cat > ${out}`] },
      { name: 'other', event: 'reaction', match: { channel: 'C999' }, cmd: ['/bin/false'] },
    ]);
    const codes = await publish(event, dir);
    expect(codes).toEqual([0]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).emoji).toBe('white_check_mark');
  });

  it('kills a hook that outlives its timeout', async () => {
    writeHooks([{ event: 'reaction', cmd: ['/bin/sleep', '5'], timeoutMs: 100 }]);
    expect(await publish(event, dir)).toEqual([null]);
  });
});
