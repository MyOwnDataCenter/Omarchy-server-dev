// Save failures must not stick in memory, a blank owner name is refused, and an
// owner written by another process is visible while this one still has none.
import assert from 'node:assert/strict'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts, secretFromUri, totpCode} from '../omarchyd/accounts.mjs'

const totpUri = 'otpauth://totp/Omarchy%20Server:Ada?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Omarchy%20Server'

async function tempDir() {
	return mkdtemp(join(os.tmpdir(), 'acct-auth-'))
}

test('createOwner rejects a name made only of spaces and stores a trimmed name', async () => {
	const root = await tempDir()
	const namedRoot = await tempDir()
	try {
		const blank = await openAccounts(root)
		await assert.rejects(
			blank.createOwner({name: '   ', password: 'longenough'}),
			/Use 1-40 letters, numbers, spaces, dots, dashes or underscores for the name/,
		)
		assert.equal(blank.hasOwner(), false)
		assert.deepEqual(blank.listAccounts(), [])
		await assert.rejects(readFile(join(root, 'accounts.json')), (err) => err.code === 'ENOENT')

		const named = await openAccounts(namedRoot)
		await named.createOwner({name: '  Ada Lovelace  ', password: 'longenough'})
		assert.deepEqual(
			named.listAccounts().map((u) => u.name),
			['Ada Lovelace'],
		)
	} finally {
		await rm(root, {recursive: true, force: true})
		await rm(namedRoot, {recursive: true, force: true})
	}
})

// A full disk refuses the temp write. Permissions are put back before the password checks,
// so a correct password can still record its session.
async function lockWrites(dir) {
	await chmod(dir, 0o500)
}
async function unlockWrites(dir) {
	await chmod(dir, 0o700)
}

test('a failed password save keeps the old password, devices, and access tokens', async () => {
	const root = await tempDir()
	try {
		const a = await openAccounts(root)
		await a.createOwner({name: 'Ada', password: 'old-password'})
		const session = await a.loginNative({userId: 'owner', password: 'old-password', client: {id: 'phone'}})
		await lockWrites(root)
		try {
			await assert.rejects(a.setPassword('owner', {oldPassword: 'old-password', newPassword: 'new-password'}), (err) => {
				assert.equal(err.code, 'EACCES')
				return true
			})
		} finally {
			await unlockWrites(root)
		}
		const headers = {authorization: `Bearer ${session.accessToken}`}
		assert.equal(a.authenticate({headers}).userId, 'owner')
		const refreshed = await a.refresh(session.deviceToken)
		assert.equal(typeof refreshed.accessToken, 'string')
		const again = await a.loginNative({userId: 'owner', password: 'old-password', client: {id: 'phone'}})
		assert.equal(again.accountId, 'owner')
		await assert.rejects(a.loginNative({userId: 'owner', password: 'new-password', client: {id: 'phone'}}), /Incorrect password/)
		const restarted = await openAccounts(root)
		assert.equal((await restarted.loginNative({userId: 'owner', password: 'old-password', client: {id: 'desk'}})).accountId, 'owner')
		await assert.rejects(restarted.loginNative({userId: 'owner', password: 'new-password', client: {id: 'desk'}}), /Incorrect password/)
	} finally {
		await unlockWrites(root)
		await rm(root, {recursive: true, force: true})
	}
})

test('a failed createOwner save does not leave the new owner in memory', async () => {
	const root = await tempDir()
	try {
		const a = await openAccounts(root)
		await lockWrites(root)
		try {
			await assert.rejects(a.createOwner({name: 'Ada', password: 'longenough'}), (err) => err.code === 'EACCES')
		} finally {
			await unlockWrites(root)
		}
		assert.equal(a.hasOwner(), false)
		assert.deepEqual(a.listAccounts(), [])
		await assert.rejects(a.loginNative({userId: 'owner', password: 'longenough', client: {id: 'phone'}}), /Incorrect password/)
		await assert.rejects(readFile(join(root, 'accounts.json')), (err) => err.code === 'ENOENT')
	} finally {
		await unlockWrites(root)
		await rm(root, {recursive: true, force: true})
	}
})

