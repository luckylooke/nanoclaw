/**
 * Fork extension seams — where fork features attach to core.
 *
 * WHY THIS EXISTS
 * Every upstream release rebases ~90 fork commits onto ~130 upstream ones, and
 * what conflicts is the fork's edits INSIDE upstream files (~1,000 lines on
 * 2026-11-09), not its new files. The rule (agent-system
 * spec/fork-extension-plan.md): a fork feature lives in its own module and
 * attaches through a `registerX` seam. Upstream already has 27 of them; the ones
 * below are the gaps. Each has a one-line call site in core marked `// EXT-SEAM`,
 * so a rebase conflict there is one line, not a feature. When upstream ships an
 * equivalent seam, the one here is deleted and its users re-point.
 *
 * Registration happens at import time from src/ext/index.ts, which
 * src/modules/index.ts imports — same pattern as upstream's modules.
 */
import type http from 'http';

import { log } from '../log.js';
import type { VolumeMount } from '../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../types.js';

// ── Wake gates ──────────────────────────────────────────────────────────────
// Core wakes a container from two places: routeInbound (a new message) and the
// host sweep (pending messages, scheduled tasks). A gate can hold both. The
// inbound row is already persisted when a gate runs, so holding loses nothing:
// the sweep retries every 60 s and wakes once no gate holds.

export interface WakeGateContext {
  /** 'inbound' = router.ts deliverToAgent; 'sweep' = reconcile-session.ts. */
  site: 'inbound' | 'sweep';
  session: Session;
  /** Inbound only: where a host-written notice to the sender would go. */
  replyTo?: { platformId: string | null; channelType: string | null; threadId: string | null };
}

/** Return a reason to hold the wake, or null to let it through. */
export type WakeGate = (ctx: WakeGateContext) => string | null | Promise<string | null>;

const wakeGates: { name: string; gate: WakeGate }[] = [];

export function registerWakeGate(name: string, gate: WakeGate): void {
  wakeGates.push({ name, gate });
}

/**
 * True when some gate holds the wake. A gate that throws HOLDS: a held message
 * is retried by the next sweep, a wrong wake (an agent turn during a deploy)
 * cannot be taken back.
 */
export async function wakeHeld(ctx: WakeGateContext): Promise<boolean> {
  for (const { name, gate } of wakeGates) {
    let reason: string | null;
    try {
      reason = await gate(ctx);
    } catch (err) {
      log.error('Wake gate threw — holding the wake', { gate: name, sessionId: ctx.session.id, err });
      return true;
    }
    if (reason) {
      log.debug('Wake held', { gate: name, site: ctx.site, sessionId: ctx.session.id, reason });
      return true;
    }
  }
  return false;
}

// ── Webhook middleware ─────────────────────────────────────────────────────
// Runs first in the webhook server's request handler, before any routing.

/** Return true when the middleware answered the request itself (routing stops). */
export type WebhookMiddleware = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

const webhookMiddleware: { name: string; fn: WebhookMiddleware }[] = [];

export function registerWebhookMiddleware(name: string, fn: WebhookMiddleware): void {
  webhookMiddleware.push({ name, fn });
}

/**
 * True when a middleware answered. A middleware that throws answers 500 and
 * stops routing: the call site sits outside the handler's try/catch, and
 * middleware is a guard — a broken guard must not wave the request through.
 */
export function webhookHandled(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  for (const { name, fn } of webhookMiddleware) {
    try {
      if (fn(req, res)) return true;
    } catch (err) {
      log.error('Webhook middleware threw — refusing the request', { middleware: name, url: req.url, err });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
      return true;
    }
  }
  return false;
}

// ── Spawn mounts ───────────────────────────────────────────────────────────
// Extra volume mounts per container spawn. Upstream's
// registerProviderContainerConfig is one registration per PROVIDER and is not
// given the agent group's folder, so it cannot carry per-group mounts.
// Mounts are appended after the group mount, in registration order.

export interface SpawnMountContext {
  agentGroup: AgentGroup;
  session: Session;
  /** Host path of the group's RW mount (groups/<folder>). */
  groupDir: string;
}

export type SpawnMountContribution = (ctx: SpawnMountContext) => VolumeMount[];

const spawnMounts: { name: string; fn: SpawnMountContribution }[] = [];

export function registerSpawnMounts(name: string, fn: SpawnMountContribution): void {
  spawnMounts.push({ name, fn });
}

/**
 * Every registered contribution's mounts. A throwing contribution FAILS the
 * spawn, on purpose: contributions include security mounts (read-only host code,
 * the per-group socket), and a container started without one is worse than one
 * not started — a failed spawn leaves the inbound row pending and the sweep
 * retries it. The error names the contribution so the log says which one.
 */
export function contributedSpawnMounts(ctx: SpawnMountContext): VolumeMount[] {
  return spawnMounts.flatMap(({ name, fn }) => {
    try {
      return fn(ctx);
    } catch (err) {
      throw new Error(
        `spawn-mount contribution '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
        },
      );
    }
  });
}

// ── Spawn tuning ───────────────────────────────────────────────────────────
// Per-spawn values computed from THIS session at spawn time: extra container env
// and overrides for container.json. The gateway provider handles everything
// static (credentials, egress, telemetry) but is given a SessionKey, not the
// group or the inbound text, so it cannot carry these.

export interface SpawnTuningContext {
  agentGroup: AgentGroup;
  session: Session;
}

export interface SpawnTuning {
  env?: Record<string, string>;
  /** Applied by materializeContainerJson only where the group has no explicit pin. */
  overrides?: { effort?: string };
}

export type SpawnTuningContribution = (ctx: SpawnTuningContext) => SpawnTuning | Promise<SpawnTuning>;

const spawnTuning: { name: string; fn: SpawnTuningContribution }[] = [];

export function registerSpawnTuning(name: string, fn: SpawnTuningContribution): void {
  spawnTuning.push({ name, fn });
}

/**
 * Merged tuning of every contribution: env merges in registration order (later
 * wins), the first contribution to set an override keeps it. A throwing
 * contribution is skipped and logged — tuning is an optimisation, and a spawn
 * without it runs on the group's static config, which is what it did before.
 */
export async function contributedSpawnTuning(ctx: SpawnTuningContext): Promise<Required<SpawnTuning>> {
  const out: Required<SpawnTuning> = { env: {}, overrides: {} };
  for (const { name, fn } of spawnTuning) {
    let t: SpawnTuning;
    try {
      t = await fn(ctx);
    } catch (err) {
      log.warn('Spawn tuning contribution failed — skipped', { contribution: name, sessionId: ctx.session.id, err });
      continue;
    }
    Object.assign(out.env, t.env ?? {});
    if (t.overrides?.effort && !out.overrides.effort) out.overrides.effort = t.overrides.effort;
  }
  return out;
}

/** Test helper: drop every registration. */
export function _resetSeamsForTest(): void {
  wakeGates.length = 0;
  webhookMiddleware.length = 0;
  spawnMounts.length = 0;
  spawnTuning.length = 0;
}
