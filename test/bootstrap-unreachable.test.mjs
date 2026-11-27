import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {UNREACHABLE_MESSAGE} from '../server/backend.mjs'
import {createStore} from '../server/store.mjs'
import {bootstrapPollInterval, connectSubmitMode} from '../web/src/connection.ts'

async function freePort() {
	return new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const {port} = s.address()
			s.close(() => resolve(port))
		})
	})
}

async function withServer({backendUrl, fetchImpl}, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'boot-unreachable-'))
	const store = await createStore(dir)
	if (backendUrl) await store.setConfig({backendUrl})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1', ...(fetchImpl ? {fetchImpl} : {})})
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	const base = `http://127.0.0.1:${server.address().port}`
	try {
		await fn({base})
	} finally {
		app.closeRelays()
		await new Promise((resolve) => server.close(resolve))
		await rm(dir, {recursive: true, force: true})
	}
}

test('/api/bootstrap omits the page URL when local omarchyd is unreachable and keeps remote backend URL', async () => {
	const closedPort = await freePort()
	await withServer({backendUrl: `http://127.0.0.1:${closedPort}`}, async ({base}) => {
		const res = await fetch(`${base}/api/bootstrap`)
		assert.equal(res.status, 200)
		const body = await res.json()
		assert.equal(body.configured, true)
		assert.equal(body.server.reachable, false)
		assert.equal(body.server.local, true)
		assert.equal(body.server.url, '')
		assert.equal(body.server.error, UNREACHABLE_MESSAGE)
		assert.equal(body.server.error.includes('127.0.0.1'), false)
	})

	await withServer(
		{
			backendUrl: 'http://192.0.2.1:2021',
			fetchImpl: async () => {
				throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
			},
		},
		async ({base}) => {
			const res = await fetch(`${base}/api/bootstrap`)
			assert.equal(res.status, 200)
			const body = await res.json()
			assert.equal(body.configured, true)
			assert.equal(body.server.reachable, false)
			assert.equal(body.server.local, false)
			assert.equal(body.server.url, 'http://192.0.2.1:2021')
			assert.equal(body.server.error, UNREACHABLE_MESSAGE)
		},
	)
})

test('/api/bootstrap transitions from unreachable to reachable when omarchyd returns', async () => {
	let up = false
	await withServer(
		{
			backendUrl: 'http://127.0.0.1:2021',
			fetchImpl: async (url) => {
				if (!up) throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
				if (String(url).includes('system.version')) {
					return new Response(JSON.stringify({result: {data: {version: '2.0.0', name: 'Omarchy Server 2.0.0'}}}), {status: 200})
				}
				if (String(url).includes('system.discoveryInfo')) {
					return new Response(JSON.stringify({result: {data: {device: 'omarchy', onboarded: true}}}), {status: 200})
				}
				return new Response(JSON.stringify({result: {data: []}}), {status: 200})
			},
		},
		async ({base}) => {
			const first = await (await fetch(`${base}/api/bootstrap`)).json()
			assert.equal(first.server.reachable, false)
			assert.equal(first.server.url, '')

			up = true
			const second = await (await fetch(`${base}/api/bootstrap`)).json()
			assert.equal(second.server.reachable, true)
			assert.equal(second.server.url, base)
			assert.equal(second.server.version, '2.0.0')
		},
	)
})

test('bootstrapPollInterval and connectSubmitMode drive polling and Try again behavior', () => {
	assert.equal(bootstrapPollInterval({status: 'error'}), 3000)
	assert.equal(bootstrapPollInterval({status: 'success', data: {configured: true, server: {reachable: false}}}), 3000)
	assert.equal(bootstrapPollInterval({status: 'success', data: {configured: false, server: null}}), false)
	assert.equal(bootstrapPollInterval({status: 'success', data: {configured: true, server: {reachable: true}}}), false)

	assert.equal(connectSubmitMode(undefined, ''), 'setup')
	assert.equal(connectSubmitMode(undefined, '192.168.1.50'), 'setup')
	assert.equal(connectSubmitMode({url: ''}, ''), 'retry')
	assert.equal(connectSubmitMode({url: ''}, '   '), 'retry')
	assert.equal(connectSubmitMode({url: ''}, '192.168.1.50'), 'setup')
	assert.equal(connectSubmitMode({url: 'http://192.168.1.50:2021'}, 'http://192.168.1.50:2021'), 'retry')
	assert.equal(connectSubmitMode({url: 'http://192.168.1.50:2021'}, ''), 'retry')
	assert.equal(connectSubmitMode({url: 'http://192.168.1.50:2021'}, 'http://192.168.1.60:2021'), 'setup')
})
