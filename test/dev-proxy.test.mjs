import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {API_ORIGIN, apiProxy} from '../vite.api-proxy.mjs'

test('the dev proxy forwards WebSocket upgrades and sets Origin on HTTP and WebSocket', async () => {
	assert.equal(apiProxy.target, 'http://127.0.0.1:7780')
	assert.equal(apiProxy.target, API_ORIGIN)
	assert.equal(apiProxy.ws, true)
	assert.equal(apiProxy.changeOrigin, true)
	const proxy = new EventEmitter()
	apiProxy.configure(proxy)
	for (const event of ['proxyReq', 'proxyReqWs']) {
		const headers = []
		proxy.emit(event, {setHeader(name, value) { headers.push([name, value]) }})
		assert.deepEqual(headers, [['Origin', API_ORIGIN]], event)
	}
	const src = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8')
	assert.match(src, /proxy:\s*\{'\/api':\s*apiProxy\}/)
})
