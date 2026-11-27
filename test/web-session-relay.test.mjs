// Web session, file relay, relay bind, and factory-reset leftovers.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import WebSocket, {WebSocketServer} from 'ws'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

const CLI = fileURLToPath(new URL('../server/cli.mjs', import.meta.url))
const VIEWER_BUFFER_LIMIT = 1024 * 1024

const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const {port} = s.address()
			s.close(() => resolve(port))
		})
	})

function listenAddrs(port) {
	const hex = port.toString(16).padStart(4, '0').toUpperCase()
	const found = []
	for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
		let text
		try {
			text = readFileSync(file, 'utf8')
		} catch {
			continue
		}
		for (const line of text.trim().split('\n').slice(1)) {
			const parts = line.trim().split(/\s+/)
			const [addr, , state] = [parts[1], parts[2], parts[3]]
			if (!addr) continue
			const [ip, p] = addr.split(':')
			if (p.toUpperCase() !== hex || state !== '0A') continue
			found.push(ip.toUpperCase())
		}
	}
	return found
}

async function listen(app) {
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	app.attachConsole(server)
	return server
}

async function withServer({backendUrl, appHosts, fetchImpl, relayHost = '127.0.0.1'} = {}) {
	const dir = await mkdtemp(join(os.tmpdir(), 'web-relay-'))
	const store = await createStore(dir)
	if (backendUrl) await store.setConfig({backendUrl})
	if (appHosts) await store.setConfig({appHosts})
	const app = createApp({store, relayPortBase: 0, relayHost, ...(fetchImpl ? {fetchImpl} : {})})
	const server = await listen(app)
	const base = `http://127.0.0.1:${server.address().port}`
	return {
		dir,
		store,
		app,
		base,
		close: async () => {
			app.closeRelays()
			app.closeAll()
			await new Promise((r) => server.close(r))
			await rm(dir, {recursive: true, force: true})
		},
	}
}

async function login(base, username = 'Chris', password = 'correct horse') {
	const res = await fetch(`${base}/api/auth/login`, {
		method: 'POST',
		headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
		body: JSON.stringify({username, password}),
	})
	const set = res.headers.getSetCookie().find((c) => c.startsWith('omarchy_server_sid='))
	return {status: res.status, cookie: set?.split(';')[0] ?? '', body: await res.json().catch(() => null)}
}

function httpGet(host, port, path, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({host: '127.0.0.1', port, path, headers: {host, ...headers}}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => resolve({status: res.statusCode, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks)}))
		})
		req.on('error', reject)
		req.end()
	})
}

test('file relay forwards If-Range when the browser sent it and omits it otherwise', async () => {
	const fake = await startFakeserverd()
	const seen = []
	const fetchImpl = async (url, init) => {
		const href = String(url)
		if (href.includes('/api/files/')) {
			seen.push({href, method: init?.method ?? 'GET', headers: {...(init?.headers ?? {})}})
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('hello-body'))
					controller.close()
				},
			})
			return new Response(stream, {status: 200, headers: {'content-type': 'text/plain', 'content-length': '10', etag: '"etag"'}})
		}
		return fetch(url, init)
	}
	const touch = await withServer({backendUrl: fake.url, fetchImpl})
	try {
		const signed = await login(touch.base)
		assert.equal(signed.status, 200)
		const withRange = await fetch(`${touch.base}/api/files/download?path=${encodeURIComponent('/Home/Documents/Notes.txt')}`, {
			headers: {cookie: signed.cookie, range: 'bytes=0-3', 'if-range': 'W/"abc"'},
		})
		assert.equal(withRange.status, 200)
		assert.equal(await withRange.text(), 'hello-body')
		const plain = await fetch(`${touch.base}/api/files/view?path=${encodeURIComponent('/Home/Documents/Notes.txt')}`, {headers: {cookie: signed.cookie, accept: 'text/plain'}})
		assert.equal(plain.status, 200)
		await plain.arrayBuffer()
		assert.equal(seen.length, 2)
		assert.equal(seen[0].headers['if-range'], 'W/"abc"')
		assert.equal(seen[0].headers.range, 'bytes=0-3')
		assert.equal(seen[0].method, 'GET')
		assert.equal(Object.hasOwn(seen[1].headers, 'if-range'), false)
		assert.equal(seen[1].headers.accept, 'text/plain')
	} finally {
		await touch.close()
		await fake.close()
	}
})

