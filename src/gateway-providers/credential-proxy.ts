/**
 * The fork's native credential proxy, as a gateway provider.
 *
 * WHY THIS IS A PROVIDER AND NOT THE ORIGINAL PATCH
 *
 * Commit 98fcd66f wired the proxy by editing `buildContainerArgs` in
 * container-runner.ts. Upstream deleted that function in the v2.3.0 driver-seam
 * rewrite (a951e74b), so replaying the patch would have meant restoring
 * buildContainerArgs, spawn() and the old ActiveSessionRuntime — reverting
 * upstream's architecture to keep a handful of env vars. Upstream instead grew
 * exactly the seam this needs: contribute() returns env and mounts merged into
 * the SessionSpec before validation, and it fails closed, which is the property
 * that matters — a session without its credentials must not launch.
 *
 * See spec/fork-features.yaml: credential-proxy, egress-allowlist-proxy,
 * gateway-cost-budget, otel-trace-per-turn. All four contribute container env,
 * and a gateway contribution is the only per-session env seam upstream exposes;
 * the alternative is patching spec composition in container-runner.ts, which is
 * the file upstream rewrites every release and the reason this port was needed.
 *
 * `gatewayEnv` is pure and exported so the invariants can be asserted without a
 * database or a spawn — the same move 880c6e26 made for the mount policy.
 */
import { CREDENTIAL_PROXY_PORT, EGRESS_PROXY_ENABLED, EGRESS_PROXY_PORT, OTEL_COLLECTOR_PORT } from '../config.js';
import fs from 'fs';
import path from 'path';

import { CONTAINER_TOOL_PROXY_SOCK_DIR } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { registerGatewayProvider } from './gateway-provider-registry.js';

export interface GatewayEnvInput {
  /** How the container reaches the host: a name, or loopback on a shared netns. */
  host: string;
  /** Agent group folder — the cost-attribution and telemetry label. */
  folder: string;
  egressEnabled?: boolean;
  otelEnabled?: boolean;
  otelEndpoint?: string;
}

export function gatewayEnv(input: GatewayEnvInput): Record<string, string> {
  const { host, folder } = input;
  const egress = input.egressEnabled ?? EGRESS_PROXY_ENABLED;
  const otel = input.otelEnabled ?? process.env.AGENT_OTEL !== '0';

  const env: Record<string, string> = {
    // The container is aimed at the proxy and given a PLACEHOLDER key; the proxy
    // injects the real x-api-key on the wire. No key material enters the
    // container, so there is nothing for an agent to read, print, or be talked
    // into quoting back — model context is an exfiltration surface.
    ANTHROPIC_BASE_URL: `http://${host}:${CREDENTIAL_PROXY_PORT}`,
    ANTHROPIC_API_KEY: 'proxy-managed-placeholder',
    // Cost attribution. The proxy reads x-agent-group to bill the turn and to
    // enforce that group's budget cap, and the claude provider APPENDS its
    // per-turn x-trace-id to this same variable — so dropping this line both
    // loses attribution and un-caps the agent, silently.
    ANTHROPIC_CUSTOM_HEADERS: `x-agent-group: ${folder}`,
  };

  // SEC-AI1. Agents keep WebFetch and agent-browser, but every outbound request
  // must traverse the allowlisting proxy so the destination is logged. Claude
  // Code and agent-browser both honour these, so the wiring is env-only.
  if (egress) {
    const proxyUrl = `http://${host}:${EGRESS_PROXY_PORT}`;
    env.HTTPS_PROXY = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    // NO_PROXY must exempt the host: the credential proxy, tool-proxy and OTEL
    // collector all live there and must not be tunnelled through squid, which
    // would break them and pollute the audit log.
    env.NO_PROXY = 'host.docker.internal,localhost,127.0.0.1';
  }

  if (otel) {
    const endpoint = input.otelEndpoint ?? process.env.AGENT_OTEL_ENDPOINT ?? `http://${host}:${OTEL_COLLECTOR_PORT}`;
    Object.assign(env, {
      // Without these two Claude Code emits nothing and every OTEL_* below is
      // inert — the exporter config is not the switch, these are.
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
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

  return env;
}

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
    const env = gatewayEnv({ host, folder });
    // Per-group tool-proxy socket: reaching it IS the credential, and the group
    // is proven by the mount rather than claimed in a request body. Set only when
    // the host actually has a socket dir for this group, so a group without one
    // falls back rather than pointing at a path that is not mounted.
    if (process.env.HOME && fs.existsSync(path.join(process.env.HOME, 'tool-proxy-sockets', folder))) {
      env.TOOL_PROXY_SOCKET = `${CONTAINER_TOOL_PROXY_SOCK_DIR}/tool-proxy.sock`;
    }
    return { env };
  },
}));
