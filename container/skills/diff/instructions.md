---
name: diff
description: Fetch a GitHub PR diff and post it as a formatted Slack message. Use when asked to review, show, or post a pull request diff.
---

# GitHub PR Diff

Fetch a GitHub pull request diff and post it formatted to Slack via the `diff` tool.

## Commands

```bash
# Post PR diff to a Slack channel
node /workspace/extra/tool-exec.js diff pr <github_pr_url> <channel_id>
node /workspace/extra/tool-exec.js diff pr <github_pr_url> <channel_id> <thread_ts>
```

## Example

```bash
node /workspace/extra/tool-exec.js diff pr https://github.com/owner/repo/pull/5 C0B65UJTYE9
```

## Rules

- The output includes: PR title, author, +additions/−deletions, file count, and the raw diff (truncated at ~2800 chars with a note if cut).
- Post to the dev channel that matches the repo. The IDs are here so you never have to go looking:

  | channel | id |
  |---|---|
  | `#agent-dev-game` | `C0B69CU8PGA` |
  | `#agent-dev-web` | `C0B69CZRS9Y` |

  For any other channel, the authoritative source is `messaging_groups` in
  `~/nanoclaw/data/v2.db` (note: `data/`, not the empty `~/nanoclaw/nanoclaw.db`),
  reachable via `ncl messaging-groups list`. Do not grep logs or the filesystem for
  a channel id.
- Requires GITHUB_TOKEN to be set in secrets (works for both public and private repos).
