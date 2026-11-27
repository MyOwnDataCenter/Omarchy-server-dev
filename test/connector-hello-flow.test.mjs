// A connector hello that cannot save swarm.json must not take the process down, and a viewer
// that stops reading must not queue connector frames without a limit.
import assert from 'node:assert/strict'
import {createHash, randomBytes} from 'node:crypto'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {createConnector} from '../omarchyd/connector.mjs'

const VIEWER_BUFFER_LIMIT = 1024 * 1024

function fakeBrowser(bufferedAmount) {
	const listeners = new Map()
	const sent = []
	const closes = []
	const ws = {
		OPEN: 1,
		readyState: 1,
		bufferedAmount,
		send(data, opts) {
			sent.push({data: Buffer.from(data), opts})
		},
		close(code, reason) {
			closes.push({code, reason: String(reason ?? '')})
			this.readyState = 3
			for (const fn of listeners.get('close') ?? []) fn(code, reason)
		},
		on(ev, fn) {
			const list = listeners.get(ev) ?? []
			list.push(fn)
			listeners.set(ev, list)
		},
	}
	return {ws, sent, closes}
}

async function withAgent(allowed, run) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-hello-'))
	const id = 'aabbccddeeff'
	const key = randomBytes(32).toString('base64url')
	const keyHash = createHash('sha256').update(key).digest('hex')
	const body = JSON.stringify({
		agents: [{id, name: 'kept-host', keyHash, allowed, on: {...allowed}, enrolledAt: 1, lastSeen: null, info: {hostname: 'kept-host'}}],
	})
	await writeFile(join(dataDir, 'swarm.json'), body)
	const c = createConnector({dataDir, tlsDir: dataDir})
	const server = http.createServer()
	server.on('upgrade', (req, socket, head) => {
		c.upgradeAgent(req, socket, head).catch(() => socket.destroy())
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const agentWs = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, {headers: {authorization: `Bearer ${id}:${key}`}})
	const fromAgent = []
	agentWs.on('message', (d, isBinary) => {
		if (!isBinary) fromAgent.push(JSON.parse(String(d)))
	})
	try {
		await new Promise((resolve, reject) => (agentWs.once('open', resolve), agentWs.once('error', reject)))
		await run({c, id, key, keyHash, dataDir, body, agentWs, fromAgent, port: server.address().port})
	} finally {
		agentWs.terminate()
		c.close()
		await new Promise((r) => server.close(r))
		await chmod(dataDir, 0o755).catch(() => {})
		await rm(dataDir, {recursive: true, force: true})
	}
}

const terminalOn = {terminal: true, desktop: false, manage: false, storage: false, backup: false}

async function until(fn, ms = 1000) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		last = await fn()
		if (last) return last
		await new Promise((r) => setTimeout(r, 10))
	}
	return last
}

test('a binary frame above the viewer buffer limit closes the viewer and is not sent', async () => {
	await withAgent(terminalOn, async ({c, id, agentWs, fromAgent}) => {
		const browser = fakeBrowser(VIEWER_BUFFER_LIMIT + 1)
		c.openChannel(id, 'pty', browser.ws, {cols: 80, rows: 24})
		const open = await until(() => fromAgent.find((m) => m.op === 'open'))
		assert.ok(open, 'the connector was not asked to open a channel')
		const frame = Buffer.alloc(4 + 3)
		frame.writeUInt32BE(open.ch)
		frame.write('xyz', 4)
		agentWs.send(frame)
		const closed = await until(() => browser.closes.length > 0 || browser.sent.length > 0)
		assert.equal(browser.sent.length, 0)
		assert.equal(closed, true)
		assert.equal(browser.closes.length, 1)
		assert.equal(browser.closes[0].code, 1011)
		assert.match(browser.closes[0].reason, /viewer fell behind/)
		const told = await until(() => fromAgent.filter((m) => m.op === 'close' && m.ch === open.ch).length > 0)
		assert.equal(told, true)
		assert.equal(fromAgent.filter((m) => m.op === 'close' && m.ch === open.ch).length, 1)
	})
})

