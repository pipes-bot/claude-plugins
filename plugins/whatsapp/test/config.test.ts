import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseConfig,
  parseEnvFile,
  loadEnvFile,
  buildWsUrl,
  bootWarnings,
  EMPTY_TRUST_WARNING,
} from '../config'

test('pk_ key selects pool mode', () => {
  expect(parseConfig({ PIPESBOT_API_KEY: 'pk_abc' })).toEqual({
    apiKey: 'pk_abc',
    mode: 'pool',
    poolNumberId: undefined,
  })
})

test('ak_ key selects app-v2 mode', () => {
  const result = parseConfig({ PIPESBOT_API_KEY: 'ak_abc' })
  expect('error' in result).toBe(false)
  expect((result as { mode: string }).mode).toBe('app-v2')
})

test('empty pool number id is undefined', () => {
  const empty = parseConfig({ PIPESBOT_API_KEY: 'pk_abc', PIPESBOT_POOL_NUMBER_ID: '' })
  expect((empty as { poolNumberId?: string }).poolNumberId).toBeUndefined()
  const set = parseConfig({ PIPESBOT_API_KEY: 'pk_abc', PIPESBOT_POOL_NUMBER_ID: 'pn_1' })
  expect((set as { poolNumberId?: string }).poolNumberId).toBe('pn_1')
})

test('bad or missing key is an error', () => {
  for (const env of [{ PIPESBOT_API_KEY: 'sk_x' }, {}]) {
    const result = parseConfig(env)
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('must start with pk_ or ak_')
  }
})

test('parseEnvFile handles CRLF', () => {
  expect(parseEnvFile('PIPESBOT_API_KEY=ak_x\r\nPIPESBOT_POOL_NUMBER_ID=pn_1\r\n')).toEqual({
    PIPESBOT_API_KEY: 'ak_x',
    PIPESBOT_POOL_NUMBER_ID: 'pn_1',
  })
})

test('loadEnvFile keeps real env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-config-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'PIPESBOT_API_KEY=pk_file\nOTHER=1\n')
  const env: Record<string, string | undefined> = { PIPESBOT_API_KEY: 'pk_real' }
  loadEnvFile(file, env)
  expect(env.PIPESBOT_API_KEY).toBe('pk_real')
  expect(env.OTHER).toBe('1')
})

test('loadEnvFile tolerates a missing file', () => {
  const env: Record<string, string | undefined> = {}
  loadEnvFile(join(tmpdir(), 'wa-config-does-not-exist', '.env'), env)
  expect(env).toEqual({})
})

test('buildWsUrl encodes key and pool number id', () => {
  expect(buildWsUrl({ apiKey: 'ak_a+b', mode: 'app-v2', poolNumberId: 'pn 1' })).toBe(
    'wss://api.pipes.bot/ws?apiKey=ak_a%2Bb&poolNumberId=pn%201',
  )
})

test('buildWsUrl omits poolNumberId when absent', () => {
  expect(buildWsUrl({ apiKey: 'pk_a', mode: 'pool' })).toBe('wss://api.pipes.bot/ws?apiKey=pk_a')
})

test('bootWarnings', () => {
  expect(bootWarnings({ apiKey: 'ak_a', mode: 'app-v2' }, 0)).toEqual([EMPTY_TRUST_WARNING])
  const queue = bootWarnings({ apiKey: 'ak_a', mode: 'app-v2', poolNumberId: 'pn_1' }, 1)
  expect(queue).toHaveLength(1)
  expect(queue[0]).toContain('does not drain the offline queue')
  expect(bootWarnings({ apiKey: 'pk_a', mode: 'pool' }, 0)).toEqual([])
})
