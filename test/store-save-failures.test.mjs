// Damaged JSON must move aside even when *.bad is taken, and a failed save must
// reject, be logged, and leave no temporary file for the next save to trip over.
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createStore} from '../server/store.mjs'

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

async function blockWithDirectory(file) {
	await rm(file, {force: true})
	await mkdir(file)
	await writeFile(join(file, 'blocker'), 'keep')
}

test('damaged config and sessions move to the next free aside, then a new config.json can be saved', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'store-aside-'))
	try {
		const configFile = join(dir, 'config.json')
		const sessionsFile = join(dir, 'sessions.json')
		const older = '{"kept":true}'
		const configOriginal = '{"token":"do-not-log-config"'
		const sessionsOriginal = '{"cookie":"do-not-log-session"'
		await writeFile(`${configFile}.bad`, older)
		await writeFile(`${configFile}.bad.1`, 'taken-config')
		await writeFile(configFile, configOriginal)
		await writeFile(`${sessionsFile}.bad`, 'taken-sessions')
		await writeFile(sessionsFile, sessionsOriginal)

		const {result: store, lines} = await captureErrors(() => createStore(dir))
		assert.deepEqual(store.getConfig(), {})
		assert.equal(store.sessionCount(), 0)
		assert.equal(await readFile(`${configFile}.bad`, 'utf8'), older)
		assert.equal(await readFile(`${configFile}.bad.1`, 'utf8'), 'taken-config')
		assert.equal(await readFile(`${configFile}.bad.2`, 'utf8'), configOriginal)
		assert.equal(await readFile(`${sessionsFile}.bad`, 'utf8'), 'taken-sessions')
		assert.equal(await readFile(`${sessionsFile}.bad.1`, 'utf8'), sessionsOriginal)
		assert.ok(lines.some((line) => line === 'config.json is empty or invalid and was moved to config.json.bad.2'))
		assert.ok(lines.some((line) => line === 'sessions.json is empty or invalid and was moved to sessions.json.bad.1'))
		assert.ok(lines.every((line) => !line.includes(dir) && !line.includes('do-not-log')))

		const next = await store.setConfig({theme: 'ink'})
		assert.equal(next.theme, 'ink')
		assert.equal(await readFile(`${configFile}.bad`, 'utf8'), older)
		assert.equal(await readFile(`${configFile}.bad.1`, 'utf8'), 'taken-config')
		assert.equal(await readFile(`${configFile}.bad.2`, 'utf8'), configOriginal)
		assert.equal(await readFile(`${sessionsFile}.bad.1`, 'utf8'), sessionsOriginal)
		assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), {theme: 'ink'})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('a failed session save is logged and rejected, leaves no temp file, and a later save still runs', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'store-sess-fail-'))
	try {
		const store = await createStore(dir)
		const secret = 'sess-SECRET-do-not-log'
		const hash = 'hash-SECRET-do-not-log'
		const totp = 'totp-SECRET-do-not-log'
		await store.putSession('device-1', {name: 'phone', accessToken: secret, hash, totp})
		await store.putSession('device-2', {name: 'tablet', accessToken: secret, hash, totp})
		const key = store.sessionEntries().find((entry) => entry.session.name === 'phone').key
		const sessionsFile = join(dir, 'sessions.json')
		await blockWithDirectory(sessionsFile)

		const {lines} = await captureErrors(async () => {
			await assert.rejects(store.putSession('device-3', {name: 'desk', accessToken: secret, hash, totp}), (err) => err?.code === 'EISDIR')
			await assert.rejects(store.updateSession('device-1', {name: 'renamed', accessToken: secret, hash, totp}), (err) => err?.code === 'EISDIR')
			await assert.rejects(store.updateSessionByKey(key, {name: 'keyed', accessToken: secret, hash, totp}), (err) => err?.code === 'EISDIR')
			await assert.rejects(store.deleteSession('device-2'), (err) => err?.code === 'EISDIR')
			await assert.rejects(store.deleteSessionByKey(key), (err) => err?.code === 'EISDIR')
			await assert.rejects(store.clearSessions(), (err) => err?.code === 'EISDIR')
		})
		const text = lines.join('\n')
		assert.match(text, /sessions\.json/)
		assert.match(text, /EISDIR/)
		assert.equal(text.includes(secret), false)
		assert.equal(text.includes(hash), false)
		assert.equal(text.includes(totp), false)
		assert.equal(text.includes(dir), false)
		assert.equal((await readdir(dir)).some((name) => name.includes('.tmp')), false)

		await rm(sessionsFile, {recursive: true, force: true})
		await store.putSession('device-4', {name: 'later'})
		const saved = JSON.parse(await readFile(sessionsFile, 'utf8'))
		assert.equal(Object.values(saved).some((session) => session.name === 'later'), true)
		assert.equal((await readdir(dir)).some((name) => name.includes('.tmp')), false)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('a failed accounts save rejects, leaves no temp file, and does not publish the owner', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'acct-save-fail-'))
	try {
		const accounts = await openAccounts(root)
		await accounts.createOwner({name: 'Ada', password: 'longenough'})
		const file = join(root, 'accounts.json')
		const saved = await readFile(file, 'utf8')
		await blockWithDirectory(file)
		await assert.rejects(accounts.updateUser('owner', {name: 'Grace'}), (err) => err?.code === 'EISDIR')
		assert.equal(accounts.getUser('owner').name, 'Ada')
		assert.equal(accounts.hasOwner(), true)
		assert.equal((await readdir(root)).includes('accounts.json.tmp'), false)
		assert.equal((await readdir(root)).some((name) => name.includes('.tmp')), false)
		assert.equal((await readdir(file)).includes('blocker'), true)

		await rm(file, {recursive: true, force: true})
		await accounts.updateUser('owner', {name: 'Grace'})
		assert.equal(accounts.getUser('owner').name, 'Grace')
		const disk = JSON.parse(await readFile(file, 'utf8'))
		assert.equal(disk.users[0].name, 'Grace')
		assert.equal(disk.users[0].hash, JSON.parse(saved).users[0].hash)
		assert.equal((await readdir(root)).some((name) => name.includes('.tmp')), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
