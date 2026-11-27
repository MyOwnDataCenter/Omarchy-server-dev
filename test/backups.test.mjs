import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {RESTIC_SHA256, createBackups, nextRun, parseSmbListing, recoveryKey} from '../omarchyd/backups.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const fakeFiles = (home) => ({
	async resolve(v) {
		if (!v.startsWith('/Home')) throw new Error('outside')
		return {real: join(home, v.slice('/Home'.length)), top: 'Home'}
	},
})

test('recovery keys are 8 groups of 4 easy characters', () => {
	const k = recoveryKey()
	assert.match(k, /^[a-hjkmnp-z2-9]{4}(?:-[a-hjkmnp-z2-9]{4}){7}$/)
	assert.notEqual(recoveryKey(), k)
})

test('the next run follows the schedule in local time', () => {
	const from = new Date(2026, 10, 19, 14, 30).getTime() // Thu 19 Nov, 14:30
	assert.equal(nextRun({frequency: 'daily', hour: 3}, from), new Date(2026, 10, 20, 3, 0).getTime())
	assert.equal(nextRun({frequency: 'daily', hour: 22}, from), new Date(2026, 10, 19, 22, 0).getTime())
	assert.equal(nextRun({frequency: 'weekly', hour: 3, weekday: 0}, from), new Date(2026, 10, 22, 3, 0).getTime())
	assert.equal(nextRun({frequency: 'weekly', hour: 15, weekday: 4}, from), new Date(2026, 10, 19, 15, 0).getTime())
	assert.equal(nextRun({frequency: 'weekly', hour: 9, weekday: 4}, from), new Date(2026, 10, 26, 9, 0).getTime())
	assert.equal(nextRun({frequency: 'off', hour: 3}, from), null)
})

test('smbclient listings become relative paths and sizes', () => {
	const text = [
		'  .                                   D        0  Thu Nov 19 14:48:56 2026',
		'  config                              A      155  Thu Nov 19 14:48:56 2026',
		'  data                                D        0  Thu Nov 19 14:48:56 2026',
		'',
		'\\My Folder\\data',
		'  00                                  D        0  Thu Nov 19 14:48:56 2026',
		'',
		'\\My Folder\\data\\00',
		'  00ab12                              A     4096  Thu Nov 19 14:48:56 2026',
		'',
		'\t\t264212084 blocks of size 1024. 22149556 blocks available',
	].join('\n')
	assert.deepEqual([...parseSmbListing(text, 'My Folder')], [
		['config', 155],
		['data/00/00ab12', 4096],
	])
})

