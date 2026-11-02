import { isBsuid } from './trust'

export type InboundMedia = { downloadUrl: string; mimeType: string; fileName?: string; kind: 'image' | 'file' }

export type InboundMessage = {
  dedupeKey: string
  poolNumberId: string
  messageId: string
  sender: { phone?: string; bsuid?: string; name?: string }
  replyTo: string
  conversationId?: string
  ts: string
  body: string
  media?: InboundMedia
}

// ── Pool (`whatsapp_message`) frame types ───────────────────────────────────

type PipesBotMedia = {
  mediaId?: string
  downloadUrl?: string
  mimeType: string
  fileName?: string
  byteSize: number
  unavailable?: boolean
}

type PipesBotLocation = {
  latitude: number
  longitude: number
  name?: string
  address?: string
}

type PipesBotContact = {
  name: { formatted_name: string }
  phones?: Array<{ phone: string; type?: string }>
  emails?: Array<{ email: string; type?: string }>
}

type PipesBotReaction = {
  messageId: string
  emoji?: string
}

export type PoolMessageData = {
  messageId: string
  conversationId: string
  poolNumberId: string
  poolNumberPhoneNumber: string
  fromNumber: string
  fromName?: string
  text: string
  body: string
  timestamp: string
  label?: string
  type:
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'sticker'
    | 'location'
    | 'contacts'
    | 'reaction'
    | 'unsupported'
  media?: PipesBotMedia
  location?: PipesBotLocation
  contacts?: PipesBotContact[]
  reaction?: PipesBotReaction
  userId?: string
  parentUserId?: string
  username?: string
}

export const MEDIA_UNAVAILABLE = '(media unavailable)'

export function withMediaUnavailable(body: string): string {
  return body ? `${body} ${MEDIA_UNAVAILABLE}` : MEDIA_UNAVAILABLE
}

export function formatLocation(l: { latitude: number; longitude: number; name?: string; address?: string }): string {
  const parts = [`📍 Location: ${l.latitude}, ${l.longitude}`]
  if (l.name) parts.push(`Name: ${l.name}`)
  if (l.address) parts.push(`Address: ${l.address}`)
  return parts.join('\n')
}

export function formatContacts(
  cs: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone: string }> }>,
): string {
  return cs
    .map(c => {
      const name = c.name?.formatted_name ?? 'Unknown'
      const phones = (c.phones ?? []).map(p => p.phone).join(', ')
      return phones ? `${name}: ${phones}` : name
    })
    .join('\n')
}

/** Resolve the text body for each pool message type. */
function resolveRawBody(data: PoolMessageData): string {
  switch (data.type) {
    case 'text':
      return data.body
    case 'reaction':
      return `[Reaction: ${data.reaction?.emoji ?? ''}]`
    case 'location':
      return data.location ? formatLocation(data.location) : '(location)'
    case 'contacts':
      return data.contacts && data.contacts.length > 0 ? formatContacts(data.contacts) : '(contacts)'
    default:
      // image, audio, video, document, sticker — caption or empty
      return data.body ?? ''
  }
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker']

/** Map a pool frame to the shared shape; null when the message is to be skipped. */
export function parsePoolMessage(d: PoolMessageData): InboundMessage | null {
  if (d.type === 'unsupported') return null
  if (d.type === 'reaction' && !d.reaction?.emoji) return null

  const fromIsBsuid = isBsuid(d.fromNumber)
  const msg: InboundMessage = {
    dedupeKey: d.messageId,
    messageId: d.messageId,
    poolNumberId: d.poolNumberId,
    conversationId: d.conversationId,
    replyTo: d.fromNumber,
    sender: {
      phone: fromIsBsuid ? undefined : d.fromNumber,
      bsuid: d.userId ?? (fromIsBsuid ? d.fromNumber : undefined),
      name: d.fromName,
    },
    body: resolveRawBody(d),
    ts: d.timestamp,
  }

  if (MEDIA_TYPES.includes(d.type) && d.media && !d.media.unavailable && d.media.downloadUrl) {
    msg.media = {
      downloadUrl: d.media.downloadUrl,
      mimeType: d.media.mimeType,
      fileName: d.media.fileName,
      kind: d.type === 'image' ? 'image' : 'file',
    }
  }
  return msg
}

/** `msg.type` when msg is an object with a string `type`. */
export function frameType(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null
  const t = (msg as { type?: unknown }).type
  return typeof t === 'string' ? t : null
}