test('a failed 2FA or profile save keeps the previous account', async () => {
	const root = await tempDir()
	try {
		const a = await openAccounts(root)
		await a.createOwner({name: 'Ada', password: 'longenough'})
		const secret = secretFromUri(totpUri)
		await lockWrites(root)
		try {
			await assert.rejects(a.enable2fa('owner', {totpUri, totpToken: totpCode(secret)}), (err) => err.code === 'EACCES')
		} finally {
			await unlockWrites(root)
		}
		assert.equal(a.is2faEnabled('owner'), false)
		assert.equal((await a.loginNative({userId: 'owner', password: 'longenough', client: {id: 'phone'}})).accountId, 'owner')

		await a.enable2fa('owner', {totpUri, totpToken: totpCode(secret)})
		await lockWrites(root)
		try {
			await assert.rejects(a.disable2fa('owner', {totpToken: totpCode(secret)}), (err) => err.code === 'EACCES')
			await assert.rejects(a.updateUser('owner', {name: 'Bea', language: 'fr'}), (err) => err.code === 'EACCES')
		} finally {
			await unlockWrites(root)
		}
		assert.equal(a.is2faEnabled('owner'), true)
		assert.equal(a.listAccounts()[0].name, 'Ada')
		assert.equal(a.listAccounts()[0].language, 'en')
		await assert.rejects(a.loginNative({userId: 'owner', password: 'longenough', client: {id: 'phone'}}), /6-digit/)
	} finally {
		await unlockWrites(root)
		await rm(root, {recursive: true, force: true})
	}
})

test('a failed reset save keeps the owner and the signed-in session', async () => {
	const root = await tempDir()
	try {
		const a = await openAccounts(root)
		await a.createOwner({name: 'Ada', password: 'longenough'})
		const session = await a.loginNative({userId: 'owner', password: 'longenough', client: {id: 'phone'}})
		await lockWrites(root)
		try {
			await assert.rejects(a.reset(), (err) => err.code === 'EACCES')
		} finally {
			await unlockWrites(root)
		}
		assert.equal(a.hasOwner(), true)
		assert.equal(a.listAccounts()[0].name, 'Ada')
		assert.equal(a.authenticate({headers: {authorization: `Bearer ${session.accessToken}`}}).userId, 'owner')
		assert.equal((await a.refresh(session.deviceToken)).accessToken.length > 0, true)
		assert.equal((await a.loginNative({userId: 'owner', password: 'longenough', client: {id: 'desk'}})).accountId, 'owner')
	} finally {
		await unlockWrites(root)
		await rm(root, {recursive: true, force: true})
	}
})

