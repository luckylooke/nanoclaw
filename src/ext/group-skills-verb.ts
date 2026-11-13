/**
 * `ncl groups config set-skills` — the write path for container_configs.skills
 * (fork feature claude-md-compose-memory, "give skills a write path").
 *
 * Every selected skill ships its instructions into the composed prompt, so
 * trimming the selection trims the prefix, but it also removes the capability,
 * not just the text. Upstream stores the column and reads it at spawn but has
 * no CLI to set it. Until 2026-11-13 this was a --skills flag inside upstream's
 * `config update`; it is its own verb on the resource-verb seam now.
 */
import fs from 'fs';
import path from 'path';

import { getContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { registerResourceVerb } from './seams.js';

/**
 * "all", or the de-duplicated names. Validated against the skills that exist,
 * so a typo cannot silently disable a capability: a wrong name here would
 * remove the skill, not error at spawn.
 */
export function parseSkillsFlag(raw: string, skillsDir: string): 'all' | string[] {
  const value = raw.trim();
  if (value === 'all') return 'all';
  const wanted = value
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (wanted.length === 0) throw new Error('--skills must be "all" or a comma-separated list of skill names');
  const available = fs.existsSync(skillsDir)
    ? fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const unknown = wanted.filter((n) => !available.includes(n));
  if (unknown.length > 0) {
    throw new Error(`Unknown skill(s): ${unknown.join(', ')}. Available: ${available.sort().join(', ')}`);
  }
  return [...new Set(wanted)];
}

registerResourceVerb('groups', 'config set-skills', {
  access: 'approval',
  description:
    'Set which container skills a group gets. Saved now; takes effect at the next spawn (`ncl groups restart`). ' +
    'Use --id <group-id> --skills <"all" | comma-separated skill names>. Every skill ships instructions into the ' +
    'composed prompt, so trimming this trims the prefix — but it also removes the capability, not just the text.',
  examples: [
    'ncl groups config set-skills --id <group-id> --skills knowledge-base,diff',
    'ncl groups config set-skills --id <group-id> --skills all',
  ],
  handler: async (args) => {
    const id = args.id as string;
    if (!id) throw new Error('--id is required');
    if (args.skills === undefined) throw new Error('--skills is required');
    if (!(await getContainerConfig(id))) throw new Error(`No container config for group: ${id}`);
    const skills = parseSkillsFlag(String(args.skills), path.join(process.cwd(), 'container', 'skills'));
    await updateContainerConfigJson(id, 'skills', skills);
    return { id, skills };
  },
});
