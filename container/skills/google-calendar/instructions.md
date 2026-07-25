---
name: google-calendar
description: Google Calendar CRUD. Use when the user asks about their schedule, wants to create/update/delete events, or asks "what do I have today/tomorrow".
---

# Google Calendar

Access Google Calendar via the `gcal` tool at `/workspace/extra/tools/gcal/gcal.js`.

## Commands

```bash
# List today's events
node /workspace/extra/tools/gcal/gcal.js list

# List events for a specific date
node /workspace/extra/tools/gcal/gcal.js list 2026-06-01

# Create an event
node /workspace/extra/tools/gcal/gcal.js create '{"summary":"Gym","start":{"dateTime":"2026-06-01T07:00:00+02:00","timeZone":"Europe/Bratislava"},"end":{"dateTime":"2026-06-01T08:00:00+02:00","timeZone":"Europe/Bratislava"}}'

# Get a specific event
node /workspace/extra/tools/gcal/gcal.js get <eventId>

# Update an event (partial update)
node /workspace/extra/tools/gcal/gcal.js update <eventId> '{"summary":"New title"}'

# Delete an event
node /workspace/extra/tools/gcal/gcal.js delete <eventId>

# NOTE: delete is a guarded destructive action. The first `delete` call returns
# {"requires_confirmation":true, "dry_run": <the event>, "confirm_token": "..."} and does
# NOT delete. Show the user the event from dry_run, get their OK, then re-run WITH the token:
#   node /workspace/extra/tools/gcal/gcal.js delete <eventId> --confirm <confirm_token>
```

## Rules

- Always use timezone `Europe/Bratislava` for events unless the user specifies otherwise
- When the user says "tomorrow", resolve the actual date before calling the tool
- For "schedule X at Y time", parse into the create JSON format
- After creating/updating/deleting, confirm back to the user with event title + time
- If list returns empty array, say "no events found" — don't fabricate