test('HEAD on a file route ends with headers and cancels the upstream body', async () => {
	const fake = await startFakeserverd()
	let cancelled = false
	const seen = []
	const fetchImpl = async (url, init) => {
		const href = String(url)
		if (href.includes('/api/files/')) {
			seen.push({method: init?.method ?? 'GET', headers: {...(init?.headers ?? {})}})
			let delivered = false
			const stream = new ReadableStream({
				pull(controller) {
					if (delivered) return
					delivered = true
					controller.enqueue(new TextEncoder().encode('hello-body-that-should-not-block-head'))
					controller.close()
				},
				cancel() {
					cancelled = true
				},
			})
			const headers = new Map([
				['content-type', 'text/plain'],
				['content-length', '37'],
				['etag', '"etag"'],
				['accept-ranges', 'bytes'],
			])
			// A real Response may pull the stream as it is built. fileGet only needs status, headers, and body.
			return {status: 200, headers: {get: (name) => headers.get(String(name).toLowerCase()) ?? null}, body: stream}
		}
		return fetch(url, init)
	}
	const touch = await withServer({backendUrl: fake.url, fetchImpl})
	try {
		const signed = await login(touch.base)
		const path = `/api/files/download?path=${encodeURIComponent('/Home/Documents/Notes.txt')}`
		const head = await Promise.race([
			new Promise((resolve, reject) => {
				const u = new URL(touch.base)
				const req = http.request({host: u.hostname, port: u.port, method: 'HEAD', path, headers: {cookie: signed.cookie, 'if-range': '"etag"'}}, (res) => {
					const chunks = []
					res.on('data', (c) => chunks.push(c))
					res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}))
				})
				req.on('error', reject)
				req.end()
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error('HEAD waited for the body')), 1500)),
		])
		assert.equal(head.status, 200)
		assert.equal(head.body.length, 0)
		assert.equal(head.headers['content-type'], 'text/plain')
		assert.equal(head.headers.etag, '"etag"')
		assert.equal(head.headers['content-length'], '37')
		assert.equal(cancelled, true)
		assert.equal(seen[0].method, 'GET')
		assert.equal(seen[0].headers['if-range'], '"etag"')
		const get = await fetch(`${touch.base}${path}`, {headers: {cookie: signed.cookie}})
		assert.equal(await get.text(), 'hello-body-that-should-not-block-head')
	} finally {
		await touch.close()
		await fake.close()
	}
})

test('an upstream 401 on download, view, thumbnail, and upload clears the console session', async () => {
	const fake = await startFakeserverd()
	const fetchImpl = async (url, init) => {
		if (String(url).includes('/api/files/')) {
			if (init?.body) await new Response(init.body).arrayBuffer().catch(() => {})
			return new Response(JSON.stringify({error: 'unauthorized'}), {status: 401, headers: {'content-type': 'application/json'}})
		}
		return fetch(url, init)
	}
	const touch = await withServer({backendUrl: fake.url, fetchImpl})
	try {
		const signed = await login(touch.base)
		const sid = signed.cookie.split('=')[1]
		const saved = touch.store.getSession(sid).console
		assert.ok(saved)
		const again = async (run) => {
			await touch.store.updateSession(sid, {console: saved})
			const res = await run()
			const body = await res.json()
			assert.equal(res.status, 409)
			assert.deepEqual(body, {error: {code: 'CONSOLE_SESSION_REQUIRED', message: 'Sign out and back in to use this'}})
			assert.equal(touch.store.getSession(sid).console, null)
			assert.ok(touch.store.getSession(sid))
		}
		const path = encodeURIComponent('/Home/Documents/Notes.txt')
		await again(() => fetch(`${touch.base}/api/files/download?path=${path}`, {headers: {cookie: signed.cookie}}))
		await again(() => fetch(`${touch.base}/api/files/view?path=${path}`, {headers: {cookie: signed.cookie}}))
		await again(() => fetch(`${touch.base}/api/files/thumbnail/Lake.webp?path=${path}`, {headers: {cookie: signed.cookie}}))
		await again(() =>
			fetch(`${touch.base}/api/files/upload?path=${path}`, {
				method: 'POST',
				headers: {cookie: signed.cookie, 'x-omarchy-server': '1', 'content-type': 'application/octet-stream'},
				body: 'nope',
			}),
		)
		const signedOut = await fetch(`${touch.base}/api/files/download?path=${path}`)
		assert.equal(signedOut.status, 401)
		assert.deepEqual(await signedOut.json(), {error: {code: 'UNAUTHORIZED', message: 'Signed out'}})
		assert.equal(touch.store.sessionCount(), 1)
	} finally {
		await touch.close()
		await fake.close()
	}
})

