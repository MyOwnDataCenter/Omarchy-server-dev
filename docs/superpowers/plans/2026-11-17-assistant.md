# Omarchy Server Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-app assistant: per-user provider keys, chat that auto-runs reads, Approve cards for writes, then catalog MCP from installed apps.

**Architecture:** The agent loop lives in omarchyd. Keys, conversations, and pending actions stay in `<dataDir>/assistant/` (mode `0600`). The SPA is a chat window. The web process allow-lists new RPCs and proxies `POST /api/assistant/stream` to omarchyd’s localhost `POST /assistant/stream` as SSE without buffering. Built-in tools wrap existing RPCs. Writes become pending actions; Approve runs the captured call. MCP is HTTP/SSE to a catalog-declared loopback port only.

**Tech Stack:** Node 20+ ESM, existing Express web server, React + TanStack Query SPA, OpenAI-compatible `POST /v1/chat/completions` (no extra SDK), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-17-assistant-design.md`

## Global Constraints

- Tabs, no semicolons, single quotes (match the repo).
- Product name is Omarchy Server. Do not mention Umbrel.
- Do not bump `package.json` version, `OMARCHYD_VERSION`, `VERSION` in `server/app.mjs`, or `web/src/changelog.ts`.
- Do not add local clone paths, `OMARCHY_SERVER_SOURCE`, or `file://` app-store wiring.
- No shell tool, no `podman exec`, no file-write tool, no SpaceXAI Responses API, no web_search / x_search.
- Keys never appear in query output, stream events, logs, or conversation files. Persist with `writeAtomic(..., {mode: 0o600})`.
- Provider HTTP is `POST {baseUrl}/chat/completions` with `stream: true`, `tools`, `parallel_tool_calls: false`. SpaceXAI `baseUrl` is `https://api.x.ai/v1`. Default model `grok-4.7` (re-check https://docs.x.ai/developers/models when implementing).
- Tool list and Approve use the same owner/member rules as the UI. Members see the Home tile.
- Work on `feat/assistant` from `upstream/main`. Do not add local clone-path wiring.
- Tests: `node --test --test-concurrency=1 test/assistant-*.test.mjs`. Full `npm test` before a PR. The known `connector.test.mjs` theme-set fail on machines with `omarchy-theme-set` is unrelated.
- `node_modules` is a symlink to the main clone; do not install a second copy.

## File map

Create:

- `omarchyd/assistant/keys.mjs` — key file, public view, share, default
- `omarchyd/assistant/conversations.mjs` — threads, messages, pending actions
- `omarchyd/assistant/tools.mjs` — curated RPC wrappers
- `omarchyd/assistant/providers.mjs` — chat/completions stream parser
- `omarchyd/assistant/loop.mjs` — one turn: reads, pending writes, SSE events
- `omarchyd/assistant/mcp.mjs` — MCP initialize/list/call over HTTP
- `omarchyd/assistant.mjs` — `createAssistant`, RPCs, `handleStream`
- `web/src/assistant.ts` — client types + SSE reader
- `web/src/screens/Assistant.tsx` — chat UI
- `test/assistant-keys.test.mjs`
- `test/assistant-loop.test.mjs`
- `test/assistant-mcp.test.mjs`

Modify:

- `omarchyd/server.mjs` — construct assistant, merge procedures, `POST /assistant/stream`
- `omarchyd/apps.mjs` — parse `mcp:`, persist, loopback publish, `mcpTargets()`
- `server/app.mjs` — `ALLOWED` entries + stream proxy
- `test/fake-omarchyd.mjs` — assistant RPCs + stream for web tests
- `web/src/api.ts` — `AssistantKey` / conversation types
- `web/src/screens/Settings.tsx` — Assistant page
- `web/src/screens/Home.tsx` — tile
- `web/src/App.tsx` — phone overlay
- `web/src/desktop/Desktop.tsx` — window kind `assistant`
- `web/src/styles.css` — chat bubbles and action cards

---

### Task 1: Key store

**Files:**
- Create: `omarchyd/assistant/keys.mjs`
- Test: `test/assistant-keys.test.mjs`

**Interfaces:**
- Consumes: `writeAtomic` from `omarchyd/atomic.mjs`
- Produces: `createKeyStore({dataDir, now})` → `{listPublic(userId), add(ownerUserId, input), update(actor, input), remove(actor, id), getSecret(id), resolveForUser(userId, keyId)}`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createKeyStore} from '../omarchyd/assistant/keys.mjs'

const tmp = async () => mkdtemp(join(os.tmpdir(), 'ask-'))

