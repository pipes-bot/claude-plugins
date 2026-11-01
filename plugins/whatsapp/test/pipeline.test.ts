import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInboundPipeline, createFrameRouter, DEDUPE_CAP } from '../pipeline'
import { parseV2Event } from '../inbound-v2'
import { EMPTY_TRUST_WARNING, type Mode } from '../config'
import type { InboundMedia, InboundMessage, PoolMessageData } from '../inbound'
import type { IdentityChange } from '../inbound-v2'
import type { Transport } from '../outbound'
import { envelopeFromMeta, envelopeWith } from './helpers'

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'meta', `${name}.json`), 'utf8'))
}

type Setup = { mode?: Mode; trust?: string[]; download?: (m: InboundMedia) => string | null }

function setup(opts: Setup = {}) {
  const notified: Array<{ content: string; meta: Record<string, string> }> = []
  const logs: string[] = []
  const downloads: InboundMedia[] = []
  const pipeline = createInboundPipeline({
    mode: opts.mode ?? 'app-v2',
    readTrust: () => new Set(opts.trust ?? []),
    download: async m => {
      downloads.push(m)
      return opts.download ? opts.download(m) : null
    },
    notify: (content, meta) => notified.push({ content, meta }),
    log: m => logs.push(m),
  })
  return { pipeline, notified, logs, downloads }
}

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    dedupeKey: 'wamid.1',
    messageId: 'wamid.1',
    poolNumberId: 'p1',
    sender: { phone: '1' },
    replyTo: '1',
    ts: '2026-11-01T00:00:00.000Z',
    body: 'hi',
    ...over,
  }
}

const image: InboundMedia = { downloadUrl: '/media/1', mimeType: 'image/jpeg', kind: 'image' }

// ── Pipeline ────────────────────────────────────────────────────────────────

test('untrusted sender reaches nothing', async () => {
  const { pipeline, notified, logs, downloads } = setup({ trust: ['1'] })
  await pipeline.deliver([message({ sender: { phone: '2' }, replyTo: '2', body: 'secret', media: image })])
  expect(downloads).toEqual([])
  expect(notified).toEqual([])
  expect(logs).toContain('dropped untrusted sender 2')
  expect(logs.some(l => l.includes('secret'))).toBe(false)
})

test('trusted text is delivered', async () => {
  const { pipeline, notified } = setup({ trust: ['5511987654321'] })
  const { messages } = parseV2Event(envelopeFromMeta(fixture('incoming-text')))
  await pipeline.deliver(messages)
  expect(notified).toHaveLength(1)
  expect(notified[0]!.content).toBe('Oi')
  expect(notified[0]!.meta).toStrictEqual({
    pool_number_id: 'pool_1',
    message_id: 'wamid.LIVE_INCOMING_TEXT',
    from_number: '5511987654321',
    user: 'Maria Silva',
    ts: new Date(1791490201000).toISOString(),
    sender_id: 'BR.10293847561029384',
  })
  expect('conversation_id' in notified[0]!.meta).toBe(false)
})

test('user falls back to replyTo', async () => {
  const { pipeline, notified } = setup({ trust: ['1'] })
  await pipeline.deliver([message()])
  expect(notified[0]!.meta.user).toBe('1')
  expect('sender_id' in notified[0]!.meta).toBe(false)
})

test('pool keeps conversation_id', async () => {
  const { pipeline, notified } = setup({ mode: 'pool', trust: [] })
  await pipeline.deliver([message({ conversationId: 'c1' })])
  expect(notified).toHaveLength(1)
  expect(notified[0]!.meta.conversation_id).toBe('c1')
})

test('duplicates are dropped', async () => {
  const { pipeline, notified } = setup({ trust: ['1'] })
  await pipeline.deliver([message()])
  await pipeline.deliver([message()])
  expect(notified).toHaveLength(1)
})

test('dedupe cap evicts oldest', async () => {
  const { pipeline, notified } = setup({ trust: ['1'] })
  const id = (i: number) => `wamid.${i}`
  for (let i = 1; i <= DEDUPE_CAP + 1; i++) {
    await pipeline.deliver([message({ dedupeKey: id(i), messageId: id(i) })])
  }
  expect(notified).toHaveLength(DEDUPE_CAP + 1)
  await pipeline.deliver([message({ dedupeKey: id(1), messageId: id(1) })])
  expect(notified).toHaveLength(DEDUPE_CAP + 2)
})

