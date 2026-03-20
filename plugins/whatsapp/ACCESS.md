# WhatsApp Channel — Access Control

## DM Policies

The `dmPolicy` field in `~/.claude/channels/whatsapp/access.json` controls how
inbound WhatsApp messages are handled:

| Policy | Behavior |
|---|---|
| `pairing` | Unknown senders get a 6-char code. The user approves via `/whatsapp:access pair <code>`. Approved numbers are added to `allowFrom`. |
| `allowlist` | Only numbers in `allowFrom` are delivered. Unknown senders are silently dropped. |
| `disabled` | All inbound messages are dropped. |

Default: `pairing`.

## Phone Number IDs

WhatsApp identifies users by phone number in E.164 format (e.g., `+1234567890`).
These are stable across devices and don't change when a user gets a new phone.

## Pairing Flow

1. Unknown user sends a message to your PipesBot WhatsApp number.
2. Server generates a 6-char hex code and replies with pairing instructions.
3. User runs `/whatsapp:access pair <code>` in Claude Code.
4. The skill adds the phone number to `allowFrom` and drops a file in
   `~/.claude/channels/whatsapp/approved/<phoneNumber>`.
5. Server polls the `approved/` directory and sends a confirmation message.

Pairing codes expire after 1 hour. Maximum 3 pending pairings at once.
Each pending sender gets at most 2 replies (initial + reminder).

## Delivery Config

Optional fields in `access.json`:

- `ackReaction` — emoji to react with on message receipt (e.g., `"👀"`). Empty
  string disables.
- `textChunkLimit` — max characters per outbound message (default: 4096).
- `chunkMode` — `"length"` (hard cut) or `"newline"` (prefer paragraph
  boundaries).
