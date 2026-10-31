# WhatsApp plugin: BYON on API v2 + trusted senders

Date: 2026-10-31
Status: approved design, pending spec review
Plugin: `plugins/whatsapp`

## Goal

Let the WhatsApp channel run on the user's own WhatsApp Business number (BYON) using a
PipesBot App on API v2 (`ak_` key), alongside today's shared pool numbers (`pk_` key), and
gate inbound messages on a list of trusted senders.

## Why

- Pool numbers are gated by the server: a pool number only routes messages from the phone
  that activated it. BYON numbers route **every** sender to the App. Anyone who knows the
  number could inject prompts into a Claude Code session that can run tools on the user's
  machine. The allowlist removed in `996c304` must come back for BYON, and it must match
  WhatsApp users who hide their phone behind a username (BSUID).
- The server never handled `whatsapp_media_reply` or `whatsapp_reaction`
  (`pipes-bot/apps/server/src/lib/ws-hub.ts` only handles `whatsapp_reply` and `send`).
  Today `reply` with files and `react` report success and deliver nothing. API v2 makes
  both deliverable. The pipes-bot v2 spec
  (`pipes-bot/docs/superpowers/specs/2026-10-06-whatsapp-bsuid-byon-v2-design.md`) lists
  this plugin's move to v2 as a follow-up.

## Decisions

| Topic | Decision |
|---|---|
| Credential modes | `pk_` → **pool** (current protocol). `ak_` → **app-v2**. Legacy `ak_` Apps are not supported |
| Trust model | Static list managed with `/whatsapp:configure trust …`. No pairing flow |
| Empty list | app-v2: drop everything (fail closed). pool: allow everyone (unchanged behavior) |
| Structure | Split `server.ts` into small modules behind one `Transport` interface |
| `pk_` files/reactions | Fail with an explicit error instead of the current silent no-op |

## Architecture

```
plugins/whatsapp/
  server.ts        MCP server, tool handlers, inbound pipeline, startup
  config.ts        .env loading, mode from key prefix, state paths
  trust.ts         trusted.json read, normalization, isTrusted()
  inbound.ts       InboundMessage type, pool whatsapp_message parser, shared body formatting
  inbound-v2.ts    v2 `event` envelope -> InboundMessage[]
  outbound.ts      Transport interface, PoolTransport, AppV2Transport
  ws.ts            WebSocket connection, heartbeat, reconnect (moved from server.ts)
  media.ts         downloadMedia (moved from server.ts)
  test/            bun tests + fixtures
```

Each module has one job. Parsers and `trust.ts` are pure, apart from the trust file read,
which is injectable for tests. `server.ts` only sees `InboundMessage` and `Transport`.

## Config (`config.ts`)

- `PIPESBOT_API_KEY` must start with `pk_` or `ak_`. The prefix sets `mode`:
  `pk_` → `pool`, `ak_` → `app-v2`. Anything else exits at boot with an error naming both
  prefixes.
- `PIPESBOT_POOL_NUMBER_ID` stays optional in both modes. It is appended to the WebSocket
  URL as `poolNumberId`; the server checks that the number belongs to the key's owner/App.
- `.env` loading is unchanged (read once at boot; real env wins).
- Boot warnings in app-v2 mode:
  - empty trust list: `BYON mode: no trusted senders — all messages will be dropped. Add one with /whatsapp:configure trust <number>.`
  - `PIPESBOT_POOL_NUMBER_ID` set: a scoped App connection does not drain the offline
    queue, so messages received while Claude Code was closed are not replayed.

## Trust (`trust.ts`)

### Storage

`~/.claude/channels/whatsapp/trusted.json`:

```json
{ "senders": ["5511999998888", "US.13491208655302741918"] }
```

- Re-read on every inbound message, so changes apply without a restart.
- Missing file → empty list. Unparseable JSON or a missing/non-array `senders` → empty
  list plus a log line. The server never writes or moves this file.
- The configure skill writes it with mode `0600`. `assertSendable` already prevents
  `reply` from attaching files in the state directory.

### Identifiers and normalization

- A sender is `{ phone?: string; bsuid?: string }`.
- BSUID: matches `/^[A-Z]{2}\.(ENT\.)?\d+$/`. Kept exactly as written.
- Phone: anything else. Normalized by removing every non-digit character
  (`+55 (11) 99999-8888` → `5511999998888`). An entry that is empty after normalization
  is ignored.
- Entries in `trusted.json` are normalized with the same rules when read.

### `isTrusted(sender, mode, list)`

- Returns true if `sender.phone` (normalized) or `sender.bsuid` is in the list.
- Empty list: `false` in app-v2, `true` in pool.

### Gate behavior

- Untrusted message: logged to stderr as `dropped untrusted sender <phone or BSUID>`.
  Message content is never logged. No reply, no reaction, no media download.
- The "empty list in app-v2" hint is logged once per process, on the first drop.
- Identity changes: a v2 `system` message of type `user_changed_number` or
  `user_changed_user_id` whose `system.previous_user_id` is trusted produces a log line
  suggesting `/whatsapp:configure trust <new user_id>`. The list is never updated
  automatically.

