/**
 * Response handler registry.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

import type { InboundReaction } from './channels/adapter.js';

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

/**
 * Inbound-reaction handlers (T1.3). Registered by the feedback module at
 * import time; dispatched from src/index.ts's ChannelSetup.onReaction. Kept
 * here (not index.ts) for the same TDZ reason as the response handlers above.
 */
export type ReactionHandler = (reaction: InboundReaction) => void | Promise<void>;

const reactionHandlers: ReactionHandler[] = [];

export function registerReactionHandler(handler: ReactionHandler): void {
  reactionHandlers.push(handler);
}

export function getReactionHandlers(): readonly ReactionHandler[] {
  return reactionHandlers;
}