test('a binary frame under the viewer buffer limit is still sent', async () => {
	await withAgent(terminalOn, async ({c, id, agentWs, fromAgent}) => {
		const browser = fakeBrowser(VIEWER_BUFFER_LIMIT - 1)
		c.openChannel(id, 'pty', browser.ws, {cols: 80, rows: 24})
		const open = await until(() => fromAgent.find((m) => m.op === 'open'))
		assert.ok(open, 'the connector was not asked to open a channel')
		const frame = Buffer.alloc(4 + 3)
		frame.writeUInt32BE(open.ch)
		frame.write('xyz', 4)
		agentWs.send(frame)
		const sent = await until(() => browser.sent.length > 0)
		assert.equal(sent, true)
		assert.equal(browser.sent.length, 1)
		assert.deepEqual(browser.sent[0].data, Buffer.from('xyz'))
		assert.deepEqual(browser.sent[0].opts, {binary: true})
		assert.equal(browser.closes.length, 0)
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(fromAgent.filter((m) => m.op === 'close').length, 0)
	})
})

const storageOn = {terminal: false, desktop: false, manage: false, storage: true, backup: false}

function connectAgent(port, id, key) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {headers: {authorization: `Bearer ${id}:${key}`}})
	const seen = []
	ws.on('message', (d, isBinary) => {
		if (!isBinary) seen.push(JSON.parse(String(d)))
	})
	return {ws, seen, open: new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))}
}

test('storage reads pass reconnect, offline and timeout through, and only remap a missing connector', async () => {
	await withAgent(storageOn, async ({c, id, key, agentWs, fromAgent, port}) => {
		const sockets = [agentWs]
		let inbox = fromAgent
		try {
			for (const proc of ['swarm.storage.disks', 'swarm.storage.pools', 'swarm.storage.importable', 'swarm.storage.status']) {
				inbox.length = 0
				const pending = c.procedures[proc].run({id}).then(
					() => ({ok: true}),
					(e) => e,
				)
				const call = await until(() => inbox.find((m) => m.op === 'call'))
				assert.ok(call, `${proc} did not call the computer`)
				const next = connectAgent(port, id, key)
				sockets.push(next.ws)
				await next.open
				const err = await pending
				assert.equal(err.code, 'PRECONDITION_FAILED', proc)
				assert.equal(err.message, 'The computer reconnected', proc)
				inbox = next.seen
			}
		} finally {
			for (const ws of sockets) ws.terminate()
		}
	})
})

test('storage reads keep a real failure and still ask to reinstall when the connector or helper is missing', async () => {
	await withAgent(storageOn, async ({c, id, agentWs, fromAgent}) => {
		const answered = async (proc, error, input = {}) => {
			fromAgent.length = 0
			const pending = c.procedures[proc].run({id, ...input}).then(
				(v) => ({ok: true, v}),
				(e) => e,
			)
			const call = await until(() => fromAgent.find((m) => m.op === 'call'))
			assert.ok(call, proc)
			agentWs.send(JSON.stringify({op: 'result', id: call.id, ok: false, error}))
			return pending
		}
		const timeout = await answered('swarm.storage.disks', 'That computer didn’t answer in time')
		assert.equal(timeout.message, 'That computer didn’t answer in time')
		const busy = await answered('swarm.storage.pools', 'device is busy')
		assert.equal(busy.message, 'device is busy')
		const old = await answered('swarm.storage.importable', 'Unknown action')
		assert.equal(old.message, 'Run the connector install again on kept-host.')
		const helper = await answered('swarm.storage.disks', 'Storage helper failed')
		assert.equal(helper.message, 'Run the connector install again on kept-host.')
		const denied = await answered('swarm.storage.status', 'This computer doesn’t allow Storage')
		assert.equal(denied.ok, true)
		assert.equal(denied.v.storageAllowed, false)
		fromAgent.length = 0
		const pending = c.procedures['swarm.storage.status'].run({id}).then(
			() => ({ok: true}),
			(e) => e,
		)
		assert.ok(await until(() => fromAgent.find((m) => m.op === 'call')))
		agentWs.close()
		const gone = await pending
		assert.equal(gone.message, 'The computer went offline')
	})
})

