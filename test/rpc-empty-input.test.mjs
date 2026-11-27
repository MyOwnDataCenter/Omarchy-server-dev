import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readdir, rm} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {handleRpc, RpcError} from '../omarchyd/rpc.mjs'

test('empty body and JSON null are an object, not Internal error', async () => {
	const procedures = {
		'x.grab': {kind: 'mutation', public: true, run: async ({label}) => label ?? 'none'},
		'x.echo': {kind: 'mutation', public: true, run: async (input) => input},
		'x.nested': {kind: 'mutation', public: true, run: async (input) => {
			const {name} = input.child
			return name
		}},
		'x.num': {kind: 'mutation', public: true, run: async (input) => {
			if (typeof input === 'number') throw new TypeError('not an object')
			return input
		}},
	}
	const server = http.createServer((req, res) => handleRpc(req, res, new URL(req.url, 'http://x'), procedures, () => null))
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${server.address().port}`
	const error = console.error
	console.error = () => {}
	const post = (body) => fetch(`${base}/trpc/x.grab`, {method: 'POST', body})
	try {
		for (const body of ['', 'null']) {
			const res = await post(body)
			assert.equal(res.status, 200, body === '' ? 'empty' : 'null')
			assert.equal((await res.json()).result.data, 'none')
		}
		assert.deepEqual((await (await fetch(`${base}/trpc/x.echo`, {method: 'POST', body: 'null'})).json()).result.data, {})
		assert.deepEqual((await (await fetch(`${base}/trpc/x.echo`, {method: 'POST', body: '[]'})).json()).result.data, [])
		assert.equal((await (await fetch(`${base}/trpc/x.echo`, {method: 'POST', body: '1'})).json()).result.data, 1)
		assert.equal((await (await fetch(`${base}/trpc/x.echo`, {method: 'POST', body: '"hi"'})).json()).result.data, 'hi')
		const nested = await fetch(`${base}/trpc/x.nested`, {method: 'POST', body: 'null'})
		assert.equal(nested.status, 500)
		assert.match(await nested.text(), /Internal error/)
		const num = await fetch(`${base}/trpc/x.num`, {method: 'POST', body: '1'})
		assert.equal(num.status, 500)
		assert.match(await num.text(), /Internal error/)
	} finally {
		console.error = error
		server.close()
	}
})

test('createDirectory rejects a non-string path before creating anything', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-mkdir-'))
	try {
		const home = join(root, 'home')
		await mkdir(join(home, 'Documents'), {recursive: true})
		const files = createFiles({home, dataDir: join(root, 'data')})
		const call = (input) => files.procedures['files.createDirectory'].run(input)
		const before = await readdir(home)
		for (const input of [{path: null}, {path: 1}, {path: ['/Home/Nope']}, null]) {
			await assert.rejects(call(input), (e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && /string/i.test(e.message), JSON.stringify(input))
		}
		assert.deepEqual(await readdir(home), before)
		assert.equal(await call({path: '/Home/Notes'}), '/Home/Notes')
		assert.ok((await readdir(home)).includes('Notes'))
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
