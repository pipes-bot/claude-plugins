import { test, expect } from 'bun:test'
import { AppV2Transport } from '../outbound'

const target = { poolNumberId: 'p1', to: '5511' }

function setup(opts: { connected?: boolean; timeoutMs?: number; fetch?: any; readFile?: any } = {}) {
  const frames: any[] = []
  const logs: string[] = []
  const transport = new AppV2Transport({
    send: f => {
      if (opts.connected === false) return false
      frames.push(f)
      return true
    },
    log: m => logs.push(m),
    apiKey: 'ak_test',
    apiBase: 'https://api.example',
    newRequestId: () => 'req_1',
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
    readFile: opts.readFile,
  })
  return { transport, frames, logs }
}

test('app-v2 transport supports files', () => {
  expect(setup().transport.supportsFiles).toBe(true)
})

test('text frame shape', async () => {
  const { transport, frames } = setup()
  const p = transport.sendText(target, 'hi')
  expect(frames[0]).toEqual({
    type: 'send',
    requestId: 'req_1',
    poolNumberId: 'p1',
    message: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511',
      type: 'text',
      text: { body: 'hi' },
    },
  })
  expect(transport.handleFrame({ type: 'send_result', requestId: 'req_1', success: true, messageId: 'wamid.1' })).toBe(true)
  expect(await p).toEqual({ messageId: 'wamid.1' })
})

test('BSUID uses recipient', async () => {
  const { transport, frames } = setup()
  const p = transport.sendText({ poolNumberId: 'p1', to: 'US.1' }, 'hi')
  expect(frames[0].message.recipient).toBe('US.1')
  expect(frames[0].message.to).toBeUndefined()
  transport.handleFrame({ type: 'send_result', requestId: 'req_1', success: true })
  await p
})

test('Meta error is surfaced', async () => {
  const { transport } = setup()
  const p = transport.sendText(target, 'hi')
  transport.handleFrame({
    type: 'send_result',
    requestId: 'req_1',
    success: false,
    error: {
      code: 131047,
      message: '(#131047) Re-engagement message',
      error_data: { details: 'More than 24 hours have passed' },
    },
  })
  await expect(p).rejects.toThrow('send failed: [131047] (#131047) Re-engagement message — More than 24 hours have passed')
})

test('Pipes error is surfaced', async () => {
  const { transport } = setup()
  const p = transport.sendText(target, 'hi')
  transport.handleFrame({
    type: 'send_result',
    requestId: 'req_1',
    success: false,
    error: { code: 'REGISTRATION_PENDING', message: 'Number registration pending' },
  })
  await expect(p).rejects.toThrow('send failed: [REGISTRATION_PENDING] Number registration pending')
})

test('failure without error object', async () => {
  const { transport } = setup()
  const p = transport.sendText(target, 'hi')
  transport.handleFrame({ type: 'send_result', requestId: 'req_1', success: false })
  await expect(p).rejects.toThrow('send failed: [UNKNOWN] unknown error')
})

test('timeout', async () => {
  const { transport } = setup({ timeoutMs: 10 })
  await expect(transport.sendText(target, 'hi')).rejects.toThrow('no send_result within 10ms')
})

test('disconnect rejects pending', async () => {
  const { transport } = setup()
  const p = transport.sendText(target, 'hi')
  transport.onDisconnect()
  await expect(p).rejects.toThrow('WebSocket disconnected')
})

test('not connected', async () => {
  const { transport } = setup({ connected: false })
  await expect(transport.sendText(target, 'hi')).rejects.toThrow('WebSocket not connected')
})

test('unknown send_result', () => {
  const { transport, logs } = setup()
  expect(transport.handleFrame({ type: 'send_result', requestId: 'nope', success: true })).toBe(true)
  expect(logs).toContain('send_result for unknown request nope')
})

test('send_result with non-string requestId is treated as unknown', () => {
  const { transport, logs } = setup()
  expect(transport.handleFrame({ type: 'send_result', requestId: 5, success: true })).toBe(true)
  expect(logs.length).toBe(1)
})

