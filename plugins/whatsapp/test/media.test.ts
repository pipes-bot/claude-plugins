import { test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { downloadMedia, mimeFromPath, whatsappMimeFor } from '../media'
import type { InboundMedia } from '../inbound'

const media: InboundMedia = { downloadUrl: '/media/1', mimeType: 'application/pdf', fileName: 'a.pdf', kind: 'file' }

test('401 returns null', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'media-'))
  const fetchFn = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch
  expect(await downloadMedia(media, 'pk_x', { inboxDir, fetch: fetchFn })).toBeNull()
  expect(readdirSync(inboxDir)).toEqual([])
})

test('redirect is followed without the auth header', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'media-'))
  const calls: Array<{ url: string; headers?: HeadersInit }> = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers })
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://r2/x' } })
    return new Response('PDFDATA', { status: 200 })
  }) as unknown as typeof fetch
  const path = await downloadMedia(media, 'pk_x', { inboxDir, apiBase: 'https://api.test', fetch: fetchFn })
  expect(calls[0].url).toBe('https://api.test/media/1')
  expect((calls[0].headers as Record<string, string>).Authorization).toBe('Bearer pk_x')
  expect(calls[1].url).toBe('https://r2/x')
  expect(calls[1].headers).toBeUndefined()
  expect(path).not.toBeNull()
  expect(path!.startsWith(inboxDir)).toBe(true)
  expect(path!.endsWith('.pdf')).toBe(true)
  expect(readFileSync(path!, 'utf8')).toBe('PDFDATA')
})

test('extension falls back to mime type, then bin', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'media-'))
  const fetchFn = (async () => new Response('x', { status: 200 })) as unknown as typeof fetch
  const a = await downloadMedia({ ...media, fileName: undefined, mimeType: 'image/png' }, 'k', { inboxDir, fetch: fetchFn })
  expect(a!.endsWith('.png')).toBe(true)
  const b = await downloadMedia({ ...media, fileName: undefined, mimeType: 'x/y' }, 'k', { inboxDir, fetch: fetchFn })
  expect(b!.endsWith('.bin')).toBe(true)
})

test('network error returns null', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'media-'))
  const fetchFn = (async () => {
    throw new Error('boom')
  }) as unknown as typeof fetch
  expect(await downloadMedia(media, 'k', { inboxDir, fetch: fetchFn })).toBeNull()
})

test('mimeFromPath', () => {
  expect(mimeFromPath('/a/B.JPG')).toBe('image/jpeg')
  expect(mimeFromPath('/a/x.unknownext')).toBe('application/octet-stream')
  expect(mimeFromPath('/a/noext')).toBe('application/octet-stream')
})

test('whatsappMimeFor: types Meta accepts', () => {
  const expected: Record<string, string> = {
    txt: 'text/plain', md: 'text/plain', csv: 'text/plain', log: 'text/plain', json: 'text/plain',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    aac: 'audio/aac', amr: 'audio/amr', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg',
    mp4: 'video/mp4', '3gp': 'video/3gpp',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  }
  for (const [ext, mime] of Object.entries(expected)) {
    expect(whatsappMimeFor(`/a/file.${ext}`)).toBe(mime)
    expect(whatsappMimeFor(`/a/FILE.${ext.toUpperCase()}`)).toBe(mime)
  }
})

test('whatsappMimeFor: anything else is null', () => {
  for (const p of ['/a/x.gif', '/a/x.zip', '/a/x.unknownext', '/a/noext', '/a/.env']) {
    expect(whatsappMimeFor(p)).toBeNull()
  }
})
