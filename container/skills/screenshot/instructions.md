---
name: screenshot
description: Capture a screenshot of any URL using headless Chromium and post it inline to Slack. Use when asked to show, preview, or check how a website looks.
---

# Screenshot

Capture a webpage and post the PNG inline to Slack via the  tool.

## Commands

```bash
# Capture to file only (no Slack post). The tool runs on the HOST, so the PNG is written
# there — it never appears in your container, whatever path you pass. Host-side use only.
node /workspace/extra/tool-exec.js screenshot capture <url> /tmp/out.png

# Capture and post directly to a Slack channel
node /workspace/extra/tool-exec.js screenshot post <url> <channel_id>
node /workspace/extra/tool-exec.js screenshot post <url> <channel_id> <thread_ts>
```

## Rules

- From a container, `post` is the only command that gives you the image: `capture` writes
  on the host and a `Read` of that path in the container fails. Never just `capture`.
- The image is posted inline (not as a link) — visible immediately in Slack on mobile and desktop.
- Viewport is 1280×900. Use this for any public or Tailscale-accessible URL.
- If the page requires authentication, it will screenshot the login page — note this to the user.
