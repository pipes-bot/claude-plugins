import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOLS, callTool } from '../tools'
import type { SendOutcome, Target, Transport } from '../outbound'

type Call = { method: 'sendText' | 'sendFile' | 'react'; args: unknown[] }

function fakeTransport(opts: { failTextAt?: number; failFile?: string; supportsFiles?: boolean } = {}) {
  const calls: Call[] = []
  let texts = 0
  const transport: Transport = {
    supportsFiles: opts.supportsFiles ?? true,
    async sendText(t: Target, text: string): Promise<SendOutcome> {
      calls.push({ method: 'sendText', args: [t, text] })
      texts++
      if (texts === opts.failTextAt) throw new Error('boom')
      return {}
    },
    async sendFile(t: Target, path: string): Promise<SendOutcome> {
      calls.push({ method: 'sendFile', args: [t, path] })
      if (opts.failFile) throw new Error(opts.failFile)
      return {}
    },
    async react(t: Target, messageId: string, emoji: string): Promise<SendOutcome> {
      calls.push({ method: 'react', args: [t, messageId, emoji] })
      return {}
    },
    handleFrame: () => false,
    onDisconnect() {},
  }
  return { transport, calls }
}

const stateDir = mkdtempSync(join(tmpdir(), 'wa-tools-'))

function deps(transport: Transport, statSize: (p: string) => number = () => 10) {
  return { transport, stateDir, statSize }
}

const replyArgs = { pool_number_id: 'p1', to_number: '5511', text: 'hello' }

function schema(name: string): any {
  return TOOLS.find(t => t.name === name)!.inputSchema
}

test('schemas', () => {
  expect(schema('reply').required).toEqual(['pool_number_id', 'to_number', 'text'])
  expect(schema('react').required).toEqual(['pool_number_id', 'to_number', 'message_id', 'emoji'])
  for (const name of ['reply', 'react']) {
    expect(schema(name).properties.conversation_id).toBeDefined()
    expect(schema(name).required).not.toContain('conversation_id')
  }
})

test('single chunk', async () => {
  const { transport, calls } = fakeTransport()
  const r = await callTool('reply', replyArgs, deps(transport))
  expect(r).toEqual({ content: [{ type: 'text', text: 'sent' }] })
  expect(calls).toEqual([{ method: 'sendText', args: [{ poolNumberId: 'p1', to: '5511', conversationId: undefined }, 'hello'] }])
})

test('5000 chars is sent as two parts', async () => {
  const { transport, calls } = fakeTransport()
  const text = 'a'.repeat(5000)
  const r = await callTool('reply', { ...replyArgs, text }, deps(transport))
  expect(r.content[0]!.text).toBe('sent 2 parts')
  expect(calls).toHaveLength(2)
  expect((calls[0]!.args[1] as string).length).toBe(4096)
  expect((calls[0]!.args[1] as string) + (calls[1]!.args[1] as string)).toBe(text)
})

test('pool conversation_id is passed through', async () => {
  const { transport, calls } = fakeTransport()
  await callTool('reply', { ...replyArgs, conversation_id: 'c1' }, deps(transport))
  expect(calls[0]!.args[0]).toEqual({ poolNumberId: 'p1', to: '5511', conversationId: 'c1' })
})

test('chunk failure stops', async () => {
  const { transport, calls } = fakeTransport({ failTextAt: 2 })
  const r = await callTool('reply', { ...replyArgs, text: 'a'.repeat(9000) }, deps(transport))
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toBe('reply failed after 1 of 3 part(s) sent: boom')
  expect(calls).toHaveLength(2)
})

test('chunk failure on a two-part reply', async () => {
  const { transport, calls } = fakeTransport({ failTextAt: 2 })
  const r = await callTool('reply', { ...replyArgs, text: 'a'.repeat(5000), files: ['/tmp/a.png'] }, deps(transport))
  expect(r).toEqual({
    content: [{ type: 'text', text: 'reply failed after 1 of 3 part(s) sent: boom' }],
    isError: true,
  })
  expect(calls.map(c => c.method)).toEqual(['sendText', 'sendText'])
})

test('files after text', async () => {
  const { transport, calls } = fakeTransport()
  const r = await callTool('reply', { ...replyArgs, files: ['/tmp/a.png'] }, deps(transport))
  expect(calls.map(c => c.method)).toEqual(['sendText', 'sendFile'])
  expect(calls[1]!.args[1]).toBe('/tmp/a.png')
  expect(r).toEqual({ content: [{ type: 'text', text: 'sent 2 parts' }] })
})

