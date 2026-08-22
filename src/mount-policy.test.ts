import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { escapableRoMounts, privilegedRepoMounts } from './container-runner.js';

/**
 * The Orchestrator's group dir is the one that is a real directory rather than a
 * symlink into agent-system/groups/<group>, so its RW mount at /workspace/agent
 * exposed the whole repo: the cron watchdog, the daemon that loads every secret,
 * the shared-memory source of truth, .git, and all nine agents' identity files.
 *
 * These tests exist because the escape in `escapableRoMounts` was found by
 * probing the live tree, which renamed the real agent-system directory and
 * dangled every symlink in the system for ninety seconds. The policy is now
 * asserted against a fixture, so nobody needs to rediscover it that way.
 */
let root: string;
const OWN = 'dm-with-ignac';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-policy-'));
  for (const d of ['tools', 'tool-proxy', 'shared/memory', '.git', 'spec', `groups/${OWN}`, 'groups/admin']) {
    fs.mkdirSync(path.join(root, 'agent', 'agent-system', d), { recursive: true });
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const groupDir = () => path.join(root, 'agent');
const byPath = (ms: { containerPath: string }[]) => ms.map((m) => m.containerPath);

describe('privilegedRepoMounts', () => {
  it('returns nothing for a group whose dir holds no agent-system/', () => {
    // Every group but the Orchestrator: groupDir is a symlink to
    // agent-system/groups/<group>, which contains no agent-system/ of its own.
    expect(privilegedRepoMounts(path.join(root, 'nonexistent'), 'admin')).toEqual([]);
  });

  it('binds agent-system over itself FIRST, so the RO mounts below cannot be escaped', () => {
    const mounts = privilegedRepoMounts(groupDir(), OWN);
    expect(mounts[0]).toMatchObject({ containerPath: '/workspace/agent/agent-system', readonly: false });
  });

  it('mounts every privileged subtree read-only', () => {
    const mounts = privilegedRepoMounts(groupDir(), OWN);
    for (const sub of ['tools', 'tool-proxy', 'shared', '.git']) {
      expect(mounts).toContainEqual(
        expect.objectContaining({ containerPath: `/workspace/agent/agent-system/${sub}`, readonly: true }),
      );
    }
  });

  it('leaves spec/ alone — the policy protects privileged code, not the whole repo', () => {
    expect(byPath(privilegedRepoMounts(groupDir(), OWN))).not.toContain('/workspace/agent/agent-system/spec');
  });

  it('makes groups/ read-only but keeps the agent OWN group writable', () => {
    const mounts = privilegedRepoMounts(groupDir(), OWN);
    expect(mounts).toContainEqual(
      expect.objectContaining({ containerPath: '/workspace/agent/agent-system/groups', readonly: true }),
    );
    expect(mounts).toContainEqual(
      expect.objectContaining({ containerPath: `/workspace/agent/agent-system/groups/${OWN}`, readonly: false }),
    );
  });

  it('never grants write access to another agent group', () => {
    const writable = privilegedRepoMounts(groupDir(), OWN)
      .filter((m) => !m.readonly)
      .map((m) => m.containerPath);
    expect(writable).not.toContain('/workspace/agent/agent-system/groups/admin');
  });

  it('pushes the RO groups/ parent before the RW own-group child', () => {
    // Docker applies -v in order; a RW child listed before its RO parent is
    // shadowed by it, silently making the agent's own dir read-only.
    const p = byPath(privilegedRepoMounts(groupDir(), OWN));
    expect(p.indexOf('/workspace/agent/agent-system/groups')).toBeLessThan(
      p.indexOf(`/workspace/agent/agent-system/groups/${OWN}`),
    );
  });

  it('skips a subtree that does not exist instead of mounting a phantom path', () => {
    const bare = path.join(root, 'bare');
    fs.mkdirSync(path.join(bare, 'agent-system', 'tools'), { recursive: true });
    const p = byPath(privilegedRepoMounts(bare, OWN));
    expect(p).toContain('/workspace/agent/agent-system/tools');
    expect(p).not.toContain('/workspace/agent/agent-system/shared');
    expect(p).not.toContain('/workspace/agent/agent-system/groups');
  });
});

describe('escapableRoMounts', () => {
  // The outer RW group mount MUST be included. Without it this assertion is
  // toothless: escapableRoMounts finds no writable ancestor and calls everything
  // safe, which is exactly what happened to the first version of this test — it
  // stayed green when the self-bind was deliberately removed.
  const fullList = () => [
    { hostPath: groupDir(), containerPath: '/workspace/agent', readonly: false },
    ...privilegedRepoMounts(groupDir(), OWN),
  ];

  it('passes the real policy — every RO mount has a mountpoint parent', () => {
    expect(escapableRoMounts(fullList())).toEqual([]);
  });

  it('fails if the self-bind is dropped — proving this assertion has teeth', () => {
    // Same list minus the agent-system self-bind: every RO subtree below it now
    // sits under a writable mount with a non-mountpoint parent.
    const sabotaged = fullList().filter((m) => m.containerPath !== '/workspace/agent/agent-system');
    expect(byPath(escapableRoMounts(sabotaged))).toEqual([
      '/workspace/agent/agent-system/tools',
      '/workspace/agent/agent-system/tool-proxy',
      '/workspace/agent/agent-system/shared',
      '/workspace/agent/agent-system/.git',
      '/workspace/agent/agent-system/groups',
    ]);
  });

  it('catches the shape actually shipped on 2026-08-22: a RO mount two levels deep', () => {
    // A mount attaches to the dentry, not the path, so `mv agent-system x`
    // carries tools/ along and frees the original path for a writable decoy.
    const offenders = escapableRoMounts([
      { hostPath: '/h/agent', containerPath: '/workspace/agent', readonly: false },
      { hostPath: '/h/agent/agent-system/tools', containerPath: '/workspace/agent/agent-system/tools', readonly: true },
    ]);
    expect(byPath(offenders)).toEqual(['/workspace/agent/agent-system/tools']);
  });

  it('accepts a RO mount whose parent is the mount root', () => {
    // Why container.json and plugins/ were always safe without a self-bind.
    expect(
      escapableRoMounts([
        { hostPath: '/h/agent', containerPath: '/workspace/agent', readonly: false },
        { hostPath: '/h/agent/container.json', containerPath: '/workspace/agent/container.json', readonly: true },
      ]),
    ).toEqual([]);
  });

  it('ignores a RO mount that no writable mount contains', () => {
    // /app/CLAUDE.md: its parent is in the image, not in agent-writable space.
    expect(escapableRoMounts([{ hostPath: '/h/CLAUDE.md', containerPath: '/app/CLAUDE.md', readonly: true }])).toEqual(
      [],
    );
  });
});
