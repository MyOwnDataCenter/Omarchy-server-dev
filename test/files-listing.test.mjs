// Files listing, search, favorites, upload collisions, and trash timestamps.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {closeSync, mkdirSync, openSync, utimesSync} from 'node:fs'
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Readable, Writable} from 'node:stream'
import {describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

async function scratch() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'omarchy-files-list-')))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	await mkdir(dataDir, {recursive: true})
	await writeFile(join(home, 'Documents', 'notes.txt'), 'hello')
	const files = createFiles({home, dataDir})
	const call = (name, input) => files.procedures[name].run(input)
	return {root, home, dataDir, files, call}
}

function mockRes() {
	return {
		status: 0,
		body: '',
		writeHead(status) {
			this.status = status
		},
		end(body) {
			this.body = body ?? ''
		},
	}
}

async function upload(files, path, body, collision = 'keep-both', io) {
	const api = io ? createFiles({home: files.home, dataDir: files.dataDir, io}) : files
	const res = mockRes()
	const url = new URL(`http://x/?path=${encodeURIComponent(path)}&collision=${encodeURIComponent(collision)}`)
	await api.upload(Readable.from([body]), res, url)
	let parsed = null
	try {
		parsed = JSON.parse(res.body)
	} catch {
		parsed = null
	}
	return {status: res.status, body: parsed, raw: res.body}
}

