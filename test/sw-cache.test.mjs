// Service worker cache decisions, loaded from web/public/sw.js without a browser.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import vm from 'node:vm'

function loadWorker() {
	const listeners = {}
	const sandbox = {
		self: {
			addEventListener(type, fn) {
				listeners[type] = fn
			},
			skipWaiting() {},
			clients: {claim: () => Promise.resolve()},
		},
		location: {origin: 'http://localhost'},
		caches: {},
		URL,
		Response,
		fetch: () => Promise.reject(new Error('fetch not stubbed')),
		console,
	}
	vm.createContext(sandbox)
	vm.runInContext(readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8'), sandbox, {filename: 'sw.js'})
	return {listeners, sandbox}
}

test('shouldCache refuses a 503 and text/html under /assets/, and accepts javascript', () => {
	const {sandbox} = loadWorker()
	const {shouldCache} = sandbox
	assert.equal(shouldCache('http://localhost/assets/x.js', new Response('nope', {status: 503, headers: {'content-type': 'text/html'}})), false)
	assert.equal(shouldCache('http://localhost/', new Response('down', {status: 503, headers: {'content-type': 'text/html'}})), false)
	assert.equal(shouldCache('http://localhost/assets/x.js', new Response('<html>', {status: 200, headers: {'content-type': 'text/html'}})), false)
	assert.equal(shouldCache('http://localhost/assets/x.js', new Response('console.log(1)', {status: 200, headers: {'content-type': 'application/javascript'}})), true)
	assert.equal(shouldCache('http://localhost/files', new Response('<html>', {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}})), true)
})

test('fetch stores only responses shouldCache accepts', async () => {
	const {listeners, sandbox} = loadWorker()
	const puts = []
	sandbox.caches.match = async () => undefined
	sandbox.caches.open = async () => ({
		put(request, response) {
			puts.push({url: typeof request === 'string' ? request : request.url, type: response.headers.get('content-type'), status: response.status})
			return Promise.resolve()
		},
	})
	const fire = async (request, response) => {
		sandbox.fetch = async () => response
		let pending
		listeners.fetch({request, respondWith(p) { pending = p }})
		await pending
		await new Promise((r) => setImmediate(r))
	}
	await fire({url: 'http://localhost/assets/x.js', method: 'GET', mode: 'cors'}, new Response('nope', {status: 503, headers: {'content-type': 'text/html'}}))
	await fire({url: 'http://localhost/assets/x.js', method: 'GET', mode: 'cors'}, new Response('<html>', {status: 200, headers: {'content-type': 'text/html'}}))
	await fire({url: 'http://localhost/assets/x.js', method: 'GET', mode: 'cors'}, new Response('console.log(1)', {status: 200, headers: {'content-type': 'application/javascript'}}))
	await fire({url: 'http://localhost/files', method: 'GET', mode: 'navigate'}, new Response('down', {status: 503, headers: {'content-type': 'text/html'}}))
	await fire({url: 'http://localhost/files', method: 'GET', mode: 'navigate'}, new Response('<html>', {status: 200, headers: {'content-type': 'text/html'}}))
	assert.deepEqual(
		puts.map((p) => `${p.status} ${p.url} ${p.type}`),
		['200 http://localhost/assets/x.js application/javascript', '200 / text/html'],
	)
})

test('activate deletes unreferenced /assets/ and keeps referenced assets and precache URLs', async () => {
	const html = '<!doctype html><script type="module" src="/assets/keep.js"></script>'
	const {listeners, sandbox} = loadWorker()
	const stored = new Map([
		['http://localhost/', new Response(html, {headers: {'content-type': 'text/html'}})],
		['http://localhost/assets/keep.js', new Response('keep', {headers: {'content-type': 'application/javascript'}})],
		['http://localhost/assets/drop.js', new Response('drop', {headers: {'content-type': 'application/javascript'}})],
		['http://localhost/favicon.ico', new Response('ico')],
		['http://localhost/manifest.webmanifest', new Response('{}')],
	])
	const deletedNames = []
	const cache = {
		async match(key) {
			const url = typeof key === 'string' ? new URL(key, 'http://localhost').href : key.url
			return stored.get(url) ?? null
		},
		async keys() {
			return [...stored.keys()].map((url) => ({url}))
		},
		async delete(request) {
			stored.delete(request.url)
			return true
		},
	}
	sandbox.caches = {
		async keys() {
			return ['omarchy-server-v3', 'omarchy-server-v2']
		},
		async delete(name) {
			deletedNames.push(name)
			return true
		},
		async open() {
			return cache
		},
	}
	assert.equal(sandbox.shouldKeepCachedUrl('http://localhost/assets/drop.js', html), false)
	assert.equal(sandbox.shouldKeepCachedUrl('/assets/keep.js', html), true)
	assert.equal(sandbox.shouldKeepCachedUrl('/favicon.ico', html), true)
	let done
	listeners.activate({waitUntil(p) { done = p }})
	await done
	assert.deepEqual(deletedNames, ['omarchy-server-v2'])
	assert.equal(stored.has('http://localhost/assets/drop.js'), false)
	assert.equal(stored.has('http://localhost/assets/keep.js'), true)
	assert.equal(stored.has('http://localhost/'), true)
	assert.equal(stored.has('http://localhost/favicon.ico'), true)
	assert.equal(stored.has('http://localhost/manifest.webmanifest'), true)
})