test('NAS details that could reach smbclient’s command line are refused', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-'))
	const calls = []
	const b = createBackups({dataDir: dir, files: fakeFiles(dir), apps: {backupTargets: async () => []}, timers: false, run: async (...a) => (calls.push(a), {stdout: '', stderr: ''})})
	try {
		for (const nas of [
			{host: 'nas.local; rm -rf /', username: 'u', password: 'p'},
			{host: 'nas.local', username: 'u"\nput /etc/shadow x', password: 'p'},
			{host: 'nas.local', username: 'u', password: 'p\nmore'},
		]) {
			await assert.rejects(b.procedures['backups.shares'].run(nas), /BAD_REQUEST|valid|Enter/)
		}
		await assert.rejects(b.procedures['backups.configure'].run({nas: {host: 'nas.local', username: 'u', password: 'p', share: 'b', folder: 'a"\ndel x'}}), /folder/)
		await assert.rejects(b.procedures['backups.configure'].run({nas: {host: 'nas.local', username: 'u', password: 'p', share: 'b', folder: '../x'}}), /folder/)
		assert.equal(calls.filter((c) => c[0] === 'smbclient').length, 0)
		// The password never goes on a command line: smbclient gets an auth file instead.
		await b.procedures['backups.shares'].run({host: 'nas.local', username: 'chris', password: 's3cret'}).catch(() => {})
		const smb = calls.find((c) => c[0] === 'smbclient')
		assert.ok(smb)
		assert.ok(!smb[1].join(' ').includes('s3cret'))
		assert.ok(smb[1].includes('-A'))
		// …and the auth file is gone afterwards.
		assert.deepEqual((await readdir(join(dir, 'backups'))).filter((f) => f.startsWith('smb-auth')), [])
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a downloaded engine that doesn’t match its checksum is never used', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-'))
	const ran = []
	const b = createBackups({
		dataDir: dir,
		files: fakeFiles(dir),
		apps: {backupTargets: async () => []},
		timers: false,
		run: async (cmd, args) => {
			ran.push([cmd, ...args])
			if (args[0] === 'version') throw Object.assign(new Error('nope'), {code: 'ENOENT'})
			if (cmd === 'smbclient') return {stdout: 'putting file\n  .omarchy-server-check   A  10  Thu Nov 19 14:48:56 2026\n', stderr: ''}
			return {stdout: '', stderr: ''}
		},
		fetchImpl: async () => new Response(Buffer.from('not restic')),
	})
	try {
		await assert.rejects(b.procedures['backups.configure'].run({nas: {host: 'nas.local', username: 'u', password: 'p', share: 'backups'}}), /checksum/)
		assert.ok(!ran.some((r) => r[0] === 'bzip2'))
		assert.equal(Object.keys(RESTIC_SHA256).length, 2)
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

// End to end against a real restic and a real SMB share. Opt in: OMARCHY_BACKUP_IT=1 with
// OMARCHY_BACKUP_RESTIC=/path/to/restic and OMARCHY_BACKUP_SMB="host:port share user password".
const it = process.env.OMARCHY_BACKUP_IT === '1' ? false : 'set OMARCHY_BACKUP_IT=1 to run against restic and an SMB share'
test('back up, copy to the NAS, restore an app, and recover on a new server', {skip: it, timeout: 300_000}, async () => {
	const [hostport, share, username, password] = String(process.env.OMARCHY_BACKUP_SMB).split(' ')
	const resticPath = process.env.OMARCHY_BACKUP_RESTIC
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-it-'))
	const folder = `Omarchy IT ${Date.now()}`
	try {
		const home = join(dir, 'home')
		const dataDir = join(dir, 'data')
		const appDir = join(dataDir, 'apps', 'installed', 'notes')
		await mkdir(join(appDir, 'data'), {recursive: true})
		await writeFile(join(appDir, 'data', 'note.txt'), 'version one\n')
		await writeFile(join(dataDir, 'settings.json'), '{"name":"test"}\n')
		const events = []
		const apps = {
			backupTargets: async () => [{id: 'notes', name: 'Notes', dir: appDir, running: true}],
			pauseForBackup: async (id) => events.push(`stop ${id}`),
			resumeAfterBackup: async (id) => events.push(`start ${id}`),
		}
		const b = createBackups({dataDir, home, serverDataDir: join(dir, 'none'), files: fakeFiles(home), apps, resticPath, unshare: false, timers: false})
		const nas = {host: hostport, share, folder, username, password}
		const found = await b.procedures['backups.shares'].run({host: hostport, username, password})
		assert.ok(found.some((s) => s.name === share))
		const set = await b.procedures['backups.configure'].run({nas})
		assert.match(set.recoveryKey, /^[a-z0-9]{4}(-[a-z0-9]{4}){7}$/)
		assert.equal(set.configured, true)

		const first = await b.runBackup()
		await first.done
		let st = await b.procedures['backups.status'].run()
		assert.equal(st.history[0].ok, true, st.history[0].error)
		assert.deepEqual(events, ['stop notes', 'start notes'])
		assert.equal(st.history[0].nas.ok, true)
		assert.ok(st.history[0].nas.uploaded > 3)

		// Change the app, back up again: only the change is sent.
		await writeFile(join(appDir, 'data', 'note.txt'), 'version two\n')
		await (await b.runBackup()).done
		st = await b.procedures['backups.status'].run()
		assert.equal(st.history[0].ok, true, st.history[0].error)
		const snaps = await b.procedures['backups.snapshots'].run()
		const appSnaps = snaps.filter((s) => s.tags.includes('app:notes'))
		assert.equal(appSnaps.length, 2)
		assert.ok(snaps.some((s) => s.tags.includes('settings')))

		// Restore the older version of the app.
		await b.procedures['backups.restoreApp'].run({snapshotId: appSnaps[1].id, appId: 'notes'})
		assert.equal(await readFile(join(appDir, 'data', 'note.txt'), 'utf8'), 'version one\n')
		assert.deepEqual((await readdir(join(dataDir, 'apps', 'installed'))).sort(), ['notes'])

		// A brand-new server: pull the backup from the NAS with the recovery key.
		const home2 = join(dir, 'home2')
		const data2 = join(dir, 'data2')
		const b2 = createBackups({dataDir: data2, home: home2, serverDataDir: join(dir, 'none'), files: fakeFiles(home2), apps, resticPath, unshare: false, timers: false})
		await assert.rejects(b2.procedures['backups.connectExisting'].run({nas, recoveryKey: 'aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh'}), /doesn’t open/)
		const back = await b2.procedures['backups.connectExisting'].run({nas, recoveryKey: set.recoveryKey})
		assert.equal(back.configured, true)
		const snaps2 = await b2.procedures['backups.snapshots'].run()
		assert.equal(snaps2.length, snaps.length)
		b.close()
		b2.close()
	} finally {
		try {
			execFileSync('smbclient', [`//${hostport.split(':')[0]}/${share}`, '-U', `${username}%${password}`, ...(hostport.includes(':') ? ['-p', hostport.split(':')[1]] : []), '-c', `deltree "${folder}"`], {stdio: 'ignore'})
		} catch {
			/* best effort */
		}
		await rm(dir, {recursive: true, force: true})
	}
})

test('empty or wrong-shaped backup files do not stop startup or get rewritten', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-'))
	const dataDir = join(dir, 'data')
	const backups = join(dataDir, 'backups')
	await mkdir(backups, {recursive: true})
	const historyFile = join(backups, 'history.json')
	const secretFile = join(backups, 'secrets.json')
	const configFile = join(backups, 'config.json')
	const configText = '{"repo":"/Home/Backups/Kept","schedule":{"frequency":"weekly","hour":9,"weekday":2}}'
	await writeFile(historyFile, '')
	await writeFile(secretFile, '[]')
	await writeFile(configFile, configText)
	const errors = []
	const orig = console.error
	console.error = (...args) => errors.push(args.map(String).join(' '))
	const b = createBackups({dataDir, files: fakeFiles(dir), apps: {backupTargets: async () => []}, timers: false, run: async () => ({stdout: '', stderr: ''})})
	try {
		await b.ready
		const st = await b.procedures['backups.status'].run()
		assert.equal(st.repo, '/Home/Backups/Kept')
		assert.deepEqual(st.schedule, {frequency: 'weekly', hour: 9, weekday: 2})
		assert.deepEqual(st.include, {apps: true, settings: true, machineBackups: false})
		assert.equal(st.nas, null)
		assert.deepEqual(st.history, [])
		assert.equal(await readFile(historyFile, 'utf8'), '')
		assert.equal(await readFile(secretFile, 'utf8'), '[]')
		assert.equal(await readFile(configFile, 'utf8'), configText)
		assert.deepEqual(errors, [
			`[omarchyd] backups: damaged file ${secretFile}`,
			`[omarchyd] backups: damaged file ${historyFile}`,
		])
	} finally {
		console.error = orig
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a backup that was in progress is still marked stopped, and an array config is left untouched', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-'))
	const dataDir = join(dir, 'data')
	const backups = join(dataDir, 'backups')
	await mkdir(backups, {recursive: true})
	const historyFile = join(backups, 'history.json')
	const row = {id: 'ab12', reason: 'scheduled', startedAt: 1000, endedAt: null, ok: false, error: null, items: [], added: 0, nas: null}
	const historyText = JSON.stringify([row])
	await writeFile(historyFile, historyText)
	const opts = {dataDir, files: fakeFiles(dir), apps: {backupTargets: async () => []}, timers: false, run: async () => ({stdout: '', stderr: ''})}
	const running = createBackups(opts)
	const errors = []
	const orig = console.error
	let damaged
	try {
		const st = await running.procedures['backups.status'].run()
		assert.equal(st.history[0].id, 'ab12')
		assert.equal(st.history[0].endedAt, 1000)
		assert.equal(st.history[0].ok, false)
		assert.equal(st.history[0].error, 'Stopped when the server restarted')
		assert.equal(await readFile(historyFile, 'utf8'), historyText)

		const configFile = join(backups, 'config.json')
		const secretFile = join(backups, 'secrets.json')
		await writeFile(configFile, '["not-a-config"]')
		await writeFile(secretFile, '{"nasPassword":"super-secret-password"')
		console.error = (...args) => errors.push(args.map(String).join(' '))
		damaged = createBackups(opts)
		await damaged.ready
		const fresh = await damaged.procedures['backups.status'].run()
		assert.equal(fresh.repo, '/Home/Backups/Omarchy Server')
		assert.deepEqual(fresh.schedule, {frequency: 'daily', hour: 3, weekday: 0})
		assert.deepEqual(fresh.include, {apps: true, settings: true, machineBackups: false})
		assert.equal(fresh.nas, null)
		assert.equal(await readFile(configFile, 'utf8'), '["not-a-config"]')
		assert.equal(await readFile(secretFile, 'utf8'), '{"nasPassword":"super-secret-password"')
		assert.equal(await readFile(historyFile, 'utf8'), historyText)
		assert.ok(errors.every((line) => !line.includes('super-secret-password') && !line.includes('not-a-config')))
		assert.deepEqual(errors, [
			`[omarchyd] backups: damaged file ${configFile}`,
			`[omarchyd] backups: damaged file ${secretFile}`,
		])
	} finally {
		console.error = orig
		running.close()
		damaged?.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('setup makes the backup folder, and a setup that fails leaves nothing half-done', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'bk-'))
	const home = join(dir, 'home')
	await mkdir(home)
	// Like the real Files module: a path whose parent folder doesn't exist isn't found.
	const files = {
		async resolve(v, {mustExist = true} = {}) {
			const real = join(home, v.slice('/Home'.length))
			const {access} = await import('node:fs/promises')
			const {dirname} = await import('node:path')
			await access(mustExist ? real : dirname(real)).catch(() => {
				throw new Error('[does-not-exist]')
			})
			return {real, top: 'Home'}
		},
	}
	let initFails = true
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'smbclient') return {stdout: '  .omarchy-server-check   A  10  Thu Nov 19 14:48:56 2026\n', stderr: ''}
		if (args[0] === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
		if (args[0] === 'init') {
			if (initFails) throw new Error('restic: disk full')
			await writeFile(join(opts.env.RESTIC_REPOSITORY, 'config'), 'x')
		}
		return {stdout: '', stderr: ''}
	}
	const b = createBackups({dataDir: join(dir, 'data'), home, files, apps: {backupTargets: async () => []}, resticPath: '/bin/restic', timers: false, run})
	try {
		const nas = {host: 'nas.local', username: 'u', password: 'p', share: 'backups'}
		await assert.rejects(b.procedures['backups.configure'].run({nas}), /disk full/)
		let st = await b.procedures['backups.status'].run()
		assert.equal(st.configured, false)
		assert.equal(st.nas, null)
		await assert.rejects(stat(join(dir, 'data', 'backups', 'recovery-key')))
		initFails = false
		const ok = await b.procedures['backups.configure'].run({nas})
		assert.equal(ok.configured, true)
		assert.ok(ok.recoveryKey)
		assert.ok((await stat(join(home, 'Backups', 'Omarchy Server', 'server', 'config'))).isFile())
		// A second setup change keeps the same key (none is shown again).
		const again = await b.procedures['backups.configure'].run({schedule: {frequency: 'weekly', hour: 2, weekday: 6}})
		assert.equal(again.recoveryKey, undefined)
		assert.deepEqual(again.schedule, {frequency: 'weekly', hour: 2, weekday: 6})
	} finally {
		b.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('connectExisting distinguishes missing internet and restic errors from a wrong recovery key', async () => {
	const smbListing = ['\\Omarchy Server\\server', '  config                              A      155  Thu Nov 19 14:48:56 2026', ''].join('\n')
	const nas = {host: 'nas.local', username: 'u', password: 'p', share: 'backups'}
	const recoveryKeyInput = 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567'

	// 1. Offline while downloading restic: must report internet/restic error, never blame the recovery key.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'bk-conn-offline-'))
		const b = createBackups({
			dataDir: dir,
			files: fakeFiles(dir),
			apps: {backupTargets: async () => []},
			timers: false,
			run: async (cmd, args) => {
				if (args[0] === 'version') throw Object.assign(new Error('nope'), {code: 'ENOENT'})
				if (cmd === 'smbclient') return {stdout: smbListing, stderr: ''}
				return {stdout: '', stderr: ''}
			},
			fetchImpl: async () => {
				throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}})
			},
		})
		try {
			await assert.rejects(
				() => b.procedures['backups.connectExisting'].run({nas, recoveryKey: recoveryKeyInput}),
				(err) => {
					assert.ok(err instanceof RpcError)
					assert.equal(err.code, 'PRECONDITION_FAILED')
					assert.match(err.message, /restic/)
					assert.match(err.message, /internet/)
					assert.equal(err.message.includes('recovery key'), false)
					return true
				},
			)
		} finally {
			b.close()
			await rm(dir, {recursive: true, force: true})
		}
	}

	// 2. Wrong password reported by restic: blames recovery key with FORBIDDEN and cleans up keyFile.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'bk-conn-badkey-'))
		const b = createBackups({
			dataDir: dir,
			files: fakeFiles(dir),
			apps: {backupTargets: async () => []},
			resticPath: '/bin/restic',
			timers: false,
			run: async (cmd, args) => {
				if (cmd === 'smbclient') return {stdout: smbListing, stderr: ''}
				if (args[0] === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
				if (args[0] === 'cat') {
					throw Object.assign(new Error('/bin/restic: Fatal: wrong password or no key found'), {
						stderr: 'Fatal: wrong password or no key found\n',
					})
				}
				return {stdout: '', stderr: ''}
			},
		})
		try {
			await assert.rejects(
				() => b.procedures['backups.connectExisting'].run({nas, recoveryKey: recoveryKeyInput}),
				(err) => err instanceof RpcError && err.code === 'FORBIDDEN' && /recovery key doesn’t open/.test(err.message),
			)
			await assert.rejects(stat(join(dir, 'backups', 'recovery-key')))
		} finally {
			b.close()
			await rm(dir, {recursive: true, force: true})
		}
	}

	// 3. Non-password restic failure: reports restic error, not wrong recovery key.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'bk-conn-damaged-'))
		const b = createBackups({
			dataDir: dir,
			files: fakeFiles(dir),
			apps: {backupTargets: async () => []},
			resticPath: '/bin/restic',
			timers: false,
			run: async (cmd, args) => {
				if (cmd === 'smbclient') return {stdout: smbListing, stderr: ''}
				if (args[0] === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
				if (args[0] === 'cat') {
					throw Object.assign(new Error('/bin/restic: Fatal: unable to open config file: damaged'), {
						stderr: 'Fatal: unable to open config file: damaged\n',
					})
				}
				return {stdout: '', stderr: ''}
			},
		})
		try {
			await assert.rejects(
				() => b.procedures['backups.connectExisting'].run({nas, recoveryKey: recoveryKeyInput}),
				(err) => {
					assert.ok(err instanceof RpcError)
					assert.equal(err.code, 'PRECONDITION_FAILED')
					assert.match(err.message, /Couldn’t open the backup/)
					assert.match(err.message, /damaged/)
					assert.equal(err.message.includes('recovery key'), false)
					return true
				},
			)
			await assert.rejects(stat(join(dir, 'backups', 'recovery-key')))
		} finally {
			b.close()
			await rm(dir, {recursive: true, force: true})
		}
	}
})