test('startup URLs follow --host instead of every LAN address', async () => {
	const {startupUrls} = await import('../server/app.mjs')
	const ifaces = {eth0: [{family: 'IPv4', internal: false, address: '192.0.2.10'}, {family: 'IPv4', internal: true, address: '127.0.0.1'}, {family: 'IPv6', internal: false, address: '2001:db8::5'}]}
	assert.deepEqual(startupUrls('0.0.0.0', 7780, ifaces), ['http://192.0.2.10:7780', 'https://192.0.2.10:7780'])
	assert.deepEqual(startupUrls('::', 7780, ifaces), ['http://192.0.2.10:7780', 'https://192.0.2.10:7780'])
	assert.deepEqual(startupUrls('0.0.0.0', 7780, {}), ['http://localhost:7780'])
	assert.deepEqual(startupUrls('127.0.0.1', 7780, ifaces), ['http://localhost:7780', 'https://localhost:7780'])
	assert.deepEqual(startupUrls('::1', 9, ifaces), ['http://localhost:9', 'https://localhost:9'])
	assert.deepEqual(startupUrls('localhost', 9, ifaces), ['http://localhost:9', 'https://localhost:9'])
	assert.deepEqual(startupUrls('192.0.2.10', 7780, ifaces), ['http://192.0.2.10:7780', 'https://192.0.2.10:7780'])
	assert.deepEqual(startupUrls('2001:db8::1', 7780, ifaces), ['http://[2001:db8::1]:7780', 'https://[2001:db8::1]:7780'])
})

test('CLI --host 127.0.0.1 prints only localhost and binds relays there', {timeout: 60_000}, async () => {
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'web-cli-'))
	const port = await freePort()
	const child = spawn(process.execPath, [CLI, '--port', String(port), '--host', '127.0.0.1', '--backend', fake.url, '--data', dir], {
		env: {...process.env, HOME: dir, HOST: '0.0.0.0', OMARCHY_TLS_DIR: join(dir, 'tls')},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (d) => (stdout += d))
	child.stderr.on('data', (d) => (stderr += d))
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`banner timeout\n${stdout}\n${stderr}`)), 20_000)
			child.stdout.on('data', () => {
				if (/Open\s+\S+\n\n/.test(stdout)) {
					clearTimeout(timer)
					resolve()
				}
			})
			child.on('exit', (code) => {
				clearTimeout(timer)
				reject(new Error(`exited ${code}\n${stdout}\n${stderr}`))
			})
		})
		const opens = [...stdout.matchAll(/Open\s+(\S+)/g)].map((m) => m[1])
		assert.deepEqual(opens, [`http://localhost:${port}`, `https://localhost:${port}`])
		const signed = await login(`http://127.0.0.1:${port}`)
		assert.equal(signed.status, 200, stderr)
		const open = await fetch(`http://127.0.0.1:${port}/api/app-open?app=nextcloud`, {headers: {cookie: signed.cookie}})
		const body = await open.json()
		assert.equal(open.status, 200, JSON.stringify(body))
		const relayPort = Number(new URL(body.url).port)
		const addrs = listenAddrs(relayPort)
		assert.ok(addrs.length > 0, `no listener on relay port ${relayPort}`)
		assert.ok(!addrs.includes('00000000'), `relay bound all interfaces: ${addrs.join(',')}`)
		assert.ok(addrs.includes('0100007F'), `relay not on 127.0.0.1: ${addrs.join(',')}`)
	} finally {
		child.kill('SIGTERM')
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				child.kill('SIGKILL')
				resolve()
			}, 4000)
			child.once('exit', () => {
				clearTimeout(timer)
				resolve()
			})
		})
		await fake.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('omitting relayHost still listens on every address', async () => {
	const previous = process.env.HOST
	process.env.HOST = '0.0.0.0'
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'web-relay-default-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const app = createApp({store, relayPortBase: 0})
	const server = await listen(app)
	try {
		const base = `http://127.0.0.1:${server.address().port}`
		const signed = await login(base)
		assert.equal(signed.status, 200)
		const open = await fetch(`${base}/api/app-open?app=immich`, {headers: {cookie: signed.cookie}})
		const body = await open.json()
		assert.equal(open.status, 200, JSON.stringify(body))
		const addrs = listenAddrs(Number(new URL(body.url).port))
		assert.ok(addrs.includes('00000000'), `default relay host changed: ${addrs.join(',')}`)
	} finally {
		if (previous === undefined) delete process.env.HOST
		else process.env.HOST = previous
		app.closeRelays()
		app.closeAll()
		await new Promise((r) => server.close(r))
		await fake.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a successful password change ends other web sessions for that account only', async () => {
	const fake = await startFakeserverd()
	const touch = await withServer({backendUrl: fake.url})
	try {
		const owner = await login(touch.base)
		const other = await login(touch.base)
		const sam = await login(touch.base, 'Sam')
		assert.equal(touch.store.sessionCount(), 3)
		const wrong = await fetch(`${touch.base}/api/rpc/user.changePassword`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: owner.cookie},
			body: JSON.stringify({input: {oldPassword: 'nope', newPassword: 'longer-secret'}}),
		})
		assert.equal(wrong.status, 401)
		assert.equal(touch.store.sessionCount(), 3)
		const changed = await fetch(`${touch.base}/api/rpc/user.changePassword`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: owner.cookie},
			body: JSON.stringify({input: {oldPassword: 'correct horse', newPassword: 'longer-secret'}}),
		})
		assert.equal(changed.status, 200)
		assert.equal((await changed.json()).data, true)
		assert.equal(touch.store.sessionCount(), 2)
		const otherStill = await fetch(`${touch.base}/api/bootstrap`, {headers: {cookie: other.cookie}})
		assert.equal((await otherStill.json()).session, null)
		const samStill = await fetch(`${touch.base}/api/bootstrap`, {headers: {cookie: sam.cookie}})
		assert.equal((await samStill.json()).session.accountId, 'sam')
		const mine = await fetch(`${touch.base}/api/bootstrap`, {headers: {cookie: owner.cookie}})
		assert.equal((await mine.json()).session.accountId, 'owner')
	} finally {
		await touch.close()
		await fake.close()
	}
})