test('handleFrame ignores other frames', () => {
  const { transport } = setup()
  expect(transport.handleFrame({ type: 'reply_status' })).toBe(false)
  expect(transport.handleFrame(null)).toBe(false)
})

test('reaction frame', async () => {
  const { transport, frames } = setup()
  const p = transport.react(target, 'wamid.9', '👍')
  expect(frames[0].message).toEqual({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '5511',
    type: 'reaction',
    reaction: { message_id: 'wamid.9', emoji: '👍' },
  })
  transport.handleFrame({ type: 'send_result', requestId: 'req_1', success: true })
  await p
})

function fileSetup(response: { ok: boolean; status: number; json?: any; text?: string }) {
  const calls: any[] = []
  const fetchFn = async (url: string, init: any) => {
    calls.push({ url, init })
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
      text: async () => response.text ?? '',
    }
  }
  const s = setup({ fetch: fetchFn, readFile: () => new Uint8Array([1, 2, 3]) })
  return { ...s, calls }
}

test('file goes through app/send as base64', async () => {
  const { transport, calls, frames } = fileSetup({ ok: true, status: 200, json: { messageId: 'wamid.2' } })
  const out = await transport.sendFile({ poolNumberId: 'p1', to: 'US.1' }, '/tmp/shot.png')
  expect(out).toEqual({ messageId: 'wamid.2' })
  expect(frames).toEqual([])
  expect(calls.length).toBe(1)
  expect(calls[0].url).toBe('https://api.example/v1/messages/app/send')
  expect(calls[0].init.method).toBe('POST')
  expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer ak_test', 'Content-Type': 'application/json' })
  expect(JSON.parse(calls[0].init.body)).toEqual({
    poolNumberId: 'p1',
    to: 'US.1',
    media: 'AQID',
    mimeType: 'image/png',
    fileName: 'shot.png',
  })
})

test('file HTTP error', async () => {
  const { transport } = fileSetup({ ok: false, status: 400, text: '{"error":"x"}' })
  await expect(transport.sendFile(target, '/tmp/shot.png')).rejects.toThrow('send failed: HTTP 400 {"error":"x"}')
})

test('file mime from uppercase extension', async () => {
  const { transport, calls } = fileSetup({ ok: true, status: 200, json: { messageId: 'w' } })
  await transport.sendFile(target, '/tmp/A.JPG')
  expect(JSON.parse(calls[0].init.body).mimeType).toBe('image/jpeg')
})

test('file mime: markdown is sent as text/plain', async () => {
  const { transport, calls } = fileSetup({ ok: true, status: 200, json: { messageId: 'w' } })
  await transport.sendFile(target, '/tmp/notes.md')
  const body = JSON.parse(calls[0].init.body)
  expect(body.mimeType).toBe('text/plain')
  expect(body.fileName).toBe('notes.md')
})

test('file mime: docx', async () => {
  const { transport, calls } = fileSetup({ ok: true, status: 200, json: { messageId: 'w' } })
  await transport.sendFile(target, '/tmp/report.docx')
  expect(JSON.parse(calls[0].init.body).mimeType).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
})

test('unsupported file types fail before any network call', async () => {
  const { transport, calls } = fileSetup({ ok: true, status: 200, json: { messageId: 'w' } })
  const hint = 'send PDF, Office, text, JPEG/PNG, MP4/3GP or common audio'
  await expect(transport.sendFile(target, '/tmp/anim.gif')).rejects.toThrow(
    `unsupported file type for WhatsApp: .gif — ${hint}`,
  )
  await expect(transport.sendFile(target, '/tmp/bundle.ZIP')).rejects.toThrow(
    `unsupported file type for WhatsApp: .zip — ${hint}`,
  )
  await expect(transport.sendFile(target, '/tmp/Makefile')).rejects.toThrow(
    `unsupported file type for WhatsApp: (none) — ${hint}`,
  )
  expect(calls).toEqual([])
})
