import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createConnector} from '../omarchyd/connector.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'

describe('swarm self-update and in-place re-authorization', () => {
	let root, dataDir, tlsDir, connectorDir, c, server, port, agentBytes, agentSha, helperSha

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'swarm-upd-'))
		dataDir = join(root, 'data')
		tlsDir = join(root, 'tls')
		connectorDir = join(root, 'connector')
		await mkdir(dataDir, {recursive: true})
		await mkdir(connectorDir, {recursive: true})
		await ensureTls({dir: tlsDir})
		agentBytes = Buffer.from('#!/usr/bin/env python3\nVERSION = "1"\nprint("ok")\n')
		agentSha = createHash('sha256').update(agentBytes).digest('hex')
		const helperBytes = Buffer.from('#!/usr/bin/env python3\nprint("helper")\n')
		helperSha = createHash('sha256').update(helperBytes).digest('hex')
		await writeFile(join(connectorDir, 'agent.py'), agentBytes)
		await writeFile(join(connectorDir, 'helper.py'), helperBytes)
		c = createConnector({dataDir, tlsDir, connectorDir})
		server = http.createServer(async (req, res) => {
			if (req.url === '/connector/agent.py' && req.method === 'GET') {
				const agent = await c.authenticateAgent(req)
				if (!agent) {
					res.writeHead(401)
					return res.end('unauthorized')
				}
				const {bytes, sha256} = await c.readAgentScript()
				res.writeHead(200, {'content-type': 'text/x-python; charset=utf-8', 'x-connector-sha256': sha256})
				return res.end(bytes)
			}
			res.writeHead(404)
			res.end()
		})
		server.on('upgrade', (req, socket, head) => c.upgradeAgent(req, socket, head))
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		port = server.address().port
	})

	after(async () => {
		c?.close()
		await new Promise((r) => server?.close(r))
		await rm(root, {recursive: true, force: true})
	})

	test('detects outdated connectors, serves authenticated agent.py, and dispatches update-self', async () => {
		const p = await c.procedures['swarm.pair'].run({terminal: true, manage: true, storage: true})
		const enrolled = await c.enroll({
			token: p.token,
			info: {hostname: 'box1', os: 'Arch', agentSha: '0'.repeat(64), helperSha: '1'.repeat(64)},
			abilities: {terminal: true, manage: true, storage: true},
		})
		assert.equal(enrolled.status, 200)
		const {id, key} = enrolled.body

		// Unauthenticated fetch of /connector/agent.py is rejected.
		const unauth = await fetch(`http://127.0.0.1:${port}/connector/agent.py`)
		assert.equal(unauth.status, 401)

		// Authenticated fetch returns the exact bundled script and SHA-256 header.
		const authed = await fetch(`http://127.0.0.1:${port}/connector/agent.py`, {headers: {authorization: `Bearer ${id}:${key}`}})
		assert.equal(authed.status, 200)
		assert.equal(authed.headers.get('x-connector-sha256'), agentSha)
		assert.equal(await authed.text(), agentBytes.toString('utf8'))

		// Connect a fake agent over WebSocket and verify updateAvailable + updateAllConnectors.
		const ws = new WebSocket(`ws://127.0.0.1:${port}/connector/ws`, {headers: {authorization: `Bearer ${id}:${key}`}})
		const calls = []
		await new Promise((resolve, reject) => {
			ws.once('open', resolve)
			ws.once('error', reject)
		})
		ws.on('message', (raw) => {
			const msg = JSON.parse(String(raw))
			if (msg.op === 'call') {
				calls.push(msg)
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {sha256: msg.args.sha256, restarting: true}}))
			}
		})
		ws.send(JSON.stringify({op: 'hello', info: {hostname: 'box1', os: 'Arch', agentSha: '0'.repeat(64), helperSha: '1'.repeat(64)}, abilities: {terminal: true, manage: true, storage: true}}))
		await new Promise((r) => setTimeout(r, 80))

		let [listed] = await c.procedures['swarm.list'].run()
		assert.equal(listed.updateAvailable, true)
		assert.equal(listed.helperUpdateAvailable, true)

		const all = await c.procedures['swarm.updateAllConnectors'].run()
		assert.deepEqual(all.updated, [id])
		assert.equal(all.failed.length, 0)
		assert.equal(calls.length, 1)
		assert.equal(calls[0].name, 'update-self')
		assert.equal(calls[0].args.sha256, agentSha)

		// Once the agent reports matching SHAs, updateAvailable clears.
		ws.send(JSON.stringify({op: 'hello', info: {hostname: 'box1', os: 'Arch', agentSha, helperSha}, abilities: {terminal: true, manage: true, storage: true}}))
		await new Promise((r) => setTimeout(r, 80))
		;[listed] = await c.procedures['swarm.list'].run()
		assert.equal(listed.updateAvailable, false)
		assert.equal(listed.helperUpdateAvailable, false)

		ws.close()
	})

	test('reauthorize preserves id, name, enrolledAt while rotating key and widening abilities', async () => {
		const [before] = await c.procedures['swarm.list'].run()
		await c.procedures['swarm.rename'].run({id: before.id, name: 'Studio Node'})

		const reauth = await c.procedures['swarm.reauthorize'].run({id: before.id, terminal: true, desktop: true, manage: true, storage: true, backup: true})
		assert.equal(reauth.agentId, before.id)
		assert.equal(reauth.name, 'Studio Node')

		const res = await c.enroll({
			token: reauth.token,
			info: {hostname: 'box1', os: 'Arch', agentSha, helperSha},
			abilities: {terminal: true, desktop: true, manage: true, storage: true, backup: true},
		})
		assert.equal(res.status, 200)
		assert.equal(res.body.id, before.id)
		assert.equal(res.body.name, 'Studio Node')
		assert.equal(res.body.reauthorized, true)
		assert.equal(res.body.abilities.desktop, true)
		assert.equal(res.body.abilities.backup, true)

		// Single agent still in list, same id, same name, same enrolledAt, updated abilities.
		const agents = await c.procedures['swarm.list'].run()
		assert.equal(agents.length, 1)
		assert.equal(agents[0].id, before.id)
		assert.equal(agents[0].name, 'Studio Node')
		assert.equal(agents[0].enrolledAt, before.enrolledAt)
		assert.equal(agents[0].allowed.desktop, true)
		assert.equal(agents[0].allowed.backup, true)

		// New key works against /connector/agent.py.
		const authed = await fetch(`http://127.0.0.1:${port}/connector/agent.py`, {headers: {authorization: `Bearer ${res.body.id}:${res.body.key}`}})
		assert.equal(authed.status, 200)
	})

	test('new swarm RPCs are owner-only on omarchyd', async () => {
		const dRoot = await mkdtemp(join(os.tmpdir(), 'swarm-auth-'))
		const dData = join(dRoot, 'data')
		const dTls = join(dRoot, 'tls')
		await mkdir(dData, {recursive: true})
		await ensureTls({dir: dTls})
		const accounts = await openAccounts(dData)
		await accounts.createOwner({name: 'Owner', password: 'owner-password'})
		const rawAccounts = JSON.parse(await readFile(join(dData, 'accounts.json'), 'utf8'))
		rawAccounts.users.push({...rawAccounts.users[0], userId: 'member1', name: 'Member', role: 'member'})
		await writeFile(join(dData, 'accounts.json'), JSON.stringify(rawAccounts))
		const d = await startOmarchyd({port: 0, dataDir: dData, tlsDir: dTls, home: dRoot, appOptions: {run: async () => '', defaultStores: [], systemApps: null}, updaterOptions: {autoCheck: false}})
		try {
			const login = await (
				await fetch(`${d.url}/trpc/user.loginNative`, {
					method: 'POST',
					headers: {'content-type': 'application/json'},
					body: JSON.stringify({userId: 'member1', password: 'owner-password', client: {id: 'test'}}),
				})
			).json()
			const token = login.result.data.accessToken
			for (const proc of ['swarm.updateConnector', 'swarm.updateAllConnectors', 'swarm.reauthorize']) {
				const r = await (
					await fetch(`${d.url}/trpc/${proc}`, {
						method: 'POST',
						headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
						body: JSON.stringify({id: '000000000000'}),
					})
				).json()
				assert.match(r.error?.message ?? '', /Only the server’s owner/i)
			}
		} finally {
			await d.close()
			await rm(dRoot, {recursive: true, force: true})
		}
	})
})
