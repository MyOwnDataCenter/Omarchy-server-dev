import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {createConnector} from '../omarchyd/connector.mjs'
import {createFiles} from '../omarchyd/files.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'

describe('swarm remote services and files', () => {
	let root, dataDir, tlsDir, serverHome, c, server, port

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'swarm-sf-'))
		dataDir = join(root, 'data')
		tlsDir = join(root, 'tls')
		serverHome = join(root, 'home')
		await mkdir(dataDir, {recursive: true})
		await mkdir(serverHome, {recursive: true})
		await ensureTls({dir: tlsDir})
		const files = createFiles({home: serverHome, dataDir})
		c = createConnector({dataDir, tlsDir, files})
		server = http.createServer((_req, res) => {
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

	test('enforces services and files abilities and proxies service/file operations + server copies', async () => {
		const p = await c.procedures['swarm.pair'].run({services: true, files: true})
		const enrolled = await c.enroll({
			token: p.token,
			info: {hostname: 'node-sf', os: 'Omarchy'},
			abilities: {services: true, files: true},
		})
		const {id, key} = enrolled.body

		const remoteStore = new Map([['/Home/notes.txt', Buffer.from('hello from node')]])
		const ws = new WebSocket(`ws://127.0.0.1:${port}/connector/ws`, {headers: {authorization: `Bearer ${id}:${key}`}})
		const seenCalls = []
		await new Promise((resolve, reject) => {
			ws.once('open', resolve)
			ws.once('error', reject)
		})
		ws.on('message', (raw) => {
			const msg = JSON.parse(String(raw))
			if (msg.op !== 'call') return
			seenCalls.push(msg)
			if (msg.name === 'services-list') {
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {systemd: [{name: 'demo.service', scope: 'user', load: 'loaded', active: 'active', sub: 'running', description: 'Demo'}], systemFailed: [], containers: [{id: 'abc123', name: 'web', image: 'nginx', state: 'running', status: 'Up 1h', engine: 'podman'}], engine: 'podman'}}))
			} else if (msg.name === 'services-logs') {
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {logs: 'line 1\nline 2\n'}}))
			} else if (msg.name === 'services-control') {
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: true}))
			} else if (msg.name === 'files-list') {
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {path: msg.args.path, items: [{name: 'notes.txt', path: '/Home/notes.txt', isDir: false, size: 15, modified: 1000}]}}))
			} else if (msg.name === 'files-read') {
				const buf = remoteStore.get(msg.args.path)
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {path: msg.args.path, name: 'notes.txt', size: buf.length, data: buf.toString('base64')}}))
			} else if (msg.name === 'files-write') {
				const buf = Buffer.from(msg.args.data, 'base64')
				remoteStore.set(msg.args.path, buf)
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: {path: msg.args.path, size: buf.length}}))
			} else {
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: true}))
			}
		})
		ws.send(JSON.stringify({op: 'hello', info: {hostname: 'node-sf', os: 'Omarchy'}, abilities: {services: true, files: true}}))
		await new Promise((r) => setTimeout(r, 60))

		// Services RPCs.
		const listed = await c.procedures['swarm.services.list'].run({id})
		assert.equal(listed.systemd[0].name, 'demo.service')
		assert.equal(listed.containers[0].name, 'web')
		const logs = await c.procedures['swarm.services.logs'].run({id, kind: 'user', name: 'demo.service', lines: 50})
		assert.match(logs.logs, /line 1/)
		assert.equal(await c.procedures['swarm.services.control'].run({id, kind: 'user', name: 'demo.service', action: 'restart'}), true)

		// Files RPCs + copyToServer + copyFromServer.
		const dir = await c.procedures['swarm.files.list'].run({id, path: '/Home'})
		assert.equal(dir.items[0].name, 'notes.txt')

		const copiedIn = await c.procedures['swarm.files.copyToServer'].run({id, remotePath: '/Home/notes.txt', serverDir: '/Home'})
		assert.equal(copiedIn.path, '/Home/notes.txt')
		assert.equal(await readFile(join(serverHome, 'notes.txt'), 'utf8'), 'hello from node')

		await writeFile(join(serverHome, 'from-server.txt'), 'hello from server')
		const copiedOut = await c.procedures['swarm.files.copyFromServer'].run({id, serverPath: '/Home/from-server.txt', remoteDir: '/Home'})
		assert.equal(copiedOut.path, '/Home/from-server.txt')
		assert.equal(remoteStore.get('/Home/from-server.txt').toString('utf8'), 'hello from server')

		// Turning services/files off blocks calls immediately.
		await c.procedures['swarm.setAbilities'].run({id, services: false, files: false})
		await assert.rejects(c.procedures['swarm.services.list'].run({id}), /isn’t switched on/)
		await assert.rejects(c.procedures['swarm.files.list'].run({id, path: '/Home'}), /isn’t switched on/)

		ws.close()
	})
})
