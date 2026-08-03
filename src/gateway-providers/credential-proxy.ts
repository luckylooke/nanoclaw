/**
 * The fork's native credential proxy, as a gateway provider.
 *
 * WHY THIS IS A PROVIDER AND NOT THE ORIGINAL PATCH
 *
 * Commit 98fcd66f wired the proxy by editing `buildContainerArgs` in
 * container-runner.ts. Upstream deleted that function in the v2.3.0 driver-seam
 * rewrite (a951e74b), so replaying the patch would have meant restoring
 * buildContainerArgs, spawn() and the old ActiveSessionRuntime — reverting
 * upstream's architecture in order to keep two env vars. Upstream instead grew
 * exactly the seam this needs: contribute() returns env and mounts merged into
 * the SessionSpec before validation, and it fails closed, which is the property
 * that matters here — a session without its credentials must not launch.
 *
 * So this is a better home than the original patch, not merely a different one.
 * See spec/fork-features.yaml, feature `credential-proxy`.
 *
 * WHAT IT CONTRIBUTES, AND WHY THAT IS THE WHOLE POINT
 *
 * Two env vars. The container is pointed at the proxy and given a PLACEHOLDER
 * key; the proxy injects the real x-api-key on the wire. No key material ever
 * enters the container, so there is nothing for an agent to read, print, or be
 * talked into quoting back — model context is an exfiltration surface, and this
 * is the layer that keeps secrets off it. Same policy as the strict-secrets rules
 * in container/CLAUDE.md and the per-group tool-proxy socket.
 */
import { CREDENTIAL_PROXY_PORT } from '../config.js';
import { registerGatewayProvider } from './gateway-provider-registry.js';

registerGatewayProvider('credential-proxy', () => ({
  kind: 'credential-proxy',
  async contribute({ capabilities }) {
    // A container with its own netns reaches the host gateway by name; a driver
    // that shares the host namespace reaches it on loopback. Reading the
    // capability rather than assuming docker is what keeps this working on a
    // driver that is not docker — the seam exists precisely so that features do
    // not branch on driver identity.
    const host = capabilities.sharedNetworkNamespace ? '127.0.0.1' : 'host.docker.internal';
    return {
      env: {
        ANTHROPIC_BASE_URL: `http://${host}:${CREDENTIAL_PROXY_PORT}`,
        ANTHROPIC_API_KEY: 'proxy-managed-placeholder',
      },
    };
  },
}));
