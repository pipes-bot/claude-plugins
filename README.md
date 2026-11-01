# pipes-bot-claude-plugins

Claude Code plugins that bridge messaging platforms to Claude Code via [PipesBot](https://pipes.bot).

## Plugins

| Plugin | Description | Version |
|--------|-------------|---------|
| [WhatsApp](./plugins/whatsapp) | Receive and reply to WhatsApp messages directly from Claude Code | 0.1.0 |

## Installation

### From the marketplace

```bash
claude plugin install pipes-bot/claude-plugins --plugin whatsapp
```

### From source

```bash
git clone https://github.com/pipes-bot/claude-plugins.git
cd claude-plugins
claude plugin install ./plugins/whatsapp
```

## Quick start

Once the WhatsApp plugin is installed:

1. Get an API key from [pipes.bot](https://pipes.bot). The prefix picks the mode:
   - `pk_` — PipesBot's shared pool number (text only)
   - `ak_` — your own WhatsApp number as a BYON App on API v2 (text, files, reactions)
2. Run `/whatsapp:configure pk_your_api_key_here` (or `ak_…`)
3. On BYON, run `/whatsapp:configure trust <your number>` — only trusted senders reach Claude
4. Send a WhatsApp message to your PipesBot number

See the [WhatsApp plugin README](./plugins/whatsapp/README.md) for full setup and usage details.

## Plugin overview

### WhatsApp

A real-time WhatsApp channel powered by an MCP server that connects to PipesBot via WebSocket. Features include:

- **Messaging** — send and receive text, images, audio, video, documents, locations, and contacts
- **Two modes** — a shared pool number (`pk_` key) or your own number as a BYON App on API v2 (`ak_` key)
- **Trusted senders** — only senders in `~/.claude/channels/whatsapp/trusted.json` reach Claude (required on BYON, optional on pool numbers)
- **Reactions** — react to messages with emoji (BYON only)
- **Smart chunking** — long messages are automatically split

#### Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a text reply; file attachments (max 50 MB each) are BYON only |
| `react` | Add an emoji reaction to a message (BYON only) |

#### Skills

| Skill | Description |
|-------|-------------|
| `/whatsapp:configure` | Set up API key, manage trusted senders, review configuration |

## Requirements

- [Bun](https://bun.sh) runtime
- A PipesBot API key ([pipes.bot](https://pipes.bot))

## License

See [LICENSE](./LICENSE) for details.
