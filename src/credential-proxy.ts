/**
 * Credential proxy for container isolation — also the model gateway (T1.1).
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Gateway role (T1.1): for POST /v1/messages it additionally
 *   - tees the SSE response to parse usage (tokens) and stop_reason,
 *   - computes EUR cost and logs one api_calls row (best-effort; a parse
 *     error must never break the stream to the container),
 *   - enforces month-to-date budget caps per bucket → 429 when exceeded,
 *   - retries transient upstream 429/5xx with exponential back-off.
 *
 * Per-agent attribution rides on the `x-agent-group` request header injected
 * by the container launcher (ANTHROPIC_CUSTOM_HEADERS). It is stripped before
 * forwarding upstream.
 *
 * Ported manually from upstream/skill/native-credential-proxy (2026-06-12)
 * to replace the OneCLI gateway without merging the stale pre-v2 branch.
 * Adapted to v2's logger (`log` from ./log.js, message-first signature).
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';
import zlib from 'node:zlib';

import { readEnvFile } from './env.js';
import { initGatewayDb, checkBudget, recordApiCall, computeCostEur, type Usage } from './gateway-db.js';
import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const MAX_RETRIES = 2;

/** Compute back-off before a retry: honor Retry-After (seconds), else exp+jitter. */
function retryDelayMs(retryAfter: string | string[] | undefined, attempt: number): number {
  const ra = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
}

interface UsageAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  stopReason: string | null;
  resolvedModel: string | null; // exact model id Anthropic served (drift vs the requested alias)
}

/** Decompress a response body per its Content-Encoding (Anthropic streams gzip). */
function decodeBody(raw: Buffer, encoding: string): Buffer {
  switch (encoding) {
    case 'gzip':
      return zlib.gunzipSync(raw);
    case 'br':
      return zlib.brotliDecompressSync(raw);
    case 'deflate':
      try {
        return zlib.inflateSync(raw);
      } catch {
        return zlib.inflateRawSync(raw);
      }
    default:
      return raw;
  }
}

/**
 * Extract usage from a (decompressed) response body. Handles the streaming SSE
 * shape (message_start + message_delta events) and falls back to a single
 * non-streaming JSON message object. Best-effort — never throws on bad input.
 */
function parseUsage(text: string): UsageAcc {
  const acc: UsageAcc = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, stopReason: null, resolvedModel: null };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.type === 'message_start' && obj.message?.usage) {
        if (obj.message.model != null) acc.resolvedModel = obj.message.model;
        const u = obj.message.usage;
        if (u.input_tokens != null) acc.input = u.input_tokens;
        if (u.cache_read_input_tokens != null) acc.cacheRead = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) acc.cacheCreate = u.cache_creation_input_tokens;
      } else if (obj.type === 'message_delta') {
        if (obj.usage?.output_tokens != null) acc.output = obj.usage.output_tokens;
        if (obj.delta?.stop_reason != null) acc.stopReason = obj.delta.stop_reason;
      }
    } catch {
      /* partial or non-JSON line — best-effort, ignore */
    }
  }
  // Non-streaming fallback: the whole body is one JSON message object.
  if (acc.input === 0 && acc.output === 0) {
    try {
      const obj = JSON.parse(text);
      if (obj.usage) {
        acc.input = obj.usage.input_tokens ?? 0;
        acc.output = obj.usage.output_tokens ?? 0;
        acc.cacheRead = obj.usage.cache_read_input_tokens ?? 0;
        acc.cacheCreate = obj.usage.cache_creation_input_tokens ?? 0;
      }
      if (obj.model != null) acc.resolvedModel = obj.model;
      if (obj.stop_reason != null) acc.stopReason = obj.stop_reason;
    } catch {
      /* not a single JSON object */
    }
  }
  return acc;
}

