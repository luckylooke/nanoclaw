import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const maint = vi.hoisted(() => ({
  state: null as null | { since: string; reason: string; by: string; notified: string[] },
}));
vi.mock('../maintenance.js', () => ({
  getMaintenance: () => maint.state,
  hasBeenNotified: (id: string) => maint.state?.notified.includes(id) ?? false,
  markNotified: (id: string) => maint.state?.notified.push(id),
}));
const writeOutboundDirect = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../session-manager.js', () => ({ writeOutboundDirect }));

import {
  _resetSeamsForTest,
  contributedSpawnMounts,
  registerSpawnMounts,
  registerWakeGate,
  registerWebhookMiddleware,
  wakeHeld,
  webhookHandled,
} from './seams.js';
import { maintenanceGate } from './maintenance-gate.js';
import { _resetRateLimitForTest, checkRateLimit, rateLimitMiddleware } from './webhook-rate-limit.js';
import { toolProxySocketMounts } from './tool-proxy-socket.js';
import type { AgentGroup, Session } from '../types.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const replyTo = { platformId: 'slack:C1', channelType: 'slack', threadId: null };

beforeEach(() => {
  _resetSeamsForTest();
  maint.state = null;
  writeOutboundDirect.mockClear();
});

describe('wake gates', () => {
  it('lets the wake through when no gate holds', async () => {
    registerWakeGate('open', () => null);
    expect(await wakeHeld({ site: 'inbound', session })).toBe(false);
  });

  it('holds when any gate returns a reason', async () => {
    registerWakeGate('open', () => null);
    registerWakeGate('closed', async () => 'busy');
    expect(await wakeHeld({ site: 'sweep', session })).toBe(true);
  });

  it('holds when a gate throws — a held wake is retried, a wrong one is not undone', async () => {
    registerWakeGate('broken', () => {
      throw new Error('boom');
    });
    expect(await wakeHeld({ site: 'sweep', session })).toBe(true);
  });
});

describe('maintenance gate', () => {
  it('is open outside maintenance', () => {
    expect(maintenanceGate({ site: 'inbound', session, replyTo })).toBeNull();
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('holds both wake sites during maintenance', () => {
    maint.state = { since: 'now', reason: 'deploy', by: 'x', notified: [] };
    expect(maintenanceGate({ site: 'sweep', session })).toContain('deploy');
    expect(maintenanceGate({ site: 'inbound', session, replyTo })).toContain('deploy');
  });

  it('sends one notice per session per window, only from the inbound site', () => {
    maint.state = { since: 'now', reason: 'deploy', by: 'x', notified: [] };
    maintenanceGate({ site: 'sweep', session });
    expect(writeOutboundDirect).not.toHaveBeenCalled();
    maintenanceGate({ site: 'inbound', session, replyTo });
    maintenanceGate({ site: 'inbound', session, replyTo });
    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    expect(writeOutboundDirect.mock.calls[0]).toMatchObject(['ag-1', 'sess-1', { platformId: 'slack:C1' }]);
  });
});

describe('webhook middleware + rate limit', () => {
  afterEach(() => _resetRateLimitForTest());

  it('stops routing when a middleware answers', () => {
    registerWebhookMiddleware('no', () => false);
    expect(webhookHandled({} as never, {} as never)).toBe(false);
    registerWebhookMiddleware('yes', () => true);
    expect(webhookHandled({} as never, {} as never)).toBe(true);
  });

  it('answers 500 and stops routing when a middleware throws', () => {
    registerWebhookMiddleware('broken', () => {
      throw new Error('boom');
    });
    registerWebhookMiddleware('never', () => {
      throw new Error('must not run');
    });
    const res = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };
    expect(webhookHandled({ url: '/webhook/slack' } as never, res as never)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('allows 100 requests per IP, then refills one token per 600 ms of elapsed time', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i++) expect(checkRateLimit('1.2.3.4', t0)).toBe(true);
    expect(checkRateLimit('1.2.3.4', t0)).toBe(false);
    expect(checkRateLimit('5.6.7.8', t0)).toBe(true);
    // Calls 400 ms apart must still earn tokens — the elapsed remainder carries over.
    expect(checkRateLimit('1.2.3.4', t0 + 400)).toBe(false);
    expect(checkRateLimit('1.2.3.4', t0 + 800)).toBe(true);
    // A clock stepped backwards re-anchors instead of freezing the bucket.
    for (let i = 0; i < 100; i++) checkRateLimit('1.2.3.4', t0 - 60_000);
    expect(checkRateLimit('1.2.3.4', t0 - 60_000 + 600)).toBe(true);
  });

  it('answers 429 with Retry-After when the bucket is empty', () => {
    const req = { socket: { remoteAddress: '9.9.9.9' } } as never;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    for (let i = 0; i < 100; i++) expect(rateLimitMiddleware(req, res as never)).toBe(false);
    expect(rateLimitMiddleware(req, res as never)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({ 'Retry-After': '60' }));
  });
});

describe('spawn mounts + tool-proxy socket', () => {
  it('collects contributions in registration order', () => {
    registerSpawnMounts('a', () => [{ hostPath: '/a', containerPath: '/x/a', readonly: true }]);
    registerSpawnMounts('b', () => [{ hostPath: '/b', containerPath: '/x/b', readonly: false }]);
    const ctx = { agentGroup: {} as AgentGroup, session, groupDir: '/g' };
    expect(contributedSpawnMounts(ctx).map((m) => m.hostPath)).toEqual(['/a', '/b']);
  });

  it('fails the spawn, naming the contribution, when one throws', () => {
    registerSpawnMounts('ro-code', () => {
      throw new Error('EACCES');
    });
    const ctx = { agentGroup: {} as AgentGroup, session, groupDir: '/g' };
    expect(() => contributedSpawnMounts(ctx)).toThrow(/ro-code.*EACCES/);
  });

  it("mounts this group's socket directory and no other", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-'));
    try {
      fs.mkdirSync(path.join(home, 'tool-proxy-sockets', 'dev-web'), { recursive: true });
      const ctx = (folder: string) => ({ agentGroup: { folder } as AgentGroup, session, groupDir: '/g' });
      expect(toolProxySocketMounts(ctx('dev-web'), home)).toEqual([
        {
          hostPath: path.join(home, 'tool-proxy-sockets', 'dev-web'),
          containerPath: '/workspace/extra/tool-proxy-sock',
          readonly: false,
        },
      ]);
      expect(toolProxySocketMounts(ctx('learning'), home)).toEqual([]);
      expect(toolProxySocketMounts(ctx('dev-web'), '')).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