test('ending a session drops its file URL token, and expired app-window entries are removed', async () => {
	const maps = []
	const origSet = Map.prototype.set
	Map.prototype.set = function (key, value) {
		if (value && typeof value === 'object' && value.sid && value.appId && value.exp) maps.push(this)
		return origSet.call(this, key, value)
	}
	const fake = await startFakeserverd()
	const touch = await withServer({backendUrl: fake.url, appHosts: '{app}-touch.example.com'})
	try {
		const owner = await login(touch.base)
		const other = await login(touch.base)
		const sid = other.cookie.split('=')[1]
		const saved = touch.store.getSession(sid)
		const tokenCalls = () => fake.calls.filter((c) => c.path === 'user.getHttpApiToken').length
		const path = encodeURIComponent('/Home/Documents/Notes.txt')
		const before = tokenCalls()
		const down = await fetch(`${touch.base}/api/files/download?path=${path}`, {headers: {cookie: other.cookie}})
		assert.equal(down.status, 200)
		await down.arrayBuffer()
		assert.equal(tokenCalls(), before + 1)
		const revoked = await fetch(`${touch.base}/api/rpc/user.revokeOtherSessions`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: owner.cookie},
			body: JSON.stringify({input: {}}),
		})
		assert.equal(revoked.status, 200)
		assert.equal(touch.store.getSession(sid), undefined)
		await touch.store.putSession(sid, saved)
		const mid = tokenCalls()
		const again = await fetch(`${touch.base}/api/files/download?path=${path}`, {headers: {cookie: other.cookie}})
		await again.arrayBuffer().catch(() => {})
		assert.equal(tokenCalls(), mid + 1, 'the deleted session reused its URL token')

		const u = new URL(touch.base)
		const open = await httpGet('touch.example.com', u.port, '/api/app-open?app=nextcloud', {cookie: owner.cookie, 'x-forwarded-proto': 'https'})
		assert.equal(open.status, 200, open.body.toString())
		const enter = new URL(JSON.parse(open.body.toString()).url)
		const handed = await httpGet('nextcloud-touch.example.com', u.port, enter.pathname + enter.search)
		assert.equal(handed.status, 302, handed.body.toString())
		const cookie = handed.headers['set-cookie'][0]
		const id = /^__touch_app=([^;]+)/.exec(cookie)[1]
		const map = maps.find((m) => m.has(id))
		assert.ok(map, 'app session was not stored')
		map.get(id).exp = Date.now() - 1000
		const open2 = await httpGet('touch.example.com', u.port, '/api/app-open?app=nextcloud', {cookie: owner.cookie, 'x-forwarded-proto': 'https'})
		const enter2 = new URL(JSON.parse(open2.body.toString()).url)
		const handed2 = await httpGet('nextcloud-touch.example.com', u.port, enter2.pathname + enter2.search)
		assert.equal(handed2.status, 302)
		assert.equal(map.has(id), false, 'expired app-window session was kept')
	} finally {
		Map.prototype.set = origSet
		await touch.close()
		await fake.close()
	}
})

