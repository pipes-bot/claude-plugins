import { test, expect } from 'bun:test'
import { closeAction, redactKey, handshakeHint, isHandshakeRejection } from '../ws'

test('upgrade 401 stops with an authentication message', () => {
  expect(closeAction({ kind: 'upgrade', statusCode: 401 }, { mode: 'pool' })).toEqual({
    action: 'stop',
    message: 'WebSocket authentication failed (HTTP 401) — stopping',
  })
})

test('upgrade 403 in app-v2 with poolNumberId hints at the pool number', () => {
  const d = closeAction({ kind: 'upgrade', statusCode: 403 }, { mode: 'app-v2', poolNumberId: 'p1' })
  expect(d.action).toBe('stop')
  expect(d.message!.endsWith(' — PIPESBOT_POOL_NUMBER_ID may not belong to this App')).toBe(true)
})

test('upgrade 403 in pool mode or without poolNumberId has no hint', () => {
  const pool = closeAction({ kind: 'upgrade', statusCode: 403 }, { mode: 'pool', poolNumberId: 'p1' })
  const noId = closeAction({ kind: 'upgrade', statusCode: 403 }, { mode: 'app-v2' })
  for (const d of [pool, noId]) {
    expect(d.action).toBe('stop')
    expect(d.message).toBe('WebSocket authentication failed (HTTP 403) — stopping')
  }
})

test('upgrade 502 reconnects', () => {
  expect(closeAction({ kind: 'upgrade', statusCode: 502 }, { mode: 'pool' })).toEqual({
    action: 'reconnect',
    message: 'WebSocket upgrade failed (HTTP 502) — will reconnect',
  })
})

test('close 4000 reconnects immediately', () => {
  expect(closeAction({ kind: 'close', code: 4000 }, { mode: 'app-v2' })).toEqual({
    action: 'reconnect-now',
    message: 'App switched API version (api_version_changed) — reconnecting',
  })
})

test('close 1006 reconnects with backoff', () => {
  expect(closeAction({ kind: 'close', code: 1006 }, { mode: 'app-v2' }).action).toBe('reconnect')
})

test('redactKey hides the key in a URL with more params', () => {
  expect(
    redactKey("WebSocket connection to 'wss://api.pipes.bot/ws?apiKey=ak_abc123&poolNumberId=pn_1' failed"),
  ).toBe("WebSocket connection to 'wss://api.pipes.bot/ws?apiKey=***&poolNumberId=pn_1' failed")
})

test('redactKey leaves text without apiKey= unchanged', () => {
  expect(redactKey('WebSocket error: connection reset')).toBe('WebSocket error: connection reset')
})

test('redactKey hides a key at the end of the string', () => {
  expect(redactKey('wss://api.pipes.bot/ws?apiKey=pk_secret')).toBe('wss://api.pipes.bot/ws?apiKey=***')
})

test('redactKey stops at whitespace and quotes', () => {
  expect(redactKey('url apiKey=ak_1 next "apiKey=ak_2" done')).toBe('url apiKey=*** next "apiKey=***" done')
})

const HINT = 'WebSocket handshake rejected 3 times in a row — check PIPESBOT_API_KEY'

test('handshakeHint fires only on the third consecutive rejection', () => {
  expect(handshakeHint(1)).toBeNull()
  expect(handshakeHint(2)).toBeNull()
  expect(handshakeHint(3)).toBe(`${HINT} (still retrying with backoff)`)
  expect(handshakeHint(3, 'pn_1')).toBe(`${HINT} and PIPESBOT_POOL_NUMBER_ID (still retrying with backoff)`)
  expect(handshakeHint(4)).toBeNull()
  expect(handshakeHint(4, 'pn_1')).toBeNull()
})

test('isHandshakeRejection matches Bun\'s non-101 error', () => {
  expect(isHandshakeRejection("WebSocket connection to 'wss://x' failed: Expected 101 status code")).toBe(true)
  expect(isHandshakeRejection('connect ECONNREFUSED')).toBe(false)
})