describe('files listing fixes', () => {
	test('renaming or moving a favorite follows the path, and a stale path is not reused', async () => {
		const box = await scratch()
		try {
			await box.call('files.addFavorite', {path: '/Home/Documents/notes.txt'})
			await box.call('files.addFavorite', {path: '/Home/Documents'})
			await box.call('files.rename', {path: '/Home/Documents', newName: 'Papers'})
			const afterRename = (await box.call('files.favorites')).map((e) => e.path).sort()
			assert.deepEqual(afterRename, ['/Home/Papers', '/Home/Papers/notes.txt'])
			await writeFile(join(box.home, 'Documents-gone'), 'x')
			await mkdir(join(box.home, 'Documents'))
			await writeFile(join(box.home, 'Documents', 'notes.txt'), 'new')
			const reused = (await box.call('files.favorites')).map((e) => e.path).sort()
			assert.deepEqual(reused, ['/Home/Papers', '/Home/Papers/notes.txt'])
			await box.call('files.move', {path: '/Home/Papers/notes.txt', toDirectory: '/Home', collision: 'keep-both'})
			const afterMove = (await box.call('files.favorites')).map((e) => e.path).sort()
			assert.deepEqual(afterMove, ['/Home/Papers', '/Home/notes.txt'])
			await rm(join(box.home, 'notes.txt'))
			const pruned = (await box.call('files.favorites')).map((e) => e.path)
			assert.deepEqual(pruned, ['/Home/Papers'])
			await writeFile(join(box.home, 'notes.txt'), 'later')
			const notReused = (await box.call('files.favorites')).map((e) => e.path)
			assert.deepEqual(notReused, ['/Home/Papers'])
			assert.equal((await readFile(join(box.dataDir, 'favorites.json'), 'utf8')).includes('/Home/notes.txt'), false)
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('a damaged favorites file is left unchanged when listing or renaming', async () => {
		const box = await scratch()
		try {
			const file = join(box.dataDir, 'favorites.json')
			await writeFile(file, '{"not":"a list"')
			const before = await readFile(file)
			assert.deepEqual(await box.call('files.favorites'), [])
			await box.call('files.rename', {path: '/Home/Documents/notes.txt', newName: 'notes2.txt'})
			assert.deepEqual(await readFile(file), before)
			await assert.rejects(box.call('files.addFavorite', {path: '/Home/Documents'}), (err) => {
				assert.ok(err instanceof RpcError)
				assert.equal(err.code, 'PRECONDITION_FAILED')
				assert.match(err.message, /favorites\.json/)
				return true
			})
			assert.deepEqual(await readFile(file), before)
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('leading-dot names are rejected for upload, create, and rename', async () => {
		const box = await scratch()
		try {
			const up = await upload(box.files, '/Home/.secret', 'x')
			assert.equal(up.status, 400)
			assert.equal(up.body.error, '[hidden-name]')
			await assert.rejects(box.call('files.createDirectory', {path: '/Home/.cache2'}), (err) => err instanceof RpcError && err.message === '[hidden-name]')
			await assert.rejects(box.call('files.rename', {path: '/Home/Documents/notes.txt', newName: '.notes.txt'}), (err) => err instanceof RpcError && err.message === '[hidden-name]')
			const names = (await box.call('files.list', {path: '/Home'})).files.map((f) => f.name)
			assert.equal(names.includes('.secret'), false)
			assert.equal(names.includes('.cache2'), false)
			assert.equal(await readFile(join(box.home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('upload maps disk and permission errors to a short reason', async () => {
		const box = await scratch()
		try {
			const full = createFiles({
				home: box.home,
				dataDir: box.dataDir,
				io: {
					createWriteStream() {
						return new Writable({
							write(_chunk, _enc, cb) {
								const error = new Error('no space')
								error.code = 'ENOSPC'
								cb(error)
							},
						})
					},
				},
			})
			const res = mockRes()
			await full.upload(Readable.from(['x']), res, new URL(`http://x/?path=${encodeURIComponent('/Home/big.bin')}&collision=keep-both`))
			assert.equal(res.status, 507)
			assert.equal(JSON.parse(res.body).error, 'Not enough free space')

			const quota = createFiles({
				home: box.home,
				dataDir: box.dataDir,
				io: {
					createWriteStream() {
						return new Writable({
							write(_chunk, _enc, cb) {
								const error = new Error('quota')
								error.code = 'EDQUOT'
								cb(error)
							},
						})
					},
				},
			})
			const qres = mockRes()
			await quota.upload(Readable.from(['x']), qres, new URL(`http://x/?path=${encodeURIComponent('/Home/quota.bin')}`))
			assert.equal(qres.status, 507)

			const missing = createFiles({
				home: box.home,
				dataDir: box.dataDir,
				io: {
					createWriteStream() {
						return new Writable({
							write(_chunk, _enc, cb) {
								const error = new Error('gone')
								error.code = 'ENOENT'
								cb(error)
							},
						})
					},
				},
			})
			const mres = mockRes()
			await missing.upload(Readable.from(['x']), mres, new URL(`http://x/?path=${encodeURIComponent('/Home/missing.bin')}`))
			assert.equal(mres.status, 404)
			assert.equal(JSON.parse(mres.body).error, 'Folder not found')

			if (process.getuid?.() !== 0) {
				const locked = join(box.home, 'locked')
				await mkdir(locked)
				await chmod(locked, 0o555)
				try {
					const denied = await upload(box.files, '/Home/locked/a.txt', 'x')
					assert.equal(denied.status, 403)
					assert.equal(denied.body.error, 'Permission denied')
				} finally {
					await chmod(locked, 0o755)
				}
			}
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('keep-both upload next to a folder uses a free name; replace and error refuse it', async () => {
		const box = await scratch()
		try {
			await mkdir(join(box.home, 'photos'))
			const kept = await upload(box.files, '/Home/photos', 'x', 'keep-both')
			assert.equal(kept.status, 200)
			assert.equal(kept.body.path, '/Home/photos (2)')
			assert.equal(await readFile(join(box.home, 'photos (2)'), 'utf8'), 'x')
			assert.equal((await stat(join(box.home, 'photos'))).isDirectory(), true)
			const erred = await upload(box.files, '/Home/photos', 'y', 'error')
			assert.equal(erred.status, 409)
			assert.equal(erred.body.error, '[already-exists]')
			const replaced = await upload(box.files, '/Home/photos', 'z', 'replace')
			assert.equal(replaced.status, 409)
			assert.equal(replaced.body.error, '[is-a-directory]')
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('keep-both does not invent an extension for folders or non-extensions', async () => {
		const box = await scratch()
		try {
			await mkdir(join(box.home, 'Photos 2024.05'))
			await writeFile(join(box.home, 'Dr. Smith'), 'a')
			await writeFile(join(box.home, 'Release v1.2'), 'b')
			await writeFile(join(box.home, 'Meeting 1.5 notes'), 'c')
			await writeFile(join(box.home, 'archive.tar.gz'), 'd')
			await writeFile(join(box.home, 'notes.txt'), 'e')
			await mkdir(join(box.home, 'archive.tar.gz.dir'))
			await writeFile(join(box.home, 'archive.tar.gz.dir', 'marker'), 'm')
			const folder = await box.call('files.copy', {path: '/Home/Photos 2024.05', toDirectory: '/Home'})
			const doctor = await box.call('files.copy', {path: '/Home/Dr. Smith', toDirectory: '/Home'})
			const release = await box.call('files.copy', {path: '/Home/Release v1.2', toDirectory: '/Home'})
			const meeting = await box.call('files.copy', {path: '/Home/Meeting 1.5 notes', toDirectory: '/Home'})
			const archive = await box.call('files.copy', {path: '/Home/archive.tar.gz', toDirectory: '/Home'})
			const notes = await box.call('files.copy', {path: '/Home/notes.txt', toDirectory: '/Home'})
			const archiveDir = await box.call('files.copy', {path: '/Home/archive.tar.gz.dir', toDirectory: '/Home'})
			assert.equal(folder, '/Home/Photos 2024.05 (2)')
			assert.equal(doctor, '/Home/Dr. Smith (2)')
			assert.equal(release, '/Home/Release v1.2 (2)')
			assert.equal(meeting, '/Home/Meeting 1.5 notes (2)')
			assert.equal(archive, '/Home/archive.tar (2).gz')
			assert.equal(notes, '/Home/notes (2).txt')
			assert.equal(archiveDir, '/Home/archive.tar.gz.dir (2)')
			assert.equal((await stat(join(box.home, 'Photos 2024.05 (2)'))).isDirectory(), true)
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('trash DeletionDate is local time, including US Eastern', () => {
		const script = `
			import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises'
			import {tmpdir} from 'node:os'
			import {join} from 'node:path'
			import {createFiles, deletionDateStamp} from ${JSON.stringify(fileURLToPath(new URL('../omarchyd/files.mjs', import.meta.url)))}
			const root = await mkdtemp(join(tmpdir(), 'omarchy-trash-tz-'))
			const home = join(root, 'home')
			const dataDir = join(root, 'data')
			await mkdir(join(home, 'Documents'), {recursive: true})
			await mkdir(dataDir, {recursive: true})
			await writeFile(join(home, 'Documents', 'n.txt'), 'x')
			const files = createFiles({home, dataDir})
			const now = new Date()
			await files.procedures['files.trash'].run({path: '/Home/Documents/n.txt'})
			const infoDir = join(home, '.local/share/Trash/info')
			const name = (await readdir(infoDir))[0]
			const text = await readFile(join(infoDir, name), 'utf8')
			const stamp = text.match(/DeletionDate=(.*)/)[1]
			const local = deletionDateStamp(now)
			const next = deletionDateStamp(new Date(now.getTime() + 1000))
			const utc = now.toISOString().slice(0, 19)
			if (stamp !== local && stamp !== next) {
				console.error(JSON.stringify({stamp, local, utc}))
				process.exit(1)
			}
			if (utc === local) {
				console.error('timezone did not move the clock')
				process.exit(2)
			}
			await rm(root, {recursive: true, force: true})
		`
		const ran = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
			env: {...process.env, TZ: 'America/New_York'},
			encoding: 'utf8',
		})
		assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`)
	})

	test('search stays in the folder, honours maxResults, and says when it is cut', async () => {
		const box = await scratch()
		try {
			await mkdir(join(box.home, 'other'))
			await mkdir(join(box.home, 'work'))
			for (let i = 0; i < 60; i++) await writeFile(join(box.home, 'other', `report${i}.txt`), 'o')
			await writeFile(join(box.home, 'work', 'report-main.txt'), 'm')
			const inside = await box.call('files.search', {query: 'report', maxResults: 100, path: '/Home/work'})
			assert.equal(inside.files.length, 1)
			assert.equal(inside.files[0].name, 'report-main.txt')
			assert.equal(inside.truncated, false)
			const cut = await box.call('files.search', {query: 'report', maxResults: 10, path: '/Home/other'})
			assert.equal(cut.files.length, 10)
			assert.equal(cut.truncated, true)
			const exact = await box.call('files.search', {query: 'report-main', maxResults: 1, path: '/Home/work'})
			assert.equal(exact.files.length, 1)
			assert.equal(exact.truncated, false)
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})

	test('search and recents still see a file past 20000 home entries', async () => {
		const box = await scratch()
		try {
			const bulk = join(box.home, 'bulk')
			const late = join(box.home, 'zzz-new')
			mkdirSync(bulk)
			mkdirSync(late)
			for (let i = 0; i < 20000; i++) closeSync(openSync(join(bulk, `p${i}.txt`), 'w'))
			const target = join(late, 'findme-target.txt')
			closeSync(openSync(target, 'w'))
			const future = new Date(Date.now() + 60_000)
			utimesSync(target, future, future)
			const found = await box.call('files.search', {query: 'findme-target', path: '/Home'})
			assert.equal(found.files.some((f) => f.name === 'findme-target.txt'), true)
			const recent = await box.call('files.recents')
			assert.equal(recent.length <= 30, true)
			assert.equal(recent[0].name, 'findme-target.txt')
			assert.equal(recent[0].path, '/Home/zzz-new/findme-target.txt')
		} finally {
			await rm(box.root, {recursive: true, force: true})
		}
	})
})

