import { mkdirSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { extname, join } from 'path'
import { API_BASE, INBOX_DIR } from './config'
import type { InboundMedia } from './inbound'

function log(msg: string): void {
  process.stderr.write(`whatsapp channel: ${msg}\n`)
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp',
  aac: 'audio/aac', amr: 'audio/amr', m4a: 'audio/mp4', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/plain', csv: 'text/plain', log: 'text/plain', json: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

// The MIME types Meta accepts for outbound media (image/webp goes out as a sticker).
const WHATSAPP_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/3gpp',
  'audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg',
  'application/pdf', 'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'video/mp4': 'mp4', 'application/pdf': 'pdf',
}

export function mimeFromPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** The MIME type to send `path` as on WhatsApp, or null when Meta would reject it. */
export function whatsappMimeFor(path: string): string | null {
  const mime = mimeFromPath(path)
  return WHATSAPP_MIMES.has(mime) ? mime : null
}

export const UNSUPPORTED_FILE_HINT = 'send PDF, Office, text, JPEG/PNG, MP4/3GP or common audio'

export function unsupportedFileType(path: string): string {
  const ext = extname(path).toLowerCase()
  return `unsupported file type for WhatsApp: ${ext || '(none)'} — ${UNSUPPORTED_FILE_HINT}`
}

export async function downloadMedia(
  m: InboundMedia,
  apiKey: string,
  opts: { apiBase?: string; inboxDir?: string; fetch?: typeof fetch } = {},
): Promise<string | null> {
  const apiBase = opts.apiBase ?? API_BASE
  const inboxDir = opts.inboxDir ?? INBOX_DIR
  const doFetch = opts.fetch ?? fetch
  const absoluteUrl = `${apiBase}${m.downloadUrl}`

  try {
    // First request with auth — follow redirects manually so the
    // Authorization header is NOT forwarded to the R2 pre-signed URL.
    const initialResponse = await doFetch(absoluteUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'manual',
    })

    const redirectUrl =
      initialResponse.status >= 300 && initialResponse.status < 400
        ? initialResponse.headers.get('location')
        : null

    const mediaResponse = redirectUrl
      ? await doFetch(redirectUrl)
      : await doFetch(absoluteUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })

    if (!mediaResponse.ok) {
      log(`media download failed: HTTP ${mediaResponse.status}`)
      return null
    }

    const buf = Buffer.from(await mediaResponse.arrayBuffer())

    // Determine extension from filename, mimeType, or default
    let ext = 'bin'
    if (m.fileName) {
      const parts = m.fileName.split('.')
      if (parts.length > 1) ext = parts.pop()!
    } else {
      ext = EXT_BY_MIME[m.mimeType] ?? 'bin'
    }
    // The filename is remote-controlled: keep only a plain alphanumeric extension.
    if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) ext = 'bin'

    const path = join(inboxDir, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`)
    mkdirSync(inboxDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  } catch (err) {
    log(`media download failed: ${err}`)
    return null
  }
}
