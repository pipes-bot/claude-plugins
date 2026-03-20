# pipes-bot-claude-plugins

Claude Code plugins that bridge messaging platforms to Claude Code via [PipesBot](https://pipes.bot).

## Plugins

| Plugin | Description | Version |
|--------|-------------|---------|
| [WhatsApp](./plugins/whatsapp) | Receive and reply to WhatsApp messages directly from Claude Code | 0.0.1 |

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

1. Get an API key from [pipes.bot](https://pipes.bot) (starts with `pk_`)
2. Run `/whatsapp:configure pk_your_api_key_here`
3. Send a WhatsApp message to your PipesBot number
4. Approve the pairing: `/whatsapp:access pair <code>`
5. Lock down access: `/whatsapp:access policy allowlist`

See the [WhatsApp plugin README](./plugins/whatsapp/README.md) for full setup and usage details.

## Plugin overview

### WhatsApp

A real-time WhatsApp channel powered by an MCP server that connects to PipesBot via WebSocket. Features include:

- **Messaging** — send and receive text, images, audio, video, documents, locations, and contacts
- **Reactions** — react to messages with emoji
- **Access control** — pairing flow, phone number allowlists, and DM policies
- **Smart chunking** — long messages are split at paragraph boundaries
- **Security** — prompt injection protection, rate limiting, pairing code expiration

#### Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a text reply with optional file attachments (max 50 MB each) |
| `react` | Add an emoji reaction to a message |

#### Skills

| Skill | Description |
|-------|-------------|
| `/whatsapp:configure` | Set up API key and review configuration |
| `/whatsapp:access` | Manage access control — pairings, allowlists, DM policies |

## Requirements

- [Bun](https://bun.sh) runtime
- A PipesBot API key ([pipes.bot](https://pipes.bot))

## License

See [LICENSE](./LICENSE) for details.
