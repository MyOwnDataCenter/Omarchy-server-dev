// Damaged config.json / sessions.json must not stop startup or be overwritten by the fallback.
import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createStore} from '../server/store.mjs'

const root = await mkdtemp(join(os.tmpdir(), 'store-damaged-'))
after(() => rm(root, {recursive: true, force: true}))

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

async function readOrNull(file) {
	try {
		return await readFile(file)
	} catch (error) {
		if (error.code === 'ENOENT') return null
		throw error
	}
}

function keptAside(original, current, aside) {
	const raw = Buffer.from(original)
	return (aside && aside.equals(raw)) || (current && current.equals(raw))
}

test('empty config.json starts from {} and keeps the damaged bytes', async () => {
	const dir = join(root, 'empty-config')
	await mkdir(dir)
	const file = join(dir, 'config.json')
	await writeFile(file, '')
	const logs = []
	const error = console.error
	console.error = (...args) => logs.push(args.map(String).join(' '))
	try {
		const store = await createStore(dir)
		assert.deepEqual(store.getConfig(), {})
	} finally {
		console.error = error
	}
	const current = await readOrNull(file)
	const aside = await readOrNull(`${file}.bad`)
	assert.equal(keptAside('', current, aside), true)
	if (current) assert.notEqual(current.toString('utf8').trim(), '{}')
	assert.ok(logs.some((line) => line === 'config.json is empty or invalid and was moved to config.json.bad'))
	assert.ok(logs.every((line) => !line.includes(dir) && !line.includes(root)))
})

test('sessions.json null starts empty, accepts a session, and keeps the original bytes aside', async () => {
	const dir = join(root, 'null-sessions')
	await mkdir(dir)
	const file = join(dir, 'sessions.json')
	const original = 'null'
	await writeFile(file, original)
	const store = await createStore(dir)
	assert.equal(store.getSession('device-1'), undefined)
	assert.equal(store.sessionCount(), 0)
	await store.putSession('device-1', {name: 'phone'})
	assert.equal(store.sessionCount(), 1)
	assert.deepEqual(store.getSession('device-1'), {name: 'phone'})
	const aside = await readOrNull(`${file}.bad`)
	assert.ok(aside && aside.equals(Buffer.from(original)))
	const saved = JSON.parse((await readFile(file)).toString('utf8'))
	assert.equal(saved && typeof saved === 'object' && !Array.isArray(saved), true)
	assert.equal(JSON.stringify(saved).includes('null'), false)
})

test('config.json string is not spread, and setConfig does not persist that garbage', async () => {
	const dir = join(root, 'string-config')
	await mkdir(dir)
	const file = join(dir, 'config.json')
	const original = '"x"'
	await writeFile(file, original)
	const store = await createStore(dir)
	const config = store.getConfig()
	assert.equal(Object.hasOwn(config, '0'), false)
	assert.deepEqual(config, {})
	const next = await store.setConfig({theme: 'ink'})
	assert.equal(Object.hasOwn(next, '0'), false)
	assert.equal(next.theme, 'ink')
	const saved = JSON.parse((await readFile(file)).toString('utf8'))
	assert.equal(Object.hasOwn(saved, '0'), false)
	assert.equal(saved.theme, 'ink')
	assert.deepEqual(saved, {theme: 'ink'})
	const aside = await readOrNull(`${file}.bad`)
	assert.ok(aside && aside.equals(Buffer.from(original)))
})

test('a non-object config such as an array is not the stored value', async () => {
	const dir = join(root, 'array-config')
	await mkdir(dir)
	const file = join(dir, 'config.json')
	const original = '[1]'
	await writeFile(file, original)
	const store = await createStore(dir)
	assert.deepEqual(store.getConfig(), {})
	assert.equal(Object.hasOwn(store.getConfig(), '0'), false)
	const aside = await readOrNull(`${file}.bad`)
	const current = await readOrNull(file)
	assert.equal(keptAside(original, current, aside), true)
	if (current && !aside) assert.equal(current.toString('utf8'), original)
})

test('missing files use the fallback and do not create .bad files', async () => {
	const dir = join(root, 'missing')
	const store = await createStore(dir)
	assert.deepEqual(store.getConfig(), {})
	assert.equal(store.getSession('device-1'), undefined)
	assert.equal(store.sessionCount(), 0)
	assert.equal(await readOrNull(join(dir, 'config.json')), null)
	assert.equal(await readOrNull(join(dir, 'sessions.json')), null)
	assert.equal(await readOrNull(join(dir, 'config.json.bad')), null)
	assert.equal(await readOrNull(join(dir, 'sessions.json.bad')), null)
})

test('an existing .bad file is kept and the damaged bytes move to the next free aside', async () => {
	const dir = join(root, 'bad-exists')
	await mkdir(dir)
	const older = '{"kept":true}'
	await writeFile(join(dir, 'config.json.bad'), older)
	await writeFile(join(dir, 'sessions.json.bad'), 'null')
	await writeFile(join(dir, 'config.json'), '')
	await writeFile(join(dir, 'sessions.json'), '"x"')
	const store = await createStore(dir)
	assert.deepEqual(store.getConfig(), {})
	assert.equal(store.sessionCount(), 0)
	assert.equal(await readFile(join(dir, 'config.json.bad'), 'utf8'), older)
	assert.equal(await readFile(join(dir, 'sessions.json.bad'), 'utf8'), 'null')
	assert.equal(await readFile(join(dir, 'config.json.bad.1'), 'utf8'), '')
	assert.equal(await readFile(join(dir, 'sessions.json.bad.1'), 'utf8'), '"x"')
	assert.equal(await readOrNull(join(dir, 'config.json')), null)
	assert.equal(await readOrNull(join(dir, 'sessions.json')), null)
})

test('a directory where config.json should be still rejects createStore', async () => {
	const dir = join(root, 'eisdir')
	await mkdir(join(dir, 'config.json'), {recursive: true})
	await assert.rejects(() => createStore(dir))
	assert.equal(await readOrNull(join(dir, 'config.json.bad')), null)
})

test('an unreadable config.json still rejects createStore', {skip: asRoot ? 'root can read mode 0o000' : false}, async () => {
	const dir = join(root, 'mode0')
	await mkdir(dir, {recursive: true})
	const file = join(dir, 'config.json')
	await writeFile(file, '{"ok":true}', {mode: 0o600})
	await chmod(file, 0o000)
	try {
		await assert.rejects(() => createStore(dir), (error) => error && error.code === 'EACCES')
		assert.equal(await readOrNull(`${file}.bad`), null)
	} finally {
		await chmod(file, 0o600)
	}
})

test('a plain object is still the stored value', async () => {
	const dir = join(root, 'plain')
	await mkdir(dir)
	await writeFile(join(dir, 'config.json'), '{"theme":"ink"}\n')
	await writeFile(join(dir, 'sessions.json'), '{"abc":{"name":"phone"}}\n')
	const store = await createStore(dir)
	assert.deepEqual(store.getConfig(), {theme: 'ink'})
	assert.equal(store.sessionCount(), 1)
	assert.equal(await readOrNull(join(dir, 'config.json.bad')), null)
	assert.equal(await readOrNull(join(dir, 'sessions.json.bad')), null)
})
