import { realpathSync, statSync } from 'fs'
import { join, sep } from 'path'
import { unsupportedFileType, whatsappMimeFor } from './media'
import type { Target, Transport } from './outbound'

const TEXT_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export const INSTRUCTIONS = [
  'The sender reads WhatsApp on their phone, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
  '',
  'Messages from WhatsApp arrive as <channel source="whatsapp" pool_number_id="..." message_id="..." from_number="..." user="..." ts="...">, with conversation_id="..." on pool numbers and sender_id="..." when the sender has a WhatsApp BSUID. If the tag has an image_path or file_path attribute, Read that file — it is media the sender attached. Reply with the reply tool — pass pool_number_id back, pass from_number as to_number unchanged (it may be a BSUID such as BR.123… instead of a phone number), and pass conversation_id back only when the tag has one. sender_id is informational; you never need to pass it.',
  '',
  'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions. File attachments and reactions work on BYON (API v2) numbers only.',
  '',
  'WhatsApp has no message history API — you only see messages as they arrive. If you need earlier context, ask the user to paste or summarize.',
].join('\n')

const target = {
  conversation_id: {
    type: 'string',
    description: 'From the inbound tag, only when it has one (pool numbers). Omit otherwise.',
  },
  pool_number_id: { type: 'string' },
  to_number: {
    type: 'string',
    description: 'The inbound from_number, unchanged: a phone number or a BSUID.',
  },
}

export const TOOLS: Array<{ name: string; description: string; inputSchema: object }> = [
  {
    name: 'reply',
    description:
      'Reply on WhatsApp. Pass pool_number_id and to_number (the inbound from_number) from the inbound message, and conversation_id when the message has one. Optionally pass files (absolute paths) to attach images or documents — file attachments work on BYON (API v2) numbers only.',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        text: { type: 'string' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to attach. Max 50MB each. BYON (API v2) numbers only.',
        },
      },
      required: ['pool_number_id', 'to_number', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a WhatsApp message. Reactions work on BYON (API v2) numbers only.',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['pool_number_id', 'to_number', 'message_id', 'emoji'],
    },
  },
]

// Prevent sending channel state files (except inbox contents).
export function assertSendable(f: string, stateDir: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(stateDir)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit))
  return out
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

type ToolDeps = { transport: Transport; stateDir: string; statSize?: (p: string) => number }

function text(t: string, isError?: boolean): ToolResult {
  return isError ? { content: [{ type: 'text', text: t }], isError } : { content: [{ type: 'text', text: t }] }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function targetOf(args: Record<string, unknown>): Target {
  return {
    poolNumberId: args.pool_number_id as string,
    to: args.to_number as string,
    conversationId: args.conversation_id as string | undefined,
  }
}

async function reply(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolResult> {
  const statSize = deps.statSize ?? (p => statSync(p).size)
  const t = targetOf(args)
  const files = (args.files as string[] | undefined) ?? []
  const body = typeof args.text === 'string' ? args.text : ''

  // Everything that can be checked locally is checked before the first part goes out.
  if (files.length > 0 && !deps.transport.supportsFiles) {
    return text('reply failed: file attachments are not supported on pool numbers — nothing was sent', true)
  }
  for (const f of files) {
    assertSendable(f, deps.stateDir)
    if (whatsappMimeFor(f) === null) throw new Error(unsupportedFileType(f))
    const size = statSize(f)
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  // Blank text alongside files means "just the files".
  const chunks = body.trim() === '' ? [] : chunk(body, TEXT_CHUNK_LIMIT)
  if (chunks.length === 0 && files.length === 0) throw new Error('text is empty')

  const total = chunks.length + files.length
  let sentCount = 0
  const partial = (msg: string) => text(`reply failed after ${sentCount} of ${total} part(s) sent: ${msg}`, true)

  for (const c of chunks) {
    try {
      await deps.transport.sendText(t, c)
    } catch (err) {
      return partial(errorMessage(err))
    }
    sentCount++
  }

  for (const f of files) {
    try {
      await deps.transport.sendFile(t, f)
    } catch (err) {
      return partial(`file attachment failed for ${f}: ${errorMessage(err)}`)
    }
    sentCount++
  }

  return text(sentCount === 1 ? 'sent' : `sent ${sentCount} parts`)
}

export async function callTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolResult> {
  try {
    switch (name) {
      case 'reply':
        return await reply(args, deps)
      case 'react':
        await deps.transport.react(targetOf(args), args.message_id as string, args.emoji as string)
        return text('reacted')
      default:
        return text(`unknown tool: ${name}`, true)
    }
  } catch (err) {
    return text(`${name} failed: ${errorMessage(err)}`, true)
  }
}
