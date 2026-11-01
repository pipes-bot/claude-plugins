# WhatsApp BYON on API v2 + Trusted Senders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the WhatsApp channel on a BYON number through a PipesBot App on API v2 (`ak_` key) alongside pool numbers (`pk_` key), with a trusted-sender gate that matches phone numbers and BSUIDs.

**Architecture:** `server.ts` becomes wiring only. Pure modules (`config`, `trust`, `inbound`, `inbound-v2`, `outbound`, `pipeline`, `tools`) carry the logic and are unit-tested with `bun test`; `ws.ts` and `media.ts` hold the I/O. The key prefix picks a mode, and the mode picks a `Transport` (`PoolTransport` or `AppV2Transport`) and an inbound parser. A one-route auth fix in pipes-bot lets `ak_` keys download media.

**Tech Stack:** Bun 1.3, TypeScript, `@modelcontextprotocol/sdk`, `ws`, `bun:test`. Server task: pipes-bot (Hono, Vitest, pnpm).

**Spec:** `docs/superpowers/specs/2026-10-31-whatsapp-byon-v2-design.md`

## Global Constraints

- Work on branch `feat/whatsapp-byon-v2` in `claude-plugins`. Task 1 lives in the pipes-bot repo on its own branch.
- No new runtime dependencies. Tests use `bun:test` only.
- All plugin paths below are relative to `plugins/whatsapp/`.
- State dir `~/.claude/channels/whatsapp/`: `.env`, `trusted.json`, `inbox/`.
- API base `https://api.pipes.bot`; WebSocket `wss://api.pipes.bot/ws`.
- `TEXT_CHUNK_LIMIT = 4096`, `MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024`, `SEND_TIMEOUT_MS = 15_000`, `DEDUPE_CAP = 1000`.
- BSUID pattern `/^[A-Z]{2}\.(ENT\.)?\d+$/`.
- Every log line goes to stderr with the prefix `whatsapp channel: ` (existing `log()`).
- Never log the content of a message from an untrusted sender.
- Do not run `bun server.ts` with a real key: it drains the server-side offline queue (README, Troubleshooting). Smoke tests use `HOME=$(mktemp -d)` and fake keys.
- Until Task 9, `server.ts` stays untouched and working; new modules are built and tested beside it.

## Review Focus

1. **A Brazilian number whose WhatsApp ID lacks the 9th digit.** The user trusts `5511987654321`, but Meta sends `551187654321`. Expected: the message is dropped (no fuzzy matching in a security gate), and the drop log shows the exact ID to trust. Test: Task 9, `drop log names the exact id for a BR number without the 9th digit`.
2. **A hand-edited `trusted.json` with numbers instead of strings** (`[5511999998888]`). Expected: those entries work. Test: Task 3, `numeric entries are accepted`.
3. **`.env` saved with CRLF line endings.** Expected: the key loads. Test: Task 2, `parseEnvFile handles CRLF`.
4. **One v2 envelope carrying a trusted and an untrusted sender.** Expected: only the trusted message reaches Claude. Test: Task 9, `gates each message in a batch independently`.
5. **A lowercase BSUID typed by the user** (`us.1349…`). Expected: it matches `US.1349…`. Test: Task 3, `lowercase BSUID is upper-cased`.

---

### Task 1: pipes-bot — media routes accept `ak_` keys

**Repo:** `/Users/tulio/Projects/id49/pipes-bot/pipes-bot`. Its main checkout has unrelated work in progress, so work in a new worktree:

```bash
cd /Users/tulio/Projects/id49/pipes-bot/pipes-bot
git fetch origin
git worktree add .claude/worktrees/media-app-keys -b fix/media-routes-app-keys origin/main
cd .claude/worktrees/media-app-keys && pnpm install
```

pipes-bot's `.superpowers.json` applies to this task: `finish: "pr"`, `crossReview: true`.

**Files:**
- Modify: `apps/server/src/routes/v1/media.ts`: the `/upload` handler (around line 235) and the `/download/:mediaId` handler (around line 352)
- Create: `apps/server/src/routes/v1/media.test.ts`

**Interfaces:**
- Consumes: `validateAnyApiKey(apiKey): Promise<{ userId: string; appId?: string; apiVersion?: "legacy" | "v2" } | null>` from `../../lib/api-key-auth` (already exists); `resolveMediaDownload(mediaId, userId, appId)` from `../../lib/media-service`.
- Produces: `GET /v1/media/download/:mediaId` and `POST /v1/media/upload` accept `ak_` keys (used by the plugin in Task 9).

