import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'DEFAULT_AGENT_PROVIDER',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_PIDS_LIMIT',
  'EGRESS_PROXY_PORT',
  'NANOCLAW_EGRESS_PROXY',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'ONECLI_GATEWAY_CONTAINER',
]);

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_NAME .env key
 * directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// Instance-wide default agent provider for newly created groups. `claude` (the
// built-in provider) when unset, so existing installs are unaffected on upgrade.
// Applied only at group-creation time (stamped onto the config row) — never in
// provider resolution — so existing groups are never retroactively flipped.
// Per-group `ncl groups config update --provider` still overrides it.
export const DEFAULT_AGENT_PROVIDER = (
  process.env.DEFAULT_AGENT_PROVIDER ||
  envConfig.DEFAULT_AGENT_PROVIDER ||
  'claude'
).toLowerCase();

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_HAS_OWN_NUMBER
 * .env key directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const CENTRAL_DB_PATH = path.join(DATA_DIR, 'v2.db');
// Local agent-template library. Committed but ships empty (+ README). Resolved
// once at load. Override to another LOCAL path via NANOCLAW_TEMPLATES_DIR; never
// a remote URL, never an ncl flag, never runtime-mutable.
export const TEMPLATES_DIR = process.env.NANOCLAW_TEMPLATES_DIR
  ? path.resolve(process.env.NANOCLAW_TEMPLATES_DIR)
  : path.resolve(PROJECT_ROOT, 'templates');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — the session key's install component, stamped onto every
// runtime object via the canonical `nanoclaw-install` label so adoption and
// reaping only ever see this install's sessions, not a peer's.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
// Per-container resource caps, passed through to . Default empty =
// no flag added = today's unbounded behavior (don't OOM existing OSS workloads).
// Operators opt in: CONTAINER_CPU_LIMIT=2, CONTAINER_MEMORY_LIMIT=8g.
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || '';
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || '';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
// Native credential proxy — replaces the OneCLI gateway. Containers reach it
// via host.docker.internal (host-gateway → docker bridge IP on Linux). Port
// 3002 chosen because 3000 (nanoclaw webhook) and 3001 (github-webhook) are
// taken on this host. Bind on the docker bridge IP so the proxy is reachable
// by containers but stays off the public interface; override via env if the
// bridge differs (e.g. rootless Docker → set CREDENTIAL_PROXY_HOST=0.0.0.0).
export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3002', 10);
export const CREDENTIAL_PROXY_HOST = process.env.CREDENTIAL_PROXY_HOST || '172.17.0.1';

// Egress proxy (SEC-AI1). Agents keep WebFetch and agent-browser, but every
// outbound request goes through an allowlisting squid on the docker bridge that
// logs each destination. Same reachability model as the credential proxy: bound
// on 172.17.0.1, reached via host.docker.internal, opened in ufw on docker0.
// Set NANOCLAW_EGRESS_PROXY=false to bypass it (agents then have open egress).
export const EGRESS_PROXY_ENABLED =
  (process.env.NANOCLAW_EGRESS_PROXY || envConfig.NANOCLAW_EGRESS_PROXY || 'true') !== 'false';
export const EGRESS_PROXY_PORT = parseInt(process.env.EGRESS_PROXY_PORT || envConfig.EGRESS_PROXY_PORT || '3128', 10);

// Host-side OTLP collector (agent-system/tools/otel/collector.js). Same
// reachability model as the credential proxy: bound on the docker bridge,
// containers reach it via host.docker.internal. 4318 is the OTLP/HTTP default.
// The collector is a separate systemd service, not started by nanoclaw — this
// constant only tells containers where to export to.
export const OTEL_COLLECTOR_PORT = parseInt(process.env.OTEL_COLLECTOR_PORT || '4318', 10);
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

// Fork-bomb backstop. cgroups v2 counts THREADS, not processes, and Chromium is
// thread-hungry — a browsing agent with several tabs open runs into the high
// hundreds. Keep well above that; too low a cap kills the container mid-turn or
// blocks it from spawning subprocesses, and neither is reported as a PID limit.
// Empty = no cap.
export const CONTAINER_PIDS_LIMIT = process.env.CONTAINER_PIDS_LIMIT ?? envConfig.CONTAINER_PIDS_LIMIT ?? '2048';

// Egress lockdown — force all agent traffic through the OneCLI gateway on a
// no-internet Docker network. Off by default; consumed by src/egress-lockdown.ts.
export const EGRESS_LOCKDOWN = (process.env.NANOCLAW_EGRESS_LOCKDOWN || envConfig.NANOCLAW_EGRESS_LOCKDOWN) === 'true';
export const EGRESS_NETWORK =
  process.env.NANOCLAW_EGRESS_NETWORK || envConfig.NANOCLAW_EGRESS_NETWORK || 'nanoclaw-egress';
export const ONECLI_GATEWAY_CONTAINER =
  process.env.ONECLI_GATEWAY_CONTAINER || envConfig.ONECLI_GATEWAY_CONTAINER || 'onecli';

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
