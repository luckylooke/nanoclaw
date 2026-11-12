/**
 * Starts the native credential proxy (fork feature credential-proxy) on the
 * host pre-start seam: it injects the real Anthropic credential on the wire so
 * containers never see it, and every agent's ANTHROPIC_BASE_URL points at it.
 * So it must listen before the channel adapters, adoption of running
 * containers or the sweep can make an agent call it. Closed on shutdown.
 */
import { CREDENTIAL_PROXY_HOST, CREDENTIAL_PROXY_PORT } from '../config.js';
import { startCredentialProxy } from '../credential-proxy.js';
import { onHostShutdown } from '../host-lifecycle.js';
import { registerHostPreStart } from './seams.js';

registerHostPreStart('credential-proxy', async () => {
  const server = await startCredentialProxy(CREDENTIAL_PROXY_PORT, CREDENTIAL_PROXY_HOST);
  onHostShutdown(() => {
    server.close();
  });
});
