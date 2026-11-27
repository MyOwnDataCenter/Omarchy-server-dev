// #125 #247 #248 #297 #298: a proxied request ends when either side does.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {test} from 'node:test'

import {linkProxy} from '../omarchyd/proxy-link.mjs'

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

function proxyTo(port) {
	return http.createServer((req, res) => {
		const up = http.request({host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers}, (ur) => {
			res.writeHead(ur.statusCode, ur.headers)
			ur.pipe(res)
		})
		linkProxy(req, res, up)
		up.on('error', () => {
			if (res.headersSent) return
			res.writeHead(502)
			res.end()
		})
		req.pipe(up)
	})
}

test('the browser leaving a stream closes the connection to the app', async () => {
	let closed = false
	const app = http.createServer((req, res) => {
		res.writeHead(200, {'content-type': 'text/event-stream'})
		const t = setInterval(() => res.write('data: x\n\n'), 20)
		res.on('close', () => ((closed = true), clearInterval(t)))
	})
	const proxy = proxyTo(await listen(app))
	const port = await listen(proxy)
	const ac = new AbortController()
	const r = await fetch(`http://127.0.0.1:${port}/`, {signal: ac.signal})
	const reader = r.body.getReader()
	await reader.read()
	ac.abort()
	for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 20))
	assert.ok(closed)
	proxy.close(), app.close()
})

test('an upload the client abandons is not left open at the far side', async () => {
	let ended = false
	const app = http.createServer((req, res) => {
		req.on('close', () => (ended = true))
		req.resume()
	})
	const proxy = proxyTo(await listen(app))
	const port = await listen(proxy)
	const s = net.connect(port, '127.0.0.1')
	await new Promise((r) => s.on('connect', r))
	s.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\nabc')
	await new Promise((r) => setTimeout(r, 200))
	s.destroy()
	for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 20))
	assert.ok(ended)
	proxy.close(), app.close()
})

test('the app dropping mid-response ends the client request instead of hanging', async () => {
	const app = http.createServer((req, res) => {
		res.writeHead(200, {'content-length': '1000000'})
		res.write(Buffer.alloc(1000))
		setTimeout(() => res.socket.destroy(), 100)
	})
	const proxy = proxyTo(await listen(app))
	const port = await listen(proxy)
	const r = await fetch(`http://127.0.0.1:${port}/`)
	const done = r.arrayBuffer().then(() => 'finished', () => 'failed')
	const result = await Promise.race([done, new Promise((r) => setTimeout(() => r('hung'), 3000))])
	assert.equal(result, 'failed')
	proxy.close(), app.close()
})
