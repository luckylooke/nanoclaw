import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * health-monitor's alerting, driven against the outage it failed to report.
 *
 * On 2026-08-29 the nanoclaw host crash-looped from 08:52 to 11:23 UTC — 2.5
 * hours of total fleet outage — and #agent-admin received exactly ONE message,
 * at 09:00. Two independent defects produced that silence, and this file pins
 * both by replaying the real timeline through the real decision functions.
 *
 * (1) `no-unexpected-restart` compared NRestarts to the previous tick. That is
 *     a derivative, and src/circuit-breaker.ts paces a crash loop to one
 *     restart per ~15 min, so a 5-minute sampler sees fail/pass/pass/fail and
 *     the 2026-08-21 two-tick debounce cancels it exactly. The real log shows
 *     nine `pending=[no-unexpected-restart]` ticks, 15 min apart, none promoted.
 * (2) The re-nag was a flat 6h for every severity, so a critical that stayed
 *     critical for 2.5h said nothing after its first notice.
 *
 * The `delta` rule below is the pre-fix code, kept deliberately so the fix is
 * measured against it rather than merely asserted — the 2026-08-22 rule that a
 * check must be shown to fail before its passing means anything.
 */

const HM =
  process.env.HM_SCRIPT ||
  path.join(os.homedir(), 'nanoclaw/groups/dm-with-ignac/agent-system/tools/health-monitor.cjs');
const present = fs.existsSync(HM);
const req = createRequire(import.meta.url);

interface Verdict {
  log: string[];
  count: number;
  ok: boolean;
  baseline: boolean;
}
interface Result {
  name: string;
  ok: boolean;
  severity: string;
  detail?: string;
}
interface Decision {
  failNames: string[];
  pendingNames: string[];
  status: string;
  alertKind: string | null;
  escalate: boolean;
}
interface Helpers {
  restartWindowVerdict: (
    prevLog: string[] | null,
    prevN: number | null,
    n: number,
    nowMs: number,
    windowMin: number,
    loopMax: number,
  ) => Verdict;
  decideAlert: (
    results: Result[],
    prev: Record<string, unknown>,
    nowMs: number,
    reAlertHours: number,
    reAlertCriticalMin: number,
  ) => Decision;
}
const hm: Helpers = present ? (req(HM) as Helpers) : ({} as Helpers);

// Must track the constants at the top of health-monitor.cjs.
const WINDOW_MIN = 60;
const LOOP_MAX = 2;
const RE_ALERT_H = 6;
const RE_ALERT_CRIT_MIN = 30;
const TICK_MS = 5 * 60_000;

/**
 * Every restart systemd logged during the outage, from
 * `journalctl --user -u nanoclaw-v2-a0754bae.service`. The first five are the
 * post-reboot burst; from 09:01 the circuit breaker paces them to 15 minutes,
 * which is the interval that made the old rule blind.
 */
const REAL_RESTARTS = [
  '2026-08-29T08:53:02Z', '2026-08-29T08:53:08Z', '2026-08-29T08:53:24Z',
  '2026-08-29T08:54:00Z', '2026-08-29T08:56:06Z', '2026-08-29T09:01:06Z',
  '2026-08-29T09:16:12Z', '2026-08-29T09:31:18Z', '2026-08-29T09:46:24Z',
  '2026-08-29T10:01:30Z', '2026-08-29T10:16:37Z', '2026-08-29T10:31:42Z',
  '2026-08-29T10:46:48Z', '2026-08-29T11:01:54Z',
];

interface Post {
  at: string;
  kind: string;
  names: string[];
  escalate: boolean;
}

/**
 * Tick the monitor every 5 minutes across a window, threading the state file
 * exactly as health-monitor.cjs does, and return the Slack posts it would make.
 */
