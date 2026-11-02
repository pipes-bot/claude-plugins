import { test, expect } from 'bun:test'
import {
  parsePoolMessage,
  formatLocation,
  formatContacts,
  withMediaUnavailable,
  frameType,
  MEDIA_UNAVAILABLE,
  type PoolMessageData,
} from '../inbound'

function pool(over: Partial<PoolMessageData> = {}): PoolMessageData {
  return {
    messageId: 'm1',
    conversationId: 'c1',
    poolNumberId: 'p1',
    poolNumberPhoneNumber: '+1',
    fromNumber: '+5511999998888',
    fromName: 'Ana',
    type: 'text',
    body: 'oi',
    text: 'oi',
    timestamp: '2026-10-31T10:00:00.000Z',
    ...over,
  }
}

test('pool text maps all fields', () => {
  expect(parsePoolMessage(pool())).toEqual({
    dedupeKey: 'm1',
    messageId: 'm1',
    poolNumberId: 'p1',
    conversationId: 'c1',
    replyTo: '+5511999998888',
    sender: { phone: '+5511999998888', name: 'Ana' },
    body: 'oi',
    ts: '2026-10-31T10:00:00.000Z',
  })
})

test('pool BSUID sender', () => {
  const m = parsePoolMessage(pool({ fromNumber: 'US.1', userId: 'US.1' }))!
  expect(m.sender.phone).toBeUndefined()
  expect(m.sender.bsuid).toBe('US.1')
  expect(m.replyTo).toBe('US.1')
})

test('pool BSUID in fromNumber without userId', () => {
  const m = parsePoolMessage(pool({ fromNumber: 'US.2' }))!
  expect(m.sender.phone).toBeUndefined()
  expect(m.sender.bsuid).toBe('US.2')
})

test('pool skips', () => {
  expect(parsePoolMessage(pool({ type: 'unsupported' }))).toBeNull()
  expect(parsePoolMessage(pool({ type: 'reaction', reaction: { messageId: 'x' } }))).toBeNull()
  const r = parsePoolMessage(pool({ type: 'reaction', reaction: { messageId: 'x', emoji: '👍' } }))!
  expect(r.body).toBe('[Reaction: 👍]')
})

test('pool media kinds', () => {
  const media = { downloadUrl: '/media/1', mimeType: 'image/png', byteSize: 1 }
  const img = parsePoolMessage(pool({ type: 'image', media }))!
  expect(img.media).toEqual({ downloadUrl: '/media/1', mimeType: 'image/png', fileName: undefined, kind: 'image' })
  const doc = parsePoolMessage(
    pool({ type: 'document', media: { ...media, mimeType: 'application/pdf', fileName: 'a.pdf' } }),
  )!
  expect(doc.media?.kind).toBe('file')
  expect(doc.media?.fileName).toBe('a.pdf')
  const gone = parsePoolMessage(pool({ type: 'image', media: { ...media, unavailable: true } }))!
  expect(gone.media).toBeUndefined()
})

test("formatters keep today's strings", () => {
  expect(formatLocation({ latitude: -23.5, longitude: -46.6, name: 'X', address: 'Y' })).toBe(
    '📍 Location: -23.5, -46.6\nName: X\nAddress: Y',
  )
  expect(formatContacts([{ name: { formatted_name: 'Jane' }, phones: [{ phone: '+1' }, { phone: '+2' }] }])).toBe(
    'Jane: +1, +2',
  )
})

test('pool location and contacts bodies', () => {
  expect(parsePoolMessage(pool({ type: 'location' }))!.body).toBe('(location)')
  expect(parsePoolMessage(pool({ type: 'contacts', contacts: [] }))!.body).toBe('(contacts)')
})

test('withMediaUnavailable', () => {
  expect(withMediaUnavailable('')).toBe(MEDIA_UNAVAILABLE)
  expect(withMediaUnavailable('cap')).toBe(`cap ${MEDIA_UNAVAILABLE}`)
})

test('frameType', () => {
  expect(frameType({ type: 'event' })).toBe('event')
  expect(frameType({ type: 1 })).toBeNull()
  expect(frameType(null)).toBeNull()
  expect(frameType('x')).toBeNull()
})
