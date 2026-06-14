---
name: google-tts
description: Text-to-speech via Google Cloud TTS (Chirp 3 HD). Use when the user asks for a voice reply, audio message, or whenever a spoken response would be better than text.
---

# Google TTS

Post an audio MP3 to Slack using the tool proxy at `/workspace/extra/tool-exec.js`.

## Commands

```bash
# Synthesize and post directly to a Slack channel
node /workspace/extra/tool-exec.js tts post "text to speak" <channel_id>

# Synthesize and post in a thread
node /workspace/extra/tool-exec.js tts post "text to speak" <channel_id> <thread_ts>
```

## Rules

- Voice is en-US-Chirp3-HD-Puck — handles English and Slovak well.
- For the personal-assistant agent in #agent-personal, the channel ID is C0B6D0QNSUU.
- Keep TTS replies short (under 200 words) — audio is slower to consume than text.
- Only use TTS when the user explicitly asks for a voice reply, or when spoken confirmation fits better than a text block.