function replay(opts: {
  restarts: string[];
  from: string;
  to: string;
  rule?: 'window' | 'delta';
  reAlertCriticalMin?: number;
  /** Extra checks present on every tick — e.g. the co-failing critical port. */
  also?: (tMs: number) => Result[];
}): Post[] {
  const rule = opts.rule ?? 'window';
  const critMin = opts.reAlertCriticalMin ?? RE_ALERT_CRIT_MIN;
  const restarts = opts.restarts.map((r) => Date.parse(r)).sort((a, b) => a - b);
  let state: Record<string, unknown> = {
    failing: [] as string[],
    pendingFailing: [] as string[],
    lastAlertAt: null,
    since: null,
    nrestarts: null,
    restartLog: [] as string[],
    escalated: false,
  };
  const posts: Post[] = [];

  for (let t = Date.parse(opts.from); t <= Date.parse(opts.to); t += TICK_MS) {
    const n = restarts.filter((r) => r <= t).length;
    const prevN = state.nrestarts as number | null;
    let restartOk: boolean;
    let log = state.restartLog as string[];

    if (rule === 'window') {
      const v = hm.restartWindowVerdict(log, prevN, n, t, WINDOW_MIN, LOOP_MAX);
      restartOk = v.baseline ? true : v.ok;
      log = v.log;
    } else {
      // The pre-fix rule, verbatim: ok when the delta since the last tick is <= 0.
      restartOk = prevN == null ? true : n - prevN <= 0;
    }

    const results: Result[] = [
      { name: 'no-unexpected-restart', ok: restartOk, severity: 'critical' },
      ...(opts.also ? opts.also(t) : []),
    ];
    const d = hm.decideAlert(results, state, t, RE_ALERT_H, critMin);
    if (d.alertKind) {
      posts.push({ at: new Date(t).toISOString(), kind: d.alertKind, names: d.failNames, escalate: !!d.escalate });
    }

    state = {
      nrestarts: n,
      restartLog: log,
      failing: d.failNames,
      pendingFailing: d.pendingNames,
      since: d.failNames.length ? (state.since as string) || new Date(t).toISOString() : null,
      lastAlertAt: d.alertKind ? new Date(t).toISOString() : (state.lastAlertAt as string | null),
      escalated: d.alertKind === 'recovery' ? false : state.escalated === true || !!d.escalate,
    };
  }
  return posts;
}

/** hh:mm of each post, for readable assertions. */
const at = (posts: Post[]) => posts.map((p) => p.at.slice(11, 16));

/**
 * credproxy-port-3002 is served by the nanoclaw process itself, so it failed on
 * every tick of the outage — as health-monitor.log confirms. Including it is
 * what makes the replay faithful: it is why the old monitor posted no recovery
 * either, and why the 6h re-nag was the only remaining route to a second word.
 */
const outageCoFailure = (tMs: number): Result[] => {
  const down = tMs >= Date.parse('2026-08-29T08:53:00Z') && tMs < Date.parse('2026-08-29T11:23:00Z');
  return [{ name: 'credproxy-port-3002', ok: !down, severity: 'critical' }];
};

