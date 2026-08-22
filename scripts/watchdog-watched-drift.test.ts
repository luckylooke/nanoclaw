import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./watchdog-alive.cjs', import.meta.url));

/**
 * watchdog-alive fingerprints a HARDCODED list of host-side privileged scripts.
 * Add a cron job or a systemd user service tomorrow and it silently is not
 * watched — the failure mode being that the list looks complete while the newest
 * privileged script is the one nobody is checking.
 *
 * So: whatever cron and systemd actually run must appear in that list. This is
 * host state rather than repo state, so the assertions skip cleanly anywhere the
 * crontab and unit files are absent (a laptop, CI) and bite on the VPS, which is
 * the only place the drift can exist.
 */
function watchedList(): string[] {
  return execFileSync(process.execPath, [SCRIPT, '--list-watched'], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** agent-system-relative script paths referenced by `crontab -l`. */
function cronScripts(): string[] | null {
  let out: string;
  try {
    out = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null; // no crontab for this user — nothing to drift from
  }
  return extract(out);
}

/** agent-system-relative script paths referenced by systemd user units. */
function serviceScripts(): string[] | null {
  const dir = path.join(os.homedir(), '.config/systemd/user');
  if (!fs.existsSync(dir)) return null;
  const units = fs.readdirSync(dir).filter((f) => f.endsWith('.service'));
  if (!units.length) return null;
  return extract(units.map((u) => fs.readFileSync(path.join(dir, u), 'utf8')).join('\n'));
}

/**
 * Pull `tools/...` and `tool-proxy/...` script paths out of arbitrary text.
 * Matches through either the ~/agent-system symlink or the real repo path, since
 * the crontab uses the former and unit files may use either.
 */
function extract(text: string): string[] {
  const re = /agent-system\/((?:tools|tool-proxy)\/[\w./-]+\.(?:js|cjs))/g;
  return [...new Set(Array.from(text.matchAll(re), (m) => m[1]))].sort();
}

describe('watchdog-alive fingerprint coverage', () => {
  it('reports a non-empty list', () => {
    expect(watchedList().length).toBeGreaterThan(0);
  });

  it('watches every agent-system script the crontab runs', () => {
    const cron = cronScripts();
    if (cron === null) return; // not this host
    expect(cron.length).toBeGreaterThan(0);
    const missing = cron.filter((s) => !watchedList().includes(s));
    // If this fails, add the path to WATCHED in watchdog-alive.cjs — a new cron
    // job is exactly the script most worth fingerprinting.
    expect(missing).toEqual([]);
  });

  it('watches every agent-system script a systemd user service runs', () => {
    const svc = serviceScripts();
    if (svc === null) return; // not this host
    const missing = svc.filter((s) => !watchedList().includes(s));
    expect(missing).toEqual([]);
  });

  it('does not list a script that no longer exists in the repo', () => {
    // A stale entry is reported as "has disappeared" on every run, which trains
    // the reader to ignore the alert that matters.
    const repo = process.env.WA_REPO || path.join(os.homedir(), 'nanoclaw/groups/dm-with-ignac/agent-system');
    if (!fs.existsSync(repo)) return;
    const gone = watchedList().filter((rel) => !fs.existsSync(path.join(repo, rel)));
    expect(gone).toEqual([]);
  });
});
