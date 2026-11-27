// Names, ranges, special files, and filesystem errors for the file procedures.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {after, before, describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const exec = promisify(execFile)
const screenSrc = await readFile(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')

// Same sentences nice() shows. A bracketed code is what the procedure throws.
function screen(msg) {
	const notDir = /^\[not-a-directory:(.*)\]$/.exec(msg)
	if (notDir) return `${notDir[1]} is a file, not a folder`
	return (
		{
			'[permission]': 'You don’t have permission to change that folder',
			'[read-only]': 'That folder is read-only',
			'[no-space]': 'There isn’t enough free space',
		}[msg] ?? msg
	)
}

let root, home, files
const call = (name, input) => files.procedures[name].run(input)

before(async () => {
	root = await realpathTmp()
	home = join(root, 'home')
	await mkdir(join(home, 'Documents'), {recursive: true})
	await writeFile(join(home, 'Documents', 'notes.txt'), 'hello')
	await mkdir(join(root, 'data'))
	files = createFiles({home, dataDir: join(root, 'data')})
})
after(() => rm(root, {recursive: true, force: true}))

async function realpathTmp() {
	const {realpath} = await import('node:fs/promises')
	return realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-files-names-')))
}

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function close(server) {
	server.closeAllConnections?.()
	return new Promise((resolve) => server.close(resolve))
}
function serve(kind = 'download') {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://x')
		return files.serveFile(req, res, url, kind)
	})
	return server
}