describe.skipIf(!present)('health-monitor alerting — the 2026-08-29 crash loop', () => {
  it('the OLD rule reproduces the incident: one message for a 2.5-hour outage', () => {
    const posts = replay({
      restarts: REAL_RESTARTS,
      from: '2026-08-29T08:50:00Z',
      to: '2026-08-29T11:25:00Z',
      rule: 'delta',
      reAlertCriticalMin: 360, // the old flat RE_ALERT_HOURS = 6
      also: outageCoFailure,
    });
    // What #agent-admin actually received: one notice at 09:00, then the green
    // once it was over. Nothing at all in between, while every tick in that gap
    // recorded status=critical.
    expect(posts.map((p) => p.kind)).toEqual(['new', 'recovery']);
    expect(at(posts)[0]).toBe('09:00');
    const silenceMin = (Date.parse(posts[1].at) - Date.parse(posts[0].at)) / 60_000;
    expect(silenceMin).toBeGreaterThan(140);
  });

  it('the old restart check goes blind the moment the breaker paces the loop', () => {
    // No co-failure, so the restart check is the only voice. After the initial
    // burst it never manages two consecutive failing ticks again.
    const posts = replay({
      restarts: REAL_RESTARTS,
      from: '2026-08-29T08:50:00Z',
      to: '2026-08-29T11:25:00Z',
      rule: 'delta',
      reAlertCriticalMin: 360,
    });
    const afterBurst = posts.filter((p) => p.at >= '2026-08-29T09:15:00Z' && p.kind !== 'recovery');
    expect(afterBurst).toEqual([]);
  });

  it('the window rule keeps firing for as long as the loop runs', () => {
    const posts = replay({
      restarts: REAL_RESTARTS,
      from: '2026-08-29T08:50:00Z',
      to: '2026-08-29T11:25:00Z',
    });
    // First notice at the same tick as the real one — the fix does not trade
    // away detection speed — then a re-nag every 30 minutes while critical.
    expect(at(posts)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(posts[0].kind).toBe('new');
    expect(posts.slice(1).every((p) => p.kind === 'renag')).toBe(true);
    // Never more than 35 min of silence while the fleet is down.
    const gaps = posts.slice(1).map((p, i) => (Date.parse(p.at) - Date.parse(posts[i].at)) / 60000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(35);
  });

  it('every paced restart is visible to the window rule, not just the burst', () => {
    // The nine ticks the real log recorded as pending=[no-unexpected-restart]
    // and threw away. Under the window rule each is a failing level.
    for (const tick of ['09:20', '09:35', '09:50', '10:05', '10:35', '11:05', '11:20']) {
      const t = Date.parse(`2026-08-29T${tick}:00Z`);
      const restarts = REAL_RESTARTS.map((r) => Date.parse(r)).filter((r) => r <= t);
      const inWindow = restarts.filter((r) => r > t - WINDOW_MIN * 60_000).length;
      expect(inWindow).toBeGreaterThan(LOOP_MAX);
    }
  });
});

describe.skipIf(!present)('health-monitor alerting — the 2026-08-21 property survives', () => {
  it('a single restart never pages', () => {
    const posts = replay({
      restarts: ['2026-08-29T09:00:00Z'],
      from: '2026-08-29T08:30:00Z',
      to: '2026-08-29T11:00:00Z',
    });
    expect(posts).toEqual([]);
  });

  it("a deploy's two restarts inside the window never page", () => {
    const posts = replay({
      restarts: ['2026-08-29T09:00:00Z', '2026-08-29T09:10:00Z'],
      from: '2026-08-29T08:30:00Z',
      to: '2026-08-29T11:00:00Z',
    });
    expect(posts).toEqual([]);
  });

  it('but three inside the window do — the threshold is real in both directions', () => {
    const posts = replay({
      restarts: ['2026-08-29T09:00:00Z', '2026-08-29T09:10:00Z', '2026-08-29T09:20:00Z'],
      from: '2026-08-29T08:30:00Z',
      to: '2026-08-29T09:40:00Z',
    });
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0].kind).toBe('new');
  });

  it('a check failing on one tick only is still swallowed by the debounce', () => {
    const flap = (tMs: number): Result[] => [
      { name: 'credproxy-port-3002', ok: tMs !== Date.parse('2026-08-29T09:00:00Z'), severity: 'critical' },
    ];
    const posts = replay({
      restarts: [],
      from: '2026-08-29T08:30:00Z',
      to: '2026-08-29T10:00:00Z',
      also: flap,
    });
    expect(posts).toEqual([]);
  });

  it('warnings keep the 6-hour re-nag — the escalation is scoped to criticals', () => {
    const warn = (): Result[] => [{ name: 'egress-proxy-3128', ok: false, severity: 'warning' }];
    const posts = replay({
      restarts: [],
      from: '2026-08-29T08:30:00Z',
      to: '2026-08-29T13:00:00Z',
      also: warn,
    });
    // One 'new' after the debounce confirms it, and no re-nag inside 4.5 hours.
    expect(posts.map((p) => p.kind)).toEqual(['new']);
  });
});

describe.skipIf(!present)('health-monitor alerting — recovery', () => {
  it('the window decays and posts a green once the restarts stop', () => {
    const posts = replay({
      restarts: REAL_RESTARTS,
      from: '2026-08-29T08:50:00Z',
      to: '2026-08-29T13:00:00Z',
    });
    const green = posts.filter((p) => p.kind === 'recovery');
    expect(green).toHaveLength(1);
    // Last restart 11:01:54. The level falls back under the threshold as soon as
    // only two entries remain inside the 60-minute window — ~40 min after the
    // loop stops, not a full window later. Recovery is not delayed by the whole
    // window, which is the behaviour worth pinning.
    expect(green[0].at.slice(11, 16)).toBe('11:40');
  });

  it('a counter reset by a reboot is not read as a negative delta', () => {
    const v = hm.restartWindowVerdict([], 15, 0, Date.parse('2026-08-29T09:00:00Z'), WINDOW_MIN, LOOP_MAX);
    expect(v.count).toBe(0);
    expect(v.ok).toBe(true);
    const v2 = hm.restartWindowVerdict([], 15, 4, Date.parse('2026-08-29T09:00:00Z'), WINDOW_MIN, LOOP_MAX);
    expect(v2.count).toBe(4);
    expect(v2.ok).toBe(false);
  });
});