## Inbound

### Common shape (`inbound.ts`)

```ts
type InboundMessage = {
  dedupeKey: string          // WhatsApp message id (wamid)
  poolNumberId: string
  messageId: string          // wamid, used by `react`
  sender: { phone?: string; bsuid?: string; name?: string }
  replyTo: string            // phone if known, else BSUID
  conversationId?: string    // pool mode only
  ts: string                 // ISO 8601
  body: string
  media?: { downloadUrl: string; mimeType: string; fileName?: string; kind: 'image' | 'file' }
}
```

### Pool parser

Today's `whatsapp_message` handling moved as-is: same type skips (`unsupported`, reaction
removal), same `resolveRawBody` formatting, same media rules. Additions:
`sender.bsuid = data.userId` when present, or `data.fromNumber` when it matches the BSUID
pattern; `sender.phone = data.fromNumber` otherwise. `replyTo = data.fromNumber`.

### v2 parser (`inbound-v2.ts`)

Input: the `data` of an `event` frame (the envelope `{ id, field, createdAt, pipes, whatsapp }`).
Output: `InboundMessage[]` plus side-effect-free notes for logging (returned, not logged
by the parser).

- `field !== "messages"` → no messages; note the field name.
- `whatsapp.statuses[]` → no messages; a status with `status === "failed"` produces a note
  with Meta's `errors[0].code` and `title`.
- Each `whatsapp.messages[]` entry:
  - `phone = from`, `bsuid = from_user_id`
  - `name`: the `contacts[]` entry where `wa_id === from` or `user_id === from_user_id`;
    use `profile.name`, else `profile.username`
  - `replyTo = from ?? from_user_id`
  - `ts`: `timestamp` is unix seconds as a string → ISO
  - `dedupeKey = messageId = id`
  - `poolNumberId = envelope.pipes.poolNumberId`
- Body by `type`:

  | Type | Body / media |
  |---|---|
  | `text` | `text.body` |
  | `image`, `audio`, `video`, `document`, `sticker` | `<type>.caption ?? ''`; media from `pipes.media[<type>.id]` with `mimeType`, `fileName` (from `document.filename` when present). `kind` is `image` for `image`, otherwise `file`. An `unavailable` or missing entry → no media and body suffixed with `(media unavailable)` |
  | `location` | same formatting as pool (`📍 Location: lat, lng`, name, address) |
  | `contacts` | same formatting as pool (`Name: phone, phone`) |
  | `reaction` | `[Reaction: <emoji>]`; empty emoji → skip (removal) |
  | `button` | `button.text` |
  | `interactive` | `interactive.button_reply.title` or `interactive.list_reply.title` |
  | `system` | not delivered; identity-change note (see Trust) |
  | `unsupported`, unknown | skipped with a note |

### Legacy frame on an `ak_` key

A `whatsapp_message` frame in app-v2 mode means the App is on the legacy API. Log once:
`this App is on the legacy API — upgrade it to v2 in the PipesBot dashboard`. Drop the
frame; keep the connection.

### Pipeline (`server.ts`)

1. Route frames: pool mode handles `whatsapp_message` and `reply_status`; app-v2 handles
   `event` and `send_result` (the latter goes to the transport).
2. Parse → `InboundMessage[]`.
3. Dedupe on `dedupeKey` with an in-memory insertion-ordered set capped at 1000 entries.
4. Trust gate.
5. Download media (existing `downloadMedia`; works with `ak_` keys).
6. Emit `notifications/claude/channel`. Meta fields:
   `pool_number_id`, `message_id`, `from_number` (= `replyTo`), `user` (= name or
   `replyTo`), `ts`, `conversation_id` (pool only), `sender_id` (BSUID, when present),
   `image_path` / `file_path` (when media downloaded).

The gate runs before media download so an untrusted sender cannot cause any network
fetch or disk write.

## Outbound (`outbound.ts`)

```ts
type Target = { poolNumberId: string; to: string; conversationId?: string }
type SendOutcome = { messageId?: string }
interface Transport {
  sendText(t: Target, text: string): Promise<SendOutcome>
  sendFile(t: Target, path: string): Promise<SendOutcome>
  react(t: Target, messageId: string, emoji: string): Promise<SendOutcome>
  handleFrame(frame: unknown): boolean   // consumes send_result / reply_status
  onDisconnect(): void
}
```

Failures throw `Error` with a message that is surfaced as the tool error.

### PoolTransport (`pk_`)

- `sendText`: `whatsapp_reply { conversationId, poolNumberId, toNumber, text }`. Resolves
  once written (current behavior). Throws if `conversationId` is missing.
  `reply_status` is logged as today.
- `sendFile`, `react`: throw `not supported on pool numbers — the server ignores this frame`.

### AppV2Transport (`ak_`)

