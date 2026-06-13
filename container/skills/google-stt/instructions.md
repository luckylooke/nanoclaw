---
name: google-stt
description: Speech-to-text via Google Cloud STT V2 (Chirp 2). Use when the user sends a voice/audio message, or when you receive a Slack file URL pointing to an audio file.
---

# Google STT

Transcribe audio to text using the `stt` tool at `/workspace/extra/tools/stt/stt.js`.

## Commands

```bash
# Transcribe a local audio file
node /workspace/extra/tools/stt/stt.js transcribe /tmp/audio.mp3

# Download from Slack and transcribe (pass the url_private from the Slack file object)
node /workspace/extra/tools/stt/stt.js slack <slack_file_url_private>
```

## Rules

- When you receive a message that contains an audio file, call stt.js to transcribe it before responding.
- The url_private from the Slack file object is the correct URL to pass to "stt.js slack".
- After transcription, respond to the transcribed text as if the user had typed it.
- If transcription returns "(no speech detected)", ask the user to try again.
- Supported formats: MP3, MP4/M4A, WAV, OGG, WebM.
