/**
 * Per-IP rate limit on the webhook server (feature `webhook-rate-limit`, SEC-M1),
 * on the webhook-middleware seam. Token bucket: 100 requests per IP, one token
 * back every 600 ms; an empty bucket answers 429 before any routing.
 */
import type http from 'http';

import { registerWebhookMiddleware } from './seams.js';

const IP_BUCKET = new Map<string, { tokens: number; last: number }>();
const RATE_LIMIT = 100;
const REFILL_MS = 600;

export function checkRateLimit(ip: string, now = Date.now()): boolean {
  let b = IP_BUCKET.get(ip);
  if (!b) {
    b = { tokens: RATE_LIMIT, last: now };
    IP_BUCKET.set(ip, b);
  }
  // A clock stepped backwards would leave `last` in the future and freeze the
  // bucket; re-anchor instead.
  if (now < b.last) b.last = now;
  const refill = Math.floor((now - b.last) / REFILL_MS);
  if (refill > 0) {
    b.tokens = Math.min(RATE_LIMIT, b.tokens + refill);
    b.last += refill * REFILL_MS;
  }
  if (b.tokens <= 0) return false;
  b.tokens--;
  return true;
}

export function rateLimitMiddleware(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (checkRateLimit(req.socket.remoteAddress || 'unknown')) return false;
  res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
  res.end('Too Many Requests');
  return true;
}

/** Test helper. */
export function _resetRateLimitForTest(): void {
  IP_BUCKET.clear();
}

registerWebhookMiddleware('rate-limit', rateLimitMiddleware);
