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
- Use the channel ID for the relevant dev channel: #agent-dev-game or #agent-dev-web.
- Requires GITHUB_TOKEN to be set in secrets (works for both public and private repos).
