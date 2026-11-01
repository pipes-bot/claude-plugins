import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseV2Event } from '../inbound-v2'
import { formatLocation } from '../inbound'
import { envelopeFromMeta, envelopeWith } from './helpers'

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'meta', `${name}.json`), 'utf8'))
}

const contacts = [{ profile: { name: 'Maria Silva' }, wa_id: '5511987654321', user_id: 'BR.10293847561029384' }]

function msg(over: Record<string, any>) {
  return {
    from: '5511987654321',
    from_user_id: 'BR.10293847561029384',
    id: 'wamid.T1',
    timestamp: '1791490201',
    ...over,
  }
}

function parseOne(over: Record<string, any>, media?: Record<string, any>) {
  return parseV2Event(envelopeWith({ contacts, messages: [msg(over)] }, { media }))
}

test('live incoming text', () => {
  const r = parseV2Event(envelopeFromMeta(fixture('incoming-text')))
  expect(r.notes).toEqual([])
  expect(r.messages).toHaveLength(1)
  const m = r.messages[0]!
  expect(m.body).toBe('Oi')
  expect(m.sender).toEqual({ phone: '5511987654321', bsuid: 'BR.10293847561029384', name: 'Maria Silva' })
  expect(m.replyTo).toBe('5511987654321')
  expect(m.messageId).toBe('wamid.LIVE_INCOMING_TEXT')
  expect(m.dedupeKey).toBe('wamid.LIVE_INCOMING_TEXT')
  expect(m.poolNumberId).toBe('pool_1')
  expect(m.ts).toBe(new Date(1791490201000).toISOString())
  expect(m.conversationId).toBeUndefined()
})

test('BSUID-only sender', () => {
  const f = fixture('incoming-text')
  const v = f.entry[0].changes[0].value
  delete v.messages[0].from
  delete v.contacts[0].wa_id
  const m = parseV2Event(envelopeFromMeta(f)).messages[0]!
  expect(m.replyTo).toBe('BR.10293847561029384')
  expect(m.sender.phone).toBeUndefined()
  expect(m.sender.bsuid).toBe('BR.10293847561029384')
  expect(m.sender.name).toBe('Maria Silva')
})

test('username fallback', () => {
  const f = fixture('incoming-text')
  f.entry[0].changes[0].value.contacts[0].profile = { username: 'maria' }
  expect(parseV2Event(envelopeFromMeta(f)).messages[0]!.sender.name).toBe('maria')
})

test('statuses are not messages', () => {
  for (const name of ['status-sent-bsuid-recipient', 'status-delivered-bsuid-recipient', 'status-read-bsuid-recipient']) {
    const r = parseV2Event(envelopeFromMeta(fixture(name)))
    expect(r.messages).toEqual([])
    expect(r.notes).toEqual([])
  }
})

test('failed status is noted', () => {
  const r = parseV2Event(
    envelopeWith({ statuses: [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }] }),
  )
  expect(r.messages).toEqual([])
  expect(r.notes).toEqual(['reply failed to deliver [id=wamid.X]: [131047] Re-engagement message'])
})

test('live contact request', () => {
  const r = parseV2Event(envelopeFromMeta(fixture('contact-request')))
  expect(r.messages[0]!.body).toBe('Maria Silva: +55 11 98765-4321')
})

test('image with stored media', () => {
  const m = parseOne(
    { type: 'image', image: { id: '123', mime_type: 'image/jpeg', caption: 'look' } },
    { '123': { downloadUrl: '/v1/media/download/abc', mimeType: 'image/jpeg' } },
  ).messages[0]!
  expect(m.body).toBe('look')
  expect(m.media).toEqual({ downloadUrl: '/v1/media/download/abc', mimeType: 'image/jpeg', kind: 'image' })
})

test('document keeps filename', () => {
  const m = parseOne(
    { type: 'document', document: { id: '9', filename: 'report.pdf' } },
    { '9': { downloadUrl: '/v1/media/download/doc', mimeType: 'application/pdf' } },
  ).messages[0]!
  expect(m.media?.fileName).toBe('report.pdf')
  expect(m.media?.kind).toBe('file')
  expect(m.body).toBe('')
})

