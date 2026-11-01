#!/usr/bin/env bun
/**
 * WhatsApp channel for Claude Code via PipesBot.
 *
 * Self-contained MCP server, wiring only. The PipesBot API key picks the mode:
 *   - pk_ (pool number): every sender reaches Claude unless trusted.json has
 *     entries; replies go out as `whatsapp_reply` frames.
 *   - ak_ (BYON App on API v2): only senders in ~/.claude/channels/whatsapp/trusted.json
 *     reach Claude; replies, reactions and files go out as v2 `send` frames / app/send.
 *
 * Connects to wss://api.pipes.bot/ws to receive WhatsApp messages and send replies.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  API_BASE,
  ENV_FILE,
  STATE_DIR,
  TRUST_FILE,
  bootWarnings,
  buildWsUrl,
  loadEnvFile,
  parseConfig,
} from './config'
import { readTrustList } from './trust'
import { downloadMedia } from './media'
import { AppV2Transport, PoolTransport, type Send, type Transport } from './outbound'
import { createConnection } from './ws'
import { createFrameRouter, createInboundPipeline } from './pipeline'
import { INSTRUCTIONS, TOOLS, callTool } from './tools'

function log(msg: string): void {
  process.stderr.write(`whatsapp channel: ${msg}\n`)
}

// ── Config ──────────────────────────────────────────────────────────────────

loadEnvFile(ENV_FILE, process.env)
const parsed = parseConfig(process.env)
if ('error' in parsed) {
  process.stderr.write(`whatsapp channel: ${parsed.error}\n`)
  process.exit(1)
}
const config = parsed

for (const warning of bootWarnings(config, readTrustList(TRUST_FILE, log).size)) log(warning)

// ── Transport ───────────────────────────────────────────────────────────────

// The transport is built before the connection exists; `conn` is assigned at startup.
let conn: { send: Send } | null = null
const send: Send = f => conn?.send(f) ?? false

const transport: Transport =
  config.mode === 'pool'
    ? new PoolTransport(send, log)
    : new AppV2Transport({ send, log, apiKey: config.apiKey, apiBase: API_BASE })

// ── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: INSTRUCTIONS,
  },
)

// TOOLS types inputSchema as a plain object; the SDK's result type wants its JSON-schema shape.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }) as any)

mcp.setRequestHandler(CallToolRequestSchema, async req =>
  callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
    transport,
    stateDir: STATE_DIR,
  }),
)

// ── Inbound ─────────────────────────────────────────────────────────────────

const pipeline = createInboundPipeline({
  mode: config.mode,
  readTrust: () => readTrustList(TRUST_FILE, log),
  download: m => downloadMedia(m, config.apiKey),
  notify: (content, meta) => {
    mcp
      .notification({ method: 'notifications/claude/channel', params: { content, meta } })
      .catch(err => log(`channel notification failed: ${err instanceof Error ? err.message : String(err)}`))
  },
  log,
})

const router = createFrameRouter({ mode: config.mode, pipeline, transport, log })

// ── Startup ─────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
conn = createConnection({
  url: buildWsUrl(config),
  mode: config.mode,
  poolNumberId: config.poolNumberId,
  onFrame: router,
  onDisconnect: () => transport.onDisconnect(),
  log,
})
