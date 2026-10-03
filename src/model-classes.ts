/**
 * Model classes — the gateway half of the registry in
 * agent-system/tools/models/model-classes.json.
 *
 * A caller sends `model: "fast"` (or balanced / deep) and the gateway swaps in
 * the class's current Claude model id before forwarding. Flows and host tools
 * then never bake in an id that Anthropic will retire: Anthropic ships no
 * floating "latest Haiku" alias on purpose — from the 4.6 generation every id
 * is a pinned snapshot — so the indirection has to live here.
 *
 * Design rules, each one a failure it prevents:
 * - Read per request with an mtime cache, so `models.js set` takes effect on the
 *   next call. A registry that needs a restart is one that gets edited and then
 *   silently not applied.
 * - A broken file keeps the LAST GOOD registry and logs, rather than failing
 *   every class request: one bad save must not take down every flow at once.
 *   With no good registry ever loaded, a class request is refused loudly (503).
 * - Only names that are not `claude-…` ids are treated as classes. Real model
 *   ids pass through untouched, so agent containers — which still send concrete
 *   ids — see no change at all.
 * - The resolved id is what the gateway logs and prices, so cost accounting and
 *   the alias-drift watch keep seeing real models, not class names.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from './log.js';

export interface ModelClass {
  model: string;
  family?: string;
  purpose?: string;
  since?: string;
  reason?: string;
}

export type ModelClasses = Record<string, ModelClass>;

export const MODEL_CLASSES_FILE =
  process.env.MODEL_CLASSES_FILE || path.join(os.homedir(), 'agent-system', 'tools', 'models', 'model-classes.json');

const CLASS_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A class name is anything that is not a Claude model id. */
export function isClassName(model: unknown): model is string {
  return typeof model === 'string' && CLASS_NAME.test(model) && !model.startsWith('claude-');
}

function parseRegistry(raw: string): ModelClasses {
  const reg = JSON.parse(raw) as { classes?: unknown };
  if (!reg || typeof reg.classes !== 'object' || reg.classes === null) throw new Error('no "classes" object');
  const out: ModelClasses = {};
  for (const [name, c] of Object.entries(reg.classes as Record<string, ModelClass>)) {
    if (!isClassName(name)) throw new Error(`invalid class name "${name}"`);
    if (!c || typeof c.model !== 'string' || !c.model.startsWith('claude-')) {
      throw new Error(`class "${name}" has no claude-… model`);
    }
    out[name] = c;
  }
  return out;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  classes: ModelClasses;
}
const cache = new Map<string, CacheEntry>();

/**
 * The current registry, or null when none has ever loaded from this file.
 * Re-reads only when the file's mtime or size moved.
 */
export function loadModelClasses(file = MODEL_CLASSES_FILE): ModelClasses | null {
  const prev = cache.get(file) || null;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (err) {
    if (prev) log.warn('Model classes: registry unreadable — keeping last good', { file, err: String(err) });
    return prev ? prev.classes : null;
  }
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.classes;
  try {
    const classes = parseRegistry(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, classes });
    if (prev) log.info('Model classes: registry reloaded', { file, classes: summarize(classes) });
    return classes;
  } catch (err) {
    log.error('Model classes: registry invalid — keeping last good', { file, err: String(err), haveLastGood: !!prev });
    return prev ? prev.classes : null;
  }
}

export function summarize(classes: ModelClasses): Record<string, string> {
  return Object.fromEntries(Object.entries(classes).map(([n, c]) => [n, c.model]));
}

/** Test seam: forget cached registries. */
export function resetModelClassCache(): void {
  cache.clear();
}

export type ClassResolution =
  | { kind: 'none' }
  | { kind: 'resolved'; className: string; model: string; body: Buffer }
  | { kind: 'unknown'; className: string; known: string[] }
  | { kind: 'unavailable'; className: string };

/**
 * Resolve the `model` of a parsed /v1/messages body. Pure: `parsed` is not
 * touched. On success it returns the resolved id and the re-serialized body to
 * forward; a caller that keeps using `parsed` (the gateway's budget directive
 * re-serializes it) must set `parsed.model` itself, visibly, at the call site.
 */
export function resolveModelClass(
  parsed: Record<string, unknown> | null,
  classes: ModelClasses | null,
): ClassResolution {
  if (!parsed || !isClassName(parsed.model)) return { kind: 'none' };
  const className = parsed.model;
  if (!classes) return { kind: 'unavailable', className };
  const cls = Object.prototype.hasOwnProperty.call(classes, className) ? classes[className] : undefined;
  if (!cls) return { kind: 'unknown', className, known: Object.keys(classes) };
  return {
    kind: 'resolved',
    className,
    model: cls.model,
    body: Buffer.from(JSON.stringify({ ...parsed, model: cls.model }), 'utf8'),
  };
}