test('media mime falls back to the Meta object, then octet-stream', () => {
  const a = parseOne(
    { type: 'audio', audio: { id: '1', mime_type: 'audio/ogg' } },
    { '1': { downloadUrl: '/d/1' } },
  ).messages[0]!
  expect(a.media).toEqual({ downloadUrl: '/d/1', mimeType: 'audio/ogg', kind: 'file' })
  const b = parseOne({ type: 'video', video: { id: '2' } }, { '2': { downloadUrl: '/d/2' } }).messages[0]!
  expect(b.media?.mimeType).toBe('application/octet-stream')
})

test('unavailable media', () => {
  const unavailable = { '123': { unavailable: true } }
  const a = parseOne({ type: 'image', image: { id: '123' } }, unavailable).messages[0]!
  expect(a.media).toBeUndefined()
  expect(a.body).toBe('(media unavailable)')
  const b = parseOne({ type: 'image', image: { id: '123', caption: 'hi' } }, unavailable).messages[0]!
  expect(b.body).toBe('hi (media unavailable)')
  const c = parseOne({ type: 'image', image: { id: '123', caption: 'hi' } }).messages[0]!
  expect(c.media).toBeUndefined()
  expect(c.body).toBe('hi (media unavailable)')
})

test('reactions', () => {
  expect(parseOne({ type: 'reaction', reaction: { message_id: 'w', emoji: '❤️' } }).messages[0]!.body).toBe('[Reaction: ❤️]')
  const r = parseOne({ id: 'wamid.R', type: 'reaction', reaction: { message_id: 'w', emoji: '' } })
  expect(r.messages).toEqual([])
  expect(r.notes).toEqual(['skipping reaction removal [id=wamid.R]'])
})

test('buttons and interactive', () => {
  expect(parseOne({ type: 'button', button: { text: 'Yes' } }).messages[0]!.body).toBe('Yes')
  expect(
    parseOne({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { title: 'Ok' } } }).messages[0]!.body,
  ).toBe('Ok')
  expect(
    parseOne({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { title: 'Opt' } } }).messages[0]!.body,
  ).toBe('Opt')
})

test('interactive without a reply is skipped', () => {
  const r = parseOne({ id: 'wamid.I', type: 'interactive', interactive: { type: 'nfm_reply' } })
  expect(r.messages).toEqual([])
  expect(r.notes).toEqual(['skipping interactive message [id=wamid.I]'])
})

test('location', () => {
  const location = { latitude: -23.5, longitude: -46.6, name: 'Office', address: 'Av. Paulista' }
  expect(parseOne({ type: 'location', location }).messages[0]!.body).toBe(formatLocation(location))
})

test('system identity change', () => {
  const r = parseV2Event(
    envelopeWith({
      messages: [
        {
          id: 'wamid.S',
          timestamp: '1791490201',
          type: 'system',
          system: { type: 'user_changed_number', previous_user_id: 'BR.1', user_id: 'BR.2', wa_id: '5511' },
        },
      ],
    }),
  )
  expect(r.messages).toEqual([])
  expect(r.notes).toEqual([])
  expect(r.identityChanges).toEqual([{ previousUserId: 'BR.1', userId: 'BR.2', waId: '5511' }])
})

test('other system messages produce nothing', () => {
  const r = parseV2Event(
    envelopeWith({
      messages: [
        { id: 'wamid.S1', timestamp: '1', type: 'system', system: { type: 'customer_identity_changed' } },
        { id: 'wamid.S2', timestamp: '1', type: 'system', system: { type: 'user_changed_user_id', user_id: 'BR.2' } },
      ],
    }),
  )
  expect(r).toEqual({ messages: [], notes: [], identityChanges: [] })
})

test('other fields are ignored', () => {
  const r = parseV2Event(envelopeWith({ event: 'APPROVED' }, { field: 'message_template_status_update' }))
  expect(r.messages).toEqual([])
  expect(r.notes).toEqual(['ignored event field message_template_status_update'])
})

test('unknown type', () => {
  const r = parseOne({ id: 'wamid.O', type: 'order', order: {} })
  expect(r.messages).toEqual([])
  expect(r.notes).toEqual(['skipping order message [id=wamid.O]'])
})

test('order is preserved', () => {
  const r = parseV2Event(
    envelopeWith({
      contacts,
      messages: [
        msg({ id: 'wamid.A', type: 'text', text: { body: 'first' } }),
        msg({ id: 'wamid.B', type: 'text', text: { body: 'second' } }),
      ],
    }),
  )
  expect(r.messages.map(m => m.body)).toEqual(['first', 'second'])
})
