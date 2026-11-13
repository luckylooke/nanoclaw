/**
 * Fork feature container-skill-fragments: the fork's own skills under
 * container/skills/ reach the composed CLAUDE.md through upstream's skill
 * mechanism (a selected skill's instructions.md is inlined as a
 * `NanoClaw Skill: <name>` section). They need no seam, but nothing else would
 * notice a rebase that renamed, emptied or dropped them, so this composes
 * against the real repo and checks each one arrives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';

const FORK_SKILLS = ['diff', 'google-calendar', 'google-stt', 'google-tts', 'knowledge-base', 'screenshot'];

let dir: string;
let n = 0;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-fragments-'));
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function compose(skills?: string[]): Promise<string> {
  const id = `ag-skills-${++n}`;
  const ag = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  await createAgentGroup(ag);
  await ensureContainerConfig(id);
  if (skills) await updateContainerConfigJson(id, 'skills', skills);
  await composeGroupProjectDoc(ag, dir, DEFAULT_PROJECT_DOC);
  return fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
}

describe('fork container skills in the composed CLAUDE.md', () => {
  it.each(FORK_SKILLS)('%s ships non-empty resident instructions', (skill) => {
    const file = path.join(process.cwd(), 'container', 'skills', skill, 'instructions.md');
    expect(fs.readFileSync(file, 'utf-8').trim().length).toBeGreaterThan(0);
  });

  it('inlines every fork skill at the default selection', async () => {
    const doc = await compose();
    for (const skill of FORK_SKILLS) expect(doc).toContain(`# NanoClaw Skill: ${skill}`);
  });

  it('inlines only the selected ones when a group trims its skills', async () => {
    const doc = await compose(['knowledge-base']);
    expect(doc).toContain('# NanoClaw Skill: knowledge-base');
    for (const skill of FORK_SKILLS.filter((s) => s !== 'knowledge-base')) {
      expect(doc).not.toContain(`# NanoClaw Skill: ${skill}`);
    }
  });
});