/**
 * The second half of the 2026-08-29 incident: `data/upgrade-state.json` was
 * stamped mid-deploy at b13416f4, commit c2b5641c landed after it, and nothing
 * re-stamped. enforceUpgradeTripwire() only runs at startup, so the running
 * process never noticed and the reboot 15 hours later made every start exit 1.
 *
 * The state is legitimate mid-deploy — docs/upgrade-recovery.md puts the stamp
 * "immediately before the health-gated restart" — so what separates a correct
 * deploy from a forgotten one is how long it lasts, which is what the grace
 * window measures and what a commit hook or a verify.js stage could not see.
 */
const GRACE_MIN = 15;
const CODE = { version: '2.3.0', commit: 'c2b5641c2bb3c097', tree: '7da2d6f153240e67' };
const marker = (over: Partial<typeof CODE> = {}) => ({ ...CODE, ...over });

interface MarkerVerdict {
  ok: boolean;
  current: boolean;
  grace?: boolean;
  armedMin: number;
}
const verdict = (m: unknown, armedMin: number, code = CODE): MarkerVerdict =>
  (hm as unknown as {
    upgradeMarkerVerdict: (m: unknown, c: typeof CODE, a: number, g: number) => MarkerVerdict;
  }).upgradeMarkerVerdict(m, code, armedMin, GRACE_MIN);

describe.skipIf(!present)('health-monitor — upgrade tripwire armed', () => {
  it('is quiet when the marker matches the checkout', () => {
    expect(verdict(marker(), 9999).ok).toBe(true);
    expect(verdict(marker(), 9999).current).toBe(true);
  });

  it('stays quiet mid-deploy, before the stamp that is documented to come last', () => {
    const v = verdict(marker({ commit: 'b13416f4aaaaaaaa' }), 4);
    expect(v.ok).toBe(true);
    expect(v.grace).toBe(true);
  });

  it('fires once the stamp has been forgotten past the grace window', () => {
    const v = verdict(marker({ commit: 'b13416f4aaaaaaaa' }), 16);
    expect(v.ok).toBe(false);
    expect(v.grace).toBe(false);
  });

  it('reproduces the incident: same version, one commit further on', () => {
    // b13416f4 stamped, c2b5641c landed after it, 15 hours before the reboot.
    const v = verdict(marker({ commit: 'b13416f4aaaaaaaa', tree: 'aaaaaaaaaaaaaaaa' }), 15 * 60);
    expect(v.ok).toBe(false);
  });

  it('fires when the marker is missing altogether', () => {
    expect(verdict(null, 60).ok).toBe(false);
  });

  it('fires on a tree change even when version and commit agree', () => {
    expect(verdict(marker({ tree: 'ffffffffffffffff' }), 60).ok).toBe(false);
  });

  it('is not stricter than the gate it predicts when Git cannot identify the checkout', () => {
    // isUpgradeCurrent() accepts a version match alone in that world, so a
    // check that failed here would page for a boot that is going to succeed.
    const blind = { version: '2.3.0', commit: 'unknown', tree: 'unknown' };
    expect(verdict(marker({ commit: 'whatever' }), 9999, blind).ok).toBe(true);
    // ...but a genuine version mismatch is still a real trip.
    expect(verdict(marker({ version: '2.2.0' }), 9999, blind).ok).toBe(false);
  });

  it('is a level, so the two-tick debounce promotes it instead of eating it', () => {
    // The failure mode that made the restart check useless was intermittency.
    // An armed marker stays armed, so consecutive ticks both fail and it alerts.
    const armed = marker({ commit: 'b13416f4aaaaaaaa' });
    expect(verdict(armed, 20).ok).toBe(false);
    expect(verdict(armed, 25).ok).toBe(false);
  });
});