describe('files: special files and names', () => {
	test('#818 serveFile refuses a named pipe without reading it', async () => {
		const fifo = join(home, 'pipe')
		await exec('mkfifo', [fifo])
		await writeFile(join(home, 'plain.txt'), 'plain-bytes')
		const server = serve('download')
		const port = await listen(server)
		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), 800)
		let status
		let body
		let err
		try {
			const res = await fetch(`http://127.0.0.1:${port}/?path=${encodeURIComponent('/Home/pipe')}`, {signal: ctrl.signal})
			status = res.status
			body = await res.text()
		} catch (e) {
			err = e
		} finally {
			clearTimeout(timer)
			await close(server)
		}
		assert.equal(err, undefined, `serveFile hung on the fifo (${err?.name ?? ''} ${err?.message ?? ''})`)
		assert.equal(status, 400)
		assert.match(body, /isn’t a regular file/)
		const server2 = serve('download')
		const port2 = await listen(server2)
		try {
			const ok = await fetch(`http://127.0.0.1:${port2}/?path=${encodeURIComponent('/Home/plain.txt')}`)
			assert.equal(ok.status, 200)
			assert.equal(await ok.text(), 'plain-bytes')
		} finally {
			await close(server2)
		}
	})

	test('#818 a pipe has no download or view, a file does', async () => {
		const fifo = join(home, 'pipe')
		try {
			await stat(fifo)
		} catch {
			await exec('mkfifo', [fifo])
		}
		await writeFile(join(home, 'plain.txt'), 'plain-bytes')
		const listed = await call('files.list', {path: '/Home'})
		const pipe = listed.files.find((f) => f.name === 'pipe')
		const file = listed.files.find((f) => f.name === 'plain.txt')
		assert.ok(pipe, 'pipe is listed')
		assert.ok(file, 'file is listed')
		assert.equal(file.operations.includes('download'), true)
		assert.equal(file.operations.includes('view'), true)
		assert.equal(pipe.operations.includes('download'), false)
		assert.equal(pipe.operations.includes('view'), false)
		const docs = await call('files.list', {path: '/Home/Documents'})
		const folder = docs
		assert.deepEqual(
			folder.operations.includes('download') || folder.files.some((f) => f.type === 'directory' && f.operations.includes('download')),
			false,
		)
	})

	test('directories under Home offer share to the owner; files and Trash do not', async () => {
		await mkdir(join(home, 'Documents', 'Nested'), {recursive: true})
		await writeFile(join(home, 'Documents', 'plain.txt'), 'plain')
		const homeList = await call('files.list', {path: '/Home'})
		assert.equal(homeList.operations.includes('share'), false)
		const docs = homeList.files.find((f) => f.name === 'Documents')
		assert.equal(docs?.type, 'directory')
		assert.equal(docs.operations.includes('share'), true)
		const docList = await call('files.list', {path: '/Home/Documents'})
		assert.equal(docList.operations.includes('share'), true)
		const nested = docList.files.find((f) => f.name === 'Nested')
		const plain = docList.files.find((f) => f.name === 'plain.txt')
		assert.equal(nested.operations.includes('share'), true)
		assert.equal(plain.operations.includes('share'), false)
		await call('files.trash', {path: '/Home/Documents/Nested'})
		const trash = await call('files.list', {path: '/Trash'})
		assert.equal(trash.operations.includes('share'), false)
		assert.equal(trash.files.every((f) => !f.operations.includes('share')), true)
		await call('files.restore', {path: '/Trash/Nested'})
	})

	test('#814 a stale If-Range ignores Range and returns the whole file', async () => {
		const file = join(home, 'range.txt')
		const old = new Date('2020-01-01T00:00:00Z')
		const cur = new Date('2024-06-01T00:00:00Z')
		await writeFile(file, 'A'.repeat(40))
		await utimes(file, old, old)
		const oldLM = old.toUTCString()
		await writeFile(file, 'B'.repeat(40))
		await utimes(file, cur, cur)
		const curLM = cur.toUTCString()
		const server = serve('download')
		const port = await listen(server)
		const url = `http://127.0.0.1:${port}/?path=${encodeURIComponent('/Home/range.txt')}`
		try {
			const changed = await fetch(url, {headers: {range: 'bytes=10-', 'if-range': oldLM}})
			assert.equal(changed.status, 200)
			assert.equal(await changed.text(), 'B'.repeat(40))
			const fresh = await fetch(url, {headers: {range: 'bytes=10-', 'if-range': curLM}})
			assert.equal(fresh.status, 206)
			assert.equal(await fresh.text(), 'B'.repeat(30))
			const open = await fetch(url, {headers: {range: 'bytes=10-'}})
			assert.equal(open.status, 206)
			assert.equal(await open.text(), 'B'.repeat(30))
			assert.equal(fresh.headers.get('last-modified'), curLM)
		} finally {
			await close(server)
		}
	})

	test('#635 list includes a non-UTF-8 file name', async () => {
		const dir = join(home, 'Odd')
		await mkdir(dir, {recursive: true})
		await writeFile(join(dir, 'caf-ok.txt'), 'ok')
		const raw = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])
		await writeFile(Buffer.concat([Buffer.from(dir + '/'), raw]), 'latin1')
		const listed = await call('files.list', {path: '/Home/Odd'})
		assert.equal(listed.files.length, listed.totalFiles)
		assert.equal(listed.files.length, 2)
		assert.ok(listed.files.some((f) => f.name.includes('caf') && f.name.includes('\uFFFD')))
	})

	test('#635 search does not throw when a name is not valid UTF-8', async () => {
		const dir = join(home, 'Odd')
		await mkdir(dir, {recursive: true})
		await writeFile(join(dir, 'caf-ok.txt'), 'ok')
		const raw = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])
		await writeFile(Buffer.concat([Buffer.from(dir + '/'), raw]), 'latin1')
		const found = (await call('files.search', {query: 'caf'})).files
		assert.ok(Array.isArray(found))
		assert.ok(found.some((f) => f.name === 'caf-ok.txt'))
	})

	test('#630 permission, not-a-directory, read-only, and no-space are sentences', async () => {
		const locked = join(home, 'locked')
		await mkdir(locked, {recursive: true})
		await chmod(locked, 0o555)
		try {
			await assert.rejects(call('files.createDirectory', {path: '/Home/locked/child'}), (e) => {
				assert.ok(e instanceof RpcError, `expected RpcError, got ${e?.constructor?.name}: ${e?.code} ${e?.message}`)
				assert.equal(e.code, 'FORBIDDEN')
				assert.equal(screen(e.message), 'You don’t have permission to change that folder')
				return true
			})
		} finally {
			await chmod(locked, 0o755)
		}
		await writeFile(join(home, 'Documents', 'notes.txt'), 'hello')
		await assert.rejects(call('files.createDirectory', {path: '/Home/Documents/notes.txt/child'}), (e) => {
			assert.ok(e instanceof RpcError, `expected RpcError, got ${e?.constructor?.name}: ${e?.code} ${e?.message}`)
			assert.equal(e.code, 'BAD_REQUEST')
			assert.equal(screen(e.message), 'notes.txt is a file, not a folder')
			return true
		})
		const ro = createFiles({
			home,
			dataDir: join(root, 'data'),
			io: {
				mkdir: async () => {
					throw Object.assign(new Error('read-only filesystem'), {code: 'EROFS'})
				},
			},
		})
		await assert.rejects(ro.procedures['files.createDirectory'].run({path: '/Home/Nope'}), (e) => {
			assert.ok(e instanceof RpcError, `expected RpcError, got ${e?.constructor?.name}: ${e?.code} ${e?.message}`)
			assert.equal(e.code, 'FORBIDDEN')
			assert.equal(screen(e.message), 'That folder is read-only')
			return true
		})
		const full = createFiles({
			home,
			dataDir: join(root, 'data'),
			io: {
				mkdir: async () => {
					throw Object.assign(new Error('no space'), {code: 'ENOSPC'})
				},
			},
		})
		await assert.rejects(full.procedures['files.createDirectory'].run({path: '/Home/Full'}), (e) => {
			assert.ok(e instanceof RpcError, `expected RpcError, got ${e?.constructor?.name}: ${e?.code} ${e?.message}`)
			assert.equal(e.code, 'BAD_REQUEST')
			assert.equal(screen(e.message), 'There isn’t enough free space')
			return true
		})
		const rulesSrc = await readFile(new URL('../web/src/screens/filesRules.ts', import.meta.url), 'utf8')
		for (const sentence of ['You don’t have permission to change that folder', 'That folder is read-only', 'is a file, not a folder', 'There isn’t enough free space']) {
			assert.equal(screenSrc.includes(sentence) || rulesSrc.includes(sentence), true, sentence)
		}
	})

	test('#286 long upload and trash names stay within the filesystem limit', async () => {
		const long = 'a'.repeat(240)
		const server = http.createServer((req, res) => files.upload(req, res, new URL(req.url, 'http://x')))
		const port = await listen(server)
		const during = []
		try {
			const status = await new Promise((resolve, reject) => {
				const req = http.request(
					{
						hostname: '127.0.0.1',
						port,
						path: `/?path=${encodeURIComponent(`/Home/${long}`)}`,
						method: 'POST',
					},
					(res) => {
						res.resume()
						res.on('end', () => resolve(res.statusCode))
					},
				)
				req.on('error', reject)
				req.write('hello')
				setTimeout(async () => {
					during.push(...(await readdir(home).catch(() => [])))
					req.end('-upload')
				}, 50)
			})
			assert.equal(status, 200)
			assert.equal(await readFile(join(home, long), 'utf8'), 'hello-upload')
			assert.equal(during.some((n) => n.includes(long) && n !== long), false)
			assert.ok(during.some((n) => n.startsWith('.upload.')), `temp name was ${during.filter((n) => n.startsWith('.')).join(',')}`)
		} finally {
			await close(server)
		}
		const jp = 'あ'.repeat(80)
		assert.equal(Buffer.byteLength(jp), 240)
		const server2 = http.createServer((req, res) => files.upload(req, res, new URL(req.url, 'http://x')))
		const port2 = await listen(server2)
		try {
			const res = await fetch(`http://127.0.0.1:${port2}/?path=${encodeURIComponent(`/Home/${jp}`)}`, {method: 'POST', body: 'jp'})
			assert.equal(res.status, 200)
			assert.equal(await readFile(join(home, jp), 'utf8'), 'jp')
			const temps = (await readdir(home)).filter((n) => n.includes('uploading') || n.startsWith('.upload.'))
			assert.equal(temps.some((n) => n.includes(jp)), false)
		} finally {
			await close(server2)
		}
		const wide = 'é'.repeat(128)
		assert.equal(Buffer.byteLength(wide), 256)
		assert.equal(wide.length <= 255, true)
		await assert.rejects(call('files.createDirectory', {path: `/Home/${wide}`}), (e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && e.message === '[invalid-name]')
		const ok = 'd'.repeat(255)
		assert.equal(Buffer.byteLength(ok), 255)
		assert.equal(await call('files.createDirectory', {path: `/Home/${ok}`}), `/Home/${ok}`)
		const trashedName = 'b'.repeat(250)
		await writeFile(join(home, trashedName), 'trash-me')
		const next = await call('files.trash', {path: `/Home/${trashedName}`})
		assert.match(next, /^\/Trash\//)
		const infos = await readdir(join(home, '.local/share/Trash/info'))
		assert.ok(infos.length >= 1)
		for (const name of infos) assert.ok(Buffer.byteLength(name) <= 255, name)
		assert.equal(await readFile(join(home, '.local/share/Trash/files', trashedName), 'utf8'), 'trash-me')
	})
})