test('relay CSP drops frame-ancestors from each comma-separated policy', async () => {
	const upstream = http.createServer((req, res) => {
		if (req.url.startsWith('/two')) res.setHeader('Content-Security-Policy', `script-src 'self', style-src 'unsafe-inline'; font-src "a, b"`)
		else if (req.url.startsWith('/only')) res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
		else {
			res.setHeader('Content-Security-Policy', "default-src 'self', frame-ancestors 'none'")
			res.setHeader('X-Frame-Options', 'DENY')
		}
		res.end('page')
	})
	await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
	const upstreamPort = upstream.address().port
	const fetchImpl = async (url) => {
		if (String(url).includes('/trpc/apps.list')) {
			const data = [{id: 'nextcloud', name: 'Nextcloud', port: upstreamPort, path: '/', state: 'ready'}]
			return new Response(JSON.stringify({result: {data}}), {headers: {'content-type': 'application/json'}})
		}
		return new Response(JSON.stringify({error: {message: 'unexpected', data: {code: 'BAD_RESPONSE', httpStatus: 500}}}), {status: 500, headers: {'content-type': 'application/json'}})
	}
	const touch = await withServer({backendUrl: 'http://127.0.0.1:9', fetchImpl})
	try {
		const sid = 'relay-sid-cookie-value'
		const now = Date.now()
		await touch.store.putSession(sid, {
			mode: 'native',
			accountId: 'owner',
			accessToken: 'tok-1',
			accessExpiresAt: now + 60 * 60 * 1000,
			deviceToken: 'dev-1',
			client: {id: 'omarchy-server'},
			console: {token: 'dash', cookie: 'OMARCHY_BROWSER_SESSION=abc', appCookie: 'OMARCHY_APP_SESSION=held', renewedAt: now, appPassAt: now},
			createdAt: now,
			lastSeenAt: now,
		})
		const cookie = `omarchy_server_sid=${sid}`
		const open = await fetch(`${touch.base}/api/app-open?app=nextcloud`, {headers: {cookie}})
		const body = await open.json()
		assert.equal(open.status, 200, JSON.stringify(body))
		const relay = new URL(body.url)
		const policies = (raw) => {
			const out = []
			for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'content-security-policy') out.push(raw[i + 1])
			return out
		}
		const page = await httpGet(relay.host, relay.port, '/', {cookie})
		assert.equal(page.status, 200)
		assert.equal(page.headers['x-frame-options'], undefined)
		const csp = policies(page.raw)
		assert.deepEqual(csp, [`default-src 'self'; frame-ancestors 'self' ${touch.base}`])
		const two = policies((await httpGet(relay.host, relay.port, '/two', {cookie})).raw)
		assert.equal(two.length, 2)
		assert.match(two[0], /^script-src 'self'; frame-ancestors 'self' /)
		assert.match(two[1], /^style-src 'unsafe-inline'; font-src "a, b"; frame-ancestors 'self' /)
		assert.ok(two.every((v) => !/frame-ancestors 'none'/.test(v)))
		const only = policies((await httpGet(relay.host, relay.port, '/only', {cookie})).raw)
		assert.deepEqual(only, [`frame-ancestors 'self' ${touch.base}`])
	} finally {
		await touch.close()
		await new Promise((r) => upstream.close(r))
	}
})

