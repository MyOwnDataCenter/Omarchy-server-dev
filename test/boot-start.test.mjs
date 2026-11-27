// A server with no screen must come back by itself after a restart or a power cut.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
const unit = (name) => {
	const m = new RegExp(`cat >"\\$UNITS/${name}" <<EOF\\n([\\s\\S]*?)\\nEOF`).exec(script)
	assert.ok(m, `${name} unit`)
	return m[1]
}

test('both services start at boot and never stop retrying', () => {
	for (const name of ['omarchyd.service', 'omarchy-server-web.service']) {
		const u = unit(name)
		assert.match(u, /^WantedBy=default\.target$/m, name)
		assert.match(u, /^Restart=on-failure$/m, name)
		assert.match(u, /^StartLimitIntervalSec=0$/m, `${name} must not give up after a few fast failures at boot`)
	}
	assert.match(script, /systemctl --user enable omarchyd\.service omarchy-server-web\.service/)
})

test('linger is turned on without sudo when allowed, never waits on a password in an in-app update, and says so when it fails', () => {
	const block = script.slice(script.indexOf('# Start at boot and keep running'), script.indexOf('# Everything above succeeded'))
	assert.match(block, /loginctl enable-linger "\$USER" 2>\/dev\/null \|\|/)
	assert.match(block, /sudo -n loginctl enable-linger/)
	assert.match(block, /stays off until you sign in/)
})

test('an encrypted system disk is reported, so Settings and Restart can say it waits for the disk password', async () => {
	const {mkdtemp, rm} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const {openAccounts} = await import('../omarchyd/accounts.mjs')
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-lock-'))
	const accounts = await openAccounts(join(root, 'd'))
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const d = await startOmarchyd({port: 0, dataDir: join(root, 'd'), home: root, machineOptions: {diskLock: {encrypted: true, unlocksItself: false}}})
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 's'}})})).json()
		const res = await (await fetch(`${d.url}/trpc/system.bootStart`, {headers: {authorization: `Bearer ${login.result.data.accessToken}`}})).json()
		assert.deepEqual(res.result.data.diskLock, {encrypted: true, unlocksItself: false})
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
