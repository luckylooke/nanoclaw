import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../container-restart.js', () => ({ restartAgentGroupContainers: vi.fn().mockResolvedValue(0) }));

import { dispatch } from '../cli/dispatch.js';
import { getResource } from '../cli/crud.js';
import { ensureContainerConfig, getContainerConfig } from '../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
// The verb registers first, like src/ext/index.ts before the CLI barrel.
import { parseSkillsFlag } from './group-skills-verb.js';
import '../cli/resources/groups.js';

const GID = 'ag-skills';

describe('parseSkillsFlag', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    for (const s of ['diff', 'knowledge-base']) fs.mkdirSync(path.join(dir, s));
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a skill');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('accepts "all" and de-duplicated known names', () => {
    expect(parseSkillsFlag(' all ', dir)).toBe('all');
    expect(parseSkillsFlag('diff, knowledge-base,diff', dir)).toEqual(['diff', 'knowledge-base']);
  });

  it('refuses unknown names and an empty list, naming what exists', () => {
    expect(() => parseSkillsFlag('diff,typo', dir)).toThrow('Unknown skill(s): typo. Available: diff, knowledge-base');
    expect(() => parseSkillsFlag(' , ', dir)).toThrow('comma-separated list');
    expect(() => parseSkillsFlag('README.md', dir)).toThrow('Unknown skill(s): README.md');
  });
});

describe('ncl groups config set-skills', () => {
  const REPO = process.cwd();
  let root: string;
  beforeEach(async () => {
    // The verb resolves container/skills against the cwd (the host's project root).
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-root-'));
    fs.mkdirSync(path.join(root, 'container', 'skills', 'alpha'), { recursive: true });
    process.chdir(root);
    await runMigrations(await initTestDb());
    await createAgentGroup({
      id: GID,
      name: 'skills',
      folder: 'skills',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig(GID);
  });
  afterEach(async () => {
    process.chdir(REPO);
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is a verb of the groups resource, so help and approval treat it as one', () => {
    expect(getResource('groups')?.customOperations?.['config set-skills']?.access).toBe('approval');
    expect(getResource('groups')?.customOperations?.['config update']).toBeDefined();
  });

  it('stores the selection on the group', async () => {
    const skill = 'alpha';
    const resp = await dispatch(
      { id: 'r1', command: 'groups-config-set-skills', args: { id: GID, skills: skill } },
      { caller: 'host' },
    );
    expect(resp).toEqual({ id: 'r1', ok: true, data: { id: GID, skills: [skill] } });
    expect(JSON.parse((await getContainerConfig(GID))!.skills)).toEqual([skill]);
  });
});
