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
