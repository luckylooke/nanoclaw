/**
 * review-gate.ts — the deterministic "done means done" gate (spec/review-board.md
 * §3.4, build step F).
 *
 * WHAT IT DOES: watches one turn through PostToolUse — which files were edited,
 * which shell commands ran — and, when the agent tries to stop after editing code
 * in a dev workspace without having run its checks and the review board since the
 * last edit, blocks the stop ONCE with a reason that says exactly what is missing.
 * The SDK sets `stop_hook_active` on the retry, and the gate always lets that
 * through: one nudge per stop, never a loop.
 *
 * WHAT IT DOES NOT DO: call a model, read the diff, judge quality, or guess intent
 * from the agent's prose. Both reference repos keep Stop hooks mechanical (ECC's
 * delivery-gate: "regex heuristics are too weak to block on"), and so does this.
 *
 * SCOPE: only edits under `<agentDir>/<something>-workspace/` count — that is where
 * dev-web and dev-game keep their repos. Memory, diary, identity and doc edits
 * never trip it. Nothing per-group to configure.
 */

import fs from 'fs';
import path from 'path';

export type GateOptions = {
  /** The group folder as mounted in the container (verdict files live in <agentDir>/review). Default: /workspace/agent. */
  agentDir?: string;
  /**
   * Every path the agent may use for the same group folder. The group mounts at
   * /workspace/agent but the identity files and the agents' own commands use
   * /workspace/group (the image's WORKDIR). Default: both.
   */
  roots?: string[];
  /** Injected clock for tests. */
  now?: () => number;
};

export type GateState = {
  editedCodeFiles: Map<string, number>;
  lastCodeEditAt: number | null;
  lastChecksAt: number | null;
  lastReviewAt: number | null;
  lastReviewDry: boolean;
};

export type StopDecision =
  | { decision: 'allow'; why: string }
  | { decision: 'block'; reason: string };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WORKSPACE_SEGMENT = /(^|\/)[a-z0-9_-]+-workspace\//i;
// The repos' own checks, as the identity files tell the agent to run them.
const CHECK_COMMAND =
  /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|build|verify|check)[\w:-]*|verify\/verify\.js|verify\.js\b|node\s+--test\b|vitest\b|tsc\s+--noEmit/;
const REVIEW_RUN = /tool-exec\.js\s+review\s+run\b/;

export function isCodeEditPath(filePath: string, agentDir: string, roots: string[] = [agentDir, '/workspace/group']): boolean {
  if (!filePath) return false;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(agentDir, filePath);
  let rel: string | null = null;
  for (const root of roots) {
    const r = path.relative(root, abs);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) { rel = r; break; }
  }
  if (rel == null) return false;
  if (!WORKSPACE_SEGMENT.test(rel)) return false;
  if (/(^|\/)(node_modules|dist|\.nuxt|\.output|review)\//.test(rel)) return false;
  if (/\.(md|mdx|txt|log|jsonl)$/i.test(rel)) return false;
  return true;
}

export function classifyCommand(command: string): { checks: boolean; review: boolean; dry: boolean } {
  const c = String(command || '');
  const review = REVIEW_RUN.test(c);
  return { checks: CHECK_COMMAND.test(c), review, dry: review && /--dry\b/.test(c) };
}

/** Newest verdict file in <agentDir>/review, or null. Tolerates a missing dir and bad JSON. */
export function latestVerdict(agentDir: string): { verdict: string; round: number; rounds_cap: number; ts: number } | null {
  const dir = path.join(agentDir, 'review');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (let i = names.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, names[i]), 'utf8')) as Record<string, unknown>;
      const ts = Date.parse(String(j.ts ?? ''));
      if (typeof j.verdict !== 'string' || Number.isNaN(ts)) continue;
      return { verdict: j.verdict, round: Number(j.round ?? 1), rounds_cap: Number(j.rounds_cap ?? 2), ts };
    } catch {
      /* skip a half-written or foreign file */
    }
  }
  return null;
}

