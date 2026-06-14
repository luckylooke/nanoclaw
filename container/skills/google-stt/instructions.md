---
name: google-stt
description: Speech-to-text via Google Cloud STT V2 (Chirp 2). Use when the user sends a voice/audio message, or when you receive a Slack file URL pointing to an audio file.
---

# Google STT

Transcribe audio to text using the tool proxy at `/workspace/extra/tool-exec.js`.

## Commands

```bash
# Download from Slack and transcribe (pass the url_private from the Slack file object)
node /workspace/extra/tool-exec.js stt slack <slack_file_url_private>
```

## Rules

- When you receive a message that contains an audio file, call via tool-exec.js stt to transcribe it before responding.
- The url_private from the Slack file object is the correct URL to pass to "stt slack".
- After transcription, respond to the transcribed text as if the user had typed it.
- If transcription returns "(no speech detected)", ask the user to try again.
- Supported formats: MP3, MP4/M4A, WAV, OGG, WebM.
