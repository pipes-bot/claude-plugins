import { EMPTY_TRUST_WARNING, type Mode } from './config'
import { describeSender, isTrusted, normalizeId } from './trust'
import {
  frameType,
  parsePoolMessage,
  withMediaUnavailable,
  type InboundMedia,
  type InboundMessage,
  type PoolMessageData,
} from './inbound'
import { parseV2Event, type IdentityChange, type V2Envelope } from './inbound-v2'
import type { Log, Transport } from './outbound'

export const DEDUPE_CAP = 1000

export type Notify = (content: string, meta: Record<string, string>) => void

export type PipelineDeps = {
  mode: Mode
  readTrust: () => Set<string>
  download: (m: InboundMedia) => Promise<string | null>
  notify: Notify
  log: Log
}

/**
 * Per message: dedupe → trust gate → media download → notification. The gate runs
 * before the download, so an untrusted sender causes no fetch, no disk write, and
 * no log of its content — only its identifier.
 */
export function createInboundPipeline(deps: PipelineDeps): {
  deliver(msgs: InboundMessage[]): Promise<void>
  identityChanges(changes: IdentityChange[]): void
} {
  const { mode, log } = deps
  // A Set iterates in insertion order, so its first entry is the oldest.
  const seen = new Set<string>()
  let emptyHintLogged = false

  function isDuplicate(key: string): boolean {
    if (seen.has(key)) return true
    seen.add(key)
    if (seen.size > DEDUPE_CAP) seen.delete(seen.values().next().value!)
    return false
  }

  async function deliverOne(m: InboundMessage): Promise<void> {
    if (!m.replyTo) {
      log(`skipping message without sender id [id=${m.messageId}]`)
      return
    }
    if (isDuplicate(m.dedupeKey)) return

    const trust = deps.readTrust()
    if (!isTrusted(m.sender, mode, trust)) {
      log(`dropped untrusted sender ${describeSender(m.sender)}`)
      if (mode === 'app-v2' && trust.size === 0 && !emptyHintLogged) {
        emptyHintLogged = true
        log(EMPTY_TRUST_WARNING)
      }
      return
    }

    let content = m.body
    let mediaMeta: Record<string, string> = {}
    if (m.media) {
      const path = await deps.download(m.media)
      if (path) mediaMeta = { [m.media.kind === 'image' ? 'image_path' : 'file_path']: path }
      else content = withMediaUnavailable(content)
    }

    const meta: Record<string, string> = {
      pool_number_id: m.poolNumberId,
      message_id: m.messageId,
      from_number: m.replyTo,
      user: m.sender.name ?? m.replyTo,
      ts: m.ts,
    }
    if (m.conversationId) meta.conversation_id = m.conversationId
    if (m.sender.bsuid) meta.sender_id = m.sender.bsuid
    deps.notify(content, { ...meta, ...mediaMeta })
  }

  return {
    async deliver(msgs) {
      for (const m of msgs) await deliverOne(m)
    },
    // The list is never updated automatically; a trusted sender's new ID only gets a hint.
    identityChanges(changes) {
      const trust = deps.readTrust()
      for (const c of changes) {
        const previous = normalizeId(c.previousUserId)
        if (previous === null || !trust.has(previous)) continue
        log(
          `trusted sender ${c.previousUserId} changed WhatsApp ID — run /whatsapp:configure trust ${c.userId ?? c.waId} to keep receiving their messages`,
        )
      }
    },
  }
}

const LEGACY_API_WARNING = 'this App is on the legacy API — upgrade it to v2 in the PipesBot dashboard'

/**
 * Route one WebSocket frame. Pool mode handles `whatsapp_message`; app-v2 handles
 * `event` (and logs a legacy `whatsapp_message` once). Everything else goes to the
 * transport (`reply_status`, `send_result`). Never rejects: errors are logged.
 */
export function createFrameRouter(deps: {
  mode: Mode
  pipeline: ReturnType<typeof createInboundPipeline>
  transport: Transport
  log: Log
}): (frame: unknown) => Promise<void> {
  const { mode, pipeline, transport, log } = deps
  let legacyLogged = false

  async function route(frame: unknown): Promise<void> {
    const type = frameType(frame)
    // frameType is non-null only for objects, so reading `data` is safe then.
    const data = type === null ? undefined : (frame as { data?: unknown }).data

    if (mode === 'app-v2' && type === 'event') {
      const result = parseV2Event(data as V2Envelope)
      for (const note of result.notes) log(note)
      await pipeline.deliver(result.messages)
      pipeline.identityChanges(result.identityChanges)
      return
    }

    if (type === 'whatsapp_message') {
      if (mode === 'app-v2') {
        if (!legacyLogged) {
          legacyLogged = true
          log(LEGACY_API_WARNING)
        }
        return
      }
      const d = data as PoolMessageData
      log(`inbound [id=${d.messageId}] [type=${d.type}] from=${d.fromNumber}`)
      const m = parsePoolMessage(d)
      if (!m) {
        log(d.type === 'unsupported' ? `skipping unsupported message type [id=${d.messageId}]` : `skipping reaction removal [id=${d.messageId}]`)
        return
      }
      await pipeline.deliver([m])
      return
    }

    transport.handleFrame(frame)
  }

  return async frame => {
    try {
      await route(frame)
    } catch (err) {
      log(`frame handler error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
