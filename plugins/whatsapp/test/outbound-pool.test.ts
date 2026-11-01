import { test, expect } from 'bun:test'
import { recipientField, PoolTransport, POOL_UNSUPPORTED } from '../outbound'

function setup(connected = true) {
  const frames: object[] = []
  const logs: string[] = []
  const transport = new PoolTransport(
    f => {
      if (!connected) return false
      frames.push(f)
      return true
    },
    m => logs.push(m),
  )
  return { transport, frames, logs }
}

test('recipientField sends phone numbers as to', () => {
  expect(recipientField('5511999998888')).toEqual({ to: '5511999998888' })
})

test('recipientField sends BSUIDs as recipient', () => {
  expect(recipientField('US.1')).toEqual({ recipient: 'US.1' })
  expect(recipientField('BR.ENT.1')).toEqual({ recipient: 'BR.ENT.1' })
})

test('pool sendText writes whatsapp_reply', async () => {
  const { transport, frames } = setup()
  const out = await transport.sendText({ poolNumberId: 'p1', to: '+55', conversationId: 'c1' }, 'hi')
  expect(frames).toEqual([
    { type: 'whatsapp_reply', data: { conversationId: 'c1', poolNumberId: 'p1', toNumber: '+55', text: 'hi' } },
  ])
  expect(out).toEqual({})
})

test('pool sendText needs a conversation', async () => {
  const { transport, frames } = setup()
  await expect(transport.sendText({ poolNumberId: 'p1', to: '+55' }, 'hi')).rejects.toThrow(
    'conversation_id is required for pool numbers',
  )
  expect(frames).toEqual([])
})

test('pool sendText when disconnected', async () => {
  const { transport } = setup(false)
  await expect(
    transport.sendText({ poolNumberId: 'p1', to: '+55', conversationId: 'c1' }, 'hi'),
  ).rejects.toThrow('WebSocket not connected')
})

test('pool files and reactions fail loudly', async () => {
  const sent: object[] = []
  const transport = new PoolTransport(f => (sent.push(f), true), () => {})
  const t = { poolNumberId: 'p1', to: '+55', conversationId: 'c1' }
  await expect(transport.sendFile(t, '/tmp/x.png')).rejects.toThrow(POOL_UNSUPPORTED)
  await expect(transport.react(t, 'm1', '👍')).rejects.toThrow(POOL_UNSUPPORTED)
  expect(sent).toEqual([])
})

test('pool transport does not support files', () => {
  expect(new PoolTransport(() => true, () => {}).supportsFiles).toBe(false)
})

test('pool consumes reply_status', () => {
  const { transport, logs } = setup()
  expect(
    transport.handleFrame({
      type: 'reply_status',
      data: { conversationId: 'c1', success: false, code: 'X', error: 'e' },
    }),
  ).toBe(true)
  expect(logs).toEqual(['reply failed for c1: [X] e'])
  expect(transport.handleFrame({ type: 'event' })).toBe(false)
})

test('pool logs successful reply_status', () => {
  const { transport, logs } = setup()
  transport.handleFrame({ type: 'reply_status', data: { conversationId: 'c1', success: true, messageId: 'm9' } })
  expect(logs).toEqual(['reply delivered to c1 (messageId: m9)'])
})
