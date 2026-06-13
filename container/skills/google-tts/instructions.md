---
name: google-tts
description: Text-to-speech via Google Cloud TTS (Chirp 3 HD). Use when the user asks for a voice reply, audio message, or whenever a spoken response would be better than text.
---

# Google TTS

Post an audio MP3 to Slack using the `tts` tool at `/workspace/extra/tools/tts/tts.js`.

## Commands

```bash
# Synthesize to file only (no Slack post)
node /workspace/extra/tools/tts/tts.js synthesize "text to speak" /tmp/output.mp3

# Synthesize and post directly to a Slack channel
node /workspace/extra/tools/tts/tts.js post "text to speak" <channel_id>
```

## Rules

- Voice is en-US-Chirp3-HD-Puck — handles English and Slovak well.
- For the personal-assistant agent in #agent-personal, the channel ID is C0B6D0QNSUU.
- Keep TTS replies short (under 200 words) — audio is slower to consume than text.
- Only use TTS when the user explicitly asks for a voice reply, or when spoken confirmation fits better than a text block.
