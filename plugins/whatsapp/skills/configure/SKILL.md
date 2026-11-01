---
name: configure
description: Set up the WhatsApp channel — save the PipesBot API key, manage trusted senders, and review channel status. Use when the user pastes an API key, asks to configure WhatsApp, asks "how do I set this up", wants to trust or untrust a sender, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /whatsapp:configure — WhatsApp Channel Setup

Writes the PipesBot API key to `~/.claude/channels/whatsapp/.env` and the
trusted-sender list to `~/.claude/channels/whatsapp/trusted.json`. The server
reads `.env` at boot and re-reads `trusted.json` on every inbound message.

The API key prefix picks the mode:

- `pk_` — **pool number** (PipesBot's shared number). Text only: file
  attachments and reactions return an explicit error. Every sender reaches
  Claude; `trusted.json` is not consulted.
- `ak_` — **BYON App on PipesBot API v2** (your own WhatsApp number). Text,
  files and reactions. Only senders in `trusted.json` reach Claude; with an
  empty list, every message is dropped.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read `.env` and `trusted.json` and give the user a complete picture:

1. **API Key** — check `~/.claude/channels/whatsapp/.env` for
   `PIPESBOT_API_KEY`. Show set/not-set; if set, show first 6 chars masked
   (`pk_ab...` / `ak_ab...`).

2. **Mode** — from the key prefix: `pk_` → *"pool number (shared PipesBot
   number, text only)"*; `ak_` → *"BYON (your own number, API v2)"*. Omit if
   no key.

3. **Pool Number** — check `.env` for `PIPESBOT_POOL_NUMBER_ID`. Show:
   - If set: the pool number ID value (e.g. `pn_abc123`)
   - If not set: *"not set — receiving all pool numbers"*

4. **Trusted senders** — read `~/.claude/channels/whatsapp/trusted.json` and
   show how many entries `senders` holds (missing file = 0). On a `pk_` key,
   add *"(not used on pool numbers — everyone is allowed)"*. On an `ak_` key
   with 0 entries, add: *"BYON mode: no trusted senders — all messages will be
   dropped. Add one with /whatsapp:configure trust <number>."*

5. **What next** — end with a concrete next step based on state:
   - No API key → *"Run `/whatsapp:configure <key>` with your PipesBot API
     key (starts with pk_ for a pool number, ak_ for a BYON App on API v2)."*
   - `pk_` key set → *"Ready. Message your PipesBot number on WhatsApp to
     reach the assistant."*
   - `ak_` key set, no trusted senders → *"Run `/whatsapp:configure trust
     <your number>` so your own messages get through."*
   - `ak_` key set, trusted senders present → *"Ready. Message your WhatsApp
     number from a trusted sender to reach the assistant."*

### `<key>` — save it

1. Treat `$ARGUMENTS` as the API key (trim whitespace). PipesBot keys start
   with `pk_` (pool number) or `ak_` (BYON App on API v2). Reject anything
   else and say so.
2. `mkdir -p ~/.claude/channels/whatsapp`
3. Read existing `.env` if present; update/add the `PIPESBOT_API_KEY=` line,
   preserve other keys. Write back, no quotes around the value.
4. Confirm, then show the no-args status so the user sees where they stand.

Note: `PIPESBOT_POOL_NUMBER_ID=pn_...` can also be set in `.env` to scope the
WebSocket connection to a single number (see `pool` argument below). On BYON
this also stops the server-side offline queue from being drained, so messages
received while Claude Code was closed are not replayed.

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

### `trust <phone|BSUID>` — allow a sender (BYON)

1. Normalize the argument to the exact form the server compares:
   - Trim whitespace and upper-case it.
   - If the result is a BSUID — two letters, a dot, an optional `ENT.`, then
     digits (pattern `^[A-Z]{2}\.(ENT\.)?\d+$`, e.g. `BR.1234567890`) — keep
     it as is.
   - Otherwise keep only the digits (strip `+`, spaces, dashes, parentheses),
     e.g. `+55 (11) 91234-5678` → `5511912345678`.
   - If nothing is left (no digits), tell the user the value is not a phone
     number or BSUID and stop.
2. `mkdir -p ~/.claude/channels/whatsapp`. If `trusted.json` does not exist,
   create it as `{ "senders": [] }` and `chmod 600` it.
3. Read `trusted.json`, add the normalized ID to `senders` unless already
   there (compare after normalizing existing entries), preserve everything
   else, write back as pretty-printed JSON.
4. Confirm with the normalized ID that was stored. The change applies
   immediately — no restart needed.
5. If the key is `pk_`, mention that trust only matters on BYON (`ak_`) keys.

Brazilian numbers: WhatsApp's own ID for a number may lack the 9th digit
(`5511912345678` may arrive as `551112345678`). The server compares the
sender ID exactly, so if a message is dropped, the log line
`dropped untrusted sender <id>` (stderr, in the MCP log) shows the exact ID
to pass to `trust`.

### `untrust <phone|BSUID>` — remove a sender

Normalize the argument exactly as for `trust`, remove every entry of
`senders` that normalizes to it, write back. If it was not in the list, say
so. Applies immediately. If the list is now empty on a BYON key, warn that
all messages will be dropped.

### `trusted` — list trusted senders

Read `trusted.json` and list the entries in `senders` (missing file = none).
On a BYON key with none, include the empty-list warning from the no-args
status.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. API key (and pool number) changes need
  a session restart or `/reload-plugins`. Say so after saving.
- The server reads `trusted.json` on every message, so `trust` / `untrust`
  apply immediately. Never write anything other than `{ "senders": [...] }`
  to it; keep it `chmod 600`.
