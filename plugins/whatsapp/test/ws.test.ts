import { test, expect } from 'bun:test'
import { closeAction } from '../ws'

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