- Recipient field: `recipient` when `to` matches the BSUID pattern, else `to`.
- `sendText`: WebSocket frame

  ```json
  {
    "type": "send",
    "requestId": "<uuid>",
    "poolNumberId": "<id>",
    "message": {
      "messaging_product": "whatsapp",
      "recipient_type": "individual",
      "to": "<phone>",
      "type": "text",
      "text": { "body": "<chunk>" }
    }
  }
  ```

  Waits for `send_result` with the same `requestId`. Timeout 15 s. `success: false` →
  throw with `error.code` and `error.message` (or Meta's error body when present).
- `react`: same frame with `type: "reaction"`, `reaction: { message_id, emoji }`.
- Pending requests live in a `Map<requestId, {resolve, reject, timer}>`. `onDisconnect`
  rejects all pending with `WebSocket disconnected`. A `send_result` with an unknown
  `requestId` is logged and dropped.
- `sendFile`:
  1. `POST https://api.pipes.bot/v1/media/upload`, multipart field `file`,
     `Authorization: Bearer <ak_>` → `{ mediaId }`.
  2. `POST https://api.pipes.bot/v1/messages/app/send` with
     `{ poolNumberId, to, media: mediaId }` → `{ messageId, contacts }`.

  Any non-2xx throws with the HTTP status and the response body.
- Not connected: `sendText`/`react` throw `WebSocket not connected` immediately.

### Tool handlers

- `reply`: unchanged validation (`assertSendable`, 50 MB per file), 4096-char chunks.
  Chunks are sent in order, each awaited; the first failure stops and reports
  `reply failed after N of M part(s) sent: <error>`. Then files, one `sendFile` each.
  Result: `sent` or `sent N parts`.
- `react`: one `transport.react` call.
- Schemas: `conversation_id` becomes optional on both tools; `pool_number_id` and
  `to_number` stay required.
- MCP `instructions`: pass `conversation_id` back only if the tag has it; `to_number` may
  be a BSUID and is passed as-is; `sender_id` is informational.

## Connection (`ws.ts`)

Moved from `server.ts` with these changes:

- 401/403 on upgrade still stops reconnecting. In app-v2 mode with
  `PIPESBOT_POOL_NUMBER_ID` set, a 403 logs that the number may not belong to this App.
- Close code `4000` (`api_version_changed`): log, reset backoff, reconnect immediately.
- On close: call `transport.onDisconnect()`.
- The connection exposes `send(obj): boolean` and an `onFrame` callback; it knows nothing
  about message types.

## Configure skill

`skills/configure/SKILL.md` gains:

- `trust <phone|BSUID>`: normalize, add to `trusted.json` if absent (create with
  `{ "senders": [] }` and mode `0600` if missing).
- `untrust <phone|BSUID>`: normalize, remove.
- `trusted`: list entries.
- No-args status adds **Mode** (pool / BYON v2, from the key prefix) and
  **Trusted senders** (count; warning when BYON and empty).
- The key argument accepts `pk_` or `ak_`.
- Notes that trust changes apply immediately, key changes need a restart.

## Errors summary

| Situation | Behavior |
|---|---|
| Bad key prefix | exit at boot |
| 401/403 on upgrade | stop reconnecting, log |
| Close 4000 | reconnect immediately |
| Untrusted sender | drop, log identifier only |
| Corrupt `trusted.json` | treat as empty, log |
| Legacy frame on `ak_` | drop, log once |
| `send_result` failure / timeout | tool error with code and message |
| REST media failure | tool error with HTTP status and body |
| Pool file/reaction | tool error, explicit |

## Testing

- `bun test`, `test` script in `package.json`, files under `plugins/whatsapp/test/`.
- Fixtures: copy `incoming-text.json`, `contact-request.json`, `status-{sent,delivered,read}-bsuid-recipient.json` and `send-response-bsuid.json` from
  `pipes-bot/apps/server/src/lib/__fixtures__/meta/live/` (anonymized real v2 traffic),
  wrapped in envelopes. Hand-built envelopes for: image with `pipes.media`, unavailable
  media, reaction, reaction removal, button reply, interactive list reply, `system`
  identity change, non-`messages` field, failed status. A pool `whatsapp_message` sample.
- Unit tests:
  - `trust`: normalization, BSUID passthrough, either-identifier match, empty list per
    mode, missing file, corrupt file.
  - `inbound-v2`: every type above, statuses skipped, failed status note, media lookup,
    name fallback, system not delivered.
  - `inbound` (pool): current behavior, BSUID mapping.
  - `AppV2Transport`: `to` vs `recipient`, frame shapes, `send_result` correlation,
    timeout, disconnect rejection, two-step REST file send with mocked `fetch`.
  - Pipeline: untrusted sender → no download, no notification; duplicate → one notification.
- Manual end-to-end on a v2 App with a BYON number: trusted phone sends text, image,
  reaction (all reach Claude); Claude replies with text and a file and reacts; an
  untrusted phone is dropped and logged; a BSUID-only sender if available; a `pk_`
  regression pass.

## Docs and version

- `plugins/whatsapp/README.md` and root `README.md`: BYON v2 setup, trust, corrected tool
  tables (pool: no files or reactions), new architecture section.
- `plugin.json` → `0.1.0`.

## Out of scope

- Legacy `ak_` Apps.
- Automatic trust migration on identity changes.
- Pairing flow.
- Surfacing delivery statuses to Claude.
- Server changes (e.g. API version in the `connected` frame).
