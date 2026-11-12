/**
 * Fork extension seams for the container runner — the agent-runner twin of the
 * host's src/ext/seams.ts (agent-system spec/fork-extension-plan.md).
 *
 * A fork feature lives in its own module under src/ext/ and attaches here; core
 * files carry one-line call sites marked `// EXT-SEAM`, so a rebase conflict is
 * one line, not a feature. When upstream ships an equivalent seam, the one here
 * is deleted and its users re-point.
 *
 * Registration happens at import time from src/ext/index.ts, which
 * src/modules/index.ts imports.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

import type { RoutingContext } from '../formatter.js';

function log(msg: string): void {
  console.error(`[ext] ${msg}`);
}

// ── Query contributions ─────────────────────────────────────────────────────
// Called once per sdkQuery() by the Claude provider. A contribution adds env to
// the Claude Code process and hook callbacks per event. A contributor that
// throws is logged and skipped: the query must still run.

export interface QueryContribution {
  env?: Record<string, string>;
  hooks?: Partial<Record<HookEvent, HookCallback[]>>;
}

export interface ContributedQuery {
  env: Record<string, string>;
  hooks: Partial<Record<HookEvent, HookCallback[]>>;
}

const queryContributors: { name: string; fn: () => QueryContribution }[] = [];

export function registerQueryContributor(name: string, fn: () => QueryContribution): void {
  queryContributors.push({ name, fn });
}

/** Env merged in registration order (later wins); hooks appended per event. */
export function contributedQuery(): ContributedQuery {
  const out: ContributedQuery = { env: {}, hooks: {} };
  for (const { name, fn } of queryContributors) {
    let c: QueryContribution;
    try {
      c = fn();
    } catch (err) {
      log(`query contributor ${name} threw, skipped: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    Object.assign(out.env, c.env ?? {});
    for (const [event, callbacks] of Object.entries(c.hooks ?? {}) as [HookEvent, HookCallback[]][]) {
      (out.hooks[event] ??= []).push(...callbacks);
    }
  }
  return out;
}

/**
 * Core's hook map plus the contributed callbacks, each event's contributions as
 * one extra matcher after core's. Core's own matchers are never changed.
 */
export function withContributedHooks(
  contributed: ContributedQuery,
  base: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...base };
  for (const [event, callbacks] of Object.entries(contributed.hooks) as [HookEvent, HookCallback[]][]) {
    if (callbacks.length === 0) continue;
    out[event] = [...(out[event] ?? []), { hooks: callbacks }];
  }
  return out;
}

// ── Turn end ────────────────────────────────────────────────────────────────
// Called by the poll loop after a turn's result has been handled. Observers are
// decoration: one that throws is logged and the loop goes on.

export interface TurnEnd {
  routing: RoutingContext;
  /** Something user-visible went out this turn (a chat row was written). */
  delivered: boolean;
}

const turnEndObservers: { name: string; fn: (t: TurnEnd) => void | Promise<void> }[] = [];

export function registerTurnEndObserver(name: string, fn: (t: TurnEnd) => void | Promise<void>): void {
  turnEndObservers.push({ name, fn });
}

export async function turnEnded(t: TurnEnd): Promise<void> {
  for (const { name, fn } of turnEndObservers) {
    try {
      await fn(t);
    } catch (err) {
      log(`turn-end observer ${name} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function _resetContainerSeamsForTest(): void {
  queryContributors.length = 0;
  turnEndObservers.length = 0;
}