/**
 * Escalation. The 09:00 alert on 2026-08-29 was DELIVERED — health-monitor.log
 * records `alert(new) delivered` and it named the crash loop — and the outage
 * still ran another 2h20m before anyone saw it, found by chance in an unrelated
 * `systemctl --user status`. Delivery was never the failure; attention was. So
 * a critical that survives to its first re-nag also goes to a DM, which is a
 * different notification from a bot post in a low-traffic ops channel.
 */
describe.skipIf(!present)('health-monitor — escalation to a DM', () => {
  it('pages on the first re-nag, not on the first notice', () => {
    const posts = replay({
      restarts: REAL_RESTARTS,
      from: '2026-08-29T08:50:00Z',
      to: '2026-08-29T11:25:00Z',
    });
    expect(posts[0].escalate).toBe(false); // 09:00 — channel only
    expect(at(posts.filter((p) => p.escalate))).toEqual(['09:30', '10:00', '10:30', '11:00']);
  });

  it('sends the all-clear to the same place it paged', () => {
    const posts = replay({
      restarts: REAL_RESTARTS,
      from: '2026-08-29T08:50:00Z',
      to: '2026-08-29T13:00:00Z',
    });
    const green = posts.filter((p) => p.kind === 'recovery');
    expect(green).toHaveLength(1);
    expect(green[0].escalate).toBe(true);
  });

  it('never DMs for a critical that clears before the re-nag', () => {
    // Confirmed by the debounce, so it alerts — but gone well inside 30 min.
    const brief = (tMs: number): Result[] => [
      {
        name: 'credproxy-port-3002',
        ok: !(tMs >= Date.parse('2026-08-29T09:00:00Z') && tMs <= Date.parse('2026-08-29T09:10:00Z')),
        severity: 'critical',
      },
    ];
    const posts = replay({ restarts: [], from: '2026-08-29T08:30:00Z', to: '2026-08-29T10:30:00Z', also: brief });
    expect(posts.some((p) => p.escalate)).toBe(false);
    // ...and no all-clear DM either, since nobody was paged.
    expect(posts.filter((p) => p.kind === 'recovery').every((p) => !p.escalate)).toBe(true);
  });

  it('never DMs for warnings, however long they last', () => {
    const warn = (): Result[] => [{ name: 'egress-proxy-3128', ok: false, severity: 'warning' }];
    const posts = replay({ restarts: [], from: '2026-08-29T08:30:00Z', to: '2026-08-29T20:00:00Z', also: warn });
    // Long enough to pass the 6-hour warning re-nag, so re-nags DO happen here.
    expect(posts.filter((p) => p.kind === 'renag').length).toBeGreaterThan(0);
    expect(posts.some((p) => p.escalate)).toBe(false);
  });
});

/**
 * host-cli-responsive — the check that asks whether the host SERVES, not
 * whether it exists.
 *
 * Every other liveness check can pass while nobody is being helped.
 * `nanoclaw-service` asks systemd whether a process exists, and systemd
 * reported `active` on all 28 ticks of the 2026-08-29 outage because a restart
 * loop is "active" between crashes. The port checks are stronger but a TCP
 * connect is completed by the kernel from the listen backlog, so a process with
 * a wedged event loop accepts connections it will never answer — which is the
 * fixture below, and the case no existing check could see.
 *
 * The fixture servers run as CHILD PROCESSES on purpose: cliProbe is
 * synchronous, so a server in this process could never accept the connection
 * while the main thread is blocked inside execFileSync.
 */
const SERVERS: Record<string, string> = {
  ok: "require('net').createServer(c=>{c.on('data',()=>c.write(JSON.stringify({id:'x',ok:true,data:[]})+'\\n'))}).listen(process.env.S)",
  wedge: "require('net').createServer(()=>{}).listen(process.env.S)",
  reject:
    "require('net').createServer(c=>{c.on('data',()=>c.write(JSON.stringify({id:'x',ok:false,error:{code:'unknown-command',message:'no'}})+'\\n'))}).listen(process.env.S)",
  garbage: "require('net').createServer(c=>{c.on('data',()=>c.write('not json\\n'))}).listen(process.env.S)",
};

