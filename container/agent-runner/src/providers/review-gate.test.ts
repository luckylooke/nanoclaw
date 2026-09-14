import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { classifyCommand, createReviewGate, isCodeEditPath, latestVerdict } from './review-gate.js';

let agentDir: string;
let clock: number;
const tick = () => ++clock;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-'));
  clock = 1000;
});
afterEach(() => fs.rmSync(agentDir, { recursive: true, force: true }));

function gate() {
  return createReviewGate({ agentDir, now: tick });
}
const edit = (g: ReturnType<typeof gate>, rel: string) => g.observeToolUse('Edit', { file_path: path.join(agentDir, rel) });
const bash = (g: ReturnType<typeof gate>, command: string) => g.observeToolUse('Bash', { command });
const writeVerdict = (verdict: string, round: number, ts = new Date().toISOString()) => {
  fs.mkdirSync(path.join(agentDir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'review', `${ts.replace(/[:.]/g, '-')}-abc.json`), JSON.stringify({ ts, verdict, round, rounds_cap: 2 }));
};

describe('what counts as a code edit', () => {
  it('only files under a *-workspace/ dir, not memory, diary, docs, dist or the review dir', () => {
    expect(isCodeEditPath(path.join(agentDir, 'web-workspace/framework/app/a.ts'), agentDir)).toBe(true);
    expect(isCodeEditPath(path.join(agentDir, 'game-workspace/projects/bomberman/src/x.ts'), agentDir)).toBe(true);
    expect(isCodeEditPath('web-workspace/framework/app/a.vue', agentDir)).toBe(true); // relative
    expect(isCodeEditPath(path.join(agentDir, 'web-workspace/framework/README.md'), agentDir)).toBe(false);
    expect(isCodeEditPath(path.join(agentDir, 'memory/ops/dev-urls.md'), agentDir)).toBe(false);
    expect(isCodeEditPath(path.join(agentDir, 'CLAUDE.local.md'), agentDir)).toBe(false);
    expect(isCodeEditPath(path.join(agentDir, 'web-workspace/framework/dist/index.js'), agentDir)).toBe(false);
    expect(isCodeEditPath(path.join(agentDir, 'review/x.json'), agentDir)).toBe(false);
    expect(isCodeEditPath('/etc/passwd', agentDir)).toBe(false);
    // the agents address the same folder as /workspace/group (the image WORKDIR)
    expect(isCodeEditPath('/workspace/group/web-workspace/framework/app/a.ts', agentDir)).toBe(true);
    expect(isCodeEditPath('/workspace/group/memory/index.md', agentDir)).toBe(false);
    expect(isCodeEditPath('', agentDir)).toBe(false);
  });
});

describe('what counts as checks and as a review run', () => {
  it('recognises the repo checks the identity files name, and a non-dry review run', () => {
    expect(classifyCommand('cd web-workspace && pnpm build && pnpm lint:tokens').checks).toBe(true);
    expect(classifyCommand('pnpm test').checks).toBe(true);
    expect(classifyCommand('node ~/agent-system/tools/verify/verify.js --full').checks).toBe(true);
    expect(classifyCommand('git status').checks).toBe(false);
    expect(classifyCommand('node /workspace/extra/tool-exec.js review run --repo web-workspace/framework')).toEqual({ checks: false, review: true, dry: false });
    expect(classifyCommand('node /workspace/extra/tool-exec.js review run --repo web-workspace/framework --dry').dry).toBe(true);
    expect(classifyCommand('node /workspace/extra/tool-exec.js review show last').review).toBe(false);
  });
});

