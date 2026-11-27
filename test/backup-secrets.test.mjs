import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {test} from 'node:test'

import {createBackups} from '../omarchyd/backups.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const exists = (p) => readFile(p).then(() => true, () => false)

const smbOk = 'putting file\n  .omarchy-server-check   A  10  Thu Nov 19 14:48:56 2026\n'

// Like the real Files module: a path whose parent folder doesn't exist isn't found.
const homeFiles = (home) => ({
	async resolve(v, {mustExist = true} = {}) {
		if (!v.startsWith('/Home')) throw new Error('outside')
		const real = join(home, v.slice('/Home'.length))
		const {access} = await import('node:fs/promises')
		await access(mustExist ? real : dirname(real)).catch(() => {
			throw new Error('[does-not-exist]')
		})
		return {real, top: 'Home'}
	},
})

const nasRun = ({onSmb} = {}) => async (cmd, args, opts = {}) => {
	if (cmd === 'smbclient') {
		if (onSmb) return onSmb()
		return {stdout: smbOk, stderr: ''}
	}
	if (args?.[0] === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
	if (args?.[0] === 'init') {
		await mkdir(opts.env.RESTIC_REPOSITORY, {recursive: true})
		await writeFile(join(opts.env.RESTIC_REPOSITORY, 'config'), 'x')
	}
	return {stdout: '', stderr: ''}
}

const nas = {host: 'nas.local', username: 'u', password: 'kept-secret', share: 'backups'}

async function setupDir() {
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-sec-'))
	const home = join(dir, 'home')
	const dataDir = join(dir, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	return {dir, home, dataDir, backups: join(dataDir, 'backups')}
}

test('#813 startup removes leftover smb-auth password files and keeps config.json', async () => {
	const {dir, dataDir, backups} = await setupDir()
	const auth = join(backups, 'smb-auth-abc')
	const configFile = join(backups, 'config.json')
	const configText = '{"repo":"/Home/Backups/Kept"}\n'
	await writeFile(auth, 'password=leftover-nas-secret\n')
	await writeFile(configFile, configText)
	const b = createBackups({dataDir, files: homeFiles(dir), apps: {backupTargets: async () => []}, timers: false, run: nasRun()})
	try {
		await b.ready
		assert.equal(await exists(auth), false, 'leftover smb-auth file is still there')
		assert.equal(await readFile(configFile, 'utf8'), configText)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#774 damaged config.json is not overwritten and save is refused', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const configFile = join(backups, 'config.json')
	await writeFile(configFile, '{')
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run: nasRun()})
	try {
		await b.ready
		assert.equal(await readFile(configFile, 'utf8'), '{')
		let err
		try {
			await b.procedures['backups.keySaved'].run()
		} catch (e) {
			err = e
		}
		assert.equal(await readFile(configFile, 'utf8'), '{', 'damaged config.json was overwritten')
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'PRECONDITION_FAILED')
		assert.match(err.message, /config\.json/)
		const st = await b.procedures['backups.status'].run()
		assert.ok(st.damaged?.includes('config.json'), JSON.stringify(st.damaged))
		let setupErr
		try {
			await b.procedures['backups.configure'].run({nas})
		} catch (e) {
			setupErr = e
		}
		assert.equal(await readFile(configFile, 'utf8'), '{', 'setup save overwrote damaged config.json')
		assert.equal(await exists(join(backups, 'recovery-key')), false, 'a recovery key was written over a damaged config')
		assert.ok(setupErr instanceof RpcError)
		assert.equal(setupErr.code, 'PRECONDITION_FAILED')
		assert.match(setupErr.message, /config\.json/)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#774 damaged secrets.json is not overwritten and save is refused', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const secretFile = join(backups, 'secrets.json')
	await writeFile(secretFile, '{')
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run: nasRun()})
	try {
		await b.ready
		assert.equal(await readFile(secretFile, 'utf8'), '{')
		let err
		try {
			await b.procedures['backups.configure'].run({nas: {...nas, password: 'new-secret'}})
		} catch (e) {
			err = e
		}
		assert.equal(await readFile(secretFile, 'utf8'), '{', 'damaged secrets.json was overwritten')
		assert.equal(await exists(join(backups, 'recovery-key')), false, 'a recovery key was written over damaged secrets')
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'PRECONDITION_FAILED')
		assert.match(err.message, /secrets\.json/)
		const st = await b.procedures['backups.status'].run()
		assert.ok(st.damaged?.includes('secrets.json'), JSON.stringify(st.damaged))
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#774 damaged history.json is not overwritten and save is refused', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const historyFile = join(backups, 'history.json')
	await writeFile(join(backups, 'config.json'), JSON.stringify({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'}}))
	await writeFile(join(backups, 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(join(backups, 'recovery-key'), 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567\n')
	await writeFile(historyFile, '{')
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run: nasRun()})
	try {
		await b.ready
		assert.equal(await readFile(historyFile, 'utf8'), '{')
		let err
		try {
			await b.procedures['backups.runNow'].run()
		} catch (e) {
			err = e
		}
		assert.equal(await readFile(historyFile, 'utf8'), '{', 'damaged history.json was overwritten')
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'PRECONDITION_FAILED')
		assert.match(err.message, /history\.json/)
		const st = await b.procedures['backups.status'].run()
		assert.ok(st.damaged?.includes('history.json'), JSON.stringify(st.damaged))
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#774 a missing backup file still allows a first setup', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run: nasRun()})
	try {
		await b.ready
		const ok = await b.procedures['backups.configure'].run({nas})
		assert.equal(ok.configured, true)
		assert.match(await readFile(join(backups, 'secrets.json'), 'utf8'), /kept-secret/)
		assert.match(await readFile(join(backups, 'config.json'), 'utf8'), /nas\.local/)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#741 a setup that finishes after factory reset does not write the NAS password back', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	let release
	const gate = new Promise((r) => {
		release = r
	})
	let opened
	const openedP = new Promise((r) => {
		opened = r
	})
	let smbCalls = 0
	const b = createBackups({
		dataDir,
		home,
		files: homeFiles(home),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		timers: false,
		run: nasRun({
			onSmb: () => {
				smbCalls++
				if (smbCalls === 1) {
					opened()
					return gate.then(() => ({stdout: smbOk, stderr: ''}))
				}
				return {stdout: smbOk, stderr: ''}
			},
		}),
	})
	try {
		await b.ready
		const pending = b.procedures['backups.configure'].run({nas: {...nas, password: 'abandoned-secret'}})
		await openedP
		await b.clearSettings()
		release()
		await pending.then(() => {}, () => {})
		const text = await readFile(join(backups, 'secrets.json'), 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)))
		assert.equal(text.includes('abandoned-secret'), false, text)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#741 a setup that is not interrupted still saves the NAS password', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run: nasRun()})
	try {
		const ok = await b.procedures['backups.configure'].run({nas})
		assert.equal(ok.configured, true)
		assert.match(await readFile(join(backups, 'secrets.json'), 'utf8'), /kept-secret/)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#803 configure refuses a new recovery key when the store exists and the key is gone', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const storeConfig = join(home, 'Backups', 'Omarchy Server', 'server', 'config')
	await mkdir(dirname(storeConfig), {recursive: true})
	await writeFile(storeConfig, 'existing-store\n')
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run: nasRun()})
	try {
		await b.ready
		let err
		try {
			await b.procedures['backups.configure'].run({nas})
		} catch (e) {
			err = e
		}
		assert.equal(await exists(join(backups, 'recovery-key')), false, 'a new recovery key was written')
		assert.equal(await readFile(storeConfig, 'utf8'), 'existing-store\n')
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'PRECONDITION_FAILED')
		assert.match(err.message, /\/Home\/Backups\/Omarchy Server/)
		assert.match(err.message, /existing backup/i)
		assert.match(err.message, /old key/i)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('#803 clearSettings removes history and keeps the backup store', async () => {
	const {dir, home, dataDir, backups} = await setupDir()
	const historyFile = join(backups, 'history.json')
	const storeConfig = join(home, 'Backups', 'Omarchy Server', 'server', 'config')
	await writeFile(historyFile, '[{"id":"keep-history"}]')
	await mkdir(dirname(storeConfig), {recursive: true})
	await writeFile(storeConfig, 'keep-store\n')
	const b = createBackups({dataDir, home, files: homeFiles(home), apps: {backupTargets: async () => []}, timers: false, run: nasRun()})
	try {
		await b.ready
		assert.equal((await b.procedures['backups.status'].run()).history[0].id, 'keep-history')
		await b.clearSettings()
		assert.equal(await exists(historyFile), false, 'history.json is still there')
		assert.equal(await readFile(storeConfig, 'utf8'), 'keep-store\n')
		assert.equal((await b.procedures['backups.status'].run()).history.length, 0)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})
