/**
 * Invariants of the fork's gateway contribution.
 *
 * Re-pointed from `container-runner.test.ts`'s "egress proxy env (structural)"
 * suite on the v2.3.0 rebase: that suite asserted against `buildContainerArgs`,
 * which upstream deleted. The invariants did not change with the seam, so the
 * test follows the behaviour rather than being dropped with the function.
 */
import { describe, expect, it } from 'vitest';

import { gatewayEnv } from './credential-proxy.js';

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