test('media success', async () => {
  const { pipeline, notified, downloads } = setup({
    trust: ['1'],
    download: m => (m.kind === 'image' ? '/inbox/a.jpg' : '/inbox/b.pdf'),
  })
  await pipeline.deliver([
    message({ media: image }),
    message({ dedupeKey: 'wamid.2', messageId: 'wamid.2', media: { ...image, mimeType: 'application/pdf', kind: 'file' } }),
  ])
  expect(downloads).toHaveLength(2)
  expect(notified[0]!.meta.image_path).toBe('/inbox/a.jpg')
  expect('file_path' in notified[0]!.meta).toBe(false)
  expect(notified[1]!.meta.file_path).toBe('/inbox/b.pdf')
  expect('image_path' in notified[1]!.meta).toBe(false)
})

test('media failure', async () => {
  const { pipeline, notified } = setup({ trust: ['1'], download: () => null })
  await pipeline.deliver([message({ body: 'look', media: image })])
  expect(notified[0]!.content).toBe('look (media unavailable)')
  expect('image_path' in notified[0]!.meta).toBe(false)
  expect('file_path' in notified[0]!.meta).toBe(false)
})

test('gates each message in a batch independently', async () => {
  const { pipeline, notified } = setup({ trust: ['1'] })
  await pipeline.deliver([
    message(),
    message({ dedupeKey: 'wamid.2', messageId: 'wamid.2', sender: { phone: '2' }, replyTo: '2' }),
  ])
  expect(notified).toHaveLength(1)
  expect(notified[0]!.meta.message_id).toBe('wamid.1')
})

test('empty list hint is logged once', async () => {
  const { pipeline, logs } = setup({ trust: [] })
  await pipeline.deliver([message()])
  await pipeline.deliver([message({ dedupeKey: 'wamid.2', messageId: 'wamid.2' })])
  expect(logs.filter(l => l === 'dropped untrusted sender 1')).toHaveLength(2)
  expect(logs.filter(l => l === EMPTY_TRUST_WARNING)).toHaveLength(1)
})

test('drop log names the exact id for a BR number without the 9th digit', async () => {
  const { pipeline, notified, logs } = setup({ trust: ['5511987654321'] })
  await pipeline.deliver([message({ sender: { phone: '551187654321' }, replyTo: '551187654321' })])
  expect(notified).toEqual([])
  expect(logs).toContain('dropped untrusted sender 551187654321')
})

test('message without a sender id is skipped before the gate', async () => {
  const { pipeline, notified, logs } = setup({ trust: [] })
  await pipeline.deliver([message({ sender: {}, replyTo: '' })])
  expect(notified).toEqual([])
  expect(logs).toEqual(['skipping message without sender id [id=wamid.1]'])
})

test('identity change of a trusted sender', () => {
  const { pipeline, logs } = setup({ trust: ['BR.1'] })
  pipeline.identityChanges([{ previousUserId: 'BR.1', userId: 'BR.2' }])
  expect(logs).toEqual([
    'trusted sender BR.1 changed WhatsApp ID — run /whatsapp:configure trust BR.2 to keep receiving their messages',
  ])
})

test('identity change falls back to waId', () => {
  const { pipeline, logs } = setup({ trust: ['BR.1'] })
  pipeline.identityChanges([{ previousUserId: 'BR.1', waId: '5511' }])
  expect(logs[0]).toContain('/whatsapp:configure trust 5511 ')
})

test('identity change of a phone-trusted sender names the new wa_id', () => {
  const { pipeline, logs } = setup({ trust: ['5511987654321'] })
  pipeline.identityChanges([{ previousPhone: '5511987654321', waId: '5511912345678' }])
  expect(logs).toEqual([
    'trusted sender 5511987654321 changed WhatsApp ID — run /whatsapp:configure trust 5511912345678 to keep receiving their messages',
  ])
})

test('identity change without a new id never logs undefined', () => {
  const { pipeline, logs } = setup({ trust: ['BR.1', '5511'] })
  pipeline.identityChanges([{ previousUserId: 'BR.1' }, { previousPhone: '5511' }])
  expect(logs).toEqual([
    "trusted sender BR.1 changed WhatsApp ID — check the next message's sender and run /whatsapp:configure trust <id>",
    "trusted sender 5511 changed WhatsApp ID — check the next message's sender and run /whatsapp:configure trust <id>",
  ])
  expect(logs.some(l => l.includes('undefined'))).toBe(false)
})

test('identity change matches each identifier only as its own kind', () => {
  const { pipeline, logs } = setup({ trust: ['BR.1', '5511'] })
  pipeline.identityChanges([{ previousUserId: '5511', userId: 'BR.2' }, { previousPhone: 'BR.1', waId: '9' }])
  expect(logs).toEqual([])
})