export function createReviewGate(opts: GateOptions = {}) {
  const agentDir = opts.agentDir ?? '/workspace/agent';
  const roots = opts.roots ?? [agentDir, '/workspace/group'];
  const now = opts.now ?? Date.now;
  const state: GateState = { editedCodeFiles: new Map(), lastCodeEditAt: null, lastChecksAt: null, lastReviewAt: null, lastReviewDry: false };

  function observeToolUse(toolName: string, toolInput: Record<string, unknown> | undefined): void {
    const t = now();
    if (EDIT_TOOLS.has(toolName)) {
      const fp = typeof toolInput?.file_path === 'string' ? toolInput.file_path : typeof toolInput?.notebook_path === 'string' ? toolInput.notebook_path : '';
      if (isCodeEditPath(fp, agentDir, roots)) {
        state.editedCodeFiles.set(fp, t);
        state.lastCodeEditAt = t;
      }
      return;
    }
    if (toolName === 'Bash') {
      const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
      const k = classifyCommand(cmd);
      if (k.checks) state.lastChecksAt = t;
      if (k.review && !k.dry) {
        state.lastReviewAt = t;
        state.lastReviewDry = false;
      }
    }
  }

  /**
   * The decision. Pure over `state` + the verdict directory. `stopHookActive`
   * is the SDK's loop guard: when set, this gate has already spoken once.
   */
  function decideStop(stopHookActive: boolean): StopDecision {
    if (stopHookActive) return { decision: 'allow', why: 'stop_hook_active — the gate already blocked once this stop' };
    if (state.lastCodeEditAt == null) return { decision: 'allow', why: 'no code edited in a workspace this turn' };
    const missing: string[] = [];
    if (state.lastChecksAt == null || state.lastChecksAt < state.lastCodeEditAt) {
      missing.push("the repo's own checks (pnpm test / lint / typecheck / build, as your identity file lists them) have not run since your last edit");
    }
    if (state.lastReviewAt == null || state.lastReviewAt < state.lastCodeEditAt) {
      missing.push('the review board has not run since your last edit: `node /workspace/extra/tool-exec.js review run --repo <repo> --task-text "<what was asked>"`');
    } else {
      const v = latestVerdict(agentDir);
      if (v && v.verdict !== 'APPROVE' && v.round < v.rounds_cap && v.ts >= (state.lastReviewAt - 5 * 60_000)) {
        missing.push(`the last review verdict is ${v.verdict} at round ${v.round} of ${v.rounds_cap}: fix what a responsible maintainer would not ignore and run the board again — or, if you are stopping to ask Ctibor about it, say so explicitly with the blocking list`);
      }
    }
    if (missing.length === 0) return { decision: 'allow', why: 'checks and review ran after the last edit' };
    const files = [...state.editedCodeFiles.keys()].slice(0, 6).map((f) => {
      const abs = path.isAbsolute(f) ? f : path.join(agentDir, f);
      const root = roots.find((r) => !path.relative(r, abs).startsWith('..')) ?? agentDir;
      return path.relative(root, abs);
    });
    return {
      decision: 'block',
      reason:
        `Not done yet — you edited ${state.editedCodeFiles.size} workspace file(s) this turn (${files.join(', ')}${state.editedCodeFiles.size > 6 ? ', …' : ''}) and:\n- ` +
        missing.join('\n- ') +
        '\n\nDo those now and report what they actually returned. If you are deliberately stopping short (blocked, waiting on Ctibor, out of scope), say that plainly in your reply instead of reporting done.',
    };
  }

  return {
    state,
    observeToolUse,
    decideStop,
    /** SDK PostToolUse callback shape. */
    postToolUse: async (input: unknown) => {
      const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
      try {
        observeToolUse(i.tool_name ?? '', i.tool_input);
      } catch {
        /* a gate must never break the tool call it observes */
      }
      return { continue: true };
    },
    /** SDK Stop callback shape: block once with a reason, otherwise let the stop through. */
    stop: async (input: unknown) => {
      const i = input as { stop_hook_active?: boolean };
      let d: StopDecision;
      try {
        d = decideStop(Boolean(i.stop_hook_active));
      } catch (err) {
        d = { decision: 'allow', why: `gate error, failing open: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (d.decision === 'block') return { decision: 'block' as const, reason: d.reason };
      return { continue: true };
    },
  };
}