test('an owner written by another process is accepted without restarting', async () => {
	const root = await tempDir()
	try {
		const live = await openAccounts(root)
		assert.equal(live.hasOwner(), false)
		assert.deepEqual(live.listAccounts(), [])
		const other = await openAccounts(root)
		await other.createOwner({name: 'bob', password: 'longenough'})
		assert.equal(live.hasOwner(), true)
		assert.deepEqual(live.listAccounts().map((u) => u.name), ['bob'])
		const session = await live.loginNative({userId: 'owner', password: 'longenough', client: {id: 'phone'}})
		assert.equal(session.accountId, 'owner')

		// A later edit on disk must not replace the owner already in this process.
		const disk = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8'))
		disk.users[0].name = 'other'
		disk.users[0].hash = Buffer.from('not-the-real-hash').toString('base64')
		disk.devices = {}
		await writeFile(join(root, 'accounts.json'), JSON.stringify(disk))
		assert.equal(live.hasOwner(), true)
		assert.deepEqual(live.listAccounts().map((u) => u.name), ['bob'])
		assert.equal(live.authenticate({headers: {authorization: `Bearer ${session.accessToken}`}}).userId, 'owner')
		assert.equal((await live.refresh(session.deviceToken)).accessToken.length > 0, true)
		assert.equal((await live.loginNative({userId: 'owner', password: 'longenough', client: {id: 'desk'}})).accountId, 'owner')

		await live.reset()
		assert.equal(live.hasOwner(), false)
		const again = await openAccounts(root)
		await again.createOwner({name: 'cara', password: 'anotherlong'})
		assert.equal(live.hasOwner(), true)
		assert.deepEqual(live.listAccounts().map((u) => u.name), ['cara'])
		assert.equal((await live.loginNative({userId: 'owner', password: 'anotherlong', client: {id: 'phone'}})).accountId, 'owner')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a damaged accounts file is still an error while there is no owner, and it is not overwritten', async () => {
	const root = await tempDir()
	try {
		const live = await openAccounts(root)
		assert.equal(live.hasOwner(), false)
		const file = join(root, 'accounts.json')
		await writeFile(file, '{bad')
		assert.throws(() => live.hasOwner(), /accounts\.json is damaged or unreadable/)
		assert.equal(await readFile(file, 'utf8'), '{bad')
		assert.throws(() => live.listAccounts(), /accounts\.json is damaged or unreadable/)
		await assert.rejects(live.createOwner({name: 'Ada', password: 'longenough'}), /accounts\.json is damaged or unreadable/)
		await assert.rejects(live.loginNative({userId: 'owner', password: 'longenough', client: {id: 'phone'}}), /accounts\.json is damaged or unreadable/)
		assert.throws(() => live.getUser('owner'), /accounts\.json is damaged or unreadable/)
		assert.equal(await readFile(file, 'utf8'), '{bad')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a running omarchyd accepts an owner created in another process', async () => {
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await tempDir()
	const data = join(root, 'data')
	const d = await startOmarchyd({port: 0, dataDir: data, home: root})
	const get = (path) => fetch(`${d.url}/trpc/${path}`)
	const post = (path, body) => fetch(`${d.url}/trpc/${path}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
	try {
		assert.equal((await (await get('system.discoveryInfo')).json()).result.data.onboarded, false)
		assert.deepEqual((await (await get('user.listAccounts')).json()).result.data, [])
		const other = await openAccounts(data)
		await other.createOwner({name: 'bob', password: 'longenough'})
		assert.equal((await (await get('system.discoveryInfo')).json()).result.data.onboarded, true)
		assert.equal((await (await get('user.listAccounts')).json()).result.data[0].name, 'bob')
		const ok = await post('user.loginNative', {userId: 'owner', password: 'longenough', client: {id: 'phone'}})
		assert.equal(ok.status, 200)
		assert.equal((await ok.json()).result.data.accountId, 'owner')
		assert.equal((await post('user.loginNative', {userId: 'owner', password: 'not-the-password', client: {id: 'phone'}})).status, 401)
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('a running omarchyd keeps the old password when the account file cannot be saved', async () => {
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await tempDir()
	const data = join(root, 'data')
	const setup = await openAccounts(data)
	await setup.createOwner({name: 'Ada', password: 'old-password'})
	const d = await startOmarchyd({port: 0, dataDir: data, home: root})
	const post = (path, body, headers = {}) => fetch(`${d.url}/trpc/${path}`, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)})
	try {
		const first = await post('user.loginNative', {userId: 'owner', password: 'old-password', client: {id: 'phone'}})
		assert.equal(first.status, 200)
		const session = (await first.json()).result.data
		await lockWrites(data)
		try {
			const changed = await post('user.changePassword', {oldPassword: 'old-password', newPassword: 'new-password'}, {authorization: `Bearer ${session.accessToken}`})
			assert.equal(changed.status, 500)
			assert.equal((await changed.json()).error.message, 'Internal error')
		} finally {
			await unlockWrites(data)
		}
		assert.equal((await post('user.refreshNativeAccess', {deviceToken: session.deviceToken})).status, 200)
		assert.equal((await post('user.loginNative', {userId: 'owner', password: 'old-password', client: {id: 'desk'}})).status, 200)
		assert.equal((await post('user.loginNative', {userId: 'owner', password: 'new-password', client: {id: 'desk'}})).status, 401)
	} finally {
		await unlockWrites(data)
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