test('identity change of an untrusted sender logs nothing', () => {
  const { pipeline, logs } = setup({ trust: ['BR.1'] })
  pipeline.identityChanges([{ previousUserId: 'BR.9', userId: 'BR.2' }])
  expect(logs).toEqual([])
})

// ── Frame router ────────────────────────────────────────────────────────────

function routerSetup(mode: Mode, opts: { deliver?: () => Promise<void> } = {}) {
  const delivered: InboundMessage[][] = []
  const changes: IdentityChange[][] = []
  const handled: unknown[] = []
  const logs: string[] = []
  const pipeline = {
    deliver: async (msgs: InboundMessage[]) => {
      delivered.push(msgs)
      if (opts.deliver) await opts.deliver()
    },
    identityChanges: (c: IdentityChange[]) => {
      changes.push(c)
    },
  }
  const transport = {
    handleFrame: (f: unknown) => {
      handled.push(f)
      return true
    },
  } as unknown as Transport
  const route = createFrameRouter({ mode, pipeline, transport, log: m => logs.push(m) })
  return { route, delivered, changes, handled, logs }
}

function poolFrame(over: Partial<PoolMessageData> = {}) {
  const data: PoolMessageData = {
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
  return { type: 'whatsapp_message', data }
}

const LEGACY = 'this App is on the legacy API — upgrade it to v2 in the PipesBot dashboard'

test('router: legacy frame in app-v2 is logged once and dropped', async () => {
  const { route, delivered, logs } = routerSetup('app-v2')
  await route(poolFrame())
  await route(poolFrame({ messageId: 'm2' }))
  expect(logs.filter(l => l === LEGACY)).toHaveLength(1)
  expect(delivered).toEqual([])
})

test('router: app-v2 event logs notes and delivers messages', async () => {
  const { route, delivered, changes, logs } = routerSetup('app-v2')
  const env = envelopeWith({
    messages: [
      { from: '5511', id: 'wamid.T', timestamp: '1', type: 'text', text: { body: 'oi' } },
      { from: '5511', id: 'wamid.R', timestamp: '1', type: 'reaction', reaction: { message_id: 'wamid.T' } },
      {
        id: 'wamid.S',
        timestamp: '1',
        type: 'system',
        system: { type: 'user_changed_user_id', previous_user_id: 'BR.1', user_id: 'BR.2' },
      },
    ],
  })
  await route({ type: 'event', data: env })
  expect(logs).toEqual(['skipping reaction removal [id=wamid.R]'])
  expect(delivered).toHaveLength(1)
  expect(delivered[0]!.map(m => m.messageId)).toEqual(['wamid.T'])
  expect(changes).toEqual([[{ previousUserId: 'BR.1', userId: 'BR.2', waId: undefined }]])
})

test('router: pool whatsapp_message is delivered', async () => {
  const { route, delivered } = routerSetup('pool')
  await route(poolFrame())
  expect(delivered).toHaveLength(1)
  expect(delivered[0]![0]!.messageId).toBe('m1')
  expect(delivered[0]![0]!.conversationId).toBe('c1')
})

test('router: pool skips are logged', async () => {
  const { route, delivered, logs } = routerSetup('pool')
  await route(poolFrame({ type: 'unsupported' }))
  await route(poolFrame({ messageId: 'm2', type: 'reaction', reaction: { messageId: 'm1' } }))
  expect(delivered).toEqual([])
  expect(logs).toContain('skipping unsupported message type [id=m1]')
  expect(logs).toContain('skipping reaction removal [id=m2]')
})

test('router: send_result and reply_status go to the transport', async () => {
  const v2 = routerSetup('app-v2')
  const sendResult = { type: 'send_result', requestId: 'r1', success: true }
  await v2.route(sendResult)
  expect(v2.handled).toEqual([sendResult])

  const pool = routerSetup('pool')
  const status = { type: 'reply_status', data: { conversationId: 'c1', success: true } }
  await pool.route(status)
  expect(pool.handled).toEqual([status])
})

test('router: handler errors are caught and logged', async () => {
  const { route, logs } = routerSetup('pool', {
    deliver: async () => {
      throw new Error('kaboom')
    },
  })
  await route(poolFrame())
  const v2 = routerSetup('app-v2')
  await v2.route({ type: 'event' })
  expect(logs).toContain('frame handler error: kaboom')
  expect(v2.logs.some(l => l.startsWith('frame handler error: '))).toBe(true)
})
