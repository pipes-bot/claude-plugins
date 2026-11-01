import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeId, isBsuid, readTrustList, isTrusted, describeSender } from '../trust'

function tmpFile(contents?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'trust-')), 'trusted.json')
  if (contents !== undefined) writeFileSync(path, contents)
  return path
}

test('phone is reduced to digits', () => {
  expect(normalizeId('+55 (11) 99999-8888')).toBe('5511999998888')
})

test('BSUID kept as written', () => {
  expect(normalizeId('US.13491208655302741918')).toBe('US.13491208655302741918')
  expect(normalizeId('BR.ENT.123')).toBe('BR.ENT.123')
  expect(isBsuid('US.1')).toBe(true)
  expect(isBsuid('5511')).toBe(false)
})

test('lowercase BSUID is upper-cased', () => {
  expect(normalizeId(' us.1349 ')).toBe('US.1349')
})

test('numeric entries are accepted', () => {
  expect(normalizeId(5511999998888)).toBe('5511999998888')
})

test('junk is rejected', () => {
  expect(normalizeId('abc')).toBeNull()
  expect(normalizeId('')).toBeNull()
  expect(normalizeId({})).toBeNull()
  expect(normalizeId(null)).toBeNull()
  expect(normalizeId(undefined)).toBeNull()
  expect(normalizeId(NaN)).toBeNull()
  expect(normalizeId(Infinity)).toBeNull()
})

test('missing file is an empty list', () => {
  const logs: string[] = []
  const list = readTrustList(tmpFile(), m => logs.push(m))
  expect(list.size).toBe(0)
  expect(logs).toHaveLength(0)
})

test('corrupt file fails closed', () => {
  const logs: string[] = []
  const list = readTrustList(tmpFile('{'), m => logs.push(m))
  expect(list.size).toBe(0)
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('trusted.json')
})

test('wrong shape fails closed', () => {
  const logs: string[] = []
  const list = readTrustList(tmpFile('{"senders":"x"}'), m => logs.push(m))
  expect(list.size).toBe(0)
  expect(logs.length).toBeGreaterThan(0)
})

test('entries are normalized on read', () => {
  const list = readTrustList(
    tmpFile('{"senders":["+55 11 99999-8888","us.1",5511,null,"x"]}'),
    () => {},
  )
  expect(list).toEqual(new Set(['5511999998888', 'US.1', '5511']))
})

test('isTrusted matches phone or BSUID', () => {
  const list = new Set(['5511999998888', 'US.1'])
  expect(isTrusted({ phone: '+55 11 99999-8888' }, 'app-v2', list)).toBe(true)
  expect(isTrusted({ bsuid: 'US.1' }, 'app-v2', list)).toBe(true)
  expect(isTrusted({ phone: '1', bsuid: 'US.1' }, 'app-v2', list)).toBe(true)
  expect(isTrusted({ phone: '1' }, 'app-v2', list)).toBe(false)
  expect(isTrusted({}, 'app-v2', list)).toBe(false)
})

test('empty list: app-v2 rejects, pool accepts', () => {
  expect(isTrusted({ phone: '5511999998888' }, 'app-v2', new Set())).toBe(false)
  expect(isTrusted({ phone: '5511999998888' }, 'pool', new Set())).toBe(true)
})

test('a BSUID in the phone field, or digits in the bsuid field, never match across kinds', () => {
  const list = new Set(['5511', 'US.1'])
  expect(isTrusted({ phone: 'US.1' }, 'app-v2', list)).toBe(false)
  expect(isTrusted({ bsuid: '5511' }, 'app-v2', list)).toBe(false)
})

test('describeSender prefers phone, then BSUID', () => {
  expect(describeSender({ phone: '5511', bsuid: 'US.1' })).toBe('5511')
  expect(describeSender({ bsuid: 'US.1' })).toBe('US.1')
  expect(describeSender({})).toBe('unknown sender')
})
