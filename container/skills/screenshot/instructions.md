---
name: screenshot
description: Capture any URL as a PNG, post it to Slack, or put your own dev preview side by side with the design you were given. Use when asked to show, preview, or check how a page looks — and before ever claiming your build matches a design.
---

# Screenshot

Headless Chromium, run on the host. Three commands: `capture`, `compare`, `post`.

## Seeing your own work

```bash
# Your dev preview, at the design\x27s width, into your own workspace.
node /workspace/extra/tool-exec.js screenshot capture http://127.0.0.1:3010/ \
  screenshots/home.png --width=1240
```

The reply carries `read` — the path **you** open:

```json
{"ok":true,"read":"/workspace/agent/screenshots/<the name you gave>.png","path":"/home/agent/…","bytes":574258}
```

`Read` that path. A relative name always lands in your own workspace; an absolute
one is treated as a host path and you will not be able to open it.

`http://127.0.0.1:3010/` is the one non-public address this tool will open, and
it is your dev server. Every other local address — the dashboard, the model
runner, nanoclaw — is refused, and that is deliberate: this tool runs on the
host, so a URL you pass is a request to photograph something on the machine.

## Comparing against the design

```bash
node /workspace/extra/tool-exec.js screenshot compare \
  http://127.0.0.1:3010/repertoar \
  /workspace/extra/reference/divadlo-ivery/design/Repertoar.png \
  screenshots/cmp-repertoar.png
```

One PNG, the design on the left and your build on the right, captured in the
**artboard\x27s own frame** so the only differences are the ones you caused.

**Use this before you say a page matches the design.** Two images looked at
minutes apart are compared from memory, and memory agrees with whatever you were
hoping — the first run of this tool on a page that had been reported as matching
found a hero title hidden behind a photo, a missing button and a missing footer.
"It matches" is a claim; this is how you check it, and if you have not run it,
say what you actually did instead.

If you have no design to compare against, **ask for one**. Do not estimate.

## Posting to Slack

```bash
node /workspace/extra/tool-exec.js screenshot post <url> <channel_id> [thread_ts]
```

Posts inline, visible immediately on mobile and desktop. `post` takes public URLs
only — to show someone your dev preview, `compare` or `capture` it first and
attach the file.

## Rules

- Viewport defaults to 1280×900. Match the artboard: `--width=1240` for the
  desktop boards, `--width=390` for mobile. `--full` captures the whole scroll.
- `compare` reads its reference from `/workspace/extra/reference/…` or your own
  workspace; it reports the design and built sizes it used.
- A page needing authentication screenshots the login page — say so rather than
  describing what you assume is behind it.
