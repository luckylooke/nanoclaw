#!/usr/bin/env node
/**
 * watchdog-alive.cjs — the watchdog's watchdog.
 *
 * Two questions nothing in this system could answer before 2026-08-22:
 *
 *   1. Is health-monitor still running at all? Every check it makes is about
 *      something else; nothing checked *it*. Edited into a syntax error,
 *      deleted, its flock left held by a hung run, or its cron entry lost, and
 *      the system goes completely silent — which is exactly how the 2026-08-03
 *      outage lasted three days with every check reporting green.
 *   2. Has any host-side privileged script changed? `drift-watch` hashes agent
 *      identity files only (CLAUDE.local.md, SOUL.md, memory/index.md,
 *      memory/system/definition.md). The cron tools and the secrets-loading
 *      tool-proxy daemon were watched by nothing.
 *
 * Lives in ~/nanoclaw/scripts/ because that really is outside every container
 * mount — unlike health-monitor.cjs, whose own header claimed as much while
 * sitting inside the Orchestrator's read-write mount. Deliberately duplicates
 * the Slack-post code rather than importing anything from agent-system/tools:
 * this script has to work on exactly the days that tree is broken.
 *
 * Nothing watches THIS script. That regress has to stop somewhere; it stops
 * here, one level further out than before, on a file an agent cannot reach.
 *
 *   node watchdog-alive.cjs             # cron
 *   node watchdog-alive.cjs --dry-run   # print findings, post nothing, keep state
 *   node watchdog-alive.cjs --seed      # (re)baseline fingerprints, no alerts
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const HOME = process.env.HOME || '/home/agent';
const NANO = path.join(HOME, 'nanoclaw');
// WA_REPO / WA_HM_STATE / WA_STATE exist so both halves can be exercised against
// fixtures instead of production state — the same reason health-monitor has
// HM_ERROR_LOG. A watchdog nobody can test is a watchdog nobody trusts.
const REPO = process.env.WA_REPO || path.join(NANO, 'groups/dm-with-ignac/agent-system');
const HM_STATE = process.env.WA_HM_STATE || path.join(NANO, 'logs/health-monitor.state.json');
const STATE_FILE = process.env.WA_STATE || path.join(NANO, 'logs/watchdog-alive.state.json');

const ALERT_CHANNEL = 'C0B6B8A1MEV'; // #agent-admin
const STALE_MIN = 20;                // health-monitor runs every 5 min: 4 missed ticks
const RE_ALERT_HOURS = 6;

const DRY_RUN = process.argv.includes('--dry-run');
const SEED = process.argv.includes('--seed');

// Every host-side script that runs with privileges the containers do not have:
// cron entries, systemd user services, and the pre-commit syntax gate.
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
].map((rel) => ({ rel, abs: path.join(REPO, rel) }));

const iso = () => new Date().toISOString();
function log(m) { process.stdout.write(`[watchdog-alive] ${iso()} ${m}\n`); }
function sh(cmd, cwd) {
  try { return execSync(cmd, { encoding: 'utf8', cwd, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return null; }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let prev;
try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
catch (e) { prev = { fingerprints: {}, lastAlertAt: null, lastConditions: [] }; }

const findings = [];   // { key, text }

// ---------- 1. dead-man's switch ----------
(() => {
  let st;
  try { st = JSON.parse(fs.readFileSync(HM_STATE, 'utf8')); }
  catch (e) {
    findings.push({ key: 'hm-state-unreadable', text:
      `*health-monitor state unreadable* — \`${HM_STATE}\`: ${e.message}\n` +
      'It has not written state, so it is not completing runs. Check ' +
      '`tail ~/nanoclaw/logs/health-monitor.log` and `node --check ~/agent-system/tools/health-monitor.cjs`.' });
    return;
  }
  if (!st.lastRun) {
    findings.push({ key: 'hm-no-lastrun', text: '*health-monitor state has no `lastRun`* — it is writing state it should not be able to write.' });
    return;
  }
  const ageMin = (Date.now() - new Date(st.lastRun).getTime()) / 60000;
  if (ageMin > STALE_MIN) {
    findings.push({ key: 'hm-stale', text:
      `*health-monitor has stopped running* — last completed run ${ageMin.toFixed(0)} min ago (${st.lastRun}), threshold ${STALE_MIN} min.\n` +
      'Nothing is checking the system right now. Likely: a syntax error in the script, a held ' +
      '`.health-monitor.lock`, or a lost crontab entry — in that order of past frequency.' });
  }
})();

// ---------- 2. fingerprints of host-side privileged scripts ----------
const fingerprints = {};
for (const { rel, abs } of WATCHED) {
  let cur;
  try { cur = fs.readFileSync(abs); }
  catch (e) {
    fingerprints[rel] = null;
    if (prev.fingerprints && prev.fingerprints[rel]) {
      findings.push({ key: `gone:${rel}`, text: `*${rel} has disappeared* — it was present at the last check and cron/systemd still expects it.` });
    }
    continue;
  }
  const curSha = sha(cur);
  fingerprints[rel] = { sha: curSha, bytes: cur.length };
  const old = prev.fingerprints && prev.fingerprints[rel];
  if (!old || SEED) continue;
  if (old.sha === curSha) continue;

  // Committed or not? An uncommitted change to one of these is either a live
  // hand-edit or an agent that reached the tree — both worth naming as such.
  const porcelain = sh(`git status --porcelain -- ${JSON.stringify(rel)}`, REPO);
  const committed = porcelain === '';
  const head = sh(`git log -1 --format=%h\\ %s -- ${JSON.stringify(rel)}`, REPO) || 'unknown';
  findings.push({ key: `changed:${rel}:${curSha.slice(0, 12)}`, text:
    `*${rel} changed* — sha \`${old.sha.slice(0, 8)}\` → \`${curSha.slice(0, 8)}\` ` +
    `(${cur.length - old.bytes >= 0 ? '+' : ''}${cur.length - old.bytes} bytes)\n` +
    (committed
      ? `Committed — last commit touching it: \`${head}\`.`
      : '*Uncommitted* — this is a working-tree edit, not a deploy. If nobody is editing it by hand, an agent reached the tree.') });
}

// ---------- alert ----------
const conditions = findings.map((f) => f.key).sort();
const prevConditions = (prev.lastConditions || []).slice().sort();
const isNew = conditions.some((c) => !prevConditions.includes(c));
const hoursSince = prev.lastAlertAt ? (Date.now() - new Date(prev.lastAlertAt).getTime()) / 3.6e6 : Infinity;
const recovered = prevConditions.length > 0 && conditions.length === 0;
let kind = null;
if (recovered) kind = 'recovery';
else if (isNew) kind = 'new';
else if (conditions.length && hoursSince >= RE_ALERT_HOURS) kind = 'renag';

const host = sh('hostname') || 'vps';
let text = '';
if (kind === 'recovery') text = `🟢 *Watchdog check clear* (${host})\nPreviously: ${prevConditions.join(', ')}.`;
else if (kind) text = `🔴 *Watchdog integrity alert* (${host})${kind === 'renag' ? ' _(still failing)_' : ''}\n` +
  findings.map((f) => '• ' + f.text).join('\n') + `\n\n_watchdog-alive • ${iso()}_`;

function readEnvVar(file, key) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
    if (!m) return null;
    let v = m[1].trim().replace(/\s+#.*$/, '');
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || null;
  } catch (e) { return null; }
}
function slackPost(txt) {
  return new Promise((resolve) => {
    let token = readEnvVar(path.join(NANO, '.env'), 'SLACK_BOT_TOKEN');
    if (!token) { try { token = JSON.parse(fs.readFileSync(path.join(HOME, '.agent-secrets/secrets.json'), 'utf8')).SLACK_BOT_TOKEN || null; } catch (e) {} }
    if (!token) { log('cannot alert: SLACK_BOT_TOKEN not found'); return resolve(false); }
    const body = JSON.stringify({ channel: ALERT_CHANNEL, text: txt, unfurl_links: false, unfurl_media: false });
    const req = https.request({ hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let ok = false; try { ok = JSON.parse(d).ok; } catch (e) {} if (!ok) log('slack post failed: ' + d.slice(0, 120)); resolve(ok); }); });
    req.on('error', (e) => { log('slack request error: ' + e.message); resolve(false); });
    req.write(body); req.end();
  });
}

const state = {
  fingerprints,
  lastConditions: conditions,
  lastAlertAt: kind ? iso() : (prev.lastAlertAt || null),
  lastRun: iso(),
};
if (!DRY_RUN) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log('could not write state: ' + e.message); }
}
log(`findings=${findings.length} [${conditions.join(',')}] alert=${kind || 'no'}${SEED ? ' (SEED)' : ''}${DRY_RUN ? ' (DRY RUN — nothing posted, state untouched)' : ''}`);
if (DRY_RUN || SEED) { for (const f of findings) log('  ' + f.text.replace(/\n/g, ' ')); if (text) log('would post:\n' + text); }

(async () => { if (kind && !DRY_RUN && !SEED) await slackPost(text); })();