describe('the stop decision', () => {
  it('allows a turn with no code edits (chat, memory, docs)', () => {
    const g = gate();
    g.observeToolUse('Edit', { file_path: path.join(agentDir, 'memory/index.md') });
    bash(g, 'ls');
    expect(g.decideStop(false).decision).toBe('allow');
  });

  it('blocks once when code was edited and neither checks nor review ran, naming both', () => {
    const g = gate();
    g.observeToolUse('Write', { file_path: '/workspace/group/web-workspace/framework/app/b.ts' });
    edit(g, 'web-workspace/framework/app/a.ts');
    const d = g.decideStop(false);
    expect(d.decision).toBe('block');
    if (d.decision === 'block') {
      expect(d.reason).toContain('web-workspace/framework/app/a.ts');
      expect(d.reason).toContain('web-workspace/framework/app/b.ts');
      expect(d.reason).toContain('edited 2 workspace file(s)');
      expect(d.reason).toContain("repo's own checks");
      expect(d.reason).toContain('review run');
    }
    // the SDK retry carries stop_hook_active → never block twice
    expect(g.decideStop(true).decision).toBe('allow');
  });

  it('checks and review must come AFTER the last edit', () => {
    const g = gate();
    bash(g, 'pnpm test');
    bash(g, 'node /workspace/extra/tool-exec.js review run --repo web-workspace/framework');
    edit(g, 'web-workspace/framework/app/a.ts');
    const d = g.decideStop(false);
    expect(d.decision).toBe('block');
    if (d.decision === 'block') {
      expect(d.reason).toContain("repo's own checks");
      expect(d.reason).toContain('review run');
    }
  });

  it('a dry run is not a review', () => {
    const g = gate();
    edit(g, 'web-workspace/framework/app/a.ts');
    bash(g, 'pnpm test');
    bash(g, 'node /workspace/extra/tool-exec.js review run --repo web-workspace/framework --dry');
    const d = g.decideStop(false);
    expect(d.decision).toBe('block');
    if (d.decision === 'block') {
      expect(d.reason).not.toContain("repo's own checks");
      expect(d.reason).toContain('review run');
    }
  });

  it('allows when checks and a real review ran after the last edit and the verdict is APPROVE', () => {
    const g = gate();
    edit(g, 'web-workspace/framework/app/a.ts');
    bash(g, 'pnpm build && pnpm lint:tokens');
    writeVerdict('APPROVE', 1);
    bash(g, 'node /workspace/extra/tool-exec.js review run --repo web-workspace/framework');
    expect(g.decideStop(false)).toEqual({ decision: 'allow', why: 'checks and review ran after the last edit' });
  });

  it('a CHANGES_REQUESTED verdict below the round cap blocks with the fix-or-say-so nudge', () => {
    const g = gate();
    edit(g, 'web-workspace/framework/app/a.ts');
    bash(g, 'pnpm test');
    writeVerdict('CHANGES_REQUESTED', 1);
    bash(g, 'node /workspace/extra/tool-exec.js review run --repo web-workspace/framework');
    const d = g.decideStop(false);
    expect(d.decision).toBe('block');
    if (d.decision === 'block') expect(d.reason).toContain('CHANGES_REQUESTED at round 1 of 2');
  });

  it('a CHANGES_REQUESTED verdict AT the round cap lets the agent stop — it is supposed to report to Ctibor', () => {
    const g = gate();
    edit(g, 'web-workspace/framework/app/a.ts');
    bash(g, 'pnpm test');
    writeVerdict('CHANGES_REQUESTED', 2);
    bash(g, 'node /workspace/extra/tool-exec.js review run --repo web-workspace/framework');
    expect(g.decideStop(false).decision).toBe('allow');
  });

  it('latestVerdict tolerates a missing dir, garbage and foreign files, and picks the newest valid one', () => {
    expect(latestVerdict(agentDir)).toBeNull();
    fs.mkdirSync(path.join(agentDir, 'review'));
    fs.writeFileSync(path.join(agentDir, 'review', '0-old.json'), JSON.stringify({ ts: '2026-01-01T00:00:00Z', verdict: 'APPROVE', round: 1, rounds_cap: 2 }));
    fs.writeFileSync(path.join(agentDir, 'review', '1-mid.json'), JSON.stringify({ ts: '2026-02-01T00:00:00Z', verdict: 'CHANGES_REQUESTED', round: 1, rounds_cap: 2 }));
    fs.writeFileSync(path.join(agentDir, 'review', '2-bad.json'), '{ not json');
    fs.writeFileSync(path.join(agentDir, 'review', '3-foreign.json'), JSON.stringify({ hello: 'world' }));
    expect(latestVerdict(agentDir)?.verdict).toBe('CHANGES_REQUESTED');
  });
});

describe('SDK callback shapes', () => {
  it('postToolUse never throws and always continues; stop returns block+reason or continue', async () => {
    const g = gate();
    expect(await g.postToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(agentDir, 'web-workspace/x/a.ts') } })).toEqual({ continue: true });
    expect(await g.postToolUse(null)).toEqual({ continue: true });
    const blocked = (await g.stop({ hook_event_name: 'Stop', stop_hook_active: false })) as { decision?: string; reason?: string };
    expect(blocked.decision).toBe('block');
    expect(typeof blocked.reason).toBe('string');
    expect(await g.stop({ hook_event_name: 'Stop', stop_hook_active: true })).toEqual({ continue: true });
  });
});
