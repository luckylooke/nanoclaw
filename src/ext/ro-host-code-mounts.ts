/**
 * Host-side privileged code is read-only inside the container (feature
 * `ro-host-code-mounts`), on the spawn-mounts seam. Registered after the
 * tool-proxy socket so the mount order is what it was inline in buildMounts.
 */
import fs from 'fs';
import path from 'path';

import type { VolumeMount } from '../providers/provider-container-registry.js';
import { registerSpawnMounts } from './seams.js';

/**
 * Read-only mounts protecting host-side privileged code that sits inside a
 * group's read-write mount, plus the self-bind that makes them unescapable.
 *
 * Pure apart from existence checks, which is the point: the policy is asserted
 * against a fixture tree in mount-policy.test.ts instead of being probed against
 * the live one. Probing the live one is how the escape below was found, at the
 * cost of renaming the real agent-system directory and dangling every symlink in
 * the system for ninety seconds.
 *
 * Only the Orchestrator group has `agent-system/` inside its mount — every other
 * group dir is a symlink to `agent-system/groups/<group>` — so for everyone else
 * this returns an empty list.
 */
export function privilegedRepoMounts(
  groupDir: string,
  groupFolder: string,
  containerAgentPath = '/workspace/agent',
): VolumeMount[] {
  const repoDir = path.join(groupDir, 'agent-system');
  if (!fs.existsSync(repoDir)) return [];
  const crepo = `${containerAgentPath}/agent-system`;
  const mounts: VolumeMount[] = [];

  // First: bind agent-system over itself, RW and content-unchanged, purely so it
  // becomes a MOUNTPOINT. Without this every RO mount below is escapable — Linux
  // attaches a mount to the dentry rather than the path, so
  // `mv agent-system agent-system-x` succeeds, carries the RO mounts along, and
  // leaves the original path free to be recreated as a writable decoy that the
  // host's cron symlinks would resolve to. Renaming a mountpoint fails EBUSY.
  mounts.push({ hostPath: repoDir, containerPath: crepo, readonly: false });

  // `tools` and `tool-proxy`: host-side privileged code (the cron watchdog, the
  // dashboard and otel-collector services, and the daemon that loads every
  // secret). `shared`: the shared-memory source of truth — `share` enforces that
  // an agent may promote only its own memory and the proxy forwards the caller's
  // group to make that stick, but a direct write here sidesteps the check,
  // audiences.json included, and `memory sync` would materialise the result into
  // every agent. `.git`: history rewrite and index corruption.
  for (const sub of ['tools', 'tool-proxy', 'shared', '.git']) {
    const hostPath = path.join(repoDir, sub);
    if (fs.existsSync(hostPath)) mounts.push({ hostPath, containerPath: `${crepo}/${sub}`, readonly: true });
  }

  // groups/ is RO with this agent's OWN group nested back RW, so it has the scope
  // every other agent already had rather than write access to all nine agents'
  // SOUL.md, CLAUDE.local.md and memory. Order matters: the RO parent must be
  // pushed before the RW child, or docker shadows the child and the agent's own
  // directory silently becomes read-only.
  const groupsDir = path.join(repoDir, 'groups');
  if (fs.existsSync(groupsDir)) {
    mounts.push({ hostPath: groupsDir, containerPath: `${crepo}/groups`, readonly: true });
    const ownGroupDir = path.join(groupsDir, groupFolder);
    if (fs.existsSync(ownGroupDir)) {
      mounts.push({ hostPath: ownGroupDir, containerPath: `${crepo}/groups/${groupFolder}`, readonly: false });
    }
  }
  return mounts;
}

/**
 * Every read-only mount a container could escape by renaming its parent.
 *
 * A RO mount is safe when its parent directory is itself a mountpoint (renaming
 * a mountpoint fails EBUSY) or when no writable mount contains it at all (its
 * parent lives in the image, not in agent-writable space). It is escapable when a
 * writable mount contains it but its immediate parent is not a mount — exactly
 * the shape shipped on 2026-08-22 before a fixture test caught it.
 *
 * Pass the WHOLE mount list. Handed a partial one this returns [] for mounts
 * whose writable ancestor was left out, which is how the first version of the
 * test guarding this was itself toothless.
 */
export function escapableRoMounts(mounts: VolumeMount[]): VolumeMount[] {
  const paths = new Set(mounts.map((m) => m.containerPath));
  const isProperAncestor = (a: string, b: string) => b.startsWith(a.endsWith('/') ? a : a + '/');
  return mounts.filter((m) => {
    if (!m.readonly) return false;
    if (paths.has(posixDirname(m.containerPath))) return false; // parent is a mountpoint -> EBUSY
    return mounts.some(
      (o) => !o.readonly && o.containerPath !== m.containerPath && isProperAncestor(o.containerPath, m.containerPath),
    );
  });
}

/** Container paths are always POSIX, whatever host runs the tests. */
function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

// Host-side privileged code, nested RO on top of the RW group mount.
//
// The Orchestrator's group dir is the only one that is a real directory rather
// than a symlink into `agent-system/groups/<group>`, so its RW mount exposes
// the *whole* agent-system repo. Two subtrees in there run on the host with
// privileges the container is not supposed to have: `tools/` (the cron
// watchdog — health-monitor, daily-reset, drift-watch — plus the dashboard and
// otel-collector services) and `tool-proxy/` (the daemon that loads every
// secret and enforces the confirm-token gate; `~/tool-proxy` is a symlink to
// it, same inode). An agent could edit either: the first to disable the only
// thing that would report an outage it caused, the second to reach the
// secrets. health-monitor's own header claimed it lived outside the mounted
// tree; it did not. Guarded on existence rather than a group name because no
// other group has `agent-system/` inside its mount. Nothing writes into
// either directory from inside a container — host-side tool execution goes
// through the proxy, not this mount — so RO costs no runtime capability.
// Pinned as group-state to this agent group, as the group mount itself is.
registerSpawnMounts('ro-host-code', ({ agentGroup, groupDir }) =>
  privilegedRepoMounts(groupDir, agentGroup.folder).map((m) => ({
    ...m,
    mountClass: 'group-state' as const,
    scope: agentGroup.id,
  })),
);
