# WhatsApp Channel for Claude Code

Bridge WhatsApp messages to Claude Code via [PipesBot](https://pipes.bot).

## Setup

### 1. Get a PipesBot API Key

Sign up at [pipes.bot](https://pipes.bot) and create an API key (starts with `pk_`).

### 2. Install the Plugin

Clone this repo and install as a Claude Code plugin:

```bash
git clone <this-repo> ~/projects/pipes-bot-claude-code-channel
```

Then add it via Claude Code's plugin system.

### 3. Configure

```
/whatsapp:configure pk_your_api_key_here
```

This saves the key to `~/.claude/channels/whatsapp/.env`.

## Architecture

Single-file MCP server (`server.ts`) that:

- Connects to `wss://api.pipes.bot/ws` via WebSocket
- Receives WhatsApp messages and delivers them as MCP channel notifications
- Exposes `reply` and `react` tools for Claude to respond

## Tools

| Tool | Description |
|---|---|
| `reply` | Send a text reply (with optional file attachments) |
| `react` | Add an emoji reaction to a message |

## Skills

| Skill | Description |
|---|---|
| `/whatsapp:configure` | Set API key and review channel status |

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
