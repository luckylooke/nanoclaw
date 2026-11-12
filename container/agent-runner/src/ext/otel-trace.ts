/**
 * Per-turn trace id (fork feature otel-trace-per-turn).
 *
 * One trace id per query() — i.e. per agent turn — shared by two channels so
 * the cost row and the execution detail describe the same unit of work:
 *
 *   1. `x-trace-id` appended to ANTHROPIC_CUSTOM_HEADERS. Claude Code attaches
 *      it to every Anthropic request; the credential proxy reads it into
 *      gateway.db `api_calls.trace_id` and strips it before forwarding upstream.
 *      The per-task budget gate keys on it too.
 *   2. `TRACEPARENT` (W3C). In Agent SDK / headless mode Claude Code adopts an
 *      inbound trace context as the parent of its own interaction span, so the
 *      OTel spans it exports carry this same trace id.
 *
 * The id is in OTel's wire format (32 lowercase hex) so `api_calls.trace_id`
 * joins `otel.db spans.trace_id` with no translation.
 */
import crypto from 'crypto';

import { registerQueryContributor } from './seams.js';

let current: string | null = null;

/** The trace id of the running query, or null before the first one. */
export function currentTraceId(): string | null {
  return current;
}

/**
 * `ANTHROPIC_CUSTOM_HEADERS` already carries `x-agent-group` from the container
 * launcher (docker -e) and Claude Code reads the variable whole: replacing it
 * would silently drop per-agent cost attribution and un-cap that agent's budget.
 */
export function traceEnv(traceId: string, existingHeaders: string | undefined): Record<string, string> {
  const existing = existingHeaders?.trim();
  const headerLines = existing ? [existing] : [];
  headerLines.push(`x-trace-id: ${traceId}`);
  return {
    ANTHROPIC_CUSTOM_HEADERS: headerLines.join('\n'),
    TRACEPARENT: `00-${traceId}-${crypto.randomBytes(8).toString('hex')}-01`,
  };
}

registerQueryContributor('otel-trace', () => {
  current = crypto.randomBytes(16).toString('hex');
  // Logged so a container log line can be tied to the gateway row and the spans.
  console.error(`[claude-provider] trace ${current}`);
  return { env: traceEnv(current, process.env.ANTHROPIC_CUSTOM_HEADERS) };
});
