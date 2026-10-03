/**
 * What this pins: a flow can answer only on a channel the system already
 * knows, only from the host itself, and the answer goes through the same
 * channel adapter every agent reply uses — the flow never needs a token.
 *
 * The handler is exercised against a real http server on an ephemeral port so
 * the loopback check, the body limit and the status codes are the ones a flow
 * actually sees, not a mocked request object's idea of them.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: vi.fn(() => null) }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroupByPlatform: vi.fn() }));

import { makeFlowReplyHandler, startFlowReplyServer, type FlowReplyDeps } from './index.js';

const GROUP = {
  id: 'mg-1',
  channel_type: 'slack',
  platform_id: 'slack:C0B6B8A1MEV',
  instance: 'slack',
  name: 'agent-admin',
  is_group: 1,
  unknown_sender_policy: 'strict',
  created_at: '2026-01-01T00:00:00Z',
  denied_at: null,
  detached_at: null,
};

let server: http.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function call(
  deps: FlowReplyDeps,
  body: unknown,
  method = 'POST',
  headers: Record<string, string> = {},
  path = '/flow-reply',
) {
  server = http.createServer((req, res) => void makeFlowReplyHandler(deps)(req, res));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const deliver = vi.fn(async () => 'ts-123');
const deps = (over: Partial<FlowReplyDeps> = {}): FlowReplyDeps => ({
  getAdapter: () => ({ deliver }),
  lookupGroup: async () => GROUP as never,
  ...over,
});
const OK_BODY = {
  channel_type: 'slack',
  platform_id: 'slack:C0B6B8A1MEV',
  thread_id: null,
  text: 'Proposed approach…',
};

describe('flow-reply', () => {
  it('delivers through the channel adapter with the group instance, as a chat message', async () => {
    deliver.mockClear();
    const r = await call(deps(), OK_BODY);
    expect(r).toEqual({
      status: 200,
      json: { ok: true, platform_message_id: 'ts-123', reply_thread_id: 'slack:C0B6B8A1MEV:ts-123' },
    });
    expect(deliver).toHaveBeenCalledWith(
      'slack',
      'slack:C0B6B8A1MEV',
      null,
      'chat',
      JSON.stringify({ text: 'Proposed approach…' }),
      undefined,
      'slack',
    );
  });

  it('refuses a proxied request even from loopback — Funnel proxies the internet from 127.0.0.1', async () => {
    expect((await call(deps(), OK_BODY, 'POST', { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect((await call(deps(), OK_BODY, 'POST', { 'tailscale-user-login': 'someone' })).status).toBe(403);
    expect((await call(deps(), OK_BODY, 'POST', { forwarded: 'for=203.0.113.9' })).status).toBe(403);
  });

  it('answers only on its own path', async () => {
    expect((await call(deps(), OK_BODY, 'POST', {}, '/webhook/flow-reply')).status).toBe(404);
  });

  it('hands a thread id through unchanged, so the reply lands in the thread it came from', async () => {
    deliver.mockClear();
    await call(deps(), { ...OK_BODY, thread_id: 'slack:C0B6B8A1MEV:1791026220.871429' });
    expect(deliver).toHaveBeenCalledWith(
      'slack',
      'slack:C0B6B8A1MEV',
      'slack:C0B6B8A1MEV:1791026220.871429',
      'chat',
      expect.any(String),
      undefined,
      'slack',
    );
  });

  it('the production server binds loopback only', async () => {
    const srv = startFlowReplyServer(0);
    await new Promise<void>((r) => (srv.listening ? r() : srv.once('listening', () => r())));
    expect((srv.address() as AddressInfo).address).toBe('127.0.0.1');
    srv.close();
  });

  it('refuses a channel the system does not know', async () => {
    const r = await call(deps({ lookupGroup: async () => undefined }), OK_BODY);
    expect(r.status).toBe(404);
  });

  it('refuses a denied or detached messaging group', async () => {
    const r = await call(
      deps({ lookupGroup: async () => ({ ...GROUP, detached_at: '2026-09-01' }) as never }),
      OK_BODY,
    );
    expect(r.status).toBe(403);
  });

  it('requires the address and the text', async () => {
    expect((await call(deps(), { ...OK_BODY, text: '' })).status).toBe(400);
    expect((await call(deps(), { ...OK_BODY, platform_id: undefined })).status).toBe(400);
  });

  it('rejects a body that is not JSON, and anything but POST', async () => {
    expect((await call(deps(), '{not json')).status).toBe(400);
    expect((await call(deps(), null, 'GET')).status).toBe(405);
  });

  it('bounds the text a flow can post', async () => {
    expect((await call(deps(), { ...OK_BODY, text: 'x'.repeat(12_001) })).status).toBe(413);
  });

  it('says so when delivery is not ready, instead of pretending it sent', async () => {
    expect((await call(deps({ getAdapter: () => null }), OK_BODY)).status).toBe(503);
  });

  it('reports a failed delivery as 502 with the cause', async () => {
    const failing = vi.fn(async () => {
      throw new Error('channel_not_found');
    });
    const r = await call(deps({ getAdapter: () => ({ deliver: failing }) }), OK_BODY);
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toMatch(/channel_not_found/);
  });
});
