/**
 * scripts/upgrade-state.ts — read or stamp the upgrade marker.
 *
 * Usage:
 *   pnpm exec tsx scripts/upgrade-state.ts get
 *   pnpm exec tsx scripts/upgrade-state.ts set [version] [via]
 *   pnpm exec tsx scripts/upgrade-state.ts check   # exit 1 if the tripwire is armed
 *
 * `set` with no version stamps the current package.json version. The
 * sanctioned upgrade paths (setup / update / migrate) call `set` on
 * success; running it by hand is also the documented way to clear the
 * startup tripwire — see docs/upgrade-recovery.md.
 */
import {
  getCodeIdentity,
  getCodeVersion,
  isUpgradeCurrent,
  markerPath,
  readUpgradeState,
  writeUpgradeState,
} from '../src/upgrade-state.js';

const [, , cmd, versionArg, viaArg] = process.argv;

if (cmd === 'get') {
  const state = readUpgradeState();
  console.log(state ? JSON.stringify(state) : 'none');
} else if (cmd === 'check') {
  // Ask the startup gate's own question, now, instead of finding out at the
  // next restart. `set` is documented as the last step of a deploy — "after
  // validation and required migrations succeed, immediately before the
  // health-gated restart" — and nothing verified it had actually happened. A
  // commit landing after the stamp arms a boot-stop that the running process
  // cannot see, so the mistake and its symptom can be weeks apart; on
  // 2026-08-29 they were 15 hours apart and cost a 2.5-hour fleet outage.
  const state = readUpgradeState();
  const code = getCodeIdentity();
  if (isUpgradeCurrent()) {
    console.log(`upgrade marker OK — ${code.version} @ ${code.commit.slice(0, 8)}`);
  } else {
    console.error(
      [
        'upgrade tripwire ARMED — nanoclaw will refuse to start on its next restart.',
        `  code:     ${code.version} @ ${code.commit.slice(0, 8)} tree ${code.tree.slice(0, 8)}`,
        `  recorded: ${state ? `${state.version} @ ${state.commit.slice(0, 8)} tree ${state.tree.slice(0, 8)}` : 'none'}`,
        '',
        'If this checkout is validated and deployed, stamp it:',
        '  pnpm exec tsx scripts/upgrade-state.ts set',
        'Details: docs/upgrade-recovery.md',
      ].join('\n'),
    );
    process.exit(1);
  }
} else if (cmd === 'set') {
  const state = writeUpgradeState({ version: versionArg || getCodeVersion(), via: viaArg || 'manual' });
  console.log(`Stamped ${markerPath()}: ${JSON.stringify(state)}`);
} else {
  console.error('Usage: pnpm exec tsx scripts/upgrade-state.ts get | check | set [version] [via]');
  process.exit(2);
}