- [ ] **Step 1: Write the failing tests** in `media.test.ts`, mocking as `messages.test.ts` does (`vi.hoisted` + `vi.mock` for `@pipes-bot/db`, `../../lib/api-key-auth` with `validateApiKey`, `validateAppApiKey` and `validateAnyApiKey`, `../../lib/media-service`, `../../lib/media-upload`, and `@pipes-bot/env/server` → `{ env: {} }`). Call `mediaRouter.request(...)`.
  - `download accepts an ak_ key and passes its appId`: `validateAnyApiKey` → `{ userId: "u1", appId: "app1", apiVersion: "v2" }`, `resolveMediaDownload` → `{ url: "https://r2.example/x" }`. GET `/download/m1` with `Authorization: Bearer ak_xxxxxxxxxxxxxxxx` → status 302, `location` `https://r2.example/x`, and `resolveMediaDownload` called with `("m1", "u1", "app1")`.
  - `download still accepts a pk_ key`: `validateAnyApiKey` → `{ userId: "u1" }` → 302, called with `("m1", "u1", undefined)`.
  - `download rejects an unknown key`: `validateAnyApiKey` → `null` → 401, body `code` `"UNAUTHORIZED"`.
  - `upload accepts an ak_ key`: `validateAnyApiKey` → `{ userId: "u1", appId: "app1" }`, `handleMediaUpload` → `{ success: true, mediaId: "m2" }`. POST `/upload` with JSON `{ data: "aGk=", mimeType: "image/png" }` → 2xx, and `handleMediaUpload` called with `expect.objectContaining({ tenantId: "u1" })`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter server test -- src/routes/v1/media.test.ts`
Expected: the `ak_` tests FAIL with 401 (the routes still call `validateApiKey`).

- [ ] **Step 3: In both handlers, replace `validateApiKey(apiKey)` with `validateAnyApiKey(apiKey)`.** `/download` already passes `auth.appId`. Drop `validateApiKey` from the import if nothing else uses it.

- [ ] **Step 4: Run the tests and the server suite**

Run: `pnpm --filter server test`
Expected: all PASS.

- [ ] **Step 5: Commit, then finish** with superpowers:finishing-a-development-branch (pipes-bot config: cross-provider review, then a PR).

```bash
git add apps/server/src/routes/v1/media.ts apps/server/src/routes/v1/media.test.ts
git commit -m "fix(media): accept ak_ App keys on /v1/media/upload and /v1/media/download"
```

---

### Task 2: Plugin test setup + `config.ts`

**Files:**
- Modify: `package.json` (add `"test": "bun test"` to `scripts`)
- Create: `config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Mode = 'pool' | 'app-v2'
  export type Config = { apiKey: string; mode: Mode; poolNumberId?: string }
  export const STATE_DIR: string      // join(homedir(), '.claude', 'channels', 'whatsapp')
  export const ENV_FILE: string       // STATE_DIR/.env
  export const INBOX_DIR: string      // STATE_DIR/inbox
  export const TRUST_FILE: string     // STATE_DIR/trusted.json
  export const API_BASE = 'https://api.pipes.bot'
  export function parseEnvFile(text: string): Record<string, string>
  export function loadEnvFile(path: string, env: Record<string, string | undefined>): void  // real env wins; missing file is fine
  export function parseConfig(env: Record<string, string | undefined>): Config | { error: string }
  export function buildWsUrl(config: Config): string
  export function bootWarnings(config: Config, trustedCount: number): string[]
  export const EMPTY_TRUST_WARNING: string
  ```

- [ ] **Step 1: Write the failing tests** in `test/config.test.ts`:
  - `pk_ key selects pool mode`: `parseConfig({ PIPESBOT_API_KEY: 'pk_abc' })` → `{ apiKey: 'pk_abc', mode: 'pool', poolNumberId: undefined }`.
  - `ak_ key selects app-v2 mode`: mode `'app-v2'`.
  - `empty pool number id is undefined`: `PIPESBOT_POOL_NUMBER_ID: ''` → `poolNumberId` undefined; `'pn_1'` → `'pn_1'`.
  - `bad or missing key is an error`: `'sk_x'` and `undefined` → `'error' in result` and `result.error` contains `must start with pk_ or ak_`.
  - `parseEnvFile handles CRLF`: `'PIPESBOT_API_KEY=ak_x\r\nPIPESBOT_POOL_NUMBER_ID=pn_1\r\n'` → `{ PIPESBOT_API_KEY: 'ak_x', PIPESBOT_POOL_NUMBER_ID: 'pn_1' }`.
  - `loadEnvFile keeps real env`: env `{ PIPESBOT_API_KEY: 'pk_real' }` plus a temp file containing `PIPESBOT_API_KEY=pk_file` → stays `'pk_real'`.
  - `buildWsUrl`: `{ apiKey: 'ak_a+b', mode: 'app-v2', poolNumberId: 'pn 1' }` → `'wss://api.pipes.bot/ws?apiKey=ak_a%2Bb&poolNumberId=pn%201'`.
  - `bootWarnings`: app-v2 with 0 trusted → `[EMPTY_TRUST_WARNING]`; app-v2 with 1 trusted and a `poolNumberId` → one line containing `does not drain the offline queue`; pool with 0 trusted → `[]`.

- [ ] **Step 2: Run** `cd plugins/whatsapp && bun test test/config.test.ts`. Expected: FAIL, cannot resolve `../config`.

- [ ] **Step 3: Implement `config.ts`.** `parseEnvFile` trims each line's trailing `\r` before matching `^(\w+)=(.*)$`. Exact copy:
  - Error (the `error` value):
    ```
    PIPESBOT_API_KEY required (must start with pk_ or ak_)
      set in ${ENV_FILE}
      format: PIPESBOT_API_KEY=pk_... (pool number) or PIPESBOT_API_KEY=ak_... (BYON App on API v2)
    ```
  - `EMPTY_TRUST_WARNING`: `BYON mode: no trusted senders — all messages will be dropped. Add one with /whatsapp:configure trust <number>.`
  - Queue warning: `BYON mode: PIPESBOT_POOL_NUMBER_ID is set — a number-scoped connection does not drain the offline queue, so messages received while Claude Code was closed are not replayed.`

- [ ] **Step 4: Run** `bun test test/config.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git add plugins/whatsapp/package.json plugins/whatsapp/config.ts plugins/whatsapp/test/config.test.ts && git commit -m "feat(whatsapp): config module with pool / app-v2 mode by key prefix"`

---

### Task 3: `trust.ts`

**Files:**
- Create: `trust.ts`, `test/trust.test.ts`

**Interfaces:**
- Consumes: `Mode` (Task 2).
- Produces:
  ```ts
  export type Sender = { phone?: string; bsuid?: string }
  export const BSUID_RE = /^[A-Z]{2}\.(ENT\.)?\d+$/
  export function isBsuid(s: string): boolean
  export function normalizeId(raw: unknown): string | null
  export function readTrustList(path: string, log: (m: string) => void): Set<string>
  export function isTrusted(sender: Sender, mode: Mode, list: Set<string>): boolean
  export function describeSender(sender: Sender): string   // phone ?? bsuid ?? 'unknown sender'
  ```

- [ ] **Step 1: Write the failing tests** (temp files via `mkdtempSync(join(tmpdir(), 'trust-'))`):
  - `phone is reduced to digits`: `normalizeId('+55 (11) 99999-8888')` → `'5511999998888'`.
  - `BSUID kept as written`: `'US.13491208655302741918'` and `'BR.ENT.123'` unchanged; `isBsuid('US.1')` true, `isBsuid('5511')` false.
  - `lowercase BSUID is upper-cased`: `normalizeId(' us.1349 ')` → `'US.1349'`.
  - `numeric entries are accepted`: `normalizeId(5511999998888)` → `'5511999998888'`.
  - `junk is rejected`: `normalizeId('abc')`, `normalizeId('')`, `normalizeId({})`, `normalizeId(null)` → `null`.
  - `missing file is an empty list`: no file → size 0, `log` not called.
  - `corrupt file fails closed`: contents `{` → size 0, `log` called once with a string containing `trusted.json`.
  - `wrong shape fails closed`: `{"senders":"x"}` → size 0, `log` called.
  - `entries are normalized on read`: `{"senders":["+55 11 99999-8888","us.1",5511,null,"x"]}` → `Set {'5511999998888','US.1','5511'}`.
  - `isTrusted` cases, with list `{'5511999998888','US.1'}`:
    - `{ phone: '+55 11 99999-8888' }` → true
    - `{ bsuid: 'US.1' }` → true
    - `{ phone: '1', bsuid: 'US.1' }` → true
    - `{ phone: '1' }` → false
    - `{}` → false
    - empty list: app-v2 → false, pool → true

- [ ] **Step 2: Run** `bun test test/trust.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `trust.ts`.** `normalizeId` accepts strings and finite numbers only. It trims, upper-cases, tests `BSUID_RE` (BSUIDs are returned upper-cased), and otherwise strips non-digits; an empty result is `null`. `readTrustList` reads the file synchronously on every call and never writes it.

- [ ] **Step 4: Run** `bun test test/trust.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(whatsapp): trusted sender list matching phone or BSUID"` (with both files added).

---

### Task 4: `inbound.ts` (shared shape + pool parser) and `media.ts`

**Files:**
- Create: `inbound.ts`, `media.ts`, `test/inbound.test.ts`, `test/media.test.ts`

**Interfaces:**
- Consumes: `isBsuid` (Task 3), `API_BASE`, `INBOX_DIR` (Task 2).
- Produces:
  ```ts
  // inbound.ts
  export type InboundMedia = { downloadUrl: string; mimeType: string; fileName?: string; kind: 'image' | 'file' }
  export type InboundMessage = {
    dedupeKey: string; poolNumberId: string; messageId: string
    sender: { phone?: string; bsuid?: string; name?: string }
    replyTo: string; conversationId?: string; ts: string; body: string; media?: InboundMedia
  }
  export type PoolMessageData = /* current PipesBotMessageData from server.ts */ & { userId?: string; parentUserId?: string; username?: string }
  export const MEDIA_UNAVAILABLE = '(media unavailable)'
  export function withMediaUnavailable(body: string): string   // body ? `${body} ${MEDIA_UNAVAILABLE}` : MEDIA_UNAVAILABLE
  export function formatLocation(l: { latitude: number; longitude: number; name?: string; address?: string }): string
  export function formatContacts(cs: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone: string }> }>): string
  export function parsePoolMessage(d: PoolMessageData): InboundMessage | null
  export function frameType(msg: unknown): string | null       // msg.type when msg is an object with a string `type`
  // media.ts
  export function downloadMedia(m: InboundMedia, apiKey: string, opts?: { apiBase?: string; inboxDir?: string; fetch?: typeof fetch }): Promise<string | null>
  export function mimeFromPath(path: string): string
  ```

- [ ] **Step 1: Write the failing tests.**
  - `inbound.test.ts`:
    - `pool text maps all fields`: data `{ messageId:'m1', conversationId:'c1', poolNumberId:'p1', fromNumber:'+5511999998888', fromName:'Ana', type:'text', body:'oi', text:'oi', timestamp:'2026-10-31T10:00:00.000Z', poolNumberPhoneNumber:'+1' }` → `{ dedupeKey:'m1', messageId:'m1', poolNumberId:'p1', conversationId:'c1', replyTo:'+5511999998888', sender:{ phone:'+5511999998888', name:'Ana' }, body:'oi', ts:'2026-10-31T10:00:00.000Z' }`.
    - `pool BSUID sender`: `fromNumber:'US.1', userId:'US.1'` → `sender.phone` undefined, `sender.bsuid` `'US.1'`, `replyTo` `'US.1'`.
    - `pool skips`: type `unsupported` → `null`; `reaction` without emoji → `null`; reaction `👍` → body `'[Reaction: 👍]'`.
    - `pool media kinds`: image with `media.downloadUrl` → `media.kind === 'image'`; document → `'file'`; `media.unavailable: true` → no `media`.
    - `formatters keep today's strings`: `formatLocation({latitude:-23.5,longitude:-46.6,name:'X',address:'Y'})` → `'📍 Location: -23.5, -46.6\nName: X\nAddress: Y'`; `formatContacts([{name:{formatted_name:'Jane'},phones:[{phone:'+1'},{phone:'+2'}]}])` → `'Jane: +1, +2'`.
  - `media.test.ts` (inject `fetch` and a temp `inboxDir`):
    - `401 returns null`.
    - `redirect is followed without the auth header`: first call 302 with `location: https://r2/x`; the second call targets `https://r2/x` with no `Authorization`; a file is written under `inboxDir` with extension `pdf` when `fileName` is `'a.pdf'`.
    - `mimeFromPath`: `'/a/B.JPG'` → `'image/jpeg'`; `'/a/x.unknownext'` → `'application/octet-stream'`.

- [ ] **Step 2: Run** `bun test test/inbound.test.ts test/media.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement.** Move `resolveRawBody`, the `PipesBot*` types and `downloadMedia` out of `server.ts` (copy them; `server.ts` is rewired in Task 9). `formatLocation` and `formatContacts` are the location and contacts branches of `resolveRawBody`. Pool sender: `bsuid = userId ?? (isBsuid(fromNumber) ? fromNumber : undefined)`; `phone = isBsuid(fromNumber) ? undefined : fromNumber`. `mimeFromPath` uses the current reply mime map plus the extensions in `downloadMedia`'s map, keyed by the lower-cased extension.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(whatsapp): shared inbound message shape, pool parser, media module"`

---

### Task 5: `inbound-v2.ts`

**Files:**
- Create: `inbound-v2.ts`, `test/inbound-v2.test.ts`, `test/helpers.ts`
- Create: `test/fixtures/meta/` with copies of `incoming-text.json`, `contact-request.json`, `status-sent-bsuid-recipient.json`, `status-delivered-bsuid-recipient.json`, `status-read-bsuid-recipient.json` and `send-response-bsuid.json` from `/Users/tulio/Projects/id49/pipes-bot/pipes-bot/apps/server/src/lib/__fixtures__/meta/live/`, unchanged, plus that folder's `README.md`

**Interfaces:**
- Consumes: `InboundMessage`, `InboundMedia`, `formatLocation`, `formatContacts`, `withMediaUnavailable` (Task 4).
- Produces:
  ```ts
  export type V2Media = { mediaId?: string; downloadUrl?: string; mimeType?: string; byteSize?: number; unavailable?: boolean }
  export type V2Envelope = { id: string; field: string; createdAt: string; pipes: { appId: string; poolNumberId: string; media?: Record<string, V2Media> }; whatsapp: Record<string, any> }
  export type IdentityChange = { previousUserId: string; userId?: string; waId?: string }
  export type V2Result = { messages: InboundMessage[]; notes: string[]; identityChanges: IdentityChange[] }
  export function parseV2Event(env: V2Envelope): V2Result
  // test/helpers.ts
  export function envelopeFromMeta(fixture: any, media?: Record<string, V2Media>): V2Envelope
  // takes entry[0].changes[0]; id 'evt_test', appId 'app_test', poolNumberId 'pool_1'
  export function envelopeWith(value: Record<string, any>, opts?: { field?: string; media?: Record<string, V2Media> }): V2Envelope
  ```
- Note strings (exact):
  - `ignored event field <field>`
  - `reply failed to deliver [id=<id>]: [<code>] <title>`
  - `skipping <type> message [id=<id>]`
  - `skipping reaction removal [id=<id>]`

- [ ] **Step 1: Write the failing tests:**
  - `live incoming text`: `incoming-text.json` → one message with `body 'Oi'`, `sender { phone:'5511987654321', bsuid:'BR.10293847561029384', name:'Maria Silva' }`, `replyTo '5511987654321'`, `messageId` and `dedupeKey` `'wamid.LIVE_INCOMING_TEXT'`, `poolNumberId 'pool_1'`, `ts new Date(1791490201000).toISOString()`, `conversationId` undefined.
  - `BSUID-only sender`: the same fixture with `from` and `contacts[0].wa_id` deleted → `replyTo 'BR.10293847561029384'`, `sender.phone` undefined, `name 'Maria Silva'` (matched on `user_id`).
  - `username fallback`: contact `profile: { username: 'maria' }` → `name 'maria'`.
  - `statuses are not messages`: all three status fixtures → `messages []`, `notes []`.
  - `failed status is noted`: `statuses:[{ id:'wamid.X', status:'failed', errors:[{ code:131047, title:'Re-engagement message' }] }]` → `notes ['reply failed to deliver [id=wamid.X]: [131047] Re-engagement message']`.
  - `live contact request`: → body `'Maria Silva: +55 11 98765-4321'`.
  - `image with stored media`: `image:{ id:'123', mime_type:'image/jpeg', caption:'look' }`, media `{ '123': { downloadUrl:'/v1/media/download/abc', mimeType:'image/jpeg' } }` → body `'look'`, `media { downloadUrl:'/v1/media/download/abc', mimeType:'image/jpeg', kind:'image' }`.
  - `document keeps filename`: `document:{ id:'9', filename:'report.pdf' }` with a stored entry → `media.fileName 'report.pdf'`, `kind 'file'`.
  - `unavailable media`: entry `{ unavailable:true }` → no `media`, body `'(media unavailable)'`; with caption `'hi'` → `'hi (media unavailable)'`; a missing entry behaves the same.
  - `reactions`: `reaction:{ message_id:'w', emoji:'❤️' }` → `'[Reaction: ❤️]'`; empty emoji → no message and note `skipping reaction removal [id=…]`.
  - `buttons and interactive`: `button:{ text:'Yes' }` → `'Yes'`; `interactive:{ type:'button_reply', button_reply:{ title:'Ok' } }` → `'Ok'`; `list_reply:{ title:'Opt' }` → `'Opt'`.
  - `location`: same string as `formatLocation`.
  - `system identity change`: `{ type:'system', system:{ type:'user_changed_number', previous_user_id:'BR.1', user_id:'BR.2', wa_id:'5511' } }` → no messages, `identityChanges [{ previousUserId:'BR.1', userId:'BR.2', waId:'5511' }]`.
  - `other fields are ignored`: `field 'message_template_status_update'` → no messages, `notes ['ignored event field message_template_status_update']`.
  - `unknown type`: type `'order'` → no messages, note `skipping order message [id=…]`.
  - `order is preserved`: two text messages → bodies in input order.

- [ ] **Step 2: Run** `bun test test/inbound-v2.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `parseV2Event`.** Contact match: `contacts.find(c => (m.from && c.wa_id === m.from) || (m.from_user_id && c.user_id === m.from_user_id))`, then `profile?.name ?? profile?.username`. `ts = new Date(Number(m.timestamp) * 1000).toISOString()`.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(whatsapp): parse API v2 event envelopes"`

---

### Task 6: `outbound.ts`: `Transport`, `recipientField`, `PoolTransport`

**Files:**
- Create: `outbound.ts`, `test/outbound-pool.test.ts`

**Interfaces:**
- Consumes: `isBsuid` (Task 3).
- Produces:
  ```ts
  export type Target = { poolNumberId: string; to: string; conversationId?: string }
  export type SendOutcome = { messageId?: string }
  export type Send = (frame: object) => boolean
  export type Log = (msg: string) => void
  export interface Transport {
    sendText(t: Target, text: string): Promise<SendOutcome>
    sendFile(t: Target, path: string): Promise<SendOutcome>
    react(t: Target, messageId: string, emoji: string): Promise<SendOutcome>
    handleFrame(frame: unknown): boolean   // true when consumed
    onDisconnect(): void
  }
  export function recipientField(to: string): { to: string } | { recipient: string }
  export const POOL_UNSUPPORTED = 'not supported on pool numbers — the server ignores this frame'
  export class PoolTransport implements Transport { constructor(send: Send, log: Log) }
  ```

- [ ] **Step 1: Write the failing tests:**
  - `recipientField`: `'5511999998888'` → `{ to:'5511999998888' }`; `'US.1'` and `'BR.ENT.1'` → `{ recipient: … }`.
  - `pool sendText writes whatsapp_reply`: the captured frame equals `{ type:'whatsapp_reply', data:{ conversationId:'c1', poolNumberId:'p1', toNumber:'+55', text:'hi' } }` and the call resolves `{}`.
  - `pool sendText needs a conversation`: no `conversationId` → rejects `'conversation_id is required for pool numbers'`.
  - `pool sendText when disconnected`: `send` returns false → rejects `'WebSocket not connected'`.
  - `pool files and reactions fail loudly`: `sendFile` and `react` reject with `POOL_UNSUPPORTED`, and `send` is never called.
  - `pool consumes reply_status`: `handleFrame({ type:'reply_status', data:{ conversationId:'c1', success:false, code:'X', error:'e' } })` → true, `log` called with `'reply failed for c1: [X] e'`; `handleFrame({ type:'event' })` → false.

- [ ] **Step 2: Run** `bun test test/outbound-pool.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `reply_status` log lines are copied from `handleReplyStatus` in `server.ts`. `onDisconnect` is a no-op.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(whatsapp): transport interface and pool transport"`

---

### Task 7: `AppV2Transport`

**Files:**
- Modify: `outbound.ts` (add the class)
- Create: `test/outbound-v2.test.ts`

**Interfaces:**
- Consumes: `Transport`, `Target`, `Send`, `Log`, `recipientField` (Task 6); `mimeFromPath` (Task 4).
- Produces:
  ```ts
  export const SEND_TIMEOUT_MS = 15_000
  export type AppV2Deps = {
    send: Send; log: Log; apiKey: string; apiBase: string
    fetch?: typeof fetch; readFile?: (p: string) => Uint8Array
    newRequestId?: () => string; timeoutMs?: number
  }
  export class AppV2Transport implements Transport { constructor(deps: AppV2Deps) }
  ```
- Error copy (exact):
  - `send failed: [<error.code>] <error.message>`, plus ` — <error.error_data.details>` when present
  - `no send_result within <ms>ms`
  - `WebSocket disconnected`
  - `WebSocket not connected`
  - `send failed: HTTP <status> <response text>`
  - Unknown-request log: `send_result for unknown request <requestId>`

- [ ] **Step 1: Write the failing tests** (`newRequestId: () => 'req_1'`):
  - `text frame shape`: the captured frame equals `{ type:'send', requestId:'req_1', poolNumberId:'p1', message:{ messaging_product:'whatsapp', recipient_type:'individual', to:'5511', type:'text', text:{ body:'hi' } } }`. Then `handleFrame({ type:'send_result', requestId:'req_1', success:true, messageId:'wamid.1' })` returns true and the promise resolves `{ messageId:'wamid.1' }`.
  - `BSUID uses recipient`: target `to:'US.1'` → `message.recipient === 'US.1'` and no `message.to`.
  - `Meta error is surfaced`: `send_result` `{ success:false, error:{ code:131047, message:'(#131047) Re-engagement message', error_data:{ details:'More than 24 hours have passed' } } }` → rejects `'send failed: [131047] (#131047) Re-engagement message — More than 24 hours have passed'`.
  - `Pipes error is surfaced`: `error:{ code:'REGISTRATION_PENDING', message:'Number registration pending' }` → rejects `'send failed: [REGISTRATION_PENDING] Number registration pending'`.
  - `timeout`: `timeoutMs: 10` and no reply → rejects `'no send_result within 10ms'`.
  - `disconnect rejects pending`: `onDisconnect()` → rejects `'WebSocket disconnected'`.
  - `not connected`: `send` returns false → rejects `'WebSocket not connected'` without waiting.
  - `unknown send_result`: `handleFrame` with `requestId:'nope'` → true, and `log` is called with `'send_result for unknown request nope'`.
  - `reaction frame`: `message` equals `{ messaging_product:'whatsapp', recipient_type:'individual', to:'5511', type:'reaction', reaction:{ message_id:'wamid.9', emoji:'👍' } }`.
  - `file goes through app/send as base64`: `readFile` → `new Uint8Array([1,2,3])`, path `/tmp/shot.png`. `fetch` is called once with `https://api.example/v1/messages/app/send`, `method 'POST'`, headers `Authorization: 'Bearer ak_test'` and `'Content-Type': 'application/json'`, and JSON body `{ poolNumberId:'p1', to:'US.1', media:'AQID', mimeType:'image/png', fileName:'shot.png' }`. A 200 `{ messageId:'wamid.2' }` → resolves `{ messageId:'wamid.2' }`.
  - `file HTTP error`: 400 with text `{"error":"x"}` → rejects `'send failed: HTTP 400 {"error":"x"}'`.
  - `file mime from uppercase extension`: `/tmp/A.JPG` → body `mimeType 'image/jpeg'`.

- [ ] **Step 2: Run** `bun test test/outbound-v2.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Pending requests are a `Map<string, { resolve, reject, timer }>`; `newRequestId` defaults to `crypto.randomUUID()`. The REST body always uses the `to` key (`/app/send` accepts a phone or a BSUID there). `readFile` defaults to `readFileSync`.

- [ ] **Step 4: Run** `bun test`. Expected: PASS (all files).

- [ ] **Step 5: Commit** `git commit -m "feat(whatsapp): API v2 transport — send frames with send_result, files via app/send"`

---

### Task 8: `ws.ts`

**Files:**
- Create: `ws.ts`, `test/ws.test.ts`

**Interfaces:**
- Consumes: `Mode` (Task 2); `Send`, `Log` (Task 6).
- Produces:
  ```ts
  export type CloseInput = { kind: 'close'; code: number } | { kind: 'upgrade'; statusCode: number }
  export type CloseDecision = { action: 'reconnect' | 'reconnect-now' | 'stop'; message?: string }
  export function closeAction(input: CloseInput, opts: { mode: Mode; poolNumberId?: string }): CloseDecision
  export type ConnectionOptions = { url: string; mode: Mode; poolNumberId?: string; onFrame: (frame: unknown) => void; onDisconnect: () => void; log: Log }
  export function createConnection(opts: ConnectionOptions): { send: Send }
  ```

- [ ] **Step 1: Write the failing tests** for `closeAction`:
  - Upgrade 401 → `stop`, message `'WebSocket authentication failed (HTTP 401) — stopping'`.
  - Upgrade 403 in app-v2 with a `poolNumberId` → `stop`, and the message ends with `' — PIPESBOT_POOL_NUMBER_ID may not belong to this App'`. In pool mode, or with no `poolNumberId`, that suffix is absent.
  - Upgrade 502 → `reconnect`, message `'WebSocket upgrade failed (HTTP 502) — will reconnect'`.
  - Close 4000 → `reconnect-now`, message `'App switched API version (api_version_changed) — reconnecting'`.
  - Close 1006 → `reconnect`.

- [ ] **Step 2: Run** `bun test test/ws.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Move section C of `server.ts` (connection, heartbeat, backoff) into `createConnection`. The `unexpected-response` and `close` handlers call `closeAction` and act on it: `stop` disables reconnects, `reconnect-now` resets attempts and reconnects with no delay, `reconnect` schedules with the existing backoff. Every close calls `opts.onDisconnect()`. Parsed JSON goes to `opts.onFrame`; on open it logs ``WebSocket connected${poolNumberId ? ` (pool: ${poolNumberId})` : ''}``.

- [ ] **Step 4: Run** `bun test`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(whatsapp): connection module with v2 close handling"`

---

### Task 9: Pipeline, tools, and rewiring `server.ts`

**Files:**
- Create: `pipeline.ts`, `tools.ts`, `test/pipeline.test.ts`, `test/tools.test.ts`
- Modify: `server.ts`, replaced by wiring only (sections A–J become imports)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // pipeline.ts
  export const DEDUPE_CAP = 1000
  export type Notify = (content: string, meta: Record<string, string>) => void
  export type PipelineDeps = { mode: Mode; readTrust: () => Set<string>; download: (m: InboundMedia) => Promise<string | null>; notify: Notify; log: Log }
  export function createInboundPipeline(deps: PipelineDeps): {
    deliver(msgs: InboundMessage[]): Promise<void>
    identityChanges(changes: IdentityChange[]): void
  }
  export function createFrameRouter(deps: { mode: Mode; pipeline: ReturnType<typeof createInboundPipeline>; transport: Transport; log: Log }): (frame: unknown) => Promise<void>
  // tools.ts
  export const INSTRUCTIONS: string
  export const TOOLS: Array<{ name: string; description: string; inputSchema: object }>
  export function assertSendable(path: string, stateDir: string): void   // moved from server.ts
  export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
  export function callTool(name: string, args: Record<string, unknown>, deps: { transport: Transport; stateDir: string; statSize?: (p: string) => number }): Promise<ToolResult>
  ```
- Notification meta keys: `pool_number_id`, `message_id`, `from_number` (= `replyTo`), `user` (= `sender.name ?? replyTo`), `ts`, then when present `conversation_id`, `sender_id` (= `sender.bsuid`), `image_path` (kind `image`) or `file_path` (kind `file`).
- Log copy (exact):
  - `dropped untrusted sender <describeSender>`
  - `this App is on the legacy API — upgrade it to v2 in the PipesBot dashboard`
  - `trusted sender <previousUserId> changed WhatsApp ID — run /whatsapp:configure trust <userId ?? waId> to keep receiving their messages`
  - `EMPTY_TRUST_WARNING` (Task 2), logged once, on the first drop in app-v2 with an empty list

- [ ] **Step 1: Write the failing pipeline tests** (fakes for every dependency):
  - `untrusted sender reaches nothing`: trust `{'1'}`, a message from phone `'2'` with body `'secret'` and media → `download` and `notify` are never called; `log` is called with `'dropped untrusted sender 2'`; no log line contains `'secret'`.
  - `trusted text is delivered`: app-v2 → `notify('Oi', { pool_number_id, message_id, from_number:'5511987654321', user:'Maria Silva', ts, sender_id:'BR.10293847561029384' })`, with no `conversation_id` key.
  - `pool keeps conversation_id`: pool mode and a message with `conversationId:'c1'` → `meta.conversation_id === 'c1'`; an empty trust list still delivers.
  - `duplicates are dropped`: the same message delivered twice → `notify` called once.
  - `dedupe cap evicts oldest`: 1001 distinct ids, then id #1 again → notified again.
  - `media success`: `download` → `'/inbox/a.jpg'` → `meta.image_path`; kind `file` → `meta.file_path`.
  - `media failure`: `download` → `null` → content `'look (media unavailable)'`, no path keys.
  - `gates each message in a batch independently`: `[trusted, untrusted]` → `notify` called once, for the trusted one.
  - `empty list hint is logged once`: app-v2, empty list, two drops → `EMPTY_TRUST_WARNING` logged exactly once.
  - `drop log names the exact id for a BR number without the 9th digit`: trust `{'5511987654321'}`, sender phone `'551187654321'` → dropped, log `'dropped untrusted sender 551187654321'`.
  - `identity change of a trusted sender`: trust `{'BR.1'}`, `[{ previousUserId:'BR.1', userId:'BR.2' }]` → the trusted-sender-changed line naming `BR.2`; an untrusted previous ID → no log.
  - Router: app-v2 `whatsapp_message` twice → legacy line logged once and nothing delivered; app-v2 `event` → `parseV2Event` notes are logged and messages delivered; pool `whatsapp_message` → delivered; `send_result` / `reply_status` → `transport.handleFrame` called.

- [ ] **Step 2: Write the failing tools tests** (fake `Transport` recording calls):
  - `schemas`: `reply.required` deep-equals `['pool_number_id','to_number','text']`; `react.required` deep-equals `['pool_number_id','to_number','message_id','emoji']`; `conversation_id` is an optional property on both.
  - `single chunk`: → `'sent'`. `5000 chars` → two `sendText` calls, the first 4096 chars long → `'sent 2 parts'`.
  - `chunk failure stops`: the second `sendText` rejects `'boom'` → `isError`, text `'reply failed after 1 of 2 part(s) sent: boom'`, no third call.
  - `files after text`: `files ['/tmp/a.png']` → `sendFile` called after `sendText` → `'sent 2 parts'`. File error `POOL_UNSUPPORTED` → `isError`, text `'reply failed: file attachment failed for /tmp/a.png: not supported on pool numbers — the server ignores this frame'`.
  - `files are checked before sending`: `statSize` → 60 MB → `isError`, text contains `'file too large'`, `sendText` not called. A path inside `stateDir` (not `inbox`) → `isError` with `'refusing to send channel state'`.
  - `react target`: `transport.react` receives `({ poolNumberId:'p1', to:'US.1', conversationId: undefined }, 'wamid.9', '👍')` → `'reacted'`.
  - `unknown tool`: `isError`, `'unknown tool: nope'`.

- [ ] **Step 3: Run** `bun test test/pipeline.test.ts test/tools.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement `pipeline.ts` and `tools.ts`.** Dedupe uses a `Set` plus insertion order: delete the oldest entry when `size > DEDUPE_CAP`. The pipeline runs, per message: dedupe → `isTrusted(sender, mode, readTrust())` → `download` → `notify`. `INSTRUCTIONS` is today's text with these changes:
  - pass back `conversation_id` only when the tag has one;
  - `from_number` may be a BSUID — pass it as `to_number` unchanged;
  - `sender_id` is informational.

  Tool descriptions say file attachments and reactions work on BYON (v2) numbers only.

- [ ] **Step 5: Rewire `server.ts`:**
  1. `loadEnvFile(ENV_FILE, process.env)`; then `parseConfig`, and on error write it to stderr and `process.exit(1)`.
  2. Log every line of `bootWarnings(config, readTrustList(TRUST_FILE, log).size)`.
  3. Build the transport for the mode: `PoolTransport`, or `AppV2Transport` with `apiBase: API_BASE`. The transport needs `send` before the connection exists, so pass `const send: Send = f => conn?.send(f) ?? false` and assign `conn` in step 5 below.
  4. Build the pipeline: `download` = `m => downloadMedia(m, config.apiKey)`, and `notify` sends `notifications/claude/channel`.
  5. Build the router, then `createConnection({ url: buildWsUrl(config), mode, poolNumberId, onFrame: router, onDisconnect: () => transport.onDisconnect(), log })`.
  6. MCP handlers return `TOOLS` and `callTool(...)`.

  Delete the moved code from `server.ts`, and update the header comment to describe both modes.

- [ ] **Step 6: Run all tests and smoke-test boot**

```bash
cd plugins/whatsapp
bun test
H=$(mktemp -d); HOME=$H PIPESBOT_API_KEY=bad bun server.ts </dev/null; echo "exit=$?"
H=$(mktemp -d); sleep 30 | HOME=$H PIPESBOT_API_KEY=ak_0000000000000000000000000000000000 perl -e 'alarm 8; exec @ARGV' bun server.ts 2>&1 | head -5
```

Expected:
- every test PASSes;
- the first command prints the `must start with pk_ or ak_` error and `exit=1`;
- the second prints `EMPTY_TRUST_WARNING`, then `WebSocket authentication failed (HTTP 401) — stopping`. The fake key can't authenticate, so no queue is touched.

- [ ] **Step 7: Commit** `git commit -m "feat(whatsapp): BYON v2 mode with trusted-sender gate; server.ts becomes wiring"`

---

### Task 10: Configure skill, READMEs, version

**Files:**
- Modify: `plugins/whatsapp/skills/configure/SKILL.md`, `plugins/whatsapp/README.md`, `README.md`, `plugins/whatsapp/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: `trusted.json` format and normalization rules (Task 3); mode by prefix (Task 2).

- [ ] **Step 1: Update `SKILL.md`:**
  - The key argument accepts `pk_` (pool) or `ak_` (BYON App on API v2).
  - The no-args status adds **Mode** and **Trusted senders**: a count, plus `EMPTY_TRUST_WARNING`'s advice when BYON and empty.
  - New subcommands `trust <phone|BSUID>`, `untrust <phone|BSUID>` and `trusted`. Each spells out the normalization rule from Task 3 (trim, upper-case, BSUID kept, otherwise digits only) so the skill writes the same IDs the server compares. Create `trusted.json` as `{ "senders": [] }` with `chmod 600`, which means adding `Bash(chmod *)` to `allowed-tools`.
  - Trust changes apply immediately. Key changes need `/reload-plugins` or a restart.
  - A dropped message's log line shows the exact ID to trust, which matters for Brazilian numbers whose WhatsApp ID lacks the 9th digit.

- [ ] **Step 2: Update the READMEs:**
  - Setup for both modes. For BYON: the App must be on API v2, connect your number, `/whatsapp:configure ak_…`, then `/whatsapp:configure trust <your number>`.
  - A "Trusted senders" section.
  - Tool tables: files and reactions are BYON only.
  - The architecture section lists the modules, replacing "single-file".
  - A Troubleshooting note: inbound BYON media needs the pipes-bot media auth fix (Task 1) deployed; until then such messages arrive as `(media unavailable)`.
  - Root README: version `0.1.0`.

- [ ] **Step 3: Set `"version": "0.1.0"`** in `plugin.json` and in the `whatsapp` entry of `marketplace.json`.

- [ ] **Step 4: Verify**

Run: `grep -n '"version"' plugins/whatsapp/.claude-plugin/plugin.json .claude-plugin/marketplace.json && grep -c 'trust' plugins/whatsapp/skills/configure/SKILL.md && cd plugins/whatsapp && bun test`
Expected: both versions `0.1.0`, a non-zero trust count, all tests PASS.

- [ ] **Step 5: Commit** `git commit -m "docs(whatsapp): BYON v2 setup, trusted senders, configure trust commands; v0.1.0"`

---

### Task 11: Manual end-to-end check (with your human partner)

Unit tests can't cover this. It needs a v2 App, a BYON number, the Task 1 fix deployed, and your human partner's phones. Running the real server consumes the offline queue, so do it in the real Claude Code session with the plugin installed from this branch.

- [ ] **Step 1:** `/whatsapp:configure ak_…` and `/whatsapp:configure trust <phone A>`, then `/reload-plugins`.
- [ ] **Step 2:** From phone A, send a text, an image and a reaction. All three reach Claude, and the image arrives with `image_path`.
- [ ] **Step 3:** Claude replies with text, with a file, and with a reaction. All three arrive on phone A.
- [ ] **Step 4:** From an untrusted phone B, send a message. Nothing reaches Claude, and the MCP log shows `dropped untrusted sender <B>`.
- [ ] **Step 5:** If one is available, send from a username-only (BSUID) sender after `trust <BSUID>`. It is delivered, and the reply arrives.
- [ ] **Step 6:** Switch back to a `pk_` key: text in and out still works, and `reply` with files returns the pool error.
- [ ] **Step 7:** Record the results in the PR description.
