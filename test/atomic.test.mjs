// State files: many saves at the same moment all land, and the last one wins.
import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {basename, join} from 'node:path'
import {test} from 'node:test'

import {plainObject, readJsonState, writeAtomic} from '../omarchyd/atomic.mjs'

const captureErrors = async (fn) => {
	const lines = []
	const orig = console.error
	console.error = (...args) => lines.push(args.map(String).join(' '))
	try {
		return {result: await fn(), lines}
	} finally {
		console.error = orig
	}
}

test('simultaneous saves never fail and leave the newest state, with no temporary files behind', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-'))
	try {
		const file = join(dir, 'state.json')
		const state = {n: 0}
		// Before 0.9.12 two saves at once shared one temporary name and one of them failed (ENOENT).
		await Promise.all(
			Array.from({length: 50}, () => {
				state.n++
				return writeAtomic(file, () => JSON.stringify(state))
			}),
		)
		assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {n: 50})
		assert.deepEqual(await readdir(dir), ['state.json'])
		// A failed write doesn't block the next one.
		await assert.rejects(writeAtomic(join(dir, 'missing', 'x.json'), '{}'))
		await writeAtomic(file, '{"ok":true}')
		assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {ok: true})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('plainObject accepts plain objects and rejects null, arrays, and primitives', () => {
	assert.equal(plainObject({}), true)
	assert.equal(plainObject({a: 1}), true)
	for (const bad of [null, undefined, [], [1], 'x', 5, true, false]) {
		assert.equal(plainObject(bad), false, String(bad))
	}
})

test('readJsonState distinguishes missing (ENOENT) and valid files without logging', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-read-'))
	try {
		const missing = await captureErrors(() => readJsonState(join(dir, 'state.json')))
		assert.deepEqual(missing.result, {status: 'missing', value: null, damaged: false})
		assert.deepEqual(missing.lines, [])

		const file = join(dir, 'state.json')
		await writeFile(file, '{"ok":true,"count":2}')
		const ok = await captureErrors(() => readJsonState(file))
		assert.deepEqual(ok.result, {status: 'ok', value: {ok: true, count: 2}, damaged: false})
		assert.deepEqual(ok.lines, [])
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('readJsonState leaves damaged or wrong-shaped files untouched and logs basename only once', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-bad-'))
	try {
		const file = join(dir, 'state.json')
		const cases = [
			['empty', ''],
			['truncated', '{"secret":"do-not-log-secret"'],
			['bom', '\uFEFF{"ok":true}'],
			['null', 'null'],
			['array', '["do-not-log-array"]'],
			['string', '"do-not-log-string"'],
		]
		for (const [name, raw] of cases) {
			await writeFile(file, raw)
			const before = await readFile(file)
			const {result, lines} = await captureErrors(() => readJsonState(file))
			assert.equal(result.status, 'damaged', name)
			assert.equal(result.value, null, name)
			assert.equal(result.damaged, true, name)
			assert.deepEqual(await readFile(file), before, name)
			assert.deepEqual(await readdir(dir), ['state.json'], name)
			assert.equal(lines.length, 1, name)
			assert.match(lines[0], /state\.json/, name)
			assert.equal(lines[0].includes(dir), false, `${name}: no dir`)
			assert.equal(lines[0].includes(file), false, `${name}: no full path`)
			if (raw.length > 0) assert.equal(lines[0].includes(raw), false, `${name}: no file contents`)
			assert.equal(lines[0].includes('do-not-log'), false, `${name}: no secret`)
		}

		await writeFile(file, '{"items":null}')
		const rejected = await captureErrors(() => readJsonState(file, {validate: (v) => plainObject(v) && Array.isArray(v.items)}))
		assert.deepEqual(rejected.result, {status: 'damaged', value: null, damaged: true, reason: 'shape'})
		assert.equal(rejected.lines.length, 1)
		assert.equal(await readFile(file, 'utf8'), '{"items":null}')

		const throwing = await captureErrors(() => readJsonState(file, {
			validate: () => {
				throw new Error('boom')
			},
		}))
		assert.deepEqual(throwing.result, {status: 'damaged', value: null, damaged: true, reason: 'shape'})
		assert.equal(throwing.lines.length, 1)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('readJsonState treats read errors like EISDIR and EACCES as damaged without leaking paths', async (t) => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-err-'))
	try {
		const subDir = join(dir, 'dir-state.json')
		await mkdir(subDir)
		const isDir = await captureErrors(() => readJsonState(subDir))
		assert.deepEqual(isDir.result, {status: 'damaged', value: null, damaged: true, reason: 'read'})
		assert.equal(isDir.lines.length, 1)
		assert.match(isDir.lines[0], /dir-state\.json/)
		assert.equal(isDir.lines[0].includes(dir), false)
		assert.equal((await stat(subDir)).isDirectory(), true)

		if (process.getuid?.() === 0) return t.skip('root ignores file mode')
		const locked = join(dir, 'locked.json')
		await writeFile(locked, '{"secret":"kept"}', {mode: 0o600})
		await chmod(locked, 0o000)
		try {
			const eacces = await captureErrors(() => readJsonState(locked))
			assert.deepEqual(eacces.result, {status: 'damaged', value: null, damaged: true, reason: 'read'})
			assert.equal(eacces.lines.length, 1)
			assert.match(eacces.lines[0], /locked\.json/)
			assert.equal(eacces.lines[0].includes(dir), false)
			assert.equal(eacces.lines[0].includes('EACCES'), false)
		} finally {
			await chmod(locked, 0o600)
		}
		assert.equal(await readFile(locked, 'utf8'), '{"secret":"kept"}')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('readJsonState preserveCopy saves a mode-0600 copy and log suppression skips output', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-copy-'))
	try {
		const file = join(dir, 'state.json')
		const raw = '{"broken":'
		await writeFile(file, raw, {mode: 0o644})
		const {result, lines} = await captureErrors(() => readJsonState(file, {preserveCopy: true}))
		assert.equal(result.status, 'damaged')
		assert.equal(result.damaged, true)
		assert.equal(result.reason, 'parse')
		assert.ok(result.copy?.startsWith(`${file}.damaged-`))
		assert.equal(await readFile(file, 'utf8'), raw)
		assert.equal(await readFile(result.copy, 'utf8'), raw)
		assert.equal((await stat(result.copy)).mode & 0o777, 0o600)
		assert.equal(lines.length, 1)
		assert.match(lines[0], /state\.json/)
		assert.equal(lines[0].includes(dir), false)
		assert.equal(lines[0].includes(basename(result.copy)), false)

		const silentNull = await captureErrors(() => readJsonState(file, {log: null}))
		assert.equal(silentNull.result.damaged, true)
		assert.deepEqual(silentNull.lines, [])

		const silentFalse = await captureErrors(() => readJsonState(file, {log: false}))
		assert.equal(silentFalse.result.damaged, true)
		assert.deepEqual(silentFalse.lines, [])
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
