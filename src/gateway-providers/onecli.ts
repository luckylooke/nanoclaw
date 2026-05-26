/**
 * OneCLI — the built-in gateway provider.
 *
 * The same wiring the spawn path always did (ensure the agent exists
 * gateway-side, fetch the per-session container config, treat "not applied" as
 * a transient hard failure), with one change: the contribution crosses into
 * the spec as TYPED env and mounts, merged before validation, instead of raw
 * docker flags appended after it.
 *
 * The SDK's apply surface still emits argv, so this provider parses it at the
 * boundary. The grammar is closed and known from the SDK source: with
 * `addHostMapping: false` it emits exactly `-e KEY=VALUE` pairs (proxy env,
 * CA bundle pointers) and `-v host:container[:ro]` mounts (the CA
 * certificate, credential stub FILES — stubs never ride env). Anything else
 * refuses the spawn: nothing gets to ride raw argv around the spec again. A
 * typed SDK config surface is the successor that deletes this parser.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import type { MountSpec } from '../drivers/types.js';
import { log } from '../log.js';

import { registerGatewayProvider, type GatewayContribution } from './gateway-provider-registry.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Argv → typed contribution. Exported for its tests; the grammar is closed. */
export function contributionFromArgs(args: readonly string[], groupScope: string): GatewayContribution {
  const env: Record<string, string> = {};
  const mounts: MountSpec[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '-e' && value?.includes('=')) {
      const eq = value.indexOf('=');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (flag === '-v' && value) {
      const parts = value.split(':');
      if (parts.length >= 2 && parts.length <= 3 && (parts[2] === undefined || parts[2] === 'ro')) {
        mounts.push({
          class: 'allowlisted-extra',
          hostPath: parts[0],
          containerPath: parts[1],
          mode: parts[2] === 'ro' ? 'ro' : 'rw',
          groupScope,
        });
        continue;
      }
    }
    // Fail-closed on grammar drift: an SDK that starts emitting a flag this
    // parser cannot type must break the spawn loudly, not smuggle argv.
    throw new Error(`OneCLI gateway emitted argv this seam cannot type: '${flag} ${value ?? ''}'`);
  }
  return { env, mounts };
}

// OneCLI agent identifier is fixed to "default" so every NanoClaw agent group
// shares one OneCLI agent and stays within the free-plan 2-agent quota.
// Trade-off: approval requests originating from any group route to global
// admins/owner instead of group-scoped admins (since externalId no longer
// reverses to a unique agent_groups row). Acceptable until the upstream
// skill/native-credential-proxy branch is rebased onto v2 — at present it is
// 1100+ commits stale and predates the v2 rewrite.
//
// Carried here on the v2.3.0 rebase. Upstream keys the OneCLI agent on
// key.agentGroupId, and a951e74b moved that decision out of container-runner.ts
// into this provider — which is why the rebase conflicted on that file and not
// on this one. Only the agent *identity* is shared: the log field below keeps the
// real group id so spawns stay traceable, and `groupScope` keeps it because it
// scopes allowlisted-extra mounts — collapsing that to one value would put every
// group's extra mounts in a single mount-security scope.
const ONECLI_SHARED_AGENT = 'default';

registerGatewayProvider('onecli', () => ({
  kind: 'onecli',
  async contribute({ key, groupName }) {
    // `name` is still per-group, so the shared agent carries the name of whichever
    // group spawned last. That is pre-existing fork behaviour, not new here: the
    // old call site passed `name: agentGroup.name` with the same fixed identifier.
    await onecli.ensureAgent({ name: groupName, identifier: ONECLI_SHARED_AGENT });
    const args: string[] = [];
    const applied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: ONECLI_SHARED_AGENT });
    if (!applied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
    return contributionFromArgs(args, key.agentGroupId);
  },
}));
