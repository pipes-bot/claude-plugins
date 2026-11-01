import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Mode = 'pool' | 'app-v2'
export type Config = { apiKey: string; mode: Mode; poolNumberId?: string }

export const STATE_DIR = join(homedir(), '.claude', 'channels', 'whatsapp')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const TRUST_FILE = join(STATE_DIR, 'trusted.json')

export const API_BASE = 'https://api.pipes.bot'
const WS_BASE = 'wss://api.pipes.bot/ws'

export const EMPTY_TRUST_WARNING =
  'BYON mode: no trusted senders — all messages will be dropped. Add one with /whatsapp:configure trust <number>.'

const QUEUE_WARNING =
  'BYON mode: PIPESBOT_POOL_NUMBER_ID is set — a number-scoped connection does not drain the offline queue, so messages received while Claude Code was closed are not replayed.'

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.replace(/\r$/, '').match(/^(\w+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// Load an env file into `env`. Real env wins; a missing file is fine.
export function loadEnvFile(path: string, env: Record<string, string | undefined>): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const [k, v] of Object.entries(parseEnvFile(text))) {
    if (env[k] === undefined) env[k] = v
  }
}

export function parseConfig(env: Record<string, string | undefined>): Config | { error: string } {
  const apiKey = env.PIPESBOT_API_KEY
  if (!apiKey || !(apiKey.startsWith('pk_') || apiKey.startsWith('ak_'))) {
    return {
      error:
        `PIPESBOT_API_KEY required (must start with pk_ or ak_)\n` +
        `  set in ${ENV_FILE}\n` +
        `  format: PIPESBOT_API_KEY=pk_... (pool number) or PIPESBOT_API_KEY=ak_... (BYON App on API v2)`,
    }
  }
  return {
    apiKey,
    mode: apiKey.startsWith('ak_') ? 'app-v2' : 'pool',
    poolNumberId: env.PIPESBOT_POOL_NUMBER_ID || undefined,
  }
}

export function buildWsUrl(config: Config): string {
  let url = `${WS_BASE}?apiKey=${encodeURIComponent(config.apiKey)}`
  if (config.poolNumberId) url += `&poolNumberId=${encodeURIComponent(config.poolNumberId)}`
  return url
}

export function bootWarnings(config: Config, trustedCount: number): string[] {
  const warnings: string[] = []
  if (config.mode === 'app-v2') {
    if (trustedCount === 0) warnings.push(EMPTY_TRUST_WARNING)
    if (config.poolNumberId) warnings.push(QUEUE_WARNING)
  }
  return warnings
}