test('a browser console that falls behind is closed before the next frame is sent', async () => {
	const fake = await startFakeserverd()
	const touch = await withServer({backendUrl: fake.url})
	let amount = 0
	const closes = []
	const origUpgrade = WebSocketServer.prototype.handleUpgrade
	const origClose = WebSocket.prototype.close
	WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) {
		return origUpgrade.call(this, req, socket, head, (client) => {
			Object.defineProperty(client, 'bufferedAmount', {configurable: true, get: () => amount})
			cb(client)
		})
	}
	WebSocket.prototype.close = function (code, reason) {
		closes.push({code, reason: String(reason ?? '')})
		return origClose.call(this, code, reason)
	}
	try {
		const signed = await login(touch.base)
		const open = (expectClose) =>
			new Promise((resolve, reject) => {
				const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/terminal?cols=80&rows=24`, {headers: {cookie: signed.cookie, origin: touch.base}})
				const messages = []
				const timer = setTimeout(() => {
					ws.terminate()
					reject(new Error(`timed out messages=${messages.map(String).join('|')} closes=${JSON.stringify(closes)}`))
				}, 4000)
				ws.on('message', (m) => {
					messages.push(String(m))
					if (!expectClose && messages.some((line) => line.includes('x'))) {
						clearTimeout(timer)
						ws.close()
						resolve({messages})
					}
				})
				ws.once('open', () => {
					const waitWelcome = () => {
						if (messages.some((line) => line.includes('Welcome') || line.includes('$'))) {
							if (expectClose) {
								amount = VIEWER_BUFFER_LIMIT + 1
								const before = messages.length
								ws.send('x')
								ws.once('close', (code, reason) => {
									clearTimeout(timer)
									resolve({code, reason: String(reason), messages, before})
								})
							} else ws.send('x')
							return
						}
						setTimeout(waitWelcome, 15)
					}
					waitWelcome()
				})
				ws.once('error', (error) => {
					clearTimeout(timer)
					reject(error)
				})
			})
		amount = VIEWER_BUFFER_LIMIT
		const ok = await open(false)
		assert.ok(ok.messages.some((line) => line.includes('x')))
		closes.length = 0
		amount = 0
		const behind = await open(true)
		assert.equal(behind.messages.length, behind.before, `sent a frame after the buffer filled: ${behind.messages.slice(behind.before).join('|')}`)
		assert.match(behind.reason, /The viewer fell behind/)
		assert.ok(closes.filter((c) => /The viewer fell behind/.test(c.reason)).length >= 2, JSON.stringify(closes))
	} finally {
		WebSocketServer.prototype.handleUpgrade = origUpgrade
		WebSocket.prototype.close = origClose
		await touch.close()
		await fake.close()
	}
})

test('factory reset removes this server’s appearance only after the backend accepts it', async () => {
	const fake = await startFakeserverd()
	const touch = await withServer({backendUrl: fake.url, appHosts: '{app}-touch.example.com'})
	try {
		const signed = await login(touch.base)
		const prefs = await fetch(`${touch.base}/api/prefs`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: signed.cookie},
			body: JSON.stringify({theme: 'mocha'}),
		})
		assert.equal(prefs.status, 200)
		const desk = await fetch(`${touch.base}/api/desktop`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: signed.cookie},
			body: JSON.stringify({config: {dock: 'left'}}),
		})
		assert.equal(desk.status, 200)
		await mkdir(join(touch.dir, 'backgrounds'), {recursive: true})
		await writeFile(join(touch.dir, 'backgrounds', 'owner.jpg'), 'jpeg-bytes')
		await writeFile(join(touch.dir, 'keep.txt'), 'keep')
		const wrong = await fetch(`${touch.base}/api/rpc/system.factoryReset`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: signed.cookie},
			body: JSON.stringify({input: {password: 'nope'}}),
		})
		assert.equal(wrong.status, 401)
		assert.equal(touch.store.sessionCount(), 1)
		let disk = JSON.parse(await readFile(join(touch.dir, 'config.json'), 'utf8'))
		assert.equal(disk.prefs[Object.keys(disk.prefs)[0]].theme, 'mocha')
		assert.equal(disk.desktops[Object.keys(disk.desktops)[0]].config.dock, 'left')
		assert.equal(await readFile(join(touch.dir, 'backgrounds', 'owner.jpg'), 'utf8'), 'jpeg-bytes')
		const reset = await fetch(`${touch.base}/api/rpc/system.factoryReset`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie: signed.cookie},
			body: JSON.stringify({input: {password: 'correct horse'}}),
		})
		assert.equal(reset.status, 200)
		assert.equal((await reset.json()).data, true)
		assert.equal(touch.store.sessionCount(), 0)
		disk = JSON.parse(await readFile(join(touch.dir, 'config.json'), 'utf8'))
		assert.equal(Object.hasOwn(disk, 'prefs'), false)
		assert.equal(Object.hasOwn(disk, 'desktops'), false)
		assert.equal(disk.backendUrl, fake.url)
		assert.equal(disk.appHosts, '{app}-touch.example.com')
		await assert.rejects(readFile(join(touch.dir, 'backgrounds', 'owner.jpg')))
		assert.equal(await readFile(join(touch.dir, 'keep.txt'), 'utf8'), 'keep')
	} finally {
		await touch.close()
		await fake.close()
	}
})

test('#566 closing a console tab while it is still connecting does not leave the connection to omarchyd open', async () => {
	const fake = await startFakeserverd()
	const target = new URL(fake.url)
	// A slow link to omarchyd: the console handshake is held back, everything else passes straight through.
	const consoleLinks = new Set()
	const links = new Set()
	const proxy = net.createServer((client) => {
		const up = net.connect(Number(target.port), target.hostname)
		links.add(client).add(up)
		let first = true
		client.on('data', (chunk) => {
			if (!first) return void up.write(chunk)
			first = false
			if (!chunk.toString('latin1').startsWith('GET /machines/console')) return void up.write(chunk)
			consoleLinks.add(up)
			up.once('close', () => consoleLinks.delete(up))
			setTimeout(() => up.write(chunk), 600)
		})
		up.on('data', (chunk) => client.write(chunk))
		client.on('close', () => up.destroy())
		up.on('close', () => client.destroy())
		client.on('error', () => {})
		up.on('error', () => {})
	})
	await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
	const touch = await withServer({backendUrl: `http://127.0.0.1:${proxy.address().port}`})
	try {
		const signed = await login(touch.base)
		assert.equal(signed.status, 200)
		const port = new URL(touch.base).port
		for (let round = 0; round < 3; round++) {
			const sock = net.connect(Number(port), '127.0.0.1')
			sock.on('error', () => {})
			sock.write(`GET /api/console?machineId=vm1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nCookie: ${signed.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`)
			await new Promise((r) => setTimeout(r, 200))
			sock.destroy()
		}
		await new Promise((r) => setTimeout(r, 2000))
		assert.equal(consoleLinks.size, 0, `${consoleLinks.size} connections to omarchyd left open`)
	} finally {
		for (const l of links) l.destroy()
		await touch.close()
		proxy.close()
		await fake.close()
	}
})

test('the browser session behind Files and consoles is renewed by ordinary use, and a failed renewal is not recorded', async () => {
	const stale = Date.now() - 2 * 86_400_000
	const sidOf = (cookie) => cookie.split('=')[1]
	const backdate = async (touch, cookie) => {
		const sid = sidOf(cookie)
		await touch.store.updateSession(sid, {console: {...touch.store.getSession(sid).console, renewedAt: stale}})
		return sid
	}
	// A request that never touches Files or a console still renews it.
	const fake = await startFakeserverd()
	const touch = await withServer({backendUrl: fake.url})
	try {
		const signed = await login(touch.base)
		assert.equal(signed.status, 200)
		const sid = await backdate(touch, signed.cookie)
		const before = fake.calls.filter((c) => c.path === 'user.renewToken').length
		await fetch(`${touch.base}/api/prefs`, {headers: {cookie: signed.cookie}})
		for (let i = 0; i < 100 && touch.store.getSession(sid).console.renewedAt === stale; i++) await new Promise((r) => setTimeout(r, 20))
		assert.equal(fake.calls.filter((c) => c.path === 'user.renewToken').length, before + 1)
		assert.ok(touch.store.getSession(sid).console.renewedAt > stale)
	} finally {
		await touch.close()
		await fake.close()
	}
	// omarchyd refusing the renewal: nothing was renewed, so renewedAt stays put and it is tried again.
	const refusing = await startFakeserverd()
	const down = await withServer({backendUrl: refusing.url})
	try {
		const signed = await login(down.base)
		const sid = await backdate(down, signed.cookie)
		await refusing.close()
		await fetch(`${down.base}/api/prefs`, {headers: {cookie: signed.cookie}})
		await new Promise((r) => setTimeout(r, 300))
		assert.equal(down.store.getSession(sid).console.renewedAt, stale)
	} finally {
		await down.close()
	}
})
