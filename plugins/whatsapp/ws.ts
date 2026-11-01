import WebSocket from 'ws'
import type { Mode } from './config'
import type { Send, Log } from './outbound'

const BASE_MS = 1_000
const MAX_MS = 120_000
const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 50_000
const HANDSHAKE_TIMEOUT_MS = 10_000

const CLOSE_API_VERSION_CHANGED = 4000

export type CloseInput = { kind: 'close'; code: number } | { kind: 'upgrade'; statusCode: number }
export type CloseDecision = { action: 'reconnect' | 'reconnect-now' | 'stop'; message?: string }

export function closeAction(
  input: CloseInput,
  opts: { mode: Mode; poolNumberId?: string },
): CloseDecision {
  if (input.kind === 'upgrade') {
    const { statusCode } = input
    if (statusCode === 401 || statusCode === 403) {
      let message = `WebSocket authentication failed (HTTP ${statusCode}) — stopping`
      if (statusCode === 403 && opts.mode === 'app-v2' && opts.poolNumberId) {
        message += ' — PIPESBOT_POOL_NUMBER_ID may not belong to this App'
      }
      return { action: 'stop', message }
    }
    return { action: 'reconnect', message: `WebSocket upgrade failed (HTTP ${statusCode}) — will reconnect` }
  }
  if (input.code === CLOSE_API_VERSION_CHANGED) {
    return { action: 'reconnect-now', message: 'App switched API version (api_version_changed) — reconnecting' }
  }
  return { action: 'reconnect' }
}

/** Replace the value of any `apiKey=` parameter so the key never reaches a log. */
export function redactKey(text: string): string {
  return text.replace(/apiKey=[^&\s'"]*/g, 'apiKey=***')
}

// Bun's WebSocket does not emit `unexpected-response`, so a rejected upgrade (401/403
// included) only surfaces as an `error` whose message carries no status code.
export function isHandshakeRejection(message: string): boolean {
  return message.includes('Expected 101 status code')
}

const HANDSHAKE_HINT_AT = 3

/** The hint to log after `consecutiveRejections` rejected handshakes, or null. */
export function handshakeHint(consecutiveRejections: number, poolNumberId?: string): string | null {
  if (consecutiveRejections !== HANDSHAKE_HINT_AT) return null
  const vars = poolNumberId ? 'PIPESBOT_API_KEY and PIPESBOT_POOL_NUMBER_ID' : 'PIPESBOT_API_KEY'
  return `WebSocket handshake rejected ${HANDSHAKE_HINT_AT} times in a row — check ${vars} (still retrying with backoff)`
}

function computeBackoffDelay(attempt: number): number {
  return Math.floor(Math.random() * Math.min(MAX_MS, BASE_MS * Math.pow(2, attempt)))
}

export type ConnectionOptions = {
  url: string
  mode: Mode
  poolNumberId?: string
  onFrame: (frame: unknown) => void
  onDisconnect: () => void
  log: Log
}

export function createConnection(opts: ConnectionOptions): { send: Send } {
  const { log } = opts
  let ws: WebSocket | null = null
  let shouldReconnect = true
  let reconnectAttempts = 0
  let handshakeRejections = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null

  const send: Send = frame => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  function startHeartbeat(socket: WebSocket): void {
    pingTimer = setInterval(() => {
      socket.ping()

      if (pongTimer !== null) clearTimeout(pongTimer)
      pongTimer = setTimeout(() => {
        log('pong timeout — terminating dead connection')
        socket.terminate()
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)

    socket.on('pong', () => {
      if (pongTimer !== null) {
        clearTimeout(pongTimer)
        pongTimer = null
      }
    })
  }

  function stopHeartbeat(): void {
    if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null }
    if (pongTimer !== null) { clearTimeout(pongTimer); pongTimer = null }
  }

  function scheduleReconnect(): void {
    reconnectAttempts += 1
    const delay = computeBackoffDelay(reconnectAttempts)
    log(`reconnect attempt ${reconnectAttempts} in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect(): void {
    const socket = new WebSocket(opts.url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    ws = socket

    socket.on('unexpected-response', (_req, response) => {
      const decision = closeAction(
        { kind: 'upgrade', statusCode: response.statusCode ?? 0 },
        { mode: opts.mode, poolNumberId: opts.poolNumberId },
      )
      if (decision.action === 'stop') shouldReconnect = false
      if (decision.message) log(decision.message)
    })

    socket.on('open', () => {
      reconnectAttempts = 0
      handshakeRejections = 0
      log(`WebSocket connected${opts.poolNumberId ? ` (pool: ${opts.poolNumberId})` : ' (all pools)'}`)
      startHeartbeat(socket)
    })

    socket.on('message', data => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        log('received non-JSON WebSocket message — ignoring')
        return
      }
      opts.onFrame(parsed)
    })

    socket.on('error', err => {
      log(redactKey(`WebSocket error: ${err.message}`))
      if (isHandshakeRejection(err.message)) {
        handshakeRejections += 1
        const hint = handshakeHint(handshakeRejections, opts.poolNumberId)
        if (hint) log(hint)
      }
    })

    socket.on('close', code => {
      stopHeartbeat()
      ws = null
      opts.onDisconnect()
      if (!shouldReconnect) {
        log('WebSocket disconnected')
        return
      }
      const decision = closeAction({ kind: 'close', code }, { mode: opts.mode, poolNumberId: opts.poolNumberId })
      if (decision.message) log(decision.message)
      if (decision.action === 'reconnect-now') {
        reconnectAttempts = 0
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
        connect()
      } else {
        scheduleReconnect()
      }
    })
  }

  connect()
  return { send }
}
