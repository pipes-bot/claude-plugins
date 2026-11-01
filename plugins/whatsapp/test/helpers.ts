import type { V2Envelope, V2Media } from '../inbound-v2'

/** Wrap a Meta webhook fixture (entry[0].changes[0]) in an API v2 event envelope. */
export function envelopeFromMeta(fixture: any, media?: Record<string, V2Media>): V2Envelope {
  const change = fixture.entry[0].changes[0]
  return {
    id: 'evt_test',
    field: change.field,
    createdAt: '2026-11-01T00:00:00.000Z',
    pipes: { appId: 'app_test', poolNumberId: 'pool_1', media },
    whatsapp: change.value,
  }
}

/** Build an envelope around a hand-written `change.value`. */
export function envelopeWith(
  value: Record<string, any>,
  opts: { field?: string; media?: Record<string, V2Media> } = {},
): V2Envelope {
  return {
    id: 'evt_test',
    field: opts.field ?? 'messages',
    createdAt: '2026-11-01T00:00:00.000Z',
    pipes: { appId: 'app_test', poolNumberId: 'pool_1', media: opts.media },
    whatsapp: value,
  }
}
