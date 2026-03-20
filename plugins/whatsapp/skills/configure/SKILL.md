---
name: configure
description: Set up the WhatsApp channel — save the PipesBot API key and review channel status. Use when the user pastes an API key, asks to configure WhatsApp, asks "how do I set this up", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /whatsapp:configure — WhatsApp Channel Setup

Writes the PipesBot API key to `~/.claude/channels/whatsapp/.env`. The server
reads this file at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read the `.env` file and give the user a complete picture:

1. **API Key** — check `~/.claude/channels/whatsapp/.env` for
   `PIPESBOT_API_KEY`. Show set/not-set; if set, show first 6 chars masked
   (`pk_ab...`).

2. **Pool Number** — check `.env` for `PIPESBOT_POOL_NUMBER_ID`. Show:
   - If set: the pool number ID value (e.g. `pn_abc123`)
   - If not set: *"not set — receiving all pool numbers"*

3. **What next** — end with a concrete next step based on state:
   - No API key → *"Run `/whatsapp:configure <key>` with your PipesBot API
     key (starts with pk_)."*
   - Key set → *"Ready. Message your PipesBot number on WhatsApp to reach
     the assistant."*

### `<key>` — save it

1. Treat `$ARGUMENTS` as the API key (trim whitespace). PipesBot keys start
   with `pk_`.
2. `mkdir -p ~/.claude/channels/whatsapp`
3. Read existing `.env` if present; update/add the `PIPESBOT_API_KEY=` line,
   preserve other keys. Write back, no quotes around the value.
4. Confirm, then show the no-args status so the user sees where they stand.

Note: `PIPESBOT_POOL_NUMBER_ID=pn_...` can also be set in `.env` to scope the
WebSocket connection to a single pool number (see `pool` argument below).

### `clear` — remove the API key

Delete the `PIPESBOT_API_KEY=` line (or the file if that's the only line).

### `pool <id>` — scope to a single pool number

1. Treat the argument after `pool` as the pool number ID (trim whitespace).
   Pool number IDs start with `pn_`.
2. `mkdir -p ~/.claude/channels/whatsapp`
3. Read existing `.env` if present; update/add the `PIPESBOT_POOL_NUMBER_ID=`
   line, preserve other keys. Write back, no quotes around the value.
4. Confirm, then remind the user to restart the session or `/reload-plugins`.

### `pool clear` — receive all pool numbers

Delete the `PIPESBOT_POOL_NUMBER_ID=` line from `.env`.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. API key changes need a session restart
  or `/reload-plugins`. Say so after saving.
