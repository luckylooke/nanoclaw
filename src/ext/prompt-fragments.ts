/**
 * The fork's house rules for every agent (container/fork-instructions.md), on the
 * prompt-fragment seam. They used to be ~87 lines inside container/CLAUDE.md,
 * upstream's base document, where every upstream wording change conflicted
 * with them. Features: strict-secrets-and-tool-exec, reply-language-matching,
 * plus the source-of-truth, voice and tool-proxy rules.
 */
import fs from 'fs';
import path from 'path';

import { registerPromptFragment } from './seams.js';

export const FORK_INSTRUCTIONS_PATH = path.join('container', 'fork-instructions.md');

/**
 * The file without its leading maintainer comment, which is not for the model.
 * Resolved against the cwd on purpose: the composer resolves the base document
 * (container/CLAUDE.md) the same way, so a host started from the wrong
 * directory loses both together and logs it, rather than half a prompt.
 */
export function readForkInstructions(file = path.resolve(process.cwd(), FORK_INSTRUCTIONS_PATH)): string {
  return fs.readFileSync(file, 'utf-8').replace(/^\s*<!--[\s\S]*?-->\s*/, '');
}

registerPromptFragment({ name: 'House rules', body: () => readForkInstructions() });
