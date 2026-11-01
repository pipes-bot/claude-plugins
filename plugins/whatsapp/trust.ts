import { readFileSync } from 'fs'
import type { Mode } from './config'

export type Sender = { phone?: string; bsuid?: string }

export const BSUID_RE = /^[A-Z]{2}\.(ENT\.)?\d+$/

export function isBsuid(s: string): boolean {
  return BSUID_RE.test(s)
}

// Canonical form of a trusted-list entry or sender identifier: an upper-cased
// BSUID, or a phone number reduced to digits. Anything else is null.
export function normalizeId(raw: unknown): string | null {
  let s: string
  if (typeof raw === 'string') s = raw
  else if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw)
  else return null
  s = s.trim().toUpperCase()
  if (isBsuid(s)) return s
  const digits = s.replace(/\D/g, '')
  return digits === '' ? null : digits
}

// Read on every call so edits take effect without a restart. Never writes.
// A missing file is an empty list; an unreadable or malformed one fails closed
// (empty list) and is logged.
export function readTrustList(path: string, log: (m: string) => void): Set<string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`cannot read trusted.json (${path}): ${(err as Error).message} — treating as empty`)
    }
    return new Set()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    log(`trusted.json (${path}) is not valid JSON — treating as empty`)
    return new Set()
  }
  const senders = (parsed as { senders?: unknown } | null)?.senders
  if (!Array.isArray(senders)) {
    log(`trusted.json (${path}) must look like {"senders": [...]} — treating as empty`)
    return new Set()
  }
  const out = new Set<string>()
  for (const entry of senders) {
    const id = normalizeId(entry)
    if (id !== null) out.add(id)
  }
  return out
}

// An empty list trusts everyone on a pool number and no one on app-v2. A non-empty
// list gates both modes: the sender must match it by phone number or BSUID. Each
// field is only compared as its own kind, so a BSUID in `phone` or digits in `bsuid`
// never match.
export function isTrusted(sender: Sender, mode: Mode, list: Set<string>): boolean {
  if (list.size === 0) return mode === 'pool'
  const phone = normalizeId(sender.phone)
  if (phone !== null && !isBsuid(phone) && list.has(phone)) return true
  const bsuid = normalizeId(sender.bsuid)
  if (bsuid !== null && isBsuid(bsuid) && list.has(bsuid)) return true
  return false
}

export function describeSender(sender: Sender): string {
  return sender.phone ?? sender.bsuid ?? 'unknown sender'
}
