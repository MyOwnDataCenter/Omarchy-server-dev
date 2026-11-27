import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

// fetch() collapses ".." before the request leaves, so this uses Node's client with the path as given.
function hit(port, path) {
	return new Promise((resolve, reject) => {
		const req = http.request({host: '127.0.0.1', port, path, method: 'GET'}, (res) => {
			let body = ''
			res.on('data', (c) => (body += c))
			res.on('end', () => resolve({status: res.statusCode, body}))
		})
		req.on('error', reject)
		req.end()
	})
}

test('the backup proxy does not forward a collapsed path onto other omarchyd routes', async () => {
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(tmpdir(), 'backup-proxy-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	const port = server.address().port
	try {
		const leaked = await hit(port, '/connector/backup/../../trpc/user.listAccounts')
		assert.equal(leaked.status, 400)
		assert.doesNotMatch(leaked.body, /Chris/)
		const encoded = await hit(port, '/connector/backup/%2e%2e/%2e%2e/trpc/user.loginNative')
		assert.equal(encoded.status, 400)
		assert.doesNotMatch(encoded.body, /accessToken|deviceToken/)
		// A real backup-store path is still proxied (omarchyd refuses it; the web guard does not).
		const storePath = await hit(port, '/connector/backup/data/ab')
		assert.notEqual(storePath.status, 400)
	} finally {
		app.closeRelays()
		await new Promise((r) => server.close(r))
		await fake.close()
		await rm(dir, {recursive: true, force: true})
	}
})
