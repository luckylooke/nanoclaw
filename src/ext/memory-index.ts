/**
 * The group's memory index (`memory/index.md`) in every composed CLAUDE.md, on
 * the prompt-fragment seam (fork feature claude-md-compose-memory).
 *
 * `memory/system/definition.md` claims the index is loaded whenever a context
 * window is created; this fragment is what makes that claim true.
 *
 * Placed at the tail: memory changes far more often than the runtime contract
 * or the instruction set, and prompt caching is a prefix match, so the volatile
 * tail keeps everything before it cacheable. The format contract
 * (memory/system/definition.md, ~1.4k tokens of how-to-write-a-memory-file) is
 * deliberately NOT inlined: writing memory is occasional, and the index links
 * to it. Droppable, so under the size cap the persona and the runtime contract
 * outrank it.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { registerPromptFragment } from './seams.js';

export const MEMORY_INDEX_SECTION = 'Memory Index';
const MEMORY_INDEX_FILE = path.join('memory', 'index.md');

/**
 * Read the agent-authored memory index with the same discipline as
 * `readGroupPersona` — O_NOFOLLOW, regular files only — because the group
 * directory is writable from the container and a planted symlink would
 * otherwise pull any host-readable file into the system prompt.
 */
export function readMemoryIndex(groupDir: string): string | null {
  const file = path.join(groupDir, MEMORY_INDEX_FILE);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
    return content || null;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read the group memory index; omitting it', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

registerPromptFragment({
  name: MEMORY_INDEX_SECTION,
  placement: 'tail',
  droppable: true,
  body: ({ groupDir }) => readMemoryIndex(groupDir),
});
