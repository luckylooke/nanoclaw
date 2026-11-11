/**
 * SEC-AI2: this group's tool-proxy socket, and no other group's (feature
 * `tool-proxy-socket`), on the spawn-mounts seam.
 *
 * Reaching the socket is what authenticates the caller, so the group is proven
 * by the mount rather than claimed in the request body — which is what it was
 * before, only shape-validated, while AGENT_GROUP is passed into every tool and
 * scopes `memory` audiences. Mount the DIRECTORY, not the socket file: a
 * front-end restart recreates the socket with a new inode, and a file-level bind
 * mount would keep pointing at the deleted one. Read-write because a client must
 * be able to connect(); the socket grants nothing beyond the tool-proxy API.
 */
import fs from 'fs';
import path from 'path';

import { CONTAINER_TOOL_PROXY_SOCK_DIR } from '../container-config.js';
import type { VolumeMount } from '../providers/provider-container-registry.js';
import { registerSpawnMounts, type SpawnMountContext } from './seams.js';

export function toolProxySocketMounts(ctx: SpawnMountContext, home = process.env.HOME): VolumeMount[] {
  if (!home) return [];
  const dir = path.join(home, 'tool-proxy-sockets', ctx.agentGroup.folder);
  if (!fs.existsSync(dir)) return [];
  return [{ hostPath: dir, containerPath: CONTAINER_TOOL_PROXY_SOCK_DIR, readonly: false }];
}

registerSpawnMounts('tool-proxy-socket', (ctx) => toolProxySocketMounts(ctx));