test('addKey stores the secret on disk and listPublic never returns it', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir, now: () => 1_700_000_000_000})
		const row = await keys.add('owner', {name: 'My xAI', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		assert.equal(row.provider, 'spacexai')
		assert.equal(row.baseUrl, 'https://api.x.ai/v1')
		assert.equal(row.last4, 'abcd')
		assert.equal(row.mine, true)
		assert.equal(row.apiKey, undefined)
		const listed = await keys.listPublic('owner')
		assert.equal(listed.length, 1)
		assert.equal(listed[0].apiKey, undefined)
		assert.equal(listed[0].last4, 'abcd')
		const raw = JSON.parse(await readFile(join(dataDir, 'assistant', 'keys.json'), 'utf8'))
		assert.equal(raw.keys[0].apiKey, 'xai-secret-abcd')
		assert.equal((await stat(join(dataDir, 'assistant', 'keys.json'))).mode & 0o777, 0o600)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a member cannot use or list a key until it is shared or default', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const row = await keys.add('owner', {name: 'k', provider: 'spacexai', apiKey: 'secret-key-1', model: 'grok-4.7'})
		assert.deepEqual(await keys.listPublic('sam'), [])
		await assert.rejects(() => keys.resolveForUser('sam', row.id), /not/)
		await keys.update({userId: 'owner', role: 'owner'}, {id: row.id, sharedWith: ['sam']})
		assert.equal((await keys.listPublic('sam'))[0].id, row.id)
		assert.equal((await keys.resolveForUser('sam', row.id)).apiKey, 'secret-key-1')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('only the server owner can set systemDefault, and only on a key they own', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const a = await keys.add('owner', {name: 'a', provider: 'spacexai', apiKey: 'aaaa', model: 'grok-4.7'})
		const b = await keys.add('sam', {name: 'b', provider: 'openai-compatible', apiKey: 'bbbb', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1'})
		await assert.rejects(() => keys.update({userId: 'sam', role: 'member'}, {id: b.id, systemDefault: true}), /owner/)
		await keys.update({userId: 'owner', role: 'owner'}, {id: a.id, systemDefault: true})
		await assert.rejects(() => keys.update({userId: 'owner', role: 'owner'}, {id: b.id, systemDefault: true}), /own/)
		const second = await keys.add('owner', {name: 'c', provider: 'spacexai', apiKey: 'cccc', model: 'grok-4.7'})
		await keys.update({userId: 'owner', role: 'owner'}, {id: second.id, systemDefault: true})
		const listed = await keys.listPublic('owner')
		assert.equal(listed.find((k) => k.id === a.id).systemDefault, false)
		assert.equal(listed.find((k) => k.id === second.id).systemDefault, true)
		assert.equal((await keys.resolveForUser('sam')).id, second.id)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/assistant-keys.test.mjs`

Expected: FAIL, `Cannot find module` for `omarchyd/assistant/keys.mjs`.

- [ ] **Step 3: Write minimal implementation**

`omarchyd/assistant/keys.mjs`:

```js
import {mkdir, readFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {writeAtomic} from '../atomic.mjs'
import {RpcError} from '../rpc.mjs'

const SPACEXAI = 'https://api.x.ai/v1'
const ID = () => 'k_' + randomBytes(6).toString('hex')
const last4 = (s) => String(s).slice(-4)
const publicOf = (k, userId) => ({
	id: k.id,
	name: k.name,
	provider: k.provider,
	baseUrl: k.baseUrl,
	model: k.model,
	last4: k.last4,
	ownerUserId: k.ownerUserId,
	sharedWith: k.sharedWith,
	systemDefault: !!k.systemDefault,
	mine: k.ownerUserId === userId,
	createdAt: k.createdAt,
	updatedAt: k.updatedAt,
})
const canUse = (k, userId) => k.ownerUserId === userId || k.sharedWith.includes(userId) || k.systemDefault

export function createKeyStore({dataDir, now = () => Date.now()}) {
	const file = join(dataDir, 'assistant', 'keys.json')
	let state = {keys: []}
	const loaded = mkdir(join(dataDir, 'assistant'), {recursive: true, mode: 0o700})
		.then(() => readFile(file, 'utf8'))
		.then((t) => {
			state = JSON.parse(t)
			if (!Array.isArray(state.keys)) state.keys = []
		})
		.catch(() => {})
	const save = () => writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600})
	const find = (id) => state.keys.find((k) => k.id === id)

	return {
		async listPublic(userId) {
			await loaded
			return state.keys.filter((k) => canUse(k, userId)).map((k) => publicOf(k, userId))
		},
		async add(ownerUserId, input) {
			await loaded
			const provider = input?.provider === 'openai-compatible' ? 'openai-compatible' : input?.provider === 'spacexai' ? 'spacexai' : null
			if (!provider) throw new RpcError('BAD_REQUEST', 'Choose SpaceXAI or an OpenAI-compatible endpoint')
			const apiKey = String(input?.apiKey ?? '').trim()
			if (apiKey.length < 4 || apiKey.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
			const model = String(input?.model ?? '').trim()
			if (!model || model.length > 80) throw new RpcError('BAD_REQUEST', 'Enter a model id')
			const name = String(input?.name ?? '').trim().slice(0, 48) || (provider === 'spacexai' ? 'SpaceXAI' : 'API')
			let baseUrl = provider === 'spacexai' ? SPACEXAI : String(input?.baseUrl ?? '').trim().replace(/\/+$/, '')
			if (provider === 'openai-compatible') {
				if (!/^https?:\/\/[^\s]+/i.test(baseUrl) || baseUrl.length > 200) throw new RpcError('BAD_REQUEST', 'Enter the API base URL')
			}
			const t = now()
			const row = {id: ID(), ownerUserId, name, provider, baseUrl, model, apiKey, last4: last4(apiKey), sharedWith: [], systemDefault: false, createdAt: t, updatedAt: t}
			state.keys.push(row)
			await save()
			return publicOf(row, ownerUserId)
		},
		async update(actor, input) {
			await loaded
			const k = find(String(input?.id ?? ''))
			if (!k) throw new RpcError('NOT_FOUND', 'That key isn’t here')
			if (input?.systemDefault === true) {
				if (actor.role === 'member') throw new RpcError('FORBIDDEN', 'Only the server’s owner can set the default key')
				if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'You can only make a key you own the default')
				for (const x of state.keys) x.systemDefault = x.id === k.id
			} else if (input?.systemDefault === false && k.ownerUserId === actor.userId && actor.role !== 'member') {
				k.systemDefault = false
			}
			if (k.ownerUserId !== actor.userId && input?.sharedWith === undefined && input?.name === undefined && input?.model === undefined && input?.apiKey === undefined && input?.baseUrl === undefined && input?.systemDefault === undefined) {
				throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			}
			if (k.ownerUserId !== actor.userId && (input?.sharedWith || input?.name || input?.model || input?.apiKey || input?.baseUrl)) {
				throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			}
			if (k.ownerUserId === actor.userId) {
				if (typeof input?.name === 'string') k.name = input.name.trim().slice(0, 48) || k.name
				if (typeof input?.model === 'string' && input.model.trim()) k.model = input.model.trim().slice(0, 80)
				if (typeof input?.apiKey === 'string' && input.apiKey.trim().length >= 4) {
					k.apiKey = input.apiKey.trim()
					k.last4 = last4(k.apiKey)
				}
				if (k.provider === 'openai-compatible' && typeof input?.baseUrl === 'string') k.baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
				if (Array.isArray(input?.sharedWith)) k.sharedWith = [...new Set(input.sharedWith.map((id) => String(id)).filter((id) => id && id !== k.ownerUserId))].slice(0, 32)
			}
			k.updatedAt = now()
			await save()
			return publicOf(k, actor.userId)
		},
		async remove(actor, id) {
			await loaded
			const k = find(id)
			if (!k) throw new RpcError('NOT_FOUND', 'That key isn’t here')
			if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'Only the person who added this key can delete it')
			state.keys = state.keys.filter((x) => x.id !== id)
			await save()
			return true
		},
		async getSecret(id) {
			await loaded
			return find(id) ?? null
		},
		async resolveForUser(userId, keyId) {
			await loaded
			if (keyId) {
				const k = find(keyId)
				if (!k || !canUse(k, userId)) throw new RpcError('NOT_FOUND', 'That key isn’t available')
				return k
			}
			const own = state.keys.filter((k) => k.ownerUserId === userId)
			if (own.length) return own.sort((a, b) => b.updatedAt - a.updatedAt)[0]
			const shared = state.keys.filter((k) => k.sharedWith.includes(userId))
			if (shared.length) return shared[0]
			const def = state.keys.find((k) => k.systemDefault)
			if (def) return def
			throw new RpcError('PRECONDITION_FAILED', 'Add an API key in Settings → Assistant, or ask the owner to share one')
		},
	}
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test test/assistant-keys.test.mjs`

Expected: PASS (3 tests). If mode assert fails on this FS, assert `(mode & 0o600) === 0o600` instead of `=== 0o600` with umask — prefer `assert.equal(stat.mode & 0o177, 0)` plus `mode & 0o600`.

- [ ] **Step 5: Commit**

```bash
git add omarchyd/assistant/keys.mjs test/assistant-keys.test.mjs
git commit -m "Store assistant API keys without returning the secret"
```

---

### Task 2: Key RPCs on omarchyd and the web allow-list

**Files:**
- Create: `omarchyd/assistant.mjs`
- Modify: `omarchyd/server.mjs` (construct + merge procedures; HTTP `POST /assistant/stream` can 404 until Task 7)
- Modify: `server/app.mjs` `ALLOWED` object (after the swarm entries, around line 82)
- Modify: `test/assistant-keys.test.mjs` (add RPC tests against `startOmarchyd`)
- Modify: `test/fake-omarchyd.mjs` (stub the four key RPCs so `test/allowed.test.mjs` stays green once the UI exists; stubs can wait until Task 3 if the UI is not calling them yet)

**Interfaces:**
- Consumes: `createKeyStore` from Task 1
- Produces: `createAssistant({dataDir, accounts, ...})` with `procedures['assistant.keys'|'assistant.addKey'|'assistant.updateKey'|'assistant.removeKey']`

- [ ] **Step 1: Extend the key tests to hit omarchyd over HTTP**

Append to `test/assistant-keys.test.mjs` (same member-user trick as `test/terminal.test.mjs`: copy owner hash into `accounts.json` as `sam` before `startOmarchyd`):

```js
import {startOmarchyd} from '../omarchyd/server.mjs'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {writeFile} from 'node:fs/promises'

test('assistant key RPCs: member cannot set default; secret stays off the wire', async () => {
	const root = await tmp()
	const data = join(root, 'data')
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const file = join(data, 'accounts.json')
		const state = JSON.parse(await readFile(file, 'utf8'))
		state.users.push({userId: 'sam', name: 'Sam', role: 'member', language: 'en', salt: state.users[0].salt, hash: state.users[0].hash, createdAt: Date.now()})
		await writeFile(file, JSON.stringify(state, null, '\t'))
		const d = await startOmarchyd({port: 0, dataDir: data, home: root})
		const login = async (userId) => {
			const r = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})).json()
			return {authorization: `Bearer ${r.result.data.accessToken}`, 'content-type': 'application/json'}
		}
		const owner = await login('owner')
		const member = await login('sam')
		const added = await (await fetch(`${d.url}/trpc/assistant.addKey`, {method: 'POST', headers: owner, body: JSON.stringify({name: 'x', provider: 'spacexai', apiKey: 'sk-live-9999', model: 'grok-4.7'})})).json()
		assert.equal(added.result.data.last4, '9999')
		assert.equal(added.result.data.apiKey, undefined)
		assert.match(JSON.stringify(added), /^(?!.*sk-live-9999).*$/)
		const def = await fetch(`${d.url}/trpc/assistant.updateKey`, {method: 'POST', headers: member, body: JSON.stringify({id: added.result.data.id, systemDefault: true})})
		assert.equal(def.status, 403)
		await d.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
```

- [ ] **Step 2: Run it to see FAIL**

Run: `node --test test/assistant-keys.test.mjs`

Expected: FAIL `No procedure found on path "assistant.addKey"`.

- [ ] **Step 3: Implement `createAssistant` and wire it**

`omarchyd/assistant.mjs` (keys only for now):

```js
import {createKeyStore} from './assistant/keys.mjs'
import {RpcError} from './rpc.mjs'

export function createAssistant({dataDir, accounts, now}) {
	const keys = createKeyStore({dataDir, now})
	const actor = (auth) => {
		const u = accounts.getUser(auth.userId)
		if (!u) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return {userId: u.userId, role: u.role}
	}
	return {
		keys,
		procedures: {
			'assistant.keys': {kind: 'query', run: (_i, {auth}) => keys.listPublic(auth.userId)},
			'assistant.addKey': {kind: 'mutation', run: (input, {auth}) => keys.add(auth.userId, input)},
			'assistant.updateKey': {kind: 'mutation', run: (input, {auth}) => keys.update(actor(auth), input)},
			'assistant.removeKey': {kind: 'mutation', run: (input, {auth}) => keys.remove(actor(auth), String(input?.id ?? ''))},
		},
	}
}
```

In `omarchyd/server.mjs`: import `createAssistant`, after `accounts` is open:

```js
const assistant = createAssistant({dataDir, accounts})
```

After `const procedures = { ... }` is finished (after `...updater.procedures`), merge:

```js
Object.assign(procedures, assistant.procedures)
```

In `server/app.mjs` `ALLOWED`, add:

```js
'assistant.keys': 'query',
'assistant.addKey': 'mutation',
'assistant.updateKey': 'mutation',
'assistant.removeKey': 'mutation',
```

- [ ] **Step 4: Run tests**

Run: `node --test test/assistant-keys.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omarchyd/assistant.mjs omarchyd/server.mjs server/app.mjs test/assistant-keys.test.mjs
git commit -m "Expose assistant key RPCs to the signed-in web app"
```

---

### Task 3: Settings → Assistant

**Files:**
- Modify: `web/src/api.ts` (add types)
- Modify: `web/src/screens/Settings.tsx` (new page `'assistant'`, group on main)
- Modify: `test/fake-omarchyd.mjs` (key RPCs so `test/server.test.mjs` / allowed-list stay honest)

**Interfaces:**
- Consumes: `assistant.keys` / `addKey` / `updateKey` / `removeKey`; `boot.accounts` for share checkboxes
- Produces: Settings page the owner and members can open

- [ ] **Step 1: Types in `web/src/api.ts`**

```ts
export type AssistantProvider = 'spacexai' | 'openai-compatible'
export type AssistantKey = {
	id: string
	name: string
	provider: AssistantProvider
	baseUrl: string
	model: string
	last4: string
	ownerUserId: string
	sharedWith: string[]
	systemDefault: boolean
	mine: boolean
}
```

- [ ] **Step 2: Fake omarchyd stubs**

In `test/fake-omarchyd.mjs` procedures map, add in-memory keys with the same public shape (no `apiKey` on output). Owner userId `owner`, member `sam`. This unblocks later server tests.

- [ ] **Step 3: Settings UI**

In `Settings.tsx`:

- Extend `Page` with `'assistant'`.
- On main, after Appearance/Storage group, add a group with `Row icon="sparkle"` label `Assistant` → `openPage('assistant')`.
- Assistant page: back button, title `Assistant`, list from `query('assistant.keys')`.
- Add sheet (`FormSheet`): provider segmented SpaceXAI / OpenAI-compatible; name; model (placeholder `grok-4.7` for SpaceXAI); API key `type="password"`; base URL field only when compatible. Submit `assistant.addKey`.
- Per key: Share sheet — checkboxes from `boot.accounts` except self; save `assistant.updateKey` `{id, sharedWith}`. Owner + `mine`: Switch `Use as system default`. Delete uses `useConfirm` then `assistant.removeKey`.
- Copy: empty list “Add a provider and API key to talk to the assistant.” Member footer if they have no keys: “Ask the owner to share a key, or add your own.”

Do not add chat yet.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/screens/Settings.tsx test/fake-omarchyd.mjs
git commit -m "Add Settings for assistant providers and shared keys"
```

---

### Task 4: Conversation store

**Files:**
- Create: `omarchyd/assistant/conversations.mjs`
- Test: `test/assistant-loop.test.mjs` (conversation section first)

**Interfaces:**
- Produces: `createConversations({dataDir, now})` → `{list(userId), get(userId, id), create(userId, {keyId, title}), append(userId, id, message), setKey(userId, id, keyId), putAction(userId, id, action), getAction(userId, actionId), saveAction(userId, action), remove(userId, id)}`

Message shapes as in the spec. Actions live in `conversation.actions[]`. `getAction` searches all of that user’s files.

- [ ] **Step 1: Failing tests**

```js
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'

test('a user cannot read another user’s conversation', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ac-'))
	try {
		const c = createConversations({dataDir, now: () => 1})
		const row = await c.create('owner', {keyId: 'k_1', title: 'Need a VM'})
		assert.equal(row.title, 'Need a VM')
		await assert.rejects(() => c.get('sam', row.id), /not/)
		await c.append('owner', row.id, {role: 'user', content: 'hello', at: 1})
		const loaded = await c.get('owner', row.id)
		assert.equal(loaded.messages[0].content, 'hello')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
```

- [ ] **Step 2: Run — FAIL missing module**

- [ ] **Step 3: Implement `omarchyd/assistant/conversations.mjs`**

```js
import {mkdir, readFile, readdir, rm} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {writeAtomic} from '../atomic.mjs'
import {RpcError} from '../rpc.mjs'

const clipTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Chat'
const ID = () => 'c_' + randomBytes(6).toString('hex')
const AID = () => 'a_' + randomBytes(6).toString('hex')

export function createConversations({dataDir, now = () => Date.now()}) {
	const dir = join(dataDir, 'assistant', 'conversations')
	const loaded = mkdir(dir, {recursive: true, mode: 0o700})
	const path = (id) => join(dir, `${id}.json`)
	const read = async (id) => JSON.parse(await readFile(path(id), 'utf8'))
	const write = (row) => writeAtomic(path(row.id), JSON.stringify(row, null, '\t'), {mode: 0o600})
	const owned = async (userId, id) => {
		await loaded
		let row
		try {
			row = await read(id)
		} catch {
			throw new RpcError('NOT_FOUND', 'That chat isn’t here')
		}
		if (row.userId !== userId) throw new RpcError('NOT_FOUND', 'That chat isn’t here')
		return row
	}

	return {
		async list(userId) {
			await loaded
			const ids = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))
			const rows = []
			for (const n of ids) {
				const row = await read(n.slice(0, -5)).catch(() => null)
				if (row?.userId === userId) rows.push({id: row.id, title: row.title, updatedAt: row.updatedAt})
			}
			return rows.sort((a, b) => b.updatedAt - a.updatedAt)
		},
		async get(userId, id) {
			return owned(userId, id)
		},
		async create(userId, {keyId, title} = {}) {
			await loaded
			const t = now()
			const row = {id: ID(), userId, keyId: keyId ?? null, title: clipTitle(title), createdAt: t, updatedAt: t, messages: [], actions: []}
			await write(row)
			return row
		},
		async append(userId, id, message) {
			const row = await owned(userId, id)
			row.messages.push(message)
			row.updatedAt = now()
			await write(row)
			return row
		},
		async setKey(userId, id, keyId) {
			const row = await owned(userId, id)
			row.keyId = keyId
			row.updatedAt = now()
			await write(row)
			return row
		},
		async putAction(userId, id, action) {
			const row = await owned(userId, id)
			const a = {id: action.id ?? AID(), conversationId: id, userId, status: 'pending', ...action, createdAt: now()}
			row.actions.push(a)
			row.messages.push({role: 'action', actionId: a.id, at: a.createdAt})
			row.updatedAt = now()
			await write(row)
			return a
		},
		async getAction(userId, actionId) {
			await loaded
			for (const n of await readdir(dir).catch(() => [])) {
				if (!n.endsWith('.json')) continue
				const row = await read(n.slice(0, -5)).catch(() => null)
				if (row?.userId !== userId) continue
				const a = row.actions?.find((x) => x.id === actionId)
				if (a) return {row, action: a}
			}
			throw new RpcError('NOT_FOUND', 'That step isn’t here')
		},
		async saveAction(userId, action) {
			const {row} = await this.getAction(userId, action.id)
			row.actions = row.actions.map((x) => (x.id === action.id ? action : x))
			row.updatedAt = now()
			await write(row)
			return action
		},
		async remove(userId, id) {
			await owned(userId, id)
			await rm(path(id), {force: true})
			return true
		},
	}
}
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit** — `Save assistant conversations per user`

---

### Task 5: Provider stream parser

**Files:**
- Create: `omarchyd/assistant/providers.mjs`
- Test: append to `test/assistant-loop.test.mjs`

**Interfaces:**
- Produces: `streamChat({baseUrl, apiKey, model, messages, tools, fetchImpl, signal})` async generator of `{type: 'text', text}` | `{type: 'tool', id, name, arguments}` | `{type: 'error', message, status}`

- [ ] **Step 1: Test against a local fake HTTP server**

```js
import http from 'node:http'
import {streamChat} from '../omarchyd/assistant/providers.mjs'

test('streamChat yields text then a whole tool call', async () => {
	const body = [
		'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"system_diskUsage","arguments":"{}"}}]}]}}\n\n',
		'data: [DONE]\n\n',
	].join('')
	const srv = http.createServer((req, res) => {
		assert.match(req.url, /\/chat\/completions$/)
		assert.equal(req.headers.authorization, 'Bearer k')
		res.writeHead(200, {'content-type': 'text/event-stream'})
		res.end(body)
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	const port = srv.address().port
	const out = []
	for await (const ev of streamChat({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'grok-4.7', messages: [], tools: [], fetchImpl: fetch})) out.push(ev)
	srv.close()
	assert.deepEqual(out.map((e) => e.type), ['text', 'tool'])
	assert.equal(out[0].text, 'Hi')
	assert.equal(out[1].name, 'system_diskUsage')
})

test('streamChat surfaces HTTP 401 as error', async () => {
	const srv = http.createServer((_q, res) => {
		res.writeHead(401, {'content-type': 'application/json'})
		res.end(JSON.stringify({error: {message: 'Incorrect API key'}}))
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	const port = srv.address().port
	const out = []
	for await (const ev of streamChat({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad', model: 'm', messages: [], tools: []})) out.push(ev)
	srv.close()
	assert.equal(out[0].type, 'error')
	assert.match(out[0].message, /key/i)
})
```

POST JSON must include `stream: true`, `parallel_tool_calls: false`, `tool_choice: 'auto'`. `baseUrl` already includes `/v1`. Path is `${baseUrl}/chat/completions`.

- [ ] **Step 2: FAIL missing module**

- [ ] **Step 3: Implement** `streamChat`: `fetch`, read body as text stream, split on `\n\n`, parse `data:` JSON, accumulate `delta.content` and `delta.tool_calls`. When a tool call object has both `id`/`name` and complete `arguments` (xAI sends it in one chunk), yield `{type:'tool'}`. On non-OK, yield `{type:'error', message, status}`. Never log `apiKey`.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `Parse OpenAI-compatible assistant streams`

---

### Task 6: Read tools and the agent loop

**Files:**
- Create: `omarchyd/assistant/tools.mjs`
- Create: `omarchyd/assistant/loop.mjs`
- Modify: `omarchyd/assistant.mjs` (pass `runProcedure`, `isOwner`)
- Test: `test/assistant-loop.test.mjs`

**Interfaces:**
- Consumes: keys, conversations, `streamChat`, `runProcedure(name, input, auth)`
- Produces: `runTurn({userId, role, message, conversationId, keyId, signal, emit})` → `{conversationId}`; `emit(event)` for SSE objects `{event, data}`

`tools.mjs` exports `READ_TOOLS` and `WRITE_TOOLS` arrays:

```js
export const READ_TOOLS = [
	{name: 'system_diskUsage', rpc: 'system.diskUsage', description: 'Disk used and free on this server', parameters: {type: 'object', properties: {}}, ownerOnly: false},
	// system_cpuUsage, system_memoryUsage, system_gpuUsage, system_cpuTemperature,
	// system_uptime, system_device, system_getHostname, system_getIpAddresses,
	// apps_list, appStore_app (args: {appId}), machines_list, machines_details (args: {id}),
	// machines_osImages, machines_capabilities, swarm_list (ownerOnly: true),
	// omarchy_plugins (args: {q, limit}), notifications_get
]
```

`appStore_registry` is **not** a raw dump. Implement `appStore_search` that calls `appStore.registry` then filters `{q, category, limit}` (default limit 12, max 24) and returns `{id, name, tagline, category, version}` only.

`WRITE_TOOLS` can be declared now but the loop must not execute them until Task 9 — if the model calls one, treat as pending (or, until Task 9, return tool error `"writes are not enabled yet"` so Task 6 stays read-only). Prefer the error until Task 9 so this slice cannot mutate.

Cap: 16 successful or failed auto-run tool calls per turn, then stop with a text event `"I hit the lookup limit for this turn."`

System prompt (constant in `loop.mjs`):

```
You are the Omarchy Server assistant on this machine and its Local swarm. You do not write programs or propose shell commands. Use only the given tools. Lookups run immediately. You cannot change anything yet. Stay on this host.
```

Plus a facts block from `system.getHostname`, `system.device`, `apps.list` ids, `swarm.list` names (swarm call wrapped so members skip it).

- [ ] **Step 1: Loop test with fake `runProcedure` and fake `fetchImpl`**

Script the fake completions server to: (1) call `system_diskUsage`, (2) after the tool result is posted in the next request, reply with text `"12 GB free"`.

Assert `runProcedure` was called with `'system.diskUsage'`. Assert `emit` saw `text` then `done`. Assert a member-built tool list omits `swarm_list`.

Unknown tool: model calls `shell_exec` → `runProcedure` not called; next request includes a tool result `"unknown tool"`.

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement `toolsFor(role)` and `runTurn`**

`runTurn`: resolve key (`conversation.keyId` or `resolveForUser`); create conversation if needed (title = first line clipped to 48); append user message; loop `streamChat` with last 40 messages converted to OpenAI roles (`tool` → `role: 'tool', tool_call_id`); on text emit `{event:'text', data:{text}}`; on tool, if unknown append tool error; if read, `runProcedure`, append `{role:'tool', ...}`, emit optional `{event:'tool', data:{name, state:'done'}}`; continue until no tool or cap. Persist assistant text. Emit `{event:'done', data:{conversationId}}`. On provider error emit `{event:'error', data:{message}}` (401 copy: `That API key was rejected. Replace it in Settings → Assistant.`).

Wire `createAssistant` with `runProcedure` and `isOwner` from `server.mjs`:

```js
const assistant = createAssistant({
	dataDir,
	accounts,
	runProcedure: (name, input, auth) => {
		const p = procedures[name]
		if (!p) throw new RpcError('NOT_FOUND', 'Unknown tool')
		return p.run(input, {auth})
	},
})
```

Create assistant **after** `procedures` exists, then `Object.assign(procedures, assistant.procedures)`. `runProcedure` closes over `procedures` so later assign is visible. If assistant is constructed before `procedures` is const, use a `let procedures` or a getter `() => procedures`.

Also add RPCs:

```
assistant.conversations query
assistant.getConversation query
assistant.deleteConversation mutation
```

and `ALLOWED` entries.

- [ ] **Step 4: PASS `test/assistant-loop.test.mjs`**

- [ ] **Step 5: Commit** — `Run assistant read tools inside omarchyd`

---

### Task 7: Stream HTTP proxy

**Files:**
- Modify: `omarchyd/server.mjs` (before `/trpc/` handler)
- Modify: `omarchyd/assistant.mjs` (`handleStream`)
- Modify: `server/app.mjs`
- Test: `test/assistant-loop.test.mjs` + a `test/server.test.mjs` case if easy

**Interfaces:**
- Produces: omarchyd `POST /assistant/stream` (127.0.0.1 only, same authenticate as RPC); web `POST /api/assistant/stream`

SSE format:

```
event: text
data: {"text":"Hi"}

event: done
data: {"conversationId":"c_..."}
```

- [ ] **Step 1: Test omarchyd stream**

Start omarchyd with `assistantOptions: {fetchImpl}` injecting the fake completions server from Task 5. Login, `POST ${d.url}/assistant/stream` with `authorization` and `{message:'how much disk'}`. Read the body, assert `event: text` and `event: done`. Unauthenticated → 401.

- [ ] **Step 2: FAIL 404**

- [ ] **Step 3: Implement**

`handleStream(req, res, auth)`: read JSON body (limit 100_000), set `content-type: text/event-stream`, `cache-control: no-store`. `const emit = ({event, data}) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)`. `req.on('close', () => ac.abort())`. `await runTurn({..., signal: ac.signal, emit})`. `res.end()`.

In `server.mjs` http handler:

```js
if (url.pathname === '/assistant/stream' && req.method === 'POST') {
	const auth = accounts.authenticate(req)
	if (!auth) return sendError(res, new RpcError('UNAUTHORIZED', 'Invalid token'))
	return assistant.handleStream(req, res, auth)
}
```

Web proxy in `server/app.mjs` **before** `api.use` 404. Reuse `accessTokenFor`. `fetch(`${backend.baseUrl}/assistant/stream`, {method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json', accept:'text/event-stream'}, body: JSON.stringify(req.body), signal})`. Pipe `upstream.body` to `res` with SSE headers. On client close, abort. Do not `await` the full text. 20 minute timeout.

- [ ] **Step 4: PASS; `npm run typecheck` still green**

- [ ] **Step 5: Commit** — `Proxy the assistant stream without buffering`

---

### Task 8: Chat UI, Home tile, desktop window

**Files:**
- Create: `web/src/assistant.ts`
- Create: `web/src/screens/Assistant.tsx`
- Modify: `web/src/screens/Home.tsx`, `web/src/App.tsx`, `web/src/desktop/Desktop.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: stream URL, `assistant.keys`, `assistant.conversations`, `assistant.getConversation`
- Produces: phone overlay + desktop `kind: 'assistant'` (not on default dock)

- [ ] **Step 1: `web/src/assistant.ts` stream helper**

```ts
export type AssistantEvent =
	| {event: 'text'; data: {text: string}}
	| {event: 'tool'; data: {name: string; state: string}}
	| {event: 'action'; data: AssistantAction}
	| {event: 'done'; data: {conversationId: string}}
	| {event: 'error'; data: {message: string}}

export async function streamAssistant(body: {conversationId?: string; message: string; keyId?: string}, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal) {
	const res = await fetch('/api/assistant/stream', {
		method: 'POST',
		credentials: 'same-origin',
		headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
		body: JSON.stringify(body),
		signal,
	})
	if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'The assistant did not answer')
	const reader = res.body.getReader()
	const dec = new TextDecoder()
	let buf = ''
	for (;;) {
		const {done, value} = await reader.read()
		if (done) break
		buf += dec.decode(value, {stream: true})
		const parts = buf.split('\n\n')
		buf = parts.pop() ?? ''
		for (const block of parts) {
			const ev = /event: (\w+)/.exec(block)?.[1]
			const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
			if (!ev || !dataLine) continue
			onEvent({event: ev, data: JSON.parse(dataLine.slice(6))} as AssistantEvent)
		}
	}
}
```

- [ ] **Step 2: `Assistant.tsx`**

Glass column: messages (user right, assistant left, `white-space: pre-wrap`), streaming cursor, composer textarea. Enter send, Shift+Enter newline. If `assistant.keys` empty: copy from spec + button calling `onSettings`. Load last conversation via `assistant.conversations` then `getConversation`. Send aborts the previous `AbortController`.

CSS in `styles.css`: `.assistant`, `.assistant .bubble`, `.assistant .composer` matching existing `--accent` / glass. No new font.

- [ ] **Step 3: Phone + desktop wiring**

`Home.tsx`: new optional `onAssistant`. Tile **before** Terminal, `aria-label="Assistant"`, icon `sparkle` (reuse `Icon name="sparkle"` in a tile like `TerminalIcon` — add `AssistantIcon` in `ui.tsx` copying `TerminalIcon`’s wrapper with sparkle). Members get this tile even when `onTerminal` is undefined.

`App.tsx`: state `assistantOpen`. `Home onAssistant={() => setAssistantOpen(true)}`. Overlay like TerminalScreen.

`Desktop.tsx`:

- `Kind` += `'assistant'`
- `SYS.assistant = {title: 'Assistant', icon: 'sparkle', bg: 'linear-gradient(150deg,#c4b5fd,#7c3aed 70%)', tone: 'var(--mauve)', w: 720, h: 640}`
- lazy import `Assistant`
- window body: `<Assistant onSettings={() => open('settings')} />`
- `openItem`: `isSys` already opens non-terminal sys kinds; assistant reuses one window (`keyOf` is kind).
- Do **not** add to `SYSTEM_DOCK`.

- [ ] **Step 4: `npm run typecheck` and `npm run build`**

Expected: PASS.

- [ ] **Step 5: Commit** — `Open the assistant from Home and the desktop`

---

### Task 9: Write tools, pending actions, Approve / Reject

**Files:**
- Modify: `omarchyd/assistant/tools.mjs` (`WRITE_TOOLS`)
- Modify: `omarchyd/assistant/loop.mjs`
- Modify: `omarchyd/assistant.mjs` (`assistant.approve`, `assistant.reject`)
- Modify: `server/app.mjs` `ALLOWED`
- Test: `test/assistant-loop.test.mjs`

**Interfaces:**
- Produces: pending action on write tool; Approve runs captured RPC once; Reject does not; follow-up `runTurn` with a synthetic tool result so the model can continue

`WRITE_TOOLS` (each `kind: 'mutation'`):

- apps: `apps_install` `{appId}`, `apps_start|stop|restart|uninstall|update` `{appId}`
- machines: `machines_create` `{name, osId, cores, memoryGb, diskSizeGb, username}` (no password in schema — generate 16-char at Approve with `randomBytes(12).toString('base64url')` and pass to `machines.create`; card `detail` says `Password will be set when you approve`), `machines_start|stop|restart|uninstall` `{id}`, `machines_updateSettings` as the UI sends
- swarm: `swarm_action` `{id, name, pluginId?, theme?}` name enum `plugin-install|plugin-remove|theme-set|reboot`, `swarm_rename` `{id, name}` — `ownerOnly: true`
- omarchy: `omarchy_setTheme` `{slug}`, `omarchy_installPlugin` `{id}`, `omarchy_removePlugin` `{id}` — `ownerOnly: true`
- `system_restart`, `system_shutdown` — `ownerOnly: true`

Loop: on write tool, **do not** call `runProcedure`. `putAction` status `pending`. Emit `{event:'action', data: publicAction}` (no generated password). Stop this provider request (do not continue the read loop). Do not emit `done` until Approve/Reject follow-up finishes, **or** emit `done` after the card and let Approve start a new stream — spec says Approve continues immediately. Implement Approve as: run RPC; append tool result; `runTurnContinue` (no new user message) which streams more; emit `done`.

Member calling `swarm_action`: tool omitted from list. If they somehow Approve an owner action: `ownerOnly` throws, status `error`, nothing runs.

Second Approve: if status !== `pending`, `RpcError('CONFLICT', 'That step was already handled')`.

- [ ] **Step 1: Tests**

```js
test('a write tool becomes pending and Approve runs the RPC once', async () => {
	const calls = []
	const runProcedure = async (name, input) => (calls.push({name, input}), {id: 'vm1'})
	// fake model: first turn tool machines_create; after tool result, text "Created."
	const asst = createAssistant({dataDir, accounts: fakeAccounts('owner'), runProcedure, fetchImpl: scriptedFetch})
	const turn = await consume(asst.handleStream, {message: 'add ubuntu vm'})
	assert.equal(turn.actions[0].status, 'pending')
	assert.equal(calls.length, 0)
	await asst.procedures['assistant.approve'].run({actionId: turn.actions[0].id}, {auth: {userId: 'owner'}})
	assert.equal(calls[0].name, 'machines.create')
	assert.ok(calls[0].input.password)
	await asst.procedures['assistant.approve'].run({actionId: turn.actions[0].id}, {auth: {userId: 'owner'}}).then(
		() => assert.fail('second approve'),
		(e) => assert.equal(e.code, 'CONFLICT'),
	)
})

test('Reject does not run the RPC', async () => {
	const calls = []
	const runProcedure = async (name, input) => (calls.push({name, input}), true)
	const asst = createAssistant({dataDir, accounts: fakeAccounts('owner'), runProcedure, fetchImpl: scriptedFetchWrite})
	const turn = await consume(asst.handleStream, {message: 'reboot the swarm box'})
	assert.equal(turn.actions[0].status, 'pending')
	await asst.procedures['assistant.reject'].run({actionId: turn.actions[0].id}, {auth: {userId: 'owner'}})
	assert.equal(calls.length, 0)
	const again = await asst.procedures['assistant.getConversation'].run({id: turn.conversationId}, {auth: {userId: 'owner'}})
	assert.equal(again.actions[0].status, 'rejected')
})

test('a member cannot approve swarm.action', async () => {
	const calls = []
	const runProcedure = async (name, input) => (calls.push({name, input}), true)
	const asst = createAssistant({dataDir, accounts: fakeAccounts('sam', 'member'), runProcedure, fetchImpl: fetch})
	const conv = await asst.conversations.create('sam', {title: 'x'})
	const action = await asst.conversations.putAction('sam', conv.id, {
		kind: 'rpc',
		toolName: 'swarm_action',
		title: 'Reboot',
		detail: '',
		rpc: {path: 'swarm.action', input: {id: 'abc', name: 'reboot'}},
		ownerOnly: true,
	})
	await assert.rejects(
		asst.procedures['assistant.approve'].run({actionId: action.id}, {auth: {userId: 'sam'}}),
		/owner|Forbidden|swarm/i,
	)
	assert.equal(calls.length, 0)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `Hold assistant writes until Approve`

---

### Task 10: Action cards in the chat UI

**Files:**
- Modify: `web/src/screens/Assistant.tsx`
- Modify: `web/src/api.ts` (`AssistantAction`)
- Modify: `web/src/styles.css`
- Modify: `web/src/assistant.ts` (handle `action` events)

**Interfaces:**
- Consumes: `assistant.approve` / `assistant.reject` mutations; action objects from stream and `getConversation`

- [ ] **Step 1: Types**

```ts
export type AssistantAction = {
	id: string
	status: 'pending' | 'rejected' | 'running' | 'done' | 'error'
	kind: 'rpc' | 'mcp'
	toolName: string
	title: string
	detail: string
	error?: string
}
```

- [ ] **Step 2: Card UI**

When `event === 'action'` or a message `{role:'action', actionId}` resolves via `conversation.actions`, render a glass card: `title`, `detail`, if `pending` buttons Approve / Reject (`mutate`). Disable while `running`. `done` / `error` / `rejected` show status text. After Approve, keep streaming (the server follow-up uses the same stream if Approve is invoked via RPC **and** the client then… Spec: Approve is a mutation, then the model continues.

To stream the follow-up, `assistant.approve` should **not** be the only path: either (a) Approve RPC returns and client immediately `POST /api/assistant/stream` with `{conversationId, continue: true}` without a user message, or (b) Approve is itself streamed.

Pick **(a)** so mutations stay JSON. `runTurn` accepts `continue: true` (no new user message; uses last pending resolution as the next tool result already appended). Client after successful `mutate('assistant.approve')` calls `streamAssistant({conversationId, continue: true})`.

Add `continue` to the stream body in Task 9’s `handleStream` if not already.

- [ ] **Step 3: Styles** `.assistant-card`, `.assistant-card .btn` using existing `.btn.primary` / `.btn`.

- [ ] **Step 4: `npm run typecheck`**

- [ ] **Step 5: Commit** — `Show Approve cards for assistant writes`

---

### Task 11: Catalog `mcp:` field and loopback port

**Files:**
- Modify: `omarchyd/apps.mjs`
- Test: `test/assistant-mcp.test.mjs` (parse + persist; compose port)
- Existing compose tests in `test/apps.test.mjs` must still pass

**Interfaces:**
- Produces: `parseMcp(raw)`, listing field `mcp`, installed `mcp` + `mcpInternalPort`, `apps.mcpTargets()` → `{appId, name, url, transport, running}[]`
- `prepareCompose` gains `{mcp}` and may publish a second `127.0.0.1:host:container` when `mcp.port` ≠ web port. If equal, `mcpInternalPort = internalPort`.

- [ ] **Step 1: Tests**

```js
import {parseMcp, prepareCompose} from '../omarchyd/apps.mjs'

test('parseMcp accepts a listing block and rejects junk', () => {
	assert.deepEqual(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'http'}), {service: 'web', port: 8080, path: '/mcp', transport: 'http'})
	assert.equal(parseMcp({service: 'web', port: 0}), null)
	assert.equal(parseMcp(null), null)
})

test('prepareCompose publishes mcp on loopback and never as a public port', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	const {text, internalPort, mcpInternalPort} = prepareCompose('demo', compose, () => 19001, {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8090, path: '/mcp', transport: 'http'}})
	assert.match(text, /127\.0\.0\.1:19001:8090/)
	assert.doesNotMatch(text, /0\.0\.0\.0/)
	assert.ok(mcpInternalPort)
})
```

Export `mcpInternalPort` from `prepareCompose` (default `null`). If the third return would break callers, return `{text, internalPort, mcpInternalPort}` and update existing destructures — they already use `{text, internalPort}`.

Install path: copy `mcp` onto the app record; set `mcpInternalPort` from `placeApp`. `mcpTargets()` skips apps without `mcp` or not running (`state` missing or `running`/`ready` as today).

`openPorts` must not include `mcp.port`.

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement `parseMcp` next to `folderChoices`. In `loadStore` apps.push, add `...(parseMcp(a.mcp) ? {mcp: parseMcp(a.mcp)} : {})`. LIST_FIELDS does not need `mcp` on the public registry dump if we keep it on the full listing object used at install (`findInRegistry` uses the loaded app). Add `mcp` to the in-memory listing object in `loadStore` only; `toList` stays unchanged so the App Store UI does not grow.

- [ ] **Step 4: PASS `test/assistant-mcp.test.mjs` and `node --test test/apps.test.mjs`**

- [ ] **Step 5: Commit** — `Read catalog MCP endpoints and bind them on loopback`

---

### Task 12: MCP client in the loop

**Files:**
- Create: `omarchyd/assistant/mcp.mjs`
- Modify: `omarchyd/assistant/loop.mjs`, `omarchyd/assistant.mjs`, `omarchyd/server.mjs` (`mcpTargets: () => apps.mcpTargets()`)
- Test: `test/assistant-mcp.test.mjs`

**Interfaces:**
- Produces: `listMcpTools({url, transport, fetchImpl, ttlMs: 60_000})` and `callMcpTool({url, name, arguments, fetchImpl})`
- Tools named `app__<appId>__<mcpName>`
- `readOnlyHint === true` auto-runs (counts toward 16). Else pending `kind: 'mcp'`
- Stopped/unreachable app: omit tools. Approve of MCP when app gone → action `error`

MCP HTTP (2024-11-05 JSON-RPC): `POST url` with `{jsonrpc:'2.0', id, method:'initialize'|'tools/list'|'tools/call', params}`. Keep it to JSON-RPC over HTTP for v1; `transport: 'sse'` uses the same POST if the server accepts it, else skip that app (do not invent a second protocol if the listing says `http`).

No stdio. URL must be `http://127.0.0.1:<port>/...` from `mcpTargets` — reject any other host in `callMcpTool`.

- [ ] **Step 1: Fake MCP server tests**

```js
test('readOnly MCP tools auto-run; others become pending', async () => { /* start http MCP; listing tools/list with readOnlyHint; runTurn */ })
test('listing without mcp contributes no tools', async () => {})
test('stopped app contributes no tools', async () => {})
test('callMcpTool refuses a non-loopback URL', async () => {
	await assert.rejects(() => callMcpTool({url: 'http://example.com/mcp', name: 'x', arguments: {}}), /loopback/)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement and pass `mcpTargets` into `createAssistant`**

Approve `kind: 'mcp'`: `callMcpTool` then follow-up turn like RPC Approve.

- [ ] **Step 4: PASS `node --test test/assistant-mcp.test.mjs test/assistant-loop.test.mjs test/assistant-keys.test.mjs`** then `npm run typecheck` and `npm run build`

- [ ] **Step 5: Commit** — `Let the assistant call catalog MCP tools with Approve`

---

### Task 13: Allow-list, fake omarchyd, PR hygiene

**Files:**
- Modify: `test/fake-omarchyd.mjs` (conversations, approve/reject, stream 501 or simple echo)
- Modify: `server/app.mjs` `ALLOWED` if any RPC is missing
- Run: `node --test test/allowed.test.mjs`

**Interfaces:**
- Consumes: every `query('assistant…')` / `mutate('assistant…')` / `path: 'assistant…'` in `web/src`

- [ ] **Step 1: Run `node --test test/allowed.test.mjs`**

Expected: empty `problems` array. Fix any missing `ALLOWED` kind.

- [ ] **Step 2: `npm test`**

Expect the known `connector.test.mjs` theme-set failure only if `omarchy-theme-set` is on PATH. Everything else PASS. If a new fail appears, fix it in this task.

- [ ] **Step 3: Confirm no version/changelog edits** (`git diff main -- package.json omarchyd/server.mjs server/app.mjs web/src/changelog.ts` should be empty of version bumps; `ALLOWED` and assistant routes in `server/app.mjs` are expected).

- [ ] **Step 4: Commit only if there are fixes** — `Keep the assistant RPCs on the web allow-list`

Do not open the GitHub PR in this task. Leave `package.json` version and What’s New to the maintainer. PR body later uses `.github/pull_request_template.md` and mentions the theme-set test.

---

## Self-review (spec coverage)

| Spec section | Task |
|---|---|
| Per-user keys, share, owner default, 0600, no secret on wire | 1–3 |
| Conversations persisted, 40-message prompt | 4, 6 |
| chat/completions, SpaceXAI + OpenAI-compatible, no Responses API | 5 |
| Reads auto-run, 16-cap, unknown tool, no shell | 6 |
| Stream omarchyd + web proxy, cancel | 7 |
| Home tile, desktop window, not default dock, Settings empty state | 3, 8 |
| Writes pending, Approve once, Reject, password at Approve, ownerOnly | 9–10 |
| Continue after Approve without extra typing | 9–10 (`continue: true`) |
| Catalog `mcp:`, loopback, not openPorts | 11 |
| MCP tools, readOnlyHint, stopped app, no stdio | 12 |
| Tests listed in spec §14 | 1, 6, 9, 12, 13 |
| Non-goals (shell, Anthropic, multi-server, changelog) | Global constraints |

No placeholders. Names: `createKeyStore`, `createConversations`, `streamChat`, `runTurn`, `handleStream`, `parseMcp`, `mcpTargets`, `callMcpTool` stay as written across tasks.
