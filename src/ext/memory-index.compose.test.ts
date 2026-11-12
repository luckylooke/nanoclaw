import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { log } from '../log.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';
import { MEMORY_INDEX_SECTION } from './memory-index.js';
import './prompt-fragments.js';

let dir: string;
let n = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-'));
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeMemory(rel: string, text: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Composed against the real repo (cwd), so every core section is present. */
async function compose(): Promise<string> {
  const id = `ag-mem-${++n}`;
  const ag = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  await composeGroupProjectDoc(ag, dir, DEFAULT_PROJECT_DOC);
  return fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
}

describe('memory index in the composed CLAUDE.md', () => {
  it('comes LAST, after the runtime contract, the house rules and every other section', async () => {
    writeMemory('memory/index.md', '## Map\n\n- [Thing](thing.md)');

    const doc = await compose();

    // Memory is the most volatile part of the prompt and caching is a prefix
    // match: everything before the volatile tail stays cacheable.
    const sections = [...doc.matchAll(/^# (.+)$/gm)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(3);
    expect(sections.at(-1)).toBe(MEMORY_INDEX_SECTION);
    expect(sections).toContain('NanoClaw Runtime Contract');
    expect(sections).toContain('House rules');
    expect(doc).toContain('- [Thing](thing.md)');
  });

  it('reads only the index: not the format contract, other memory files or stray files', async () => {
    // memory/system/definition.md is ~1.4k tokens of "how to write a memory
    // file": needed when writing memory, which is occasional. The index links to it.
    writeMemory('memory/index.md', 'See [the contract](system/definition.md).');
    writeMemory('memory/system/definition.md', 'FORMAT CONTRACT BODY');
    writeMemory('memory/notes.md', 'must not enter the project document');
    writeMemory('scratch.md', 'and neither must a stray file');

    const doc = await compose();

    expect(doc).toContain('See [the contract](system/definition.md).');
    expect(doc).not.toContain('FORMAT CONTRACT BODY');
    expect(doc).not.toContain('must not enter the project document');
    expect(doc).not.toContain('and neither must a stray file');
  });

  it('is inert for a group with no memory directory', async () => {
    const doc = await compose();
    expect(doc).not.toContain(`# ${MEMORY_INDEX_SECTION}`);
  });

  it('does not follow a symlink planted as the index', async () => {
    // The group directory is writable from the container: a symlink at
    // memory/index.md would otherwise pull any host-readable file into the prompt.
    const outside = path.join(os.tmpdir(), `outside-${process.pid}-${n}.md`);
    fs.writeFileSync(outside, 'HOST FILE THAT MUST NOT ENTER THE PROMPT');
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'memory', 'index.md'));

    try {
      const doc = await compose();
      expect(doc).not.toContain('HOST FILE THAT MUST NOT ENTER THE PROMPT');
      expect(doc).not.toContain(`# ${MEMORY_INDEX_SECTION}`);
      expect(log.warn).toHaveBeenCalledWith('Could not read the group memory index; omitting it', expect.anything());
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('is the first section the size cap drops', async () => {
    writeMemory('memory/index.md', 'x'.repeat(200_000));
    const id = 'ag-mem-cap';
    const ag = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const file = path.join(dir, 'CLAUDE.md');
    await composeGroupProjectDoc(ag, dir, DEFAULT_PROJECT_DOC);
    const full = Buffer.byteLength(fs.readFileSync(file, 'utf-8'), 'utf-8');
    // Small enough that something must go; the index is the largest droppable section.
    await composeGroupProjectDoc(ag, dir, { ...DEFAULT_PROJECT_DOC, maxBytes: full - 100 });
    const doc = fs.readFileSync(file, 'utf-8');
    expect(doc).not.toContain(`# ${MEMORY_INDEX_SECTION}`);
    expect(doc).toContain('Memory Index');
    expect(doc).toContain('# House rules');
  });
});
