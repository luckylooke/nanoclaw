/**
 * Wires the review board's deterministic gate (providers/review-gate.ts,
 * agent-system spec/review-board.md step F) into every query: one instance per
 * query, observes PostToolUse, blocks a premature Stop once.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import { createReviewGate } from '../providers/review-gate.js';
import { registerQueryContributor } from './seams.js';

registerQueryContributor('review-gate', () => {
  const gate = createReviewGate({ agentDir: '/workspace/agent' });
  return {
    hooks: {
      PostToolUse: [gate.postToolUse as HookCallback],
      Stop: [gate.stop as HookCallback],
    },
  };
});
