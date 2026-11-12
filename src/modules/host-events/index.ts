/**
 * Host events — hand inbound platform events to host tools outside nanoclaw.
 *
 * WHY THIS EXISTS
 * Ctibor, 2026-11-09: a feature that reacts to Slack reactions (first one: the
 * study planner in agent-system/tools/study) should not need a nanoclaw patch
 * each time. Slack delivers events to one Request URL, which is nanoclaw, and
 * upstream has no inbound-reaction API at all — so nanoclaw is the only place
 * that sees a reaction, and this module is the one door it opens for everyone
 * else. It is the fork's stand-in for an upstream event API: when upstream
 * grows one, host tools move to it and this module goes.
 *
 * WHAT IT DOES, per inbound reaction (additions only — the bridge does not
 * forward removals, and the SDK already drops the bot's own reactions):
 *   1. appends one JSON line to data/events/reactions.jsonl (rotated at 5 MB);
 *   2. for each hook in data/events/hooks.json whose `event` is "reaction" and
 *      whose `match` fits, spawns `cmd` with the event JSON on stdin, no shell,
 *      killed after `timeoutMs` (default 60 s). Fire-and-forget: a slow or
 *      failing hook never delays or breaks reaction handling for anyone else.
 *
 * hooks.json is re-read on every event, so adding a hook needs no restart:
 *   [{ "name": "study", "event": "reaction", "match": { "channel": "C0B6B7FEH7T" },
 *      "cmd": ["/usr/bin/node", "/home/agent/agent-system/tools/study/study.js", "reaction"] }]
 * `match` keys are compared against the event fields; a string matches when the
 * field equals it or ends with `:<value>` (channel ids arrive namespaced).
 *
 * Security: hooks.json runs commands as the host user, so it lives under
 * data/events/ — never mounted into an agent container (containers get only
 * their own data/v2-sessions/<group>/<session>/ directory) — and a hooks file
 * that is group- or world-writable is refused.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { registerReactionHandler } from '../../ext/seams.js';
import type { InboundReaction } from '../../channels/adapter.js';

export const EVENTS_DIR = path.join(DATA_DIR, 'events');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface Hook {
  name?: string;
  event: string;
  match?: Record<string, string>;
  cmd: string[];
  timeoutMs?: number;
}

export interface HostEvent {
  type: string;
  at: string;
  [field: string]: unknown;
}

/** Hooks from <dir>/hooks.json; [] when absent, unsafe or malformed (logged). */
export function loadHooks(dir: string = EVENTS_DIR): Hook[] {
  const file = path.join(dir, 'hooks.json');
  // One open, then fstat and read on the same descriptor: the file that passed
  // the permission check is the file that is parsed (no swap in between).
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  let text: string;
  try {
    if (fs.fstatSync(fd).mode & 0o022) {
      log.warn('host-events: hooks.json is group/world-writable — ignored', { file });
      return [];
    }
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error('not an array');
    return raw.filter(
      (h): h is Hook =>
        h &&
        typeof h.event === 'string' &&
        Array.isArray(h.cmd) &&
        h.cmd.length > 0 &&
        h.cmd.every((c: unknown) => typeof c === 'string') &&
        path.isAbsolute(h.cmd[0]),
    );
  } catch (err) {
    log.warn('host-events: hooks.json unreadable — ignored', { file, err: String(err) });
    return [];
  }
}

/** Does a hook's `match` fit the event? Exact, or `…:<value>` for namespaced ids. */
export function matches(hook: Hook, event: HostEvent): boolean {
  if (hook.event !== event.type) return false;
  for (const [k, want] of Object.entries(hook.match ?? {})) {
    const got = event[k];
    if (typeof got !== 'string') return false;
    if (got !== want && !got.endsWith(':' + want)) return false;
  }
  return true;
}

/** Append to <dir>/<type>s.jsonl, rotating to .1 past MAX_LOG_BYTES. */
export function appendEvent(event: HostEvent, dir: string = EVENTS_DIR): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${event.type}s.jsonl`);
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1');
  } catch {
    /* no log yet */
  }
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

/** Spawn one hook with the event on stdin. Resolves with the exit code (null = killed). */
export function runHook(hook: Hook, event: HostEvent): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(hook.cmd[0], hook.cmd.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      if (stderr.length < 2000) stderr += String(d);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), hook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      log.warn('host-events: hook failed to start', { hook: hook.name ?? hook.cmd[0], err: String(err) });
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        log.warn('host-events: hook exited non-zero', {
          hook: hook.name ?? hook.cmd[0],
          code,
          stderr: stderr.slice(0, 500),
        });
      resolve(code);
    });
    child.stdin?.on('error', () => {
      /* hook did not read stdin — fine */
    });
    child.stdin?.end(JSON.stringify(event));
  });
}

/** Log the event and start every matching hook. Never throws. */
export function publish(event: HostEvent, dir: string = EVENTS_DIR): Promise<(number | null)[]> {
  try {
    appendEvent(event, dir);
  } catch (err) {
    log.warn('host-events: event log write failed', { err: String(err) });
  }
  try {
    return Promise.all(
      loadHooks(dir)
        .filter((h) => matches(h, event))
        .map((h) => runHook(h, event)),
    );
  } catch (err) {
    log.warn('host-events: hooks not run', { err: String(err) });
    return Promise.resolve([]);
  }
}

export function reactionEvent(r: InboundReaction): HostEvent {
  return {
    type: 'reaction',
    at: new Date().toISOString(),
    channelType: r.channelType,
    instance: r.instance ?? null,
    channel: r.channel,
    messageTs: r.messageTs,
    emoji: r.emoji,
    rawEmoji: r.rawEmoji,
    userId: r.userId,
  };
}

registerReactionHandler((reaction) => {
  // Not awaited: hooks run alongside the other reaction handlers, never before them.
  void publish(reactionEvent(reaction)).catch((err) => log.error('host-events: publish failed', { err: String(err) }));
});
