import {
  formatContacts,
  formatLocation,
  withMediaUnavailable,
  type InboundMedia,
  type InboundMessage,
} from './inbound'

export type V2Media = {
  mediaId?: string
  downloadUrl?: string
  mimeType?: string
  byteSize?: number
  unavailable?: boolean
}

export type V2Envelope = {
  id: string
  field: string
  createdAt: string
  pipes: { appId: string; poolNumberId: string; media?: Record<string, V2Media> }
  whatsapp: Record<string, any>
}

// previousPhone is the system message's `from`: the number the sender used before.
export type IdentityChange = { previousUserId?: string; previousPhone?: string; userId?: string; waId?: string }

export type V2Result = { messages: InboundMessage[]; notes: string[]; identityChanges: IdentityChange[] }

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker']
const IDENTITY_CHANGE_TYPES = ['user_changed_number', 'user_changed_user_id']

/**
 * Parse one API v2 `event` envelope (Meta's `change.value` under `whatsapp`) into the
 * shared inbound shape. Pure: anything worth logging is returned in `notes`.
 */
export function parseV2Event(env: V2Envelope): V2Result {
  const result: V2Result = { messages: [], notes: [], identityChanges: [] }
  if (env.field !== 'messages') {
    result.notes.push(`ignored event field ${env.field}`)
    return result
  }

  const value = env.whatsapp ?? {}
  const contacts: any[] = value.contacts ?? []

  for (const s of value.statuses ?? []) {
    if (s.status !== 'failed') continue
    const e = s.errors?.[0]
    result.notes.push(`reply failed to deliver [id=${s.id}]: [${e?.code ?? '?'}] ${e?.title ?? 'unknown error'}`)
  }

  for (const m of value.messages ?? []) {
    if (m.type === 'system') {
      const sys = m.system
      if (sys && IDENTITY_CHANGE_TYPES.includes(sys.type) && (sys.previous_user_id || m.from)) {
        const change: IdentityChange = {}
        if (sys.previous_user_id) change.previousUserId = sys.previous_user_id
        if (m.from) change.previousPhone = m.from
        if (sys.user_id) change.userId = sys.user_id
        if (sys.wa_id) change.waId = sys.wa_id
        result.identityChanges.push(change)
      }
      continue
    }

    const body = resolveBody(m, env.pipes.media, result.notes)
    if (!body) continue

    const contact = contacts.find(
      c => (m.from && c.wa_id === m.from) || (m.from_user_id && c.user_id === m.from_user_id),
    )
    const message: InboundMessage = {
      dedupeKey: m.id,
      messageId: m.id,
      poolNumberId: env.pipes.poolNumberId,
      sender: {
        phone: m.from,
        bsuid: m.from_user_id,
        name: contact?.profile?.name ?? contact?.profile?.username,
      },
      replyTo: m.from ?? m.from_user_id,
      ts: timestampOf(m.timestamp, env.createdAt),
      body: body.text,
    }
    if (body.media) message.media = body.media
    result.messages.push(message)
  }

  return result
}

// Meta's `timestamp` is epoch seconds as a string. A bad one falls back to the
// envelope's createdAt, then to now, so one odd message never sinks the batch.
function timestampOf(raw: unknown, createdAt: unknown): string {
  const seconds = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  const fromMeta = new Date(seconds * 1000)
  if (Number.isFinite(fromMeta.getTime())) return fromMeta.toISOString()
  const fromEnvelope = typeof createdAt === 'string' ? new Date(createdAt) : new Date(NaN)
  if (Number.isFinite(fromEnvelope.getTime())) return fromEnvelope.toISOString()
  return new Date().toISOString()
}

type Resolved = { text: string; media?: InboundMedia }

/** Body (and media) for one Meta message; null when skipped (a note is pushed where one is due). */
function resolveBody(m: any, stored: Record<string, V2Media> | undefined, notes: string[]): Resolved | null {
  switch (m.type) {
    case 'text':
      return { text: m.text?.body ?? '' }
    case 'button':
      return { text: m.button?.text ?? '' }
    case 'interactive': {
      const title = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
      if (title === undefined) break
      return { text: title }
    }
    case 'reaction':
      if (!m.reaction?.emoji) {
        notes.push(`skipping reaction removal [id=${m.id}]`)
        return null
      }
      return { text: `[Reaction: ${m.reaction.emoji}]` }
    case 'location':
      return { text: m.location ? formatLocation(m.location) : '(location)' }
    case 'contacts':
      return { text: m.contacts?.length ? formatContacts(m.contacts) : '(contacts)' }
    default:
      if (MEDIA_TYPES.includes(m.type)) return resolveMedia(m, stored)
  }
  notes.push(`skipping ${m.type} message [id=${m.id}]`)
  return null
}

function resolveMedia(m: any, stored: Record<string, V2Media> | undefined): Resolved {
  const obj = m[m.type] ?? {}
  const caption: string = obj.caption ?? ''
  const entry = obj.id !== undefined ? stored?.[obj.id] : undefined
  if (!entry || entry.unavailable || !entry.downloadUrl) return { text: withMediaUnavailable(caption) }
  return {
    text: caption,
    media: {
      downloadUrl: entry.downloadUrl,
      mimeType: entry.mimeType ?? obj.mime_type ?? 'application/octet-stream',
      fileName: m.type === 'document' ? obj.filename : undefined,
      kind: m.type === 'image' ? 'image' : 'file',
    },
  }
}