test('files on a transport without file support are rejected before sending anything', async () => {
  const { transport, calls } = fakeTransport({ supportsFiles: false })
  const r = await callTool('reply', { ...replyArgs, files: ['/tmp/a.png'] }, deps(transport))
  expect(r).toEqual({
    content: [{ type: 'text', text: 'reply failed: file attachments are not supported on pool numbers — nothing was sent' }],
    isError: true,
  })
  expect(calls).toEqual([])
})

test('text-only reply works on a transport without file support', async () => {
  const { transport, calls } = fakeTransport({ supportsFiles: false })
  const r = await callTool('reply', { ...replyArgs, files: [] }, deps(transport))
  expect(r).toEqual({ content: [{ type: 'text', text: 'sent' }] })
  expect(calls.map(c => c.method)).toEqual(['sendText'])
})

test('file failure after text reports the partial send', async () => {
  const { transport, calls } = fakeTransport({ failFile: 'HTTP 500' })
  const r = await callTool('reply', { ...replyArgs, files: ['/tmp/a.png'] }, deps(transport))
  expect(r).toEqual({
    content: [{ type: 'text', text: 'reply failed after 1 of 2 part(s) sent: file attachment failed for /tmp/a.png: HTTP 500' }],
    isError: true,
  })
  expect(calls.map(c => c.method)).toEqual(['sendText', 'sendFile'])
})

test('files are checked before sending: type', async () => {
  const { transport, calls } = fakeTransport()
  const r = await callTool('reply', { ...replyArgs, files: ['/tmp/a.png', '/tmp/anim.gif'] }, deps(transport))
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toBe(
    'reply failed: unsupported file type for WhatsApp: .gif — send PDF, Office, text, JPEG/PNG, MP4/3GP or common audio',
  )
  expect(calls).toEqual([])
})

test('empty text with files sends only the files', async () => {
  for (const text of ['', '  \n ']) {
    const { transport, calls } = fakeTransport()
    const r = await callTool('reply', { ...replyArgs, text, files: ['/tmp/a.png'] }, deps(transport))
    expect(r).toEqual({ content: [{ type: 'text', text: 'sent' }] })
    expect(calls.map(c => c.method)).toEqual(['sendFile'])
  }
})

test('empty text without files is an error', async () => {
  for (const text of ['', '   ']) {
    const { transport, calls } = fakeTransport()
    const r = await callTool('reply', { ...replyArgs, text }, deps(transport))
    expect(r).toEqual({ content: [{ type: 'text', text: 'reply failed: text is empty' }], isError: true })
    expect(calls).toEqual([])
  }
})

test('files are checked before sending: size', async () => {
  const { transport, calls } = fakeTransport()
  const r = await callTool('reply', { ...replyArgs, files: ['/tmp/a.png'] }, deps(transport, () => 60 * 1024 * 1024))
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('file too large')
  expect(calls).toEqual([])
})

test('files are checked before sending: channel state', async () => {
  const { transport, calls } = fakeTransport()
  const envFile = join(stateDir, '.env')
  writeFileSync(envFile, 'PIPESBOT_API_KEY=ak_x\n')
  const r = await callTool('reply', { ...replyArgs, files: [envFile] }, deps(transport))
  expect(r.isError).toBe(true)
  expect(r.content[0]!.text).toContain('refusing to send channel state')
  expect(calls).toEqual([])
})

test('inbox files may be sent', async () => {
  const { transport, calls } = fakeTransport()
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  const inboxFile = join(stateDir, 'inbox', 'a.jpg')
  writeFileSync(inboxFile, 'x')
  const r = await callTool('reply', { ...replyArgs, files: [inboxFile] }, deps(transport))
  expect(r.isError).toBeUndefined()
  expect(calls.map(c => c.method)).toEqual(['sendText', 'sendFile'])
})

test('react target', async () => {
  const { transport, calls } = fakeTransport()
  const r = await callTool(
    'react',
    { pool_number_id: 'p1', to_number: 'US.1', message_id: 'wamid.9', emoji: '👍' },
    deps(transport),
  )
  expect(calls).toEqual([
    { method: 'react', args: [{ poolNumberId: 'p1', to: 'US.1', conversationId: undefined }, 'wamid.9', '👍'] },
  ])
  expect(r).toEqual({ content: [{ type: 'text', text: 'reacted' }] })
})

test('react error is wrapped', async () => {
  const transport = { ...fakeTransport().transport, react: async () => { throw new Error('nope') } }
  const r = await callTool('react', { pool_number_id: 'p1', to_number: '1', message_id: 'm', emoji: 'x' }, deps(transport))
  expect(r).toEqual({ content: [{ type: 'text', text: 'react failed: nope' }], isError: true })
})

test('unknown tool', async () => {
  const { transport } = fakeTransport()
  const r = await callTool('nope', {}, deps(transport))
  expect(r).toEqual({ content: [{ type: 'text', text: 'unknown tool: nope' }], isError: true })
})
