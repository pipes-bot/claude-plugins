import { isBsuid } from './trust'

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
