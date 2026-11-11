import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';
import './prompt-fragments.js';

let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fragments-'));
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('house rules reach every composed CLAUDE.md', () => {
  it('composes them right after the base document, undroppable', async () => {
    const ag = {
      id: 'ag-hr',
      name: 'hr',
      folder: 'hr',
      agent_provider: null,
      created_at: new Date().toISOString(),
    } as AgentGroup;
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await composeGroupProjectDoc(ag, dir, DEFAULT_PROJECT_DOC);
    const doc = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    const base = doc.indexOf('# NanoClaw Runtime Contract');
    const rules = doc.indexOf('# House rules');
    expect(base).toBeGreaterThan(-1);
    expect(rules).toBeGreaterThan(base);
    expect(doc).toContain('## SECURITY: Strict secrets isolation');
    expect(doc).toContain('## Language');
    expect(doc).not.toContain('<!--\nFork house rules');
  });
});
