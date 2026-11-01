import { readFileSync } from 'fs'
import { basename } from 'path'
import { isBsuid } from './trust'
import { unsupportedFileType, whatsappMimeFor } from './media'

export type Target = { poolNumberId: string; to: string; conversationId?: string }
export type SendOutcome = { messageId?: string }
export type Send = (frame: object) => boolean
export type Log = (msg: string) => void

export interface Transport {
  sendText(t: Target, text: string): Promise<SendOutcome>
  sendFile(t: Target, path: string): Promise<SendOutcome>
  react(t: Target, messageId: string, emoji: string): Promise<SendOutcome>
  /** Returns true when the frame was consumed by this transport. */
  handleFrame(frame: unknown): boolean
  onDisconnect(): void
}

// BSUID recipients go in `recipient`; phone numbers in `to`.
export function recipientField(to: string): { to: string } | { recipient: string } {
  return isBsuid(to) ? { recipient: to } : { to }
}

export const POOL_UNSUPPORTED = 'not supported on pool numbers — the server ignores this frame'

export class PoolTransport implements Transport {
  constructor(private send: Send, private log: Log) {}

  async sendText(t: Target, text: string): Promise<SendOutcome> {
    if (!t.conversationId) throw new Error('conversation_id is required for pool numbers')
    const ok = this.send({
      type: 'whatsapp_reply',
      data: { conversationId: t.conversationId, poolNumberId: t.poolNumberId, toNumber: t.to, text },
    })
    if (!ok) throw new Error('WebSocket not connected')
    return {}
  }

  async sendFile(_t: Target, _path: string): Promise<SendOutcome> {
    throw new Error(POOL_UNSUPPORTED)
  }

  async react(_t: Target, _messageId: string, _emoji: string): Promise<SendOutcome> {
    throw new Error(POOL_UNSUPPORTED)
  }

  handleFrame(frame: unknown): boolean {
    const f = frame as { type?: unknown; data?: any } | null
    if (!f || f.type !== 'reply_status' || !f.data) return false
    const { data } = f
    if (data.success) {
      this.log(`reply delivered to ${data.conversationId} (messageId: ${data.messageId})`)
    } else {
      this.log(`reply failed for ${data.conversationId}: [${data.code ?? 'UNKNOWN'}] ${data.error ?? 'unknown error'}`)
    }
    return true
  }

  onDisconnect(): void {}
}

export const SEND_TIMEOUT_MS = 15_000

export type AppV2Deps = {
  send: Send
  log: Log
  apiKey: string
  apiBase: string
  fetch?: typeof fetch
  readFile?: (p: string) => Uint8Array
  newRequestId?: () => string
  timeoutMs?: number
}

type Pending = {
  resolve: (o: SendOutcome) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class AppV2Transport implements Transport {
  private pending = new Map<string, Pending>()
  private fetchFn: typeof fetch
  private readFile: (p: string) => Uint8Array
  private newRequestId: () => string
  private timeoutMs: number

  constructor(private deps: AppV2Deps) {
    this.fetchFn = deps.fetch ?? fetch
    this.readFile = deps.readFile ?? (p => readFileSync(p))
    this.newRequestId = deps.newRequestId ?? (() => crypto.randomUUID())
    this.timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS
  }

  sendText(t: Target, text: string): Promise<SendOutcome> {
    return this.request(t, { type: 'text', text: { body: text } })
  }

  react(t: Target, messageId: string, emoji: string): Promise<SendOutcome> {
    return this.request(t, { type: 'reaction', reaction: { message_id: messageId, emoji } })
  }

  async sendFile(t: Target, path: string): Promise<SendOutcome> {
    const mimeType = whatsappMimeFor(path)
    if (mimeType === null) throw new Error(unsupportedFileType(path))
    const bytes = this.readFile(path)
    const res = await this.fetchFn(`${this.deps.apiBase}/v1/messages/app/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.deps.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poolNumberId: t.poolNumberId,
        to: t.to,
        media: Buffer.from(bytes).toString('base64'),
        mimeType,
        fileName: basename(path),
      }),
    })
    if (!res.ok) throw new Error(`send failed: HTTP ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { messageId?: string }
    return { messageId: body.messageId }
  }

  handleFrame(frame: unknown): boolean {
    const f = frame as { type?: unknown; requestId?: unknown; success?: unknown; messageId?: string; error?: any } | null
    if (!f || f.type !== 'send_result') return false
    const id = typeof f.requestId === 'string' ? f.requestId : undefined
    const entry = id === undefined ? undefined : this.pending.get(id)
    if (id === undefined || !entry) {
      this.deps.log(`send_result for unknown request ${String(f.requestId)}`)
      return true
    }
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (f.success) {
      entry.resolve({ messageId: f.messageId })
    } else {
      const e = f.error
      const details = e?.error_data?.details ? ` — ${e.error_data.details}` : ''
      entry.reject(new Error(`send failed: [${e?.code ?? 'UNKNOWN'}] ${e?.message ?? 'unknown error'}${details}`))
    }
    return true
  }

  onDisconnect(): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(new Error('WebSocket disconnected'))
    }
  }

  private request(t: Target, content: object): Promise<SendOutcome> {
    const requestId = this.newRequestId()
    return new Promise<SendOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`no send_result within ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      const ok = this.deps.send({
        type: 'send',
        requestId,
        poolNumberId: t.poolNumberId,
        message: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...recipientField(t.to),
          ...content,
        },
      })
      if (!ok) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new Error('WebSocket not connected'))
      }
    })
  }
}