test('a refused setAbilities changes nothing and a later switch still closes the open terminal', async () => {
	const allowed = {terminal: true, desktop: false, manage: false, storage: false, backup: false}
	await withAgent(allowed, async ({c, id, dataDir, agentWs, fromAgent}) => {
		const browser = fakeBrowser(0)
		c.openChannel(id, 'pty', browser.ws, {cols: 80, rows: 24})
		assert.ok(await until(() => fromAgent.find((m) => m.op === 'open')))
		await assert.rejects(c.procedures['swarm.setAbilities'].run({id, terminal: false, desktop: true}), /wasn’t allowed desktop/)
		const [listed] = await c.procedures['swarm.list'].run()
		assert.equal(listed.on.terminal, true)
		assert.equal(listed.on.desktop, false)
		assert.equal(browser.closes.length, 0)
		const saved = JSON.parse(await readFile(join(dataDir, 'swarm.json'), 'utf8'))
		assert.equal(saved.agents[0].on.terminal, true)
		const again = fakeBrowser(0)
		c.openChannel(id, 'pty', again.ws, {cols: 80, rows: 24})
		assert.ok(await until(() => fromAgent.filter((m) => m.op === 'open').length >= 2))
		assert.equal(again.closes.length, 0)
		const closed = new Promise((r) => again.ws.on('close', () => r(true)))
		await c.procedures['swarm.setAbilities'].run({id, terminal: false})
		assert.equal(await closed, true)
		const [after] = await c.procedures['swarm.list'].run()
		assert.equal(after.on.terminal, false)
		assert.equal(agentWs.readyState, WebSocket.OPEN)
	})
})

test('a finished backup call does not keep its last progress', async () => {
	const allowed = {...terminalOn, backup: true}
	await withAgent(allowed, async ({c, id, agentWs, fromAgent}) => {
		const pending = c.backup.call(id, 'backup-run', {folders: ['Documents']}).then(
			(v) => ({ok: true, v}),
			(e) => ({ok: false, e}),
		)
		const call = await until(() => fromAgent.find((m) => m.op === 'call' && m.name === 'backup-run'))
		assert.ok(call)
		agentWs.send(JSON.stringify({op: 'progress', id: call.id, percent: 0.99, step: 'Backing up'}))
		const mid = await until(() => {
			const p = c.backup.progress(id)
			return p?.percent === 0.99 ? p : null
		})
		assert.equal(mid?.percent, 0.99)
		agentWs.send(JSON.stringify({op: 'result', id: call.id, ok: true, data: {added: 1}}))
		const done = await pending
		assert.equal(done.ok, true, done.e?.message)
		assert.deepEqual(done.v, {added: 1})
		assert.equal(c.backup.progress(id), null)
		agentWs.send(JSON.stringify({op: 'progress', id: call.id, percent: 0.99, step: 'Backing up'}))
		await new Promise((r) => setTimeout(r, 40))
		assert.equal(c.backup.progress(id), null)
	})
})

test('a hello that cannot save swarm.json does not reject the message handler', async (t) => {
	const logs = []
	t.mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')))
	const rejections = []
	const onRejection = (reason) => rejections.push(reason)
	process.on('unhandledRejection', onRejection)
	try {
		await withAgent(terminalOn, async ({c, id, key, keyHash, dataDir, body, agentWs}) => {
			await chmod(dataDir, 0o555)
			try {
				agentWs.send(JSON.stringify({op: 'hello', info: {hostname: 'changed-host'}, abilities: terminalOn}))
				await until(() => logs.length > 0 || rejections.length > 0)
				assert.deepEqual(
					rejections.map((e) => e?.message ?? String(e)),
					[],
				)
				const saved = logs.filter((line) => /couldn.t save swarm\.json/.test(line))
				assert.equal(saved.length, 1)
				assert.equal(saved[0].includes(key), false)
				assert.equal(saved[0].includes(keyHash), false)
				assert.equal(saved[0].includes(body), false)
				assert.equal(saved[0].includes('changed-host'), false)
				assert.equal(await readFile(join(dataDir, 'swarm.json'), 'utf8'), body)
				agentWs.send(JSON.stringify({op: 'metrics', metrics: {cpu: 0.25, mem: {total: 100, used: 10}}}))
				const listed = await until(async () => {
					const [a] = await c.procedures['swarm.list'].run()
					return a?.metrics?.cpu === 0.25 ? a : null
				})
				assert.equal(listed?.metrics?.cpu, 0.25)
				assert.equal(listed?.info?.hostname, 'changed-host')
				assert.equal(await readFile(join(dataDir, 'swarm.json'), 'utf8'), body)
			} finally {
				await chmod(dataDir, 0o755)
			}
		})
	} finally {
		process.off('unhandledRejection', onRejection)
	}
})
