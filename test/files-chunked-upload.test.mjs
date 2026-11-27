// Big uploads in pieces: each request stays small, so they get through proxies that limit one
// request (a Cloudflare Tunnel refuses one over 100 MB), and a dropped piece is just sent again.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

// One request to uploadChunk, with a fake response that records what was said.
async function piece(files, query, bytes) {
	const url = new URL('http://x/api/files/upload-chunk')
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
	const req = Readable.from([Buffer.from(bytes)])
	let status = 0
	let body = ''
	const res = {
		writeHead: (s) => (status = s),
		end: (b) => (body = b),
	}
	await files.uploadChunk(req, res, url)
	return {status, body: JSON.parse(body)}
}

test('pieces arrive in order, a resent piece resumes, and the file takes its name at the end', async () => {
	const home = await mkdtemp(join(os.tmpdir(), 'chunks-'))
	try {
		await mkdir(join(home, 'Documents'))
		await writeFile(join(home, 'Documents', 'big.bin'), 'already here')
		const files = createFiles({home, dataDir: join(home, '.data')})
		const id = 'a'.repeat(32)
		const q = (offset) => ({path: '/Home/Documents/big.bin', id, offset, total: 10})
		assert.deepEqual((await piece(files, q(0), 'abcd')).body, {received: 4})
		// The browser thought the last piece was lost and sends it again: told where to carry on.
		assert.deepEqual(await piece(files, q(0 + 2), 'cd'), {status: 409, body: {error: '[wrong-offset]', received: 4}})
		assert.deepEqual((await piece(files, q(4), 'efgh')).body, {received: 8})
		// Nothing shows in the folder until the file is whole.
		assert.deepEqual((await readdir(join(home, 'Documents'))).filter((n) => !n.startsWith('.')), ['big.bin'])
		const last = await piece(files, q(8), 'ij')
		assert.equal(last.status, 200)
		assert.equal(last.body.path, '/Home/Documents/big (2).bin')
		assert.equal(await readFile(join(home, 'Documents', 'big (2).bin'), 'utf8'), 'abcdefghij')
		assert.equal(await readFile(join(home, 'Documents', 'big.bin'), 'utf8'), 'already here')
		assert.deepEqual((await readdir(join(home, 'Documents'))).filter((n) => n.startsWith('.upload')), [])
	} finally {
		await rm(home, {recursive: true, force: true})
	}
})

test('bad pieces are refused: wrong id, more than it said, outside Home, a planted link', async () => {
	const home = await mkdtemp(join(os.tmpdir(), 'chunks-'))
	try {
		await mkdir(join(home, 'Documents'))
		const files = createFiles({home, dataDir: join(home, '.data')})
		const ok = {path: '/Home/Documents/x.bin', id: 'b'.repeat(32), offset: 0, total: 4}
		assert.equal((await piece(files, {...ok, id: '../../etc'}, 'ab')).status, 400)
		assert.equal((await piece(files, {...ok, offset: 5}, 'ab')).status, 400)
		assert.equal((await piece(files, ok, 'abcdef')).status, 400)
		assert.deepEqual(await readdir(join(home, 'Documents')), [])
		assert.equal((await piece(files, {...ok, path: '/Home/../outside.bin'}, 'ab')).status, 400)
		assert.equal((await piece(files, {...ok, path: '/Home/Documents/.hidden'}, 'ab')).status, 400)
		// A link where the partial file goes isn't written through.
		await writeFile(join(home, 'target.txt'), 'keep')
		await symlink(join(home, 'target.txt'), join(home, 'Documents', `.upload.part.${'c'.repeat(32)}`))
		const linked = await piece(files, {...ok, id: 'c'.repeat(32), offset: 0}, 'ab')
		assert.notEqual(linked.status, 200)
		assert.equal(await readFile(join(home, 'target.txt'), 'utf8'), 'keep')
	} finally {
		await rm(home, {recursive: true, force: true})
	}
})

test('through the web app behind a proxy that refuses requests over 100 MB, a 150 MB file arrives in pieces', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'chunks-e2e-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const d = await startOmarchyd({port: 0, dataDir: data, home})
	const store = await createStore(join(root, 'touch'))
	await store.setConfig({backendUrl: d.url})
	const app = createApp({store, staticDir: join(root, 'none'), relayHost: '127.0.0.1'})
	const web = await new Promise((r) => {
		const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s))
	})
	// Like Cloudflare's 100 MB limit: a bigger request is turned away.
	const LIMIT = 100 * 1024 * 1024
	const front = await new Promise((r) => {
		const s = http
			.createServer((req, res) => {
				if (Number(req.headers['content-length'] ?? 0) > LIMIT) {
					res.writeHead(413).end('Payload Too Large')
					return req.destroy()
				}
				const up = http.request({host: '127.0.0.1', port: web.address().port, method: req.method, path: req.url, headers: req.headers}, (ur) => {
					res.writeHead(ur.statusCode, ur.headers)
					ur.pipe(res)
				})
				req.pipe(up)
			})
			.listen(0, '127.0.0.1', () => r(s))
	})
	const base = `http://127.0.0.1:${front.address().port}`
	try {
		const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json', 'x-omarchy-server': '1'}, body: JSON.stringify({username: 'Chris', password: 'correct horse'})})
		const cookie = login.headers.getSetCookie().find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0]
		const headers = {cookie, 'x-omarchy-server': '1', 'content-type': 'application/octet-stream'}
		const SIZE = 150 * 1024 * 1024
		const file = Buffer.alloc(SIZE)
		for (let i = 0; i < SIZE; i += 4096) file.writeUInt32BE(i, i)
		const path = encodeURIComponent('/Home/Documents/movie.mkv')
		// In one request it's refused, as through the tunnel.
		const whole = await fetch(`${base}/api/files/upload?path=${path}`, {method: 'POST', headers, body: file}).catch(() => null)
		assert.ok(!whole || whole.status === 413)
		// In 8 MB pieces it arrives.
		const id = 'd'.repeat(32)
		const CHUNK = 8 * 1024 * 1024
		let offset = 0
		let done = null
		while (!done) {
			const r = await fetch(`${base}/api/files/upload-chunk?path=${path}&collision=keep-both&id=${id}&offset=${offset}&total=${SIZE}`, {method: 'POST', headers, body: file.subarray(offset, offset + CHUNK)})
			const body = await r.json()
			assert.equal(r.status, 200, JSON.stringify(body))
			offset = body.received
			if (body.path) done = body.path
		}
		assert.equal(done, '/Home/Documents/movie.mkv')
		assert.ok((await readFile(join(home, 'Documents', 'movie.mkv'))).equals(file))
	} finally {
		front.close()
		web.close()
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
