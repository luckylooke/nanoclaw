/**
 * Invariants of the fork's gateway contribution.
 *
 * Re-pointed from `container-runner.test.ts`'s "egress proxy env (structural)"
 * suite on the v2.3.0 rebase: that suite asserted against `buildContainerArgs`,
 * which upstream deleted. The invariants did not change with the seam, so the
 * test follows the behaviour rather than being dropped with the function.
 */
import { describe, expect, it } from 'vitest';

import type { DriverCapabilities } from '../drivers/types.js';
import { credentialProxyProvider, gatewayEnv } from './credential-proxy.js';
import { getGatewayProviderRegistration, type GatewaySessionInput } from './gateway-provider-registry.js';

const base = { host: 'host.docker.internal', folder: 'agent-one', otelEnabled: false };

describe('gateway env (structural)', () => {
  it('never puts real key material in the container', () => {
    const env = gatewayEnv({ ...base, egressEnabled: false });
    expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed-placeholder');
    expect(env.ANTHROPIC_BASE_URL).toContain('host.docker.internal');
  });

  it('carries the cost-attribution header the budget cap keys on', () => {
    const env = gatewayEnv({ ...base, egressEnabled: false });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-agent-group: agent-one');
  });

  it('is gated on the knob, so egress can be turned off without a code change', () => {
    expect(gatewayEnv({ ...base, egressEnabled: false }).HTTPS_PROXY).toBeUndefined();
    expect(gatewayEnv({ ...base, egressEnabled: true }).HTTPS_PROXY).toBeDefined();
  });

  it('exempts the host from the proxy, or it would break the services on it', () => {
    // Without this the credential proxy, tool-proxy and OTEL collector are
    // tunnelled through squid — which breaks them and pollutes the audit log.
    const env = gatewayEnv({ ...base, egressEnabled: true });
    expect(env.NO_PROXY).toContain('host.docker.internal');
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
  });

  it('uses loopback when the driver shares the host network namespace', () => {
    const env = gatewayEnv({ ...base, host: '127.0.0.1', egressEnabled: true });
    expect(env.ANTHROPIC_BASE_URL).toContain('127.0.0.1');
    expect(env.HTTPS_PROXY).toContain('127.0.0.1');
  });
});

describe('gateway provider definition (v2.4.0 contract)', () => {
  function input(agentGroupId: string, groupFolder?: string): GatewaySessionInput {
    return {
      key: { installSlug: 'test', agentGroupId, sessionId: 'sess-1' } as GatewaySessionInput['key'],
      runtimeIdentity: 'test/' + agentGroupId + '/sess-1',
      groupName: 'Agent One',
      ...(groupFolder ? { groupFolder } : {}),
      containerName: 'nanoclaw-test',
      capabilities: { sharedNetworkNamespace: false } as unknown as DriverCapabilities,
    };
  }

  it('is registered under its kind and exposes no agent skill', () => {
    expect(getGatewayProviderRegistration('credential-proxy')).toBe(credentialProxyProvider);
    expect(credentialProxyProvider.agentSkills).toEqual([]);
  });

  it('leases a contribution that holds no key material and stays on the host', async () => {
    const lease = await credentialProxyProvider.sessions.ensure(
      input('ag-1', 'agent-one'),
      new AbortController().signal,
    );

    expect(lease.contribution.env?.ANTHROPIC_API_KEY).toBe('proxy-managed-placeholder');
    expect(lease.contribution.env?.ANTHROPIC_BASE_URL).toContain('host.docker.internal');
    expect(lease.contribution.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('x-agent-group: agent-one');
    expect(lease.contribution.networkAccess.target).toEqual({ kind: 'host' });
  });

  it('falls back to the group id for attribution when core hands over no folder', async () => {
    const lease = await credentialProxyProvider.sessions.ensure(input('ag-missing'), new AbortController().signal);
    expect(lease.contribution.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('x-agent-group: ag-missing');
  });

  it('keeps the approval subscription open until the host aborts it', async () => {
    // The coordinator treats a subscription that ENDS as a gateway outage and
    // closes session admission — so "no approvals to relay" must still wait.
    const controller = new AbortController();
    const done = credentialProxyProvider.approvals.subscribe(async () => 'deny', controller.signal);
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller.abort();
    await done;
  });
});
