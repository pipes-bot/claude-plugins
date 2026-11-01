# WhatsApp Channel for Claude Code

Bridge WhatsApp messages to Claude Code via [PipesBot](https://pipes.bot).

## Setup

The PipesBot API key picks the mode:

| Key | Mode | What you get |
|---|---|---|
| `pk_…` | Pool number — PipesBot's shared number | Text replies only (inbound media works; outbound files and reactions are BYON-only). File attachments and reactions return an error. Everyone reaches Claude unless you add [trusted senders](#trusted-senders). |
| `ak_…` | BYON App on PipesBot API v2 — your own WhatsApp number | Text, files and reactions. Only [trusted senders](#trusted-senders) reach Claude. |

### 1. Get a PipesBot API Key

Sign up at [pipes.bot](https://pipes.bot).

- **Pool number**: create an API key (starts with `pk_`).
- **BYON**: create an App, make sure it is on **API v2**, connect your WhatsApp
  number to it, and use the App's API key (starts with `ak_`).

### 2. Install the Plugin

Clone this repo and install as a Claude Code plugin:

```bash
git clone <this-repo> ~/projects/pipes-bot-claude-code-channel
```

Then add it via Claude Code's plugin system.

### 3. Configure

Pool number:

```
/whatsapp:configure pk_your_api_key_here
```

BYON:

```
/whatsapp:configure ak_your_api_key_here
/whatsapp:configure trust <your number>
```

The key is saved to `~/.claude/channels/whatsapp/.env`. Key changes need
`/reload-plugins` or a restart. On BYON, until you trust at least one sender
every inbound message is dropped.

## Trusted senders

A WhatsApp number can be messaged by anyone, so BYON only lets senders listed in
`~/.claude/channels/whatsapp/trusted.json` reach Claude. On pool numbers the list
is optional: empty means everyone the server delivers (your activated phone) gets
through, and once you add entries only those senders do, same as BYON.

```json
{ "senders": ["5511912345678", "BR.1234567890"] }
```

- Entries are phone numbers or WhatsApp BSUIDs (such as `BR.1234567890`).
  Phone numbers are compared as digits only, so `+55 11 91234-5678` and
  `5511912345678` are the same entry.
- The file is re-read on every message: `/whatsapp:configure trust`,
  `untrust` and `trusted` (or editing the file by hand) apply immediately.
- A missing or malformed file counts as an empty list. An empty list drops
  everything on BYON and allows everyone on a pool number. Messages from untrusted senders are dropped before any media
  is downloaded, and only the sender's ID is logged, never the content.
- If a sender you trust changes their WhatsApp ID, the log suggests the
  `trust` command to add the new one. The list is never updated automatically.

Manage the list with `/whatsapp:configure`:

| Command | Effect |
|---|---|
| `trust <phone\|BSUID>` | Add a sender |
| `untrust <phone\|BSUID>` | Remove a sender |
| `trusted` | List trusted senders |

Brazilian numbers: WhatsApp's ID for a number may lack the 9th digit. The
server compares the exact ID, so if a message is dropped, look for
`dropped untrusted sender <id>` in the MCP log and trust that ID.

## Architecture

An MCP server split into small modules, with `server.ts` only wiring them together:

- `server.ts` — MCP server entry point; loads config and connects the pieces
- `config.ts` — `.env` loading, mode from the key prefix, WebSocket URL, boot warnings
- `trust.ts` — `trusted.json` reading, ID normalization, the trust gate
- `ws.ts` — WebSocket connection with reconnect, close-code handling and key redaction
- `inbound.ts` / `inbound-v2.ts` — parse pool and API v2 inbound messages
- `pipeline.ts` — dedupe, trust gate, media download, channel notifications; frame routing
- `outbound.ts` — pool and API v2 transports for replies, files and reactions
- `media.ts` — authenticated inbound media download into `~/.claude/channels/whatsapp/inbox/`
- `tools.ts` — the `reply` and `react` tool definitions and handlers

It connects to `wss://api.pipes.bot/ws`, delivers WhatsApp messages as MCP channel
notifications, and exposes `reply` and `react` tools for Claude to respond.

## Tools

| Tool | Description |
|---|---|
| `reply` | Send a text reply. Optional file attachments (BYON only, max 50 MB each) |
| `react` | Add an emoji reaction to a message (BYON only) |

On a pool number, a `reply` with `files` or a `react` call returns an error, and nothing
is sent. On BYON, attachments must be a type WhatsApp accepts: PDF, Office (doc/docx,
xls/xlsx, ppt/pptx), text (txt, md, csv, log, json — sent as plain text), JPEG/PNG,
WebP (sent as a sticker), MP4/3GP, or common audio (aac, amr, m4a, mp3, ogg/opus).
Other types (GIF, ZIP, …) are refused before anything is sent.

## Skills

| Skill | Description |
|---|---|
| `/whatsapp:configure` | Set API key, manage trusted senders, review channel status |

## Dependencies

- [Bun](https://bun.sh) runtime
- `@modelcontextprotocol/sdk` — MCP protocol
- `ws` — WebSocket client (needed for ping/pong support)

## Troubleshooting

### Running `server.ts` by hand consumes queued messages

Undelivered WhatsApp messages are queued server-side and flushed to the first
client that connects. A manually started server **is** that client — it
acknowledges the backlog, and those messages are never delivered to your real
Claude Code session afterwards.

Only run the server directly if you accept losing whatever is queued.

### The channel never connects

Check the MCP logs:

```
~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-plugin-whatsapp-whatsapp/*.jsonl
```

`Script not found "start"` there means the server was launched from the wrong
directory. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in an MCP server's
`command`, `args`, and `env` — but **not** in `cwd`, which is passed through
verbatim. Point at the plugin root from `args` instead:

```json
{ "command": "bun", "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"] }
```

### The channel keeps reconnecting and never receives anything

Under Bun, a rejected WebSocket handshake (a bad API key, or a
`PIPESBOT_POOL_NUMBER_ID` that is not in the App) does not stop the server; it
keeps retrying with backoff. After 3 rejections in a row the log says:

```
WebSocket handshake rejected 3 times in a row — check PIPESBOT_API_KEY…
```

Check the key with `/whatsapp:configure` and, if you set one, the pool number ID.
Keys are redacted in these log lines.

### Messages from a trusted sender are dropped

The log line `dropped untrusted sender <id>` shows the ID the server saw.
Run `/whatsapp:configure trust <id>` with exactly that value (see
[Trusted senders](#trusted-senders)). If the list is empty the log also says
`BYON mode: no trusted senders — all messages will be dropped`.

### Inbound media arrives as `(media unavailable)`

Downloading inbound media on BYON needs the pipes-bot fix that lets App keys
(`ak_`) download their own App's media (pipes-bot PR #72, commit `87eb508`) to be
deployed. Until then those messages arrive with `(media unavailable)` instead of an
`image_path` / `file_path`.

### No messages from while Claude Code was closed

On BYON, setting `PIPESBOT_POOL_NUMBER_ID` scopes the connection to one number,
and a number-scoped connection does not drain the offline queue, so messages
received while Claude Code was closed are not replayed. Remove it with
`/whatsapp:configure pool clear` to get the backlog.
