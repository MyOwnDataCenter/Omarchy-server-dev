// A damaged accounts file must not look like a server that has no owner yet.
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts, secretFromUri, totpCode} from '../omarchyd/accounts.mjs'

const totpUri = 'otpauth://totp/Omarchy%20Server:Chris?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Omarchy%20Server'

async function tempDir() {
	return mkdtemp(join(os.tmpdir(), 'acct-'))
}

test('a missing accounts file still means there is no owner', async () => {
	const root = await tempDir()
	try {
		const a = await openAccounts(root)
		assert.equal(a.hasOwner(), false)
		await a.createOwner({name: 'Chris', password: 'correct horse'})
		assert.equal(a.hasOwner(), true)
		const again = await openAccounts(root)
		assert.equal(again.hasOwner(), true)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('damaged accounts.json is refused and the bytes stay as they were', async () => {
	const root = await tempDir()
	try {
		const file = join(root, 'accounts.json')
		const a = await openAccounts(root)
		await a.createOwner({name: 'Chris', password: 'correct horse'})
		const secret = secretFromUri(totpUri)
		await a.enable2fa('owner', {totpUri, totpToken: totpCode(secret)})
		const saved = await readFile(file)
		assert.ok(saved.length > 40, 'a real saved file is long enough to cut')
		assert.ok(saved.includes(secret.toString('base64')), 'the saved file includes a totp secret')
		const cases = [
			['empty', ''],
			['truncated', saved.subarray(0, 40)],
			['null', 'null'],
			['array', '[1]'],
			['string', '"x"'],
			['users null', '{"users":null}'],
			['users object', '{"users":{}}'],
			['devices null', '{"users":[],"devices":null}'],
			['devices array', '{"users":[],"devices":[]}'],
			['browsers null', '{"users":[],"browsers":null}'],
			['browsers array', '{"users":[],"browsers":[]}'],
		]
		for (const [name, contents] of cases) {
			await writeFile(file, contents)
			const before = await readFile(file)
			await assert.rejects(
				openAccounts(root),
				(err) => {
					assert.match(err.message, /accounts\.json/, name)
					assert.equal(err.message.includes(root), false, `${name}: no absolute path`)
					assert.equal(err.message.includes(file), false, `${name}: no absolute path`)
					const text = before.toString('utf8')
					if (text.length > 0) assert.equal(err.message.includes(text), false, `${name}: no file contents`)
					assert.equal(err.message.includes(secret.toString('base64')), false, `${name}: no totp secret`)
					return true
				},
				name,
			)
			assert.deepEqual(await readFile(file), before, name)
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a directory named accounts.json is not an empty server', async () => {
	const root = await tempDir()
	try {
		const file = join(root, 'accounts.json')
		await mkdir(file)
		await assert.rejects(openAccounts(root), (err) => {
			assert.match(err.message, /accounts\.json/)
			assert.equal(err.message.includes(root), false)
			assert.equal(err.message.includes(file), false)
			return true
		})
		assert.equal((await stat(file)).isDirectory(), true)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a valid owner file loads, and createOwner does not rewrite it', async () => {
	const root = await tempDir()
	try {
		const file = join(root, 'accounts.json')
		const a = await openAccounts(root)
		await a.createOwner({name: 'Chris', password: 'correct horse'})
		const saved = await readFile(file)
		const state = JSON.parse(saved.toString('utf8'))
		delete state.devices
		delete state.browsers
		const trimmed = Buffer.from(JSON.stringify(state))
		await writeFile(file, trimmed)
		const again = await openAccounts(root)
		assert.equal(again.hasOwner(), true)
		await assert.rejects(() => again.createOwner({name: 'Pat', password: 'another one'}), /An owner account already exists/)
		assert.deepEqual(await readFile(file), trimmed)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