export function startCredentialProxy(port: number, host = '127.0.0.1'): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Gateway persistence (best-effort; failures are logged and disable logging
  // + caps but never block the proxy).
  initGatewayDb();

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const t0 = Date.now();
        const body = Buffer.concat(chunks);

        // Is this a model-inference call we should log + cap?
        const isMessages =
          req.method === 'POST' && !!req.url && (req.url === '/v1/messages' || req.url.startsWith('/v1/messages?'));

        // Per-agent attribution + trace id from request headers.
        const rawGroup = req.headers['x-agent-group'];
        const groupSlug = (Array.isArray(rawGroup) ? rawGroup[0] : rawGroup) ?? null;
        const rawTrace = req.headers['x-trace-id'];
        const traceId = (Array.isArray(rawTrace) ? rawTrace[0] : rawTrace) ?? null;

        // model comes from the request body JSON. Parse once; reused by the
        // optional body-inspect spike (GATEWAY_BODY_INSPECT) below.
        let model: string | null = null;
        let parsedBody: Record<string, unknown> | null = null;
        if (isMessages && body.length) {
          try {
            parsedBody = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            model = (parsedBody.model as string | undefined) ?? null;
          } catch {
            /* non-JSON body — leave model null */
          }
        }

        // --- Tier 3 spike (#8/#9): observe request-body shape, log-only -----
        // Confirms whether extended thinking is on (which locks temperature=1)
        // and whether temperature/max_tokens are already set, per agent. Gated
        // on GATEWAY_BODY_INSPECT; never mutates the forwarded body.
        if (isMessages && parsedBody && process.env.GATEWAY_BODY_INSPECT) {
          try {
            const thinking = parsedBody.thinking as { type?: string; budget_tokens?: number } | undefined;
            log.info('Gateway body-inspect', {
              group: groupSlug,
              model,
              keys: Object.keys(parsedBody),
              hasThinking: !!thinking,
              thinkingType: thinking?.type ?? null,
              thinkingBudget: thinking?.budget_tokens ?? null,
              temperature: (parsedBody.temperature as number | undefined) ?? null,
              max_tokens: (parsedBody.max_tokens as number | undefined) ?? null,
            });
          } catch (err) {
            log.warn('Gateway body-inspect failed', { err: String(err) });
          }
        }

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        // Gateway attribution header is host-side only — never send upstream.
        delete headers['x-agent-group'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // --- Budget cap: reject before forwarding -----------------------
        if (isMessages) {
          const budget = checkBudget(groupSlug);
          if (budget && budget.overCap) {
            const payload = JSON.stringify({
              error: 'budget_cap_exceeded',
              bucket: budget.bucket,
              spent_eur: Number(budget.spent_eur.toFixed(4)),
              cap_eur: budget.cap_eur,
            });
            res.writeHead(429, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            });
            res.end(payload);
            log.warn('Gateway: budget cap exceeded — returning 429', {
              group: groupSlug,
              bucket: budget.bucket,
              spent_eur: budget.spent_eur,
              cap_eur: budget.cap_eur,
            });
            recordApiCall({
              ts: new Date().toISOString(),
              trace_id: traceId,
              group_slug: groupSlug,
              model,
              input_tokens: null,
              output_tokens: null,
              cache_read_tokens: null,
              cache_creation_tokens: null,
              cost_eur: 0,
              latency_ms: Date.now() - t0,
              status: 429,
              stop_reason: 'budget_cap_exceeded',
            });
            return;
          }
        }

        // --- Forward with retry on transient upstream errors ------------
        const attempt = (n: number): void => {
          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes: IncomingMessage) => {
              const status = upRes.statusCode ?? 0;
              const retryable = status === 429 || status >= 500;
              if (retryable && n < MAX_RETRIES && !res.headersSent) {
                upRes.resume(); // drain + discard this attempt's body
                const delay = retryDelayMs(upRes.headers['retry-after'], n);
                log.warn('Gateway: retrying upstream', { status, attempt: n + 1, delayMs: delay, url: req.url });
                setTimeout(() => attempt(n + 1), delay);
                return;
              }

              // Commit this response to the container — the raw (possibly
              // gzip'd) bytes are piped through untouched; we tee a copy for
              // usage parsing so bookkeeping can never corrupt the stream.
              res.writeHead(status, upRes.headers);
              upRes.pipe(res);

              if (isMessages) {
                const encoding = String(upRes.headers['content-encoding'] || '')
                  .toLowerCase()
                  .trim();
                const MAX_PARSE_BYTES = 16 * 1024 * 1024;
                const parts: Buffer[] = [];
                let size = 0;
                let tooBig = false;
                upRes.on('data', (chunk: Buffer) => {
                  if (tooBig) return;
                  size += chunk.length;
                  if (size > MAX_PARSE_BYTES) {
                    tooBig = true;
                    parts.length = 0;
                    return;
                  }
                  parts.push(chunk);
                });
                upRes.on('end', () => {
                  let a: UsageAcc = {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheCreate: 0,
                    stopReason: null,
                    resolvedModel: null,
                  };
                  if (tooBig) {
                    log.warn('Gateway: response too large; usage not parsed', { url: req.url });
                  } else {
                    try {
                      a = parseUsage(decodeBody(Buffer.concat(parts), encoding).toString('utf8'));
                    } catch (err) {
                      log.warn('Gateway: usage decode/parse failed', { err: String(err), encoding });
                    }
                  }
                  try {
                    const usage: Usage = {
                      input_tokens: a.input,
                      output_tokens: a.output,
                      cache_read_tokens: a.cacheRead,
                      cache_creation_tokens: a.cacheCreate,
                    };
                    recordApiCall({
                      ts: new Date().toISOString(),
                      trace_id: traceId,
                      group_slug: groupSlug,
                      model,
                      resolved_model: a.resolvedModel,
                      input_tokens: a.input,
                      output_tokens: a.output,
                      cache_read_tokens: a.cacheRead,
                      cache_creation_tokens: a.cacheCreate,
                      cost_eur: computeCostEur(model, usage),
                      latency_ms: Date.now() - t0,
                      status,
                      stop_reason: a.stopReason,
                    });
                  } catch (err) {
                    log.warn('Gateway: record failed', { err: String(err) });
                  }
                });
              }
            },
          );

          upstream.on('error', (err) => {
            if (n < MAX_RETRIES && !res.headersSent) {
              const delay = retryDelayMs(undefined, n);
              log.warn('Gateway: upstream error, retrying', {
                err: String(err),
                attempt: n + 1,
                delayMs: delay,
                url: req.url,
              });
              setTimeout(() => attempt(n + 1), delay);
              return;
            }
            log.error('Credential proxy upstream error', { err, url: req.url });
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        };

        attempt(0);
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
