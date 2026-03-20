---
name: configure
description: Set up the WhatsApp channel — save the PipesBot API key and review access policy. Use when the user pastes an API key, asks to configure WhatsApp, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /whatsapp:configure — WhatsApp Channel Setup

Writes the PipesBot API key to `~/.claude/channels/whatsapp/.env` and orients
the user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **API Key** — check `~/.claude/channels/whatsapp/.env` for
   `PIPESBOT_API_KEY`. Show set/not-set; if set, show first 6 chars masked
   (`pk_ab...`).

2. **Access** — read `~/.claude/channels/whatsapp/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list phone numbers
   - Pending pairings: count, with codes and phone numbers if any

3. **What next** — end with a concrete next step based on state:
   - No API key → *"Run `/whatsapp:configure <key>` with your PipesBot API
     key (starts with pk_)."*
   - Key set, policy is pairing, nobody allowed → *"Send a WhatsApp message
     to your PipesBot number. It replies with a code; approve with
     `/whatsapp:access pair <code>`."*
   - Key set, someone allowed → *"Ready. Message your PipesBot number on
     WhatsApp to reach the assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture phone numbers you don't know. Once the numbers are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this number?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/whatsapp:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them message the number; you'll
   approve each with `/whatsapp:access pair <code>`. Run this skill again
   once everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"Message your PipesBot number to capture your own phone number first.
   Then we'll add anyone else and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to give you their phone
   number, or you can briefly flip to pairing:
   `/whatsapp:access policy pairing` → they message → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `<key>` — save it

1. Treat `$ARGUMENTS` as the API key (trim whitespace). PipesBot keys start
   with `pk_`.
2. `mkdir -p ~/.claude/channels/whatsapp`
3. Read existing `.env` if present; update/add the `PIPESBOT_API_KEY=` line,
   preserve other keys. Write back, no quotes around the value.
4. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove the API key

Delete the `PIPESBOT_API_KEY=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. API key changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/whatsapp:access` take effect immediately, no restart.