interface Probe {
  cliProbe: (sock: string, timeoutMs: number) => Record<string, unknown>;
  cliProbeVerdict: (r: Record<string, unknown>, sock: string, timeoutMs: number) => { ok: boolean; detail: string };
}
const probe = hm as unknown as Probe;

describe.skipIf(!present)('health-monitor — host-cli-responsive', () => {
  let child: ReturnType<typeof spawn> | null = null;
  let sock = '';

  async function serve(kind: keyof typeof SERVERS): Promise<void> {
    sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sock-')), 's.sock');
    child = spawn(process.execPath, ['-e', SERVERS[kind]], { env: { ...process.env, S: sock } });
    for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
  }

  afterEach(() => {
    if (child) child.kill();
    child = null;
  });

  it('passes when the host answers a real command', async () => {
    await serve('ok');
    const v = probe.cliProbeVerdict(probe.cliProbe(sock, 2000), sock, 2000);
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/answered groups-list/);
  });

  it('fails when the socket is absent — the host is not running', () => {
    const missing = path.join(os.tmpdir(), 'hm-definitely-absent.sock');
    const v = probe.cliProbeVerdict(probe.cliProbe(missing, 1000), missing, 1000);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/does not exist/);
  });

  it('fails when the host accepts but never answers — the case nothing else catches', async () => {
    await serve('wedge');
    const v = probe.cliProbeVerdict(probe.cliProbe(sock, 800), sock, 800);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/did not answer/);
    // The point of the whole check: an accept-level probe is satisfied here.
    expect(fs.existsSync(sock)).toBe(true);
  });

  it('fails when the host answers but rejects the command', async () => {
    await serve('reject');
    const v = probe.cliProbeVerdict(probe.cliProbe(sock, 2000), sock, 2000);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/did not serve a read-only command/);
  });

  it('fails on a malformed response rather than reading it as healthy', async () => {
    await serve('garbage');
    const v = probe.cliProbeVerdict(probe.cliProbe(sock, 2000), sock, 2000);
    expect(v.ok).toBe(false);
  });
});

/**
 * agent-turn-fresh — the daily paid probe's verdict.
 *
 * `chat-answered` was meant to be the catch-all symptom check, and during the
 * 2026-08-29 outage it had nothing to detect: Saturday morning, nobody had
 * written, so no message could sit unanswered for the whole 2.5 hours. A system
 * observable only while someone is talking to it is unobservable exactly when
 * it is quietest. One trivial scheduled turn a day supplies the traffic.
 */
const STALE_H = 26;
interface Turn {
  agentTurnVerdict: (newestMs: number, nowMs: number, staleH: number) => { ok: boolean; ageH: number | null };
}
const turn = hm as unknown as Turn;
const NOW = Date.parse('2026-08-29T16:00:00Z');
const hoursAgo = (h: number) => NOW - h * 3_600_000;

describe.skipIf(!present)('health-monitor — agent-turn-fresh', () => {
  it('passes while the daily probe is answering', () => {
    expect(turn.agentTurnVerdict(hoursAgo(1), NOW, STALE_H).ok).toBe(true);
    expect(turn.agentTurnVerdict(hoursAgo(23.9), NOW, STALE_H).ok).toBe(true);
  });

  it('tolerates a late run inside the grace window', () => {
    // Daily cadence plus 2h, so a probe that fires late is not an outage.
    expect(turn.agentTurnVerdict(hoursAgo(25.9), NOW, STALE_H).ok).toBe(true);
  });

  it('fails once a whole day has passed with no answer', () => {
    const v = turn.agentTurnVerdict(hoursAgo(26.1), NOW, STALE_H);
    expect(v.ok).toBe(false);
    expect(v.ageH).toBeGreaterThan(26);
  });

  it('fails when nothing has ever answered', () => {
    const v = turn.agentTurnVerdict(0, NOW, STALE_H);
    expect(v.ok).toBe(false);
    expect(v.ageH).toBeNull();
  });

  it('would have caught the 2026-08-03 outage on day one, not day three', () => {
    // Containers died at startup for three days while every other check was
    // green. With a daily probe the first missed answer trips inside ~26h.
    const outageStart = Date.parse('2026-08-03T12:00:00Z');
    const dayOne = outageStart + 26.5 * 3_600_000;
    expect(turn.agentTurnVerdict(outageStart, dayOne, STALE_H).ok).toBe(false);
  });
});
