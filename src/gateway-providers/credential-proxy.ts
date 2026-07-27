/**
 * The fork's native credential proxy, as a gateway provider.
 *
 * WHY THIS IS A PROVIDER AND NOT THE ORIGINAL PATCH
 *
 * Commit 98fcd66f wired the proxy by editing `buildContainerArgs` in
 * container-runner.ts. Upstream deleted that function in the v2.3.0 driver-seam
 * rewrite (a951e74b), so replaying the patch would have meant restoring
 * buildContainerArgs, spawn() and the old ActiveSessionRuntime — reverting
 * upstream's architecture in order to keep a handful of env vars. Upstream
 * instead grew exactly the seam this needs: contribute() returns env and mounts
 * merged into the SessionSpec before validation, and it fails closed, which is
 * the property that matters — a session without its credentials must not launch.
 *
 * So this is a better home than the original patch, not merely a different one.
 * See spec/fork-features.yaml, feature `credential-proxy`.
 *
 * WHAT IT CONTRIBUTES
 *
 * The credential pair is the point: the container is aimed at the proxy and given
 * a PLACEHOLDER key, and the proxy injects the real x-api-key on the wire. No key
 * material ever enters the container, so there is nothing for an agent to read,
 * print, or be talked into quoting back — model context is an exfiltration
 * surface, and this is the layer that keeps secrets off it.
 *
 * Cost attribution and OTel ride along because a gateway contribution is the only
 * per-session container-env seam upstream exposes; the alternative is patching
 * spec composition in container-runner.ts, which is the file upstream rewrites
 * every release and the reason this port was needed at all. See features
 * `gateway-cost-budget` and `otel-trace-per-turn`.
 */
import { CREDENTIAL_PROXY_PORT, OTEL_COLLECTOR_PORT } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { registerGatewayProvider } from './gateway-provider-registry.js';

registerGatewayProvider('credential-proxy', () => ({
  kind: 'credential-proxy',
  async contribute({ key, capabilities }) {
    // A container with its own netns reaches the host gateway by name; a driver
    // that shares the host namespace reaches it on loopback. Reading the
    // capability rather than assuming docker is what keeps this working on a
    // driver that is not docker — the seam exists so features do not branch on
    // driver identity.
    const host = capabilities.sharedNetworkNamespace ? '127.0.0.1' : 'host.docker.internal';
    const group = await getAgentGroup(key.agentGroupId);
    // Fall back to the id rather than throwing: a missing row must not stop a
    // spawn, and an attributable-but-ugly header beats no attribution.
    const folder = group?.folder ?? key.agentGroupId;

    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: `http://${host}:${CREDENTIAL_PROXY_PORT}`,
      ANTHROPIC_API_KEY: 'proxy-managed-placeholder',
      // Cost attribution. The proxy reads x-agent-group to bill the turn and to
      // enforce that group's budget cap, and the claude provider APPENDS its
      // per-turn x-trace-id to this same variable — so dropping this line both
      // loses attribution and un-caps the agent, silently.
      ANTHROPIC_CUSTOM_HEADERS: `x-agent-group: ${folder}`,
    };

    // Kill switch: AGENT_OTEL=0 in the nanoclaw service env disables injection.
    if (process.env.AGENT_OTEL !== '0') {
      const endpoint = process.env.AGENT_OTEL_ENDPOINT || `http://${host}:${OTEL_COLLECTOR_PORT}`;
      Object.assign(env, {
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_METRIC_EXPORT_INTERVAL: '30000',
        // Tool NAMES are useful signal; prompts, tool content and raw API bodies
        // are not exported — they would put user text into the telemetry store.
        OTEL_LOG_TOOL_DETAILS: '1',
        OTEL_LOG_USER_PROMPTS: '0',
        OTEL_LOG_TOOL_CONTENT: '0',
        OTEL_LOG_RAW_API_BODIES: '0',
        OTEL_SERVICE_NAME: 'nanoclaw-agent',
        OTEL_RESOURCE_ATTRIBUTES: `agent.group=${folder}`,
      });
    }

    return { env };
  },
}));
