import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./watchdog-alive.cjs', import.meta.url));

/**
 * watchdog-alive had no test when it shipped, and the first real edit after it
 * shipped exposed why: a changed file was modelled as a *condition* that could
 * recover, so one intentional tool edit produced an alert and then a meaningless
 * green "clear" on the next tick. Three Slack messages for one deliberate
 * change is how an alert channel becomes one nobody reads.
 *
 * WA_NO_POST=1 throughout. A token exists on the host that runs this suite, so
 * without it these tests would post to the real #agent-admin.
 */
const WATCHED = [
  'tools/health-monitor.cjs',
  'tools/daily-reset.js',
  'tools/nanoclaw-upstream-check.js',
  'tools/drift/drift-watch.js',
  'tools/maint/backup-gc.js',
  'tools/memory/memory-watch.js',
  'tools/dashboard/server.js',
  'tools/otel/collector.js',
  'tool-proxy/daemon.js',
  'tool-proxy/tool-exec.js',
];

let dir: string, repo: string, state: string, hmState: string;

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });

function run(extra: Record<string, string> = {}, args: string[] = []): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WA_NO_POST: '1', WA_REPO: repo, WA_STATE: state, WA_HM_STATE: hmState, ...extra },
  });
}

/** A health-monitor state file whose last run was `minAgo` minutes ago. */
function writeHmState(minAgo: number) {
  fs.writeFileSync(hmState, JSON.stringify({ lastRun: new Date(Date.now() - minAgo * 60_000).toISOString() }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  repo = path.join(dir, 'repo');
  state = path.join(dir, 'state.json');
  hmState = path.join(dir, 'hm.json');
  for (const rel of WATCHED) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), `original ${rel}\n`);
  }
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  writeHmState(1);
  run({}, ['--seed']);
});

describe('dead-man switch (conditions)', () => {
  it('is quiet while health-monitor is running', () => {
    expect(run()).toContain('alert=no');
  });

  it('alerts when lastRun goes stale', () => {
    writeHmState(90);
    const out = run();
    expect(out).toContain('conditions=[hm-stale]');
    expect(out).toContain('alert=new');
    expect(out).toContain('alert suppressed: WA_NO_POST'); // proves it did not post
  });

  it('alerts when the state file cannot be read at all', () => {
    fs.rmSync(hmState);
    expect(run()).toContain('conditions=[hm-state-unreadable]');
  });

  it('posts a green notice once the condition clears, because conditions recover', () => {
    writeHmState(90);
    expect(run()).toContain('alert=new');
    writeHmState(1);
    expect(run()).toContain('alert=recovery');
  });
});

describe('fingerprints (events)', () => {
  it('reports an uncommitted edit as a working-tree edit, not a deploy', () => {
    fs.appendFileSync(path.join(repo, 'tool-proxy/daemon.js'), 'exfiltrate\n');
    const out = run({}, ['--dry-run']);
    expect(out).toContain('events=[changed:tool-proxy/daemon.js');
    expect(out).toContain('Uncommitted');
  });

  it('reports a committed change as a deploy and names the commit', () => {
    fs.appendFileSync(path.join(repo, 'tools/health-monitor.cjs'), 'legit\n');
    git('add', '-A');
    git('commit', '-qm', 'legit fix');
    const out = run({}, ['--dry-run']);
    expect(out).toContain('Committed');
    expect(out).not.toContain('Uncommitted');
  });

  it('reports a watched file that has disappeared', () => {
    fs.rmSync(path.join(repo, 'tools/drift/drift-watch.js'));
    expect(run({}, ['--dry-run'])).toContain('events=[gone:tools/drift/drift-watch.js]');
  });

  // The regression that motivated the split. An event is over the moment it is
  // reported, because reporting it advances the baseline — so it must not linger
  // as a condition and must not produce a recovery on the following tick.
  it('alerts ONCE for a file change, then goes silent', () => {
    fs.appendFileSync(path.join(repo, 'tools/health-monitor.cjs'), 'edit\n');
    expect(run()).toContain('alert=new');
    const second = run();
    expect(second).toContain('alert=no');
    expect(second).not.toContain('recovery');
  });

  it('never lets an event trigger a recovery notice', () => {
    fs.appendFileSync(path.join(repo, 'tools/health-monitor.cjs'), 'edit\n');
    run();
    const second = run();
    expect(second).toContain('conditions=[] events=[]');
    // Without the assertion below this test is vacuous: with events folded back
    // into conditions the buckets still read empty on the second tick, so only
    // the alert kind distinguishes correct behaviour from the bug.
    expect(second).toContain('alert=no');
    expect(second).not.toContain('alert=recovery');
  });

  it('keeps events and conditions in separate buckets when both fire', () => {
    writeHmState(90);
    fs.appendFileSync(path.join(repo, 'tools/daily-reset.js'), 'edit\n');
    const out = run({}, ['--dry-run']);
    expect(out).toContain('conditions=[hm-stale]');
    expect(out).toContain('events=[changed:tools/daily-reset.js');
  });
});
