/**
 * What this pins: a class name in `model` becomes the class's current Claude
 * id, everything else passes through untouched, and a bad registry save can
 * never take down every class request at once.
 *
 * The pass-through half is the one that protects production: agent containers
 * send concrete ids (claude-sonnet-4-6) and must see byte-for-byte the request
 * they sent. The reload half is what makes `models.js set` real: the gateway
 * reads the file per request, so a change applies on the next call without a
 * restart — and a registry edited but not applied is worse than none.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isClassName, loadModelClasses, resetModelClassCache, resolveModelClass } from './model-classes.js';

let tmp: string;
let file: string;

const write = (classes: Record<string, unknown>, mtime?: Date) => {
  fs.writeFileSync(file, JSON.stringify({ classes, history: [] }));
  if (mtime) fs.utimesSync(file, mtime, mtime);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-classes-'));
  file = path.join(tmp, 'model-classes.json');
  resetModelClassCache();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('isClassName', () => {
  it('treats lowercase non-claude names as classes and claude ids as models', () => {
    expect(isClassName('fast')).toBe(true);
    expect(isClassName('claude-haiku-4-5')).toBe(false);
    expect(isClassName('Fast')).toBe(false);
    expect(isClassName(undefined)).toBe(false);
  });
});

describe('resolveModelClass', () => {
  it('swaps a class for its model and keeps every other field', () => {
    write({ fast: { model: 'claude-haiku-4-5-20251001' } });
    const parsed: Record<string, unknown> = {
      model: 'fast',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const r = resolveModelClass(parsed, loadModelClasses(file));
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(JSON.parse(r.body.toString('utf8'))).toEqual({ ...parsed, model: 'claude-haiku-4-5-20251001' });
    expect(parsed.model).toBe('fast'); // pure: the caller decides whether to rewrite its object
  });

  it('passes a concrete model id through untouched — agent traffic must not change', () => {
    write({ fast: { model: 'claude-haiku-4-5-20251001' } });
    const parsed = { model: 'claude-sonnet-4-6' };
    expect(resolveModelClass(parsed, loadModelClasses(file))).toEqual({ kind: 'none' });
    expect(parsed.model).toBe('claude-sonnet-4-6');
  });

  it('names the known classes when asked for one that does not exist', () => {
    write({ fast: { model: 'claude-haiku-4-5-20251001' }, deep: { model: 'claude-opus-5-5' } });
    expect(resolveModelClass({ model: 'cheap' }, loadModelClasses(file))).toEqual({
      kind: 'unknown',
      className: 'cheap',
      known: ['fast', 'deep'],
    });
  });

  it('does not resolve inherited object keys as classes', () => {
    write({ fast: { model: 'claude-haiku-4-5-20251001' } });
    expect(resolveModelClass({ model: 'constructor' }, loadModelClasses(file)).kind).toBe('unknown');
  });

  it('reports the registry unavailable instead of guessing a model', () => {
    expect(resolveModelClass({ model: 'fast' }, loadModelClasses(path.join(tmp, 'missing.json')))).toEqual({
      kind: 'unavailable',
      className: 'fast',
    });
  });
});

describe('loadModelClasses', () => {
  it('picks up a change on the next call, without a restart', () => {
    write({ fast: { model: 'claude-haiku-4-5-20251001' } }, new Date('2026-10-01T00:00:00Z'));
    expect(loadModelClasses(file)?.fast.model).toBe('claude-haiku-4-5-20251001');
    write({ fast: { model: 'claude-haiku-5' } }, new Date('2026-10-02T00:00:00Z'));
    expect(loadModelClasses(file)?.fast.model).toBe('claude-haiku-5');
  });

  it('keeps the last good registry when a save breaks the file', () => {
    write({ fast: { model: 'claude-haiku-4-5-20251001' } }, new Date('2026-10-01T00:00:00Z'));
    loadModelClasses(file);
    fs.writeFileSync(file, '{ "classes": { "fast": ');
    fs.utimesSync(file, new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
    expect(loadModelClasses(file)?.fast.model).toBe('claude-haiku-4-5-20251001');
  });

  it('rejects a class pointed at something that is not a Claude id', () => {
    write({ fast: { model: 'gpt-5' } });
    expect(loadModelClasses(file)).toBeNull();
  });
});
