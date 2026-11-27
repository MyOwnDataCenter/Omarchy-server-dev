import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {dirname, join, relative, sep} from 'node:path'
import {test} from 'node:test'
import {promisify} from 'node:util'

import {createBackups, defaultSpawn, nextRun} from '../omarchyd/backups.mjs'

const execFileAsync = promisify(execFile)

const fakeFiles = (home) => ({
	async resolve(v, {mustExist = true} = {}) {
		if (!v.startsWith('/Home')) throw new Error('outside')
		const real = join(home, v.slice('/Home'.length))
		if (mustExist) await stat(real)
		return {real, top: 'Home'}
	},
})

function unquote(s) {
	return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

function splitSmbLine(line) {
	const tokens = []
	const re = /"[^"]*"|\S+/g
	for (const m of line.matchAll(re)) tokens.push(unquote(m[0]))
	return tokens
}

async function listSmbDir(baseDir, smbPrefix, recurse) {
	const lines = []
	const entries = (await readdir(baseDir, {withFileTypes: true}).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
	lines.push('  .                                   D        0  Thu Nov 19 14:48:56 2026')
	lines.push('  ..                                  D        0  Thu Nov 19 14:48:56 2026')
	const dirs = []
	for (const e of entries) {
		if (e.isDirectory()) {
			dirs.push(e.name)
			lines.push(`  ${e.name.padEnd(36)} D        0  Thu Nov 19 14:48:56 2026`)
		} else if (e.isFile()) {
			const st = await stat(join(baseDir, e.name))
			lines.push(`  ${e.name.padEnd(36)} A ${String(st.size).padStart(8)}  Thu Nov 19 14:48:56 2026`)
		}
	}
	if (recurse) {
		for (const d of dirs) {
			const subPrefix = smbPrefix ? `${smbPrefix}\\${d}` : d
			lines.push('')
			lines.push(`\\${subPrefix}`)
			lines.push(...(await listSmbDir(join(baseDir, d), subPrefix, true)))
		}
	}
	return lines
}

function makeFakeNas(nasRoot, {shareName = 'backups', onCommand} = {}) {
	return async (args, opts = {}) => {
		if (args[0] === '-L') {
			return {stdout: `Disk|${shareName}|Backups\n`, stderr: ''}
		}
		const shareRoot = join(nasRoot, shareName)
		await mkdir(shareRoot, {recursive: true})
		let cwd = shareRoot
		let lcd = process.cwd()
		let recurse = false
		let stdout = ''
		let stderr = ''
		const lines = String(opts.input ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
		for (const raw of lines) {
			if (onCommand) await onCommand(raw, {shareRoot, cwd})
			const [cmd, ...rest] = splitSmbLine(raw)
			if (cmd === 'recurse') recurse = rest[0]?.toUpperCase() === 'ON'
			else if (cmd === 'prompt') continue
			else if (cmd === 'lcd') lcd = rest[0]
			else if (cmd === 'mkdir') {
				const target = join(cwd, ...rest[0].split(/[\\/]/).filter(Boolean))
				await mkdir(target, {recursive: true})
			} else if (cmd === 'cd') {
				const target = join(cwd, ...rest[0].split(/[\\/]/).filter(Boolean))
				const st = await stat(target).catch(() => null)
				if (!st?.isDirectory()) {
					stderr += 'NT_STATUS_OBJECT_NAME_NOT_FOUND\n'
					break
				}
				cwd = target
			} else if (cmd === 'put') {
				const [localPath, remotePath] = rest
				const buf = await readFile(localPath).catch(() => null)
				if (!buf) {
					stderr += 'NT_STATUS_NO_SUCH_FILE\n'
					continue
				}
				const dest = join(cwd, ...remotePath.split(/[\\/]/).filter(Boolean))
				await mkdir(dirname(dest), {recursive: true})
				await writeFile(dest, buf)
				stdout += `putting file ${localPath} as ${remotePath}\n`
			} else if (cmd === 'get') {
				const [remotePath, localPath] = rest
				const src = join(cwd, ...remotePath.split(/[\\/]/).filter(Boolean))
				const buf = await readFile(src).catch(() => null)
				if (!buf) {
					stderr += 'NT_STATUS_OBJECT_NAME_NOT_FOUND\n'
				} else {
					await mkdir(dirname(localPath), {recursive: true})
					await writeFile(localPath, buf)
				}
			} else if (cmd === 'del') {
				const target = join(cwd, ...rest[0].split(/[\\/]/).filter(Boolean))
				const st = await stat(target).catch(() => null)
				if (!st?.isFile()) stderr += 'NT_STATUS_NO_SUCH_FILE\n'
				else await rm(target)
			} else if (cmd === 'ls') {
				const rel = relative(shareRoot, cwd).split(sep).filter(Boolean).join('\\')
				stdout += (await listSmbDir(cwd, rel, recurse)).join('\n') + '\n'
			} else if (cmd === 'mget') {
				for (const name of await readdir(cwd).catch(() => [])) {
					await cp(join(cwd, name), join(lcd, name), {recursive: true})
				}
			}
		}
		return {stdout, stderr}
	}
}

function makeFakeRestic({onCall, onBackup} = {}) {
	const calls = []
	const runner = async (args, opts = {}) => {
		const sub = args[0]
		calls.push({args: [...args], repo: opts.env?.RESTIC_REPOSITORY, passwordFile: opts.env?.RESTIC_PASSWORD_FILE})
		if (onCall) {
			const res = await onCall(args, opts)
			if (res) return res
		}
		if (sub === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
		const repo = opts.env?.RESTIC_REPOSITORY
		if (sub === 'init') {
			await mkdir(join(repo, 'keys'), {recursive: true})
			await mkdir(join(repo, 'data', 'aa'), {recursive: true})
			await mkdir(join(repo, 'index'), {recursive: true})
			await mkdir(join(repo, 'snapshots'), {recursive: true})
			// Fixed 64-byte config with unique random content to catch size-only comparisons.
			await writeFile(join(repo, 'config'), randomBytes(32).toString('hex'))
			await writeFile(join(repo, 'keys', randomBytes(8).toString('hex')), 'key-data')
			return {stdout: '', stderr: ''}
		}
		if (sub === 'cat' && args[1] === 'config') {
			const buf = await readFile(join(repo, 'config')).catch(() => null)
			if (!buf) throw Object.assign(new Error('restic: config missing'), {code: 1, stdout: '', stderr: 'config missing'})
			return {stdout: buf.toString('utf8'), stderr: ''}
		}
		if (sub === 'backup') {
			if (onBackup) {
				const custom = await onBackup(args, opts)
				if (custom) return custom
			}
			const pack = randomBytes(32).toString('hex')
			const snap = randomBytes(32).toString('hex')
			await mkdir(join(repo, 'data', pack.slice(0, 2)), {recursive: true})
			await writeFile(join(repo, 'data', pack.slice(0, 2), pack), `pack-${snap}`)
			await mkdir(join(repo, 'snapshots'), {recursive: true})
			const tags = []
			for (let i = 0; i < args.length; i++) if (args[i] === '--tag') tags.push(args[i + 1])
			const paths = args.filter((a) => a.startsWith('/'))
			await writeFile(join(repo, 'snapshots', snap), JSON.stringify({id: snap, short_id: snap.slice(0, 8), time: new Date().toISOString(), tags, paths, summary: {total_bytes_processed: 1024}}))
			const line = JSON.stringify({message_type: 'summary', data_added: 1024, total_files_processed: 3})
			opts.onLine?.(line)
			return {stdout: `${line}\n`, stderr: ''}
		}
		if (sub === 'snapshots') {
			const dir = join(repo, 'snapshots')
			const names = await readdir(dir).catch(() => [])
			const out = []
			for (const n of names) out.push(JSON.parse(await readFile(join(dir, n), 'utf8')))
			return {stdout: JSON.stringify(out), stderr: ''}
		}
		if (sub === 'key') return {stdout: '', stderr: ''}
		if (sub === 'forget' || sub === 'check') return {stdout: '', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	return {calls, run: runner}
}

// The computer's restic writes the snapshot into its store during backup-run. These fakes answer the
// call without that upload, so a test that restores afterwards puts the file there itself.
async function plantSnapshot(repo) {
	const id = randomBytes(32).toString('hex')
	await mkdir(join(repo, 'snapshots'), {recursive: true})
	await writeFile(join(repo, 'snapshots', id), JSON.stringify({id, short_id: id.slice(0, 8), time: new Date().toISOString(), paths: ['/home/user/Documents'], summary: {total_bytes_processed: 100}}))
	return id
}

async function listNasFiles(nasRoot, shareName = 'backups', folder = 'Omarchy Server') {
	const root = join(nasRoot, shareName, ...folder.split('/'))
	const out = new Map()
	async function walk(d) {
		for (const e of await readdir(d, {withFileTypes: true}).catch(() => [])) {
			const p = join(d, e.name)
			if (e.isDirectory()) await walk(p)
			else if (e.isFile()) out.set(relative(root, p).split(sep).join('/'), await readFile(p))
		}
	}
	await walk(root)
	return out
}

test('#603 setting up or mirroring on a NAS folder that already holds backups is refused without deleting them', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-603-'))
	const nasRoot = join(root, 'nas')
	const homeA = join(root, 'homeA')
	const homeB = join(root, 'homeB')
	const dataA = join(root, 'dataA')
	const dataB = join(root, 'dataB')
	await mkdir(homeA, {recursive: true})
	await mkdir(homeB, {recursive: true})
	await mkdir(dataA, {recursive: true})
	await mkdir(dataB, {recursive: true})
	await writeFile(join(dataA, 'settings.json'), '{"a":1}\n')
	await writeFile(join(dataB, 'settings.json'), '{"b":1}\n')

	const fakeNas = makeFakeNas(nasRoot)
	const resticA = makeFakeRestic()
	const resticB = makeFakeRestic()
	const runWith = (resticRunner) => async (cmd, args, opts) => {
		if (cmd === 'smbclient') return fakeNas(args, opts)
		return resticRunner.run(args, opts)
	}

	const a = createBackups({dataDir: dataA, home: homeA, serverDataDir: join(root, 'noneA'), files: fakeFiles(homeA), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: runWith(resticA)})
	const b = createBackups({dataDir: dataB, home: homeB, serverDataDir: join(root, 'noneB'), files: fakeFiles(homeB), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: runWith(resticB)})
	t.after(async () => {
		a.close()
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await a.procedures['backups.configure'].run({nas})
	await (await a.runBackup()).done
	await (await a.runBackup()).done

	const beforeFiles = await listNasFiles(nasRoot)
	assert.ok(beforeFiles.has('server/config'))
	assert.ok(beforeFiles.size >= 5)

	// Server B tries to configure on the same NAS folder: must fail and leave Server A's NAS files untouched.
	await assert.rejects(
		b.procedures['backups.configure'].run({nas}),
		(err) => err.code === 'PRECONDITION_FAILED' && /already has backups/i.test(err.message) && /Restore from an existing backup/i.test(err.message),
	)
	const afterConfigureFiles = await listNasFiles(nasRoot)
	assert.deepEqual([...afterConfigureFiles.keys()].sort(), [...beforeFiles.keys()].sort())
	assert.deepEqual(afterConfigureFiles.get('server/config'), beforeFiles.get('server/config'))

	// Server A re-configuring its own NAS folder (e.g. changing password) still succeeds.
	const updated = await a.procedures['backups.configure'].run({nas: {...nas, password: 'p2'}})
	assert.equal(updated.configured, true)

	// Even if Server B had its own separate NAS folder first and was later pointed directly at Server A's folder
	// (bypassing configure), mirror() must refuse when server/config differs (even at identical byte length!).
	const nasB = {host: 'nas.local', share: 'backups', folder: 'Server B Folder', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas: nasB})
	await (await b.runBackup()).done
	// Point B's config.json at Server A's folder on disk and reload a fresh instance B2.
	const bCfgFile = join(dataB, 'backups', 'config.json')
	const bCfg = JSON.parse(await readFile(bCfgFile, 'utf8'))
	bCfg.nas.folder = 'Omarchy Server'
	await writeFile(bCfgFile, JSON.stringify(bCfg))
	const b2 = createBackups({dataDir: dataB, home: homeB, serverDataDir: join(root, 'noneB'), files: fakeFiles(homeB), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: runWith(resticB)})
	t.after(() => b2.close())
	await b2.ready
	await assert.rejects(b2.mirror(), /different backup|already has backups/i)

	const afterMirrorFiles = await listNasFiles(nasRoot)
	assert.deepEqual([...afterMirrorFiles.keys()].sort(), [...beforeFiles.keys()].sort())
	assert.deepEqual(afterMirrorFiles.get('server/config'), beforeFiles.get('server/config'))
})

test('#598 refuses to recreate a missing or empty backup store or wipe the NAS copy', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-598-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	await writeFile(join(dataDir, 'settings.json'), '{"x":1}\n')

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas})
	await (await b.runBackup()).done
	const beforeFiles = await listNasFiles(nasRoot)
	assert.ok(beforeFiles.has('server/config'))
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)

	// Case A: empty mount point (backup folder replaced with empty directory).
	const repoDir = join(home, 'Backups', 'Omarchy Server')
	await rm(repoDir, {recursive: true, force: true})
	await mkdir(repoDir, {recursive: true})

	await (await b.runBackup()).done
	let st = await b.procedures['backups.status'].run()
	assert.equal(st.history[0].ok, false)
	assert.match(st.history[0].error, /empty or missing/i)
	assert.equal(st.history[0].nas, null)
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)
	assert.deepEqual([...(await listNasFiles(nasRoot)).keys()].sort(), [...beforeFiles.keys()].sort())

	// mirror() alone must not wipe the NAS when the local store is missing.
	await assert.rejects(b.mirror(), /missing/i)
	assert.deepEqual([...(await listNasFiles(nasRoot)).keys()].sort(), [...beforeFiles.keys()].sort())

	// configure({schedule}) while drive is empty/missing must not run restic init.
	await assert.rejects(b.procedures['backups.configure'].run({schedule: {frequency: 'weekly', hour: 4, weekday: 1}}), /empty or missing/i)
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)

	// Case B: backup folder deleted completely.
	await rm(repoDir, {recursive: true, force: true})
	await (await b.runBackup()).done
	st = await b.procedures['backups.status'].run()
	assert.equal(st.history[0].ok, false)
	assert.match(st.history[0].error, /empty or missing/i)
	assert.equal(st.history[0].nas, null)
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)
	assert.deepEqual([...(await listNasFiles(nasRoot)).keys()].sort(), [...beforeFiles.keys()].sort())
})

test('#599 restic exit 3 is recorded as a warning and settings/VM failures still prune and copy to the NAS', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-599-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const appDir = join(dataDir, 'apps', 'installed', 'notes')
	await mkdir(appDir, {recursive: true})
	await mkdir(home, {recursive: true})
	await writeFile(join(appDir, 'note.txt'), 'hi\n')
	await writeFile(join(dataDir, 'settings.json'), '{"x":1}\n')

	let settingsMode = 'exit3'
	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic({
		async onBackup(args, opts) {
			if (!args.includes('settings')) return null
			if (settingsMode === 'exit1') {
				throw Object.assign(new Error('/bin/restic: Fatal: repository damaged'), {code: 1, stdout: '', stderr: 'Fatal: repository damaged\n'})
			}
			const line = JSON.stringify({message_type: 'summary', data_added: 1024, total_files_processed: 2})
			opts.onLine?.(line)
			const pack = randomBytes(32).toString('hex')
			const snap = randomBytes(32).toString('hex')
			const repo = opts.env.RESTIC_REPOSITORY
			await mkdir(join(repo, 'data', pack.slice(0, 2)), {recursive: true})
			await writeFile(join(repo, 'data', pack.slice(0, 2), pack), 'pack')
			await writeFile(join(repo, 'snapshots', snap), JSON.stringify({id: snap, short_id: snap.slice(0, 8), time: new Date().toISOString(), tags: ['settings'], paths: [dataDir]}))
			throw Object.assign(new Error('/bin/restic: Warning: at least one source file could not be read'), {
				code: 3,
				stdout: `${line}\n`,
				stderr: 'Warning: at least one source file could not be read\n',
			})
		},
	})
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => [{id: 'notes', name: 'Notes', dir: appDir, running: false}]},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas})
	await (await b.runBackup()).done

	let st = await b.procedures['backups.status'].run()
	const run1 = st.history[0]
	assert.equal(run1.ok, true, run1.error)
	assert.equal(run1.error, null)
	const settingsItem = run1.items.find((i) => i.kind === 'settings')
	assert.ok(settingsItem)
	assert.equal(settingsItem.ok, true)
	assert.equal(settingsItem.added, 1024)
	assert.equal(settingsItem.warning, 'Saved, but some files couldn’t be read')
	assert.equal(run1.nas?.ok, true)
	assert.ok(restic.calls.some((c) => c.args[0] === 'forget' && c.args.includes('--prune')))
	assert.ok(restic.calls.some((c) => c.args[0] === 'check'))
	assert.ok((await listNasFiles(nasRoot)).size >= 5)

	// Real settings failure (exit 1) marks the settings item failed, but still prunes and mirrors apps to the NAS.
	settingsMode = 'exit1'
	restic.calls.length = 0
	await (await b.runBackup()).done
	st = await b.procedures['backups.status'].run()
	const run2 = st.history[0]
	assert.equal(run2.ok, false)
	assert.match(run2.error, /Server settings/)
	assert.equal(run2.items.find((i) => i.kind === 'app')?.ok, true)
	assert.equal(run2.items.find((i) => i.kind === 'settings')?.ok, false)
	assert.equal(run2.nas?.ok, true)
	assert.ok(restic.calls.some((c) => c.args[0] === 'forget' && c.args.includes('--prune')))
})

test('#435 schedules keep their chosen hour across daylight-saving changes', async () => {
	const modUrl = new URL('../omarchyd/backups.mjs', import.meta.url).href
	const script = `
		import assert from 'node:assert/strict'
		import {latestSlot, nextRun} from ${JSON.stringify(modUrl)}

		const checkInvariant = (sc, startIso, hours) => {
			const start = Date.parse(startIso)
			const end = start + hours * 3600_000
			// Build exact sequence of slots by walking nextRun forward from well before start.
			const slots = []
			let cur = start - 14 * 86400_000
			while (true) {
				const n = nextRun(sc, cur)
				slots.push(n)
				cur = n
				if (n > end) break
			}
			for (let t = start; t <= end; t += 15 * 60_000) {
				let expected = null
				for (const s of slots) if (s <= t) expected = s
				const actual = latestSlot(sc, t)
				assert.equal(actual, expected, 'latestSlot mismatch at ' + new Date(t).toString() + ' for ' + JSON.stringify(sc))
			}
		}

		if (process.env.TZ === 'America/New_York') {
			const n = nextRun({frequency: 'daily', hour: 2, weekday: 0}, Date.parse('2026-03-08T07:30:00Z'))
			const d = new Date(n)
			assert.equal(d.getFullYear(), 2026)
			assert.equal(d.getMonth(), 2)
			assert.equal(d.getDate(), 9)
			assert.equal(d.getHours(), 2)

			const w = new Date(nextRun({frequency: 'weekly', hour: 2, weekday: 0}, Date.parse('2026-03-08T07:30:00Z')))
			assert.equal(w.getDate(), 15)
			assert.equal(w.getHours(), 2)

			for (const hour of [0, 1, 2, 3]) {
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-03-07T00:00:00Z', 72)
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-10-31T00:00:00Z', 72)
				checkInvariant({frequency: 'weekly', hour, weekday: 0}, '2026-03-07T00:00:00Z', 96)
				checkInvariant({frequency: 'weekly', hour, weekday: 0}, '2026-10-31T00:00:00Z', 96)
			}
		} else if (process.env.TZ === 'Europe/Berlin') {
			const n = nextRun({frequency: 'daily', hour: 2, weekday: 0}, Date.parse('2026-03-29T01:30:00Z'))
			const d = new Date(n)
			assert.equal(d.getFullYear(), 2026)
			assert.equal(d.getMonth(), 2)
			assert.equal(d.getDate(), 30)
			assert.equal(d.getHours(), 2)

			for (const hour of [0, 1, 2, 3]) {
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-03-28T00:00:00Z', 72)
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-10-24T00:00:00Z', 72)
			}
		}
	`
	for (const tz of ['America/New_York', 'Europe/Berlin']) {
		await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TZ: tz}})
	}
})

test('#437 backups.status includes the server timeZone', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-437-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const modUrl = new URL('../omarchyd/backups.mjs', import.meta.url).href
	const script = `
		import assert from 'node:assert/strict'
		import {createBackups} from ${JSON.stringify(modUrl)}
		const root = ${JSON.stringify(root)}
		const b = createBackups({
			dataDir: root + '/data',
			home: root,
			files: {async resolve(v) { return {real: root + v, top: 'Home'} }},
			apps: {backupTargets: async () => []},
			timers: false,
			run: async () => ({stdout: '', stderr: ''}),
		})
		try {
			const st = await b.procedures['backups.status'].run()
			assert.equal(st.timeZone, process.env.TZ)
		} finally {
			b.close()
		}
	`
	for (const tz of ['UTC', 'America/New_York']) {
		await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TZ: tz}})
	}
})

test('#451 defaultSpawn decodes multi-byte UTF-8 characters split across stdout and stderr chunks', async () => {
	const expected = '{"p":"Ünïcödé-日本語-файл"}'
	const stdoutScript = `
		const buf = Buffer.from(${JSON.stringify(expected + '\n')}, 'utf8')
		const cut = buf.indexOf(Buffer.from('日', 'utf8')) + 1
		process.stdout.write(buf.subarray(0, cut))
		setTimeout(() => process.stdout.write(buf.subarray(cut)), 20)
	`
	const lines = []
	const res = await defaultSpawn(process.execPath, ['-e', stdoutScript], {onLine: (l) => lines.push(l)})
	assert.equal(res.stdout, `${expected}\n`)
	assert.deepEqual(lines, [expected])
	assert.equal(res.stdout.includes('\uFFFD'), false)

	const errText = 'Warning: Ünïcödé-日本語-файл unreadable'
	const stderrScript = `
		const buf = Buffer.from(${JSON.stringify(errText + '\n')}, 'utf8')
		const cut = buf.indexOf(Buffer.from('日', 'utf8')) + 2
		process.stderr.write(buf.subarray(0, cut))
		setTimeout(() => {
			process.stderr.write(buf.subarray(cut))
			process.exit(1)
		}, 20)
	`
	await assert.rejects(defaultSpawn(process.execPath, ['-e', stderrScript]), (err) => {
		assert.equal(err.code, 1)
		assert.equal(err.stderr, `${errText}\n`)
		assert.ok(err.message.includes(errText))
		assert.equal(err.stderr.includes('\uFFFD'), false)
		return true
	})
})

test('#568 aborted uploads close their file streams without leaking descriptors', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-568-'))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const repoDir = join(home, 'Backups', 'Omarchy Server')
	await mkdir(join(repoDir, 'computers', 'pc1'), {recursive: true})
	await writeFile(join(repoDir, 'computers', 'pc1', 'config'), 'cfg')
	await mkdir(dataDir, {recursive: true})

	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		timers: false,
		run: async () => ({stdout: '', stderr: ''}),
	})
	const pending = []
	const server = http.createServer((req, res) => {
		const p = b.handleUpload(req, res, 'pc1', req.url.slice(1)).catch(() => {})
		pending.push(p)
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const {port} = server.address()
	t.after(async () => {
		await Promise.allSettled(pending)
		await new Promise((r) => server.close(r))
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	await b.ready
	const countFds = async () => (await readdir('/proc/self/fd').catch(() => readdir('/dev/fd'))).length
	const before = await countFds()

	const objId = 'a'.repeat(64)
	for (let i = 0; i < 25; i++) {
		const id = `${i.toString(16).padStart(2, '0')}${'b'.repeat(62)}`
		await new Promise((resolve) => {
			const req = http.request({
				host: '127.0.0.1',
				port,
				path: `/data/${id}`,
				method: 'POST',
				headers: {'content-length': '1000000'},
			})
			req.on('error', () => {})
			req.write(Buffer.alloc(1000, 0x41))
			setTimeout(() => {
				req.destroy()
				resolve()
			}, 5)
		})
	}
	await Promise.allSettled(pending)
	await new Promise((r) => setTimeout(r, 80))

	const after = await countFds()
	assert.ok(after <= before + 2, `leaked file descriptors: before=${before}, after=${after}`)
	const dataFiles = await readdir(join(repoDir, 'computers', 'pc1', 'data'), {recursive: true}).catch(() => [])
	assert.deepEqual(dataFiles.filter((f) => String(f).endsWith('.tmp')), [])

	// Normal upload still succeeds and writes exact bytes.
	const body = Buffer.from('hello restic object')
	const res = await fetch(`http://127.0.0.1:${port}/data/${objId}`, {method: 'POST', body})
	assert.equal(res.status, 200)
	assert.deepEqual(await readFile(join(repoDir, 'computers', 'pc1', 'data', objId.slice(0, 2), objId)), body)
})

test('#572 apps paused for a backup are recorded on disk and resumed on startup after a restart', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-572-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const appDir = join(dataDir, 'apps', 'installed', 'immich')
	await mkdir(appDir, {recursive: true})
	await mkdir(home, {recursive: true})
	await writeFile(join(appDir, 'db.sqlite'), 'data')

	let backupStartedResolve
	let releaseBackup
	const backupStarted = new Promise((r) => (backupStartedResolve = r))
	const backupGate = new Promise((r) => (releaseBackup = r))
	let stallNext = false

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic({
		async onBackup(args) {
			if (stallNext && args.includes('app:immich')) {
				backupStartedResolve()
				await backupGate
			}
			return null
		},
	})
	const events1 = []
	const apps1 = {
		backupTargets: async () => [{id: 'immich', name: 'Immich', dir: appDir, running: true}],
		pauseForBackup: async (id) => events1.push(`pause ${id}`),
		resumeAfterBackup: async (id) => events1.push(`resume ${id}`),
	}
	const run = async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts))
	const b1 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: apps1, resticPath: '/bin/restic', unshare: false, timers: false, run})
	let b2
	let b3
	t.after(async () => {
		releaseBackup?.()
		b1.close()
		b2?.close()
		b3?.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b1.procedures['backups.configure'].run({nas})

	// Normal backup pauses, tracks on disk while running, resumes, and removes marker when done.
	await (await b1.runBackup()).done
	assert.deepEqual(events1, ['pause immich', 'resume immich'])
	await assert.rejects(stat(join(dataDir, 'backups', 'paused-apps.json')))

	// Stalled backup (simulates omarchyd killed before resumeAfterBackup runs).
	stallNext = true
	const run1 = await b1.runBackup()
	await backupStarted
	const marker = JSON.parse(await readFile(join(dataDir, 'backups', 'paused-apps.json'), 'utf8'))
	assert.deepEqual(marker, ['immich'])

	// Simulated restart while immich is still paused: new instance resumes immich on startup and clears marker.
	const events2 = []
	const apps2 = {
		backupTargets: async () => [],
		pauseForBackup: async (id) => events2.push(`pause ${id}`),
		resumeAfterBackup: async (id) => events2.push(`resume ${id}`),
	}
	b2 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: apps2, resticPath: '/bin/restic', unshare: false, timers: false, run})
	await b2.ready
	assert.deepEqual(events2, ['resume immich'])
	await assert.rejects(stat(join(dataDir, 'backups', 'paused-apps.json')))

	// Release first backup's stalled gate before closing, then verify a clean restart doesn't resume again.
	releaseBackup()
	await run1.done
	const events3 = []
	b3 = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => [], resumeAfterBackup: async (id) => events3.push(`resume ${id}`)},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run,
	})
	await b3.ready
	assert.deepEqual(events3, [])
})

test('#578 missed scheduled server backup catches up when omarchyd comes back up', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-578-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	await mkdir(join(home, 'Backups', 'Omarchy Server', 'server', 'snapshots'), {recursive: true})
	await mkdir(join(home, 'Backups', 'Omarchy Server', 'server', 'keys'), {recursive: true})
	await mkdir(join(home, 'Backups', 'Omarchy Server', 'server', 'data'), {recursive: true})
	await mkdir(join(home, 'Backups', 'Omarchy Server', 'server', 'index'), {recursive: true})
	await writeFile(join(home, 'Backups', 'Omarchy Server', 'server', 'config'), 'server-cfg-1')
	await writeFile(join(dataDir, 'backups', 'recovery-key'), 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567\n')
	await writeFile(join(dataDir, 'backups', 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(
		join(dataDir, 'backups', 'config.json'),
		JSON.stringify({
			nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'},
			repo: '/Home/Backups/Omarchy Server',
			schedule: {frequency: 'daily', hour: 3, weekday: 0},
		}),
	)
	const mon3am = new Date(2026, 10, 16, 3, 0, 0, 0).getTime()
	await writeFile(
		join(dataDir, 'backups', 'history.json'),
		JSON.stringify([{id: 'prev1', reason: 'scheduled', startedAt: mon3am, endedAt: mon3am + 1000, ok: true, error: null, items: [], added: 0, nas: {ok: true}}]),
	)

	const origSetInterval = globalThis.setInterval
	const ticks = []
	globalThis.setInterval = (fn, ms, ...rest) => {
		if (ms === 60_000) {
			ticks.push(fn)
			return {unref() {}}
		}
		return origSetInterval(fn, ms, ...rest)
	}
	let b
	let b2
	t.after(async () => {
		globalThis.setInterval = origSetInterval
		b?.close()
		b2?.close()
		await rm(root, {recursive: true, force: true})
	})

	let fakeNow = new Date(2026, 10, 17, 9, 0, 0, 0).getTime() // Tue 09:00 (missed 03:00)
	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const run = async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts))
	b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		unshare: false,
		now: () => fakeNow,
		timers: true,
		run,
	})
	await b.ready
	await new Promise((r) => setImmediate(r))
	assert.equal(ticks.length, 1)

	const waitDone = async (inst) => {
		for (let i = 0; i < 100; i++) {
			const st = await inst.procedures['backups.status'].run()
			if (!st.running) return st
			await new Promise((r) => setTimeout(r, 5))
		}
		throw new Error('backup did not finish')
	}

	await ticks[0]()
	let st = await waitDone(b)
	assert.equal(st.history.length, 2)
	assert.equal(st.history[0].reason, 'scheduled')
	assert.equal(st.history[0].ok, true, st.history[0].error)

	// Firing again 5 minutes later must not re-run for the same slot.
	fakeNow += 5 * 60_000
	await ticks[0]()
	st = await waitDone(b)
	assert.equal(st.history.length, 2)

	// Fresh configure at 09:00 with daily 03:00 waits until tomorrow's 03:00 rather than running immediately.
	const root2 = join(root, 'fresh')
	const home2 = join(root2, 'home')
	const dataDir2 = join(root2, 'data')
	await mkdir(home2, {recursive: true})
	await mkdir(dataDir2, {recursive: true})
	let fakeNow2 = new Date(2026, 10, 18, 9, 0, 0, 0).getTime()
	ticks.length = 0
	b2 = createBackups({
		dataDir: dataDir2,
		home: home2,
		serverDataDir: join(root2, 'none'),
		files: fakeFiles(home2),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		unshare: false,
		now: () => fakeNow2,
		timers: true,
		run,
	})
	await b2.ready
	await new Promise((r) => setImmediate(r))
	assert.equal(ticks.length, 1)

	await b2.procedures['backups.configure'].run({
		nas: {host: 'nas.local', share: 'backups', folder: 'Fresh Folder', username: 'u', password: 'p'},
		schedule: {frequency: 'daily', hour: 3, weekday: 0},
	})
	fakeNow2 += 5 * 60_000
	await ticks[0]()
	st = await waitDone(b2)
	assert.equal(st.history.length, 0)

	// Advancing to the next day after 03:00 catches up and runs once.
	fakeNow2 = new Date(2026, 10, 19, 9, 0, 0, 0).getTime()
	await ticks[0]()
	st = await waitDone(b2)
	assert.equal(st.history.length, 1)
	assert.equal(st.history[0].reason, 'scheduled')
})

test('#606 failing scheduled computer backups back off, collapse errors, and reset when folders change', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-606-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	await writeFile(join(dataDir, 'settings.json'), '{"x":1}\n')

	const origSetInterval = globalThis.setInterval
	const ticks = []
	globalThis.setInterval = (fn, ms, ...rest) => {
		if (ms === 60_000) {
			ticks.push(fn)
			return {unref() {}}
		}
		return origSetInterval(fn, ms, ...rest)
	}

	let fakeNow = new Date(2026, 10, 17, 1, 0, 0, 0).getTime()
	let failBackup = true
	let callCount = 0
	const swarm = {
		async agents() {
			return [{id: 'pc1', name: 'Laptop', online: true, allowed: true, on: true}]
		},
		async call(_id, action) {
			if (action === 'backup-run') {
				callCount++
				if (failBackup) throw new Error('None of the chosen folders are on this computer')
				return {added: 512, files: 2}
			}
			return {}
		},
		progress() {
			return null
		},
	}

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		swarm,
		resticPath: '/bin/restic',
		unshare: false,
		now: () => fakeNow,
		timers: true,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		globalThis.setInterval = origSetInterval
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	await b.ready
	await new Promise((r) => setImmediate(r))
	assert.equal(ticks.length, 1)

	const waitComputerDone = async () => {
		for (let i = 0; i < 100; i++) {
			const comps = await b.procedures['backups.computers'].run()
			if (!comps.find((c) => c.id === 'pc1')?.running) return
			await new Promise((r) => setTimeout(r, 5))
		}
		throw new Error('computer backup did not finish')
	}

	// Server configured with schedule off; run one good server backup first.
	await b.procedures['backups.configure'].run({
		nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'},
		schedule: {frequency: 'off', hour: 3, weekday: 0},
	})
	await (await b.runBackup()).done
	await b.procedures['backups.setComputer'].run({
		id: 'pc1',
		folders: ['Missing'],
		schedule: {frequency: 'daily', hour: 1, weekday: 0},
		enabled: true,
	})

	// Simulate ticking every minute until just before the next day's 01:00 slot (01:00 -> 00:50 next day).
	for (let m = 0; m < 23 * 60 + 50; m++) {
		await ticks[0]()
		await waitComputerDone()
		fakeNow += 60_000
	}

	assert.equal(callCount, 3)
	let st = await b.procedures['backups.status'].run()
	assert.equal(st.history.length, 2) // 1 collapsed pc1 failure + 1 server backup
	assert.equal(st.history[0].computer, 'pc1')
	assert.equal(st.history[0].ok, false)
	assert.equal(st.history[0].attempts, 3)
	assert.equal(st.history[1].computer, undefined)
	assert.equal(st.history[1].ok, true)

	// Next day's 01:00 slot retries once again.
	fakeNow = new Date(2026, 10, 18, 1, 1, 0, 0).getTime()
	await ticks[0]()
	await waitComputerDone()
	assert.equal(callCount, 4)

	// Updating folders resets the backoff so the next tick tries immediately and succeeds.
	failBackup = false
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Documents']})
	fakeNow += 60_000
	await ticks[0]()
	await waitComputerDone()
	assert.equal(callCount, 5)
	st = await b.procedures['backups.status'].run()
	assert.equal(st.history[0].ok, true)

	// Interrupted backup or manual failure (failures === 0 with lastAttemptAt >= slot) still retries after 30 minutes.
	const prevCalls = callCount
	fakeNow = new Date(2026, 10, 19, 1, 5, 0, 0).getTime()
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Bad']})
	failBackup = true
	await b.procedures['backups.runComputer'].run({id: 'pc1'})
	await waitComputerDone()
	assert.equal(callCount, prevCalls + 1)
	// Before 30m: does not retry yet; after 30m: retries even with failures === 0 and lastAttemptAt >= slot.
	fakeNow += 10 * 60_000
	await ticks[0]()
	await waitComputerDone()
	assert.equal(callCount, prevCalls + 1)
	fakeNow += 25 * 60_000
	await ticks[0]()
	await waitComputerDone()
	assert.equal(callCount, prevCalls + 2)

	// Changing folders after a manual failure (failures === 0) clears lastAttemptAt so the next tick retries at once.
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Bad2']})
	await b.procedures['backups.runComputer'].run({id: 'pc1'})
	await waitComputerDone()
	failBackup = false
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Documents']})
	fakeNow += 60_000
	await ticks[0]()
	await waitComputerDone()
	assert.equal(callCount, prevCalls + 4)
})

test('#641 backups.discover decodes escaped UTF-8 bytes in avahi-browse service names', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-641-'))
	const avahiOut = [
		'=;eth0;IPv4;Time\\032Capsule;_smb._tcp;local;timecapsule.local;192.168.1.5;445;',
		'=;eth0;IPv4;K\\195\\188che\\032NAS;_smb._tcp;local;kuechenas.local;192.168.1.6;445;',
		'=;eth0;IPv4;Fred\\226\\128\\153s\\032NAS;_smb._tcp;local;fred.local;192.168.1.7;445;',
		'=;eth0;IPv4;Caf\\195\\169\\032\\240\\159\\143\\160;_smb._tcp;local;cafe.local;192.168.1.8;445;',
		'=;eth0;IPv4;A\\092032B;_smb._tcp;local;backslash.local;192.168.1.9;445;',
	].join('\n')
	const b = createBackups({
		dataDir: join(root, 'data'),
		home: root,
		files: fakeFiles(root),
		apps: {backupTargets: async () => []},
		timers: false,
		run: async (cmd) => (cmd === 'avahi-browse' ? {stdout: avahiOut, stderr: ''} : {stdout: '', stderr: ''}),
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const list = await b.procedures['backups.discover'].run()
	const expected = [
		{host: 'backslash.local', name: 'A\\032B', address: '192.168.1.9'},
		{host: 'cafe.local', name: 'Café 🏠', address: '192.168.1.8'},
		{host: 'fred.local', name: 'Fred’s NAS', address: '192.168.1.7'},
		{host: 'kuechenas.local', name: 'Küche NAS', address: '192.168.1.6'},
		{host: 'timecapsule.local', name: 'Time Capsule', address: '192.168.1.5'},
	].sort((x, y) => x.name.localeCompare(y.name))
	assert.deepEqual(list, expected)
})

test('#649 0.9.46 root-layout backup stores are migrated into server/ for snapshots, backups, and connectExisting', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-649-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const repoDir = join(home, 'Backups', 'Omarchy Server')
	const snapId = 'a'.repeat(64)
	const cfgContent = 'legacy-0946-config-content'
	const snapJson = JSON.stringify({id: snapId, short_id: snapId.slice(0, 8), time: '2026-11-10T03:00:00Z', tags: ['settings'], paths: [dataDir], summary: {total_bytes_processed: 512}})

	// Seed local 0.9.46 layout.
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	for (const sub of ['keys', 'data/aa', 'index', 'snapshots']) await mkdir(join(repoDir, sub), {recursive: true})
	await writeFile(join(repoDir, 'config'), cfgContent)
	await writeFile(join(repoDir, 'keys', 'k1'), 'key')
	await writeFile(join(repoDir, 'data', 'aa', 'pack1'), 'pack')
	await writeFile(join(repoDir, 'snapshots', snapId), snapJson)
	const key = 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567'
	await writeFile(join(dataDir, 'backups', 'recovery-key'), `${key}\n`)
	await writeFile(join(dataDir, 'backups', 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(
		join(dataDir, 'backups', 'config.json'),
		JSON.stringify({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'}, repo: '/Home/Backups/Omarchy Server'}),
	)

	// Seed matching 0.9.46 layout on two NAS folders: one for server 1's mirror, one pristine for connectExisting.
	for (const folder of ['Omarchy Server', 'Legacy NAS Only']) {
		const nasDir = join(nasRoot, 'backups', folder)
		for (const sub of ['keys', 'data/aa', 'index', 'snapshots']) await mkdir(join(nasDir, sub), {recursive: true})
		await writeFile(join(nasDir, 'config'), cfgContent)
		await writeFile(join(nasDir, 'keys', 'k1'), 'key')
		await writeFile(join(nasDir, 'data', 'aa', 'pack1'), 'pack')
		await writeFile(join(nasDir, 'snapshots', snapId), snapJson)
	}

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const run = async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts))
	const b1 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run})

	const home2 = join(root, 'home2')
	const dataDir2 = join(root, 'data2')
	await mkdir(home2, {recursive: true})
	await mkdir(dataDir2, {recursive: true})
	const b2 = createBackups({dataDir: dataDir2, home: home2, serverDataDir: join(root, 'none2'), files: fakeFiles(home2), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run})
	t.after(async () => {
		b1.close()
		b2.close()
		await rm(root, {recursive: true, force: true})
	})

	// snapshots() recognizes and migrates local 0.9.46 store into server/.
	const snaps1 = await b1.procedures['backups.snapshots'].run()
	assert.equal(snaps1.length, 1)
	assert.equal(snaps1[0].id, snapId)
	assert.ok((await stat(join(repoDir, 'server', 'config'))).isFile())
	await assert.rejects(stat(join(repoDir, 'config')))

	// runBackup() succeeds without "isn't empty" and mirrors against the matching 0.9.46 NAS copy.
	await (await b1.runBackup()).done
	const st = await b1.procedures['backups.status'].run()
	assert.equal(st.history[0].ok, true, st.history[0].error)
	const nasFiles = await listNasFiles(nasRoot)
	assert.ok(nasFiles.has('server/config'))

	// Calling runBackup() directly on an unmigrated 0.9.46 store also migrates via ensureRepo({allowInit: false}).
	const home3 = join(root, 'home3')
	const dataDir3 = join(root, 'data3')
	const repoDir3 = join(home3, 'Backups', 'Omarchy Server')
	await mkdir(join(dataDir3, 'backups'), {recursive: true})
	for (const sub of ['keys', 'data/aa', 'index', 'snapshots']) await mkdir(join(repoDir3, sub), {recursive: true})
	await writeFile(join(repoDir3, 'config'), cfgContent)
	await writeFile(join(repoDir3, 'keys', 'k1'), 'key')
	await writeFile(join(dataDir3, 'backups', 'recovery-key'), `${key}\n`)
	await writeFile(join(dataDir3, 'backups', 'secrets.json'), JSON.stringify({nasPassword: 'p'}))
	await writeFile(
		join(dataDir3, 'backups', 'config.json'),
		JSON.stringify({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u'}, repo: '/Home/Backups/Omarchy Server'}),
	)
	const b3 = createBackups({dataDir: dataDir3, home: home3, serverDataDir: join(root, 'none3'), files: fakeFiles(home3), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run})
	t.after(() => b3.close())
	await (await b3.runBackup()).done
	const st3 = await b3.procedures['backups.status'].run()
	assert.equal(st3.history[0].ok, true, st3.history[0].error)
	assert.ok((await stat(join(repoDir3, 'server', 'config'))).isFile())

	// connectExisting() on a fresh server recognizes and migrates a 0.9.46 NAS copy.
	const back = await b2.procedures['backups.connectExisting'].run({
		nas: {host: 'nas.local', share: 'backups', folder: 'Legacy NAS Only', username: 'u', password: 'p'},
		recoveryKey: key,
	})
	assert.equal(back.configured, true)
	const snaps2 = await b2.procedures['backups.snapshots'].run()
	assert.equal(snaps2.length, 1)
	assert.equal(snaps2[0].id, snapId)
})

test('#340 mirror ignores in-flight .tmp files from concurrent computer uploads', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-340-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	await writeFile(join(dataDir, 'settings.json'), '{"x":1}\n')

	let renamed = true
	let tmpPath = ''
	let finalPath = ''
	const fakeNas = makeFakeNas(nasRoot, {
		async onCommand(raw) {
			if (renamed || !raw.startsWith('put ')) return
			renamed = true
			await rename(tmpPath, finalPath)
		},
	})
	const restic = makeFakeRestic()
	let dropNextPut = false
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => {
			if (cmd === 'smbclient') {
				if (dropNextPut && String(opts?.input ?? '').includes('put ')) {
					dropNextPut = false
					return {stdout: '', stderr: ''}
				}
				return fakeNas(args, opts)
			}
			return restic.run(args, opts)
		},
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	await b.procedures['backups.configure'].run({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}})
	await (await b.runBackup()).done

	// Simulate an in-flight computer upload (.tmp file) that finishes and renames when the first put runs.
	const objId = 'ab' + 'c'.repeat(62)
	const compDir = join(home, 'Backups', 'Omarchy Server', 'computers', 'pc2')
	const compDataDir = join(compDir, 'data', 'ab')
	await mkdir(compDataDir, {recursive: true})
	await writeFile(join(compDir, 'config'), 'pc2-config')
	tmpPath = join(compDataDir, `${objId}.1234abcd.tmp`)
	finalPath = join(compDataDir, objId)
	await writeFile(tmpPath, 'partial-object-bytes')
	renamed = false

	const res = await b.mirror()
	assert.ok(res)
	const nasFiles = await listNasFiles(nasRoot)
	assert.ok(![...nasFiles.keys()].some((k) => k.endsWith('.tmp')))

	// A genuine missing committed file must still fail verification.
	await b.mirror()
	await writeFile(join(compDataDir, 'ab' + 'd'.repeat(62)), 'committed-pack')
	dropNextPut = true
	await assert.rejects(b.mirror(), /1 file didn’t reach the NAS/)
})

test('#600 history trims per source and status.last keeps the server’s last run', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-600-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	await mkdir(home, {recursive: true})

	const nowMs = Date.now()
	const mkEntry = (id, computer, offsetHours) => ({
		id,
		...(computer ? {computer, name: computer === 'pcA' ? 'Desktop' : 'Laptop'} : {}),
		reason: 'scheduled',
		startedAt: nowMs - offsetHours * 3600_000,
		endedAt: nowMs - offsetHours * 3600_000 + 1000,
		ok: true,
		error: null,
		items: [],
		added: 128,
		nas: {ok: true},
	})

	// 25 runs for pcA, 16 for pcB’s sibling, 1 older run for pcB, and 1 older server run.
	// Status returns every saved run. The per-source trim happens when a run is saved, not when status is read.
	const seeded = []
	for (let i = 0; i < 25; i++) seeded.push(mkEntry(`a-${i}`, 'pcA', i + 1))
	for (let i = 0; i < 16; i++) seeded.push(mkEntry(`c-${i}`, 'pcC', 30 + i))
	seeded.push(mkEntry('b-1', 'pcB', 60))
	seeded.push(mkEntry('srv-1', null, 156))

	await writeFile(join(dataDir, 'backups', 'history.json'), JSON.stringify(seeded))

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const swarm = {
		async agents() {
			return [
				{id: 'pcA', name: 'Desktop', online: true, allowed: true, on: true},
				{id: 'pcB', name: 'Laptop', online: false, allowed: true, on: true},
			]
		},
		async call() {
			return {added: 64, files: 1}
		},
		progress() {
			return null
		},
	}
	const run = async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts))
	const b1 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: {backupTargets: async () => []}, swarm, resticPath: '/bin/restic', unshare: false, timers: false, run})
	let b2
	t.after(async () => {
		b1.close()
		b2?.close()
		await rm(root, {recursive: true, force: true})
	})

	const st1 = await b1.procedures['backups.status'].run()
	assert.equal(st1.history.length, seeded.length)
	assert.equal(st1.history.some((r) => r.id === 'srv-1'), true)
	assert.equal(st1.last?.id, 'srv-1')

	// Configure and run a computer backup on pcA so saveHistory() runs, then reload a fresh instance.
	await b1.procedures['backups.configure'].run({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}})
	await b1.procedures['backups.setComputer'].run({id: 'pcA', folders: ['Documents'], enabled: true})
	await (await b1.runComputer('pcA', 'manual')).done

	b2 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: {backupTargets: async () => []}, swarm, resticPath: '/bin/restic', unshare: false, timers: false, run})
	const st2 = await b2.procedures['backups.status'].run()
	assert.equal(st2.last?.id, 'srv-1')
	const comps = await b2.procedures['backups.computers'].run()
	assert.equal(comps.find((c) => c.id === 'pcB')?.last?.at, seeded.find((r) => r.id === 'b-1').endedAt)
	const saved = JSON.parse(await readFile(join(dataDir, 'backups', 'history.json'), 'utf8'))
	assert.equal(saved.filter((r) => r.computer === 'pcA').length, 20)
	assert.ok(saved.some((r) => r.id === 'b-1'))
	assert.ok(saved.some((r) => r.id === 'srv-1'))
})

test('status returns every saved run instead of cutting history at 20', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-hist-'))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'backups'), {recursive: true})
	const seeded = Array.from({length: 25}, (_, i) => ({
		id: `run-${i}`,
		reason: 'manual',
		startedAt: 1_000 - i,
		endedAt: 1_000 - i,
		ok: true,
		error: null,
		items: [],
		added: 1,
		nas: {ok: true},
	}))
	await writeFile(join(dataDir, 'backups', 'history.json'), JSON.stringify(seeded))
	const b = createBackups({dataDir, home: join(root, 'home'), serverDataDir: join(root, 'none'), files: fakeFiles(join(root, 'home')), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: async () => ({stdout: '', stderr: ''})})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	const st = await b.procedures['backups.status'].run()
	assert.equal(st.history.length, 25)
	assert.equal(st.history.some((r) => r.id === 'run-24'), true)
})

async function until(fn, ms = 4000) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		last = await fn()
		if (last) return last
		await new Promise((r) => setTimeout(r, 30))
	}
	return last
}

test('the next backup or restore ignores a finished call’s progress', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-prog-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	let progress = {call: 1, percent: 0.99, step: 'Backing up', at: Date.now()}
	let releaseBackup
	let releaseRestore
	const swarm = {
		async agents() {
			return [{id: 'pc1', name: 'Study PC', online: true, allowed: true, on: true}]
		},
		call(_id, name) {
			if (name === 'backup-restore') return new Promise((r) => (releaseRestore = r))
			if (name === 'backup-run') return new Promise((r) => (releaseBackup = r))
			return {}
		},
		progress() {
			return progress
		},
	}
	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		swarm,
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		releaseBackup?.({added: 1, files: 1})
		releaseRestore?.({folder: 'Restored'})
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	const running = async () => (await b.procedures['backups.computers'].run()).find((c) => c.id === 'pc1')?.running
	await b.procedures['backups.configure'].run({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}})
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Documents'], enabled: true})
	const job = await b.runComputer('pc1', 'manual')
	assert.ok(await until(running))
	const started = Date.now()
	let jumped = null
	while (Date.now() - started < 1600) {
		const row = await running()
		if (row && row.progress > 0.2) {
			jumped = row.progress
			break
		}
		await new Promise((r) => setTimeout(r, 40))
	}
	assert.equal(jumped, null, `stale backup progress was applied: ${jumped}`)
	progress = {call: 2, percent: 0.5, step: 'Copying', at: Date.now()}
	const moved = await until(async () => {
		const row = await running()
		return row && Math.abs(row.progress - 0.425) < 0.001 ? row : null
	})
	assert.ok(moved, 'the backup did not show the new call’s progress')
	assert.equal(moved.step, 'Copying')
	releaseBackup({added: 4, files: 1})
	await job.done
	progress = {call: 2, percent: 0.99, step: 'Backing up', at: Date.now()}
	await plantSnapshot(join(home, 'Backups', 'Omarchy Server', 'computers', 'pc1'))
	const snaps = await b.procedures['backups.computerSnapshots'].run({id: 'pc1'})
	assert.ok(snaps[0]?.id)
	const restoring = b.procedures['backups.restoreComputer'].run({id: 'pc1', snapshotId: snaps[0].id})
	assert.ok(await until(running))
	const restoreStart = Date.now()
	let restoreJump = null
	while (Date.now() - restoreStart < 1600) {
		const row = await running()
		if (row && row.progress > 0.2) {
			restoreJump = row.progress
			break
		}
		await new Promise((r) => setTimeout(r, 40))
	}
	assert.equal(restoreJump, null, `stale restore progress was applied: ${restoreJump}`)
	progress = {call: 3, percent: 0.4, step: 'Restoring', at: Date.now()}
	const restored = await until(async () => {
		const row = await running()
		return row && Math.abs(row.progress - 0.4) < 0.001 ? row : null
	})
	assert.ok(restored, 'the restore did not show the new call’s progress')
	releaseRestore({folder: 'Restored/Docs'})
	await restoring
})

test('a computer backup stores unreadable files and skipped folders on the run', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-skip-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	const swarm = {
		async agents() {
			return [{id: 'pc1', name: 'Study PC', online: true, allowed: true, on: true}]
		},
		async call() {
			return {added: 2048, files: 9, skipped: ['Photos'], unreadable: true}
		},
		progress() {
			return null
		},
	}
	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		swarm,
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	await b.procedures['backups.configure'].run({nas: {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}})
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Documents', 'Photos'], enabled: true})
	await (await b.runComputer('pc1', 'manual')).done
	const st = await b.procedures['backups.status'].run()
	const item = st.history[0].items.find((i) => i.kind === 'computer')
	assert.equal(st.history[0].ok, true)
	assert.equal(st.history[0].error, null)
	assert.equal(item.unreadable, true)
	assert.deepEqual(item.skipped, ['Photos'])
	assert.equal(item.files, 9)
	const [c] = await b.procedures['backups.computers'].run()
	assert.equal(c.last.ok, true)
	assert.equal(c.last.unreadable, true)
	assert.deepEqual(c.last.skipped, ['Photos'])
	assert.equal(c.last.files, 9)
})

test('a removed computer’s backups stay listed and can be restored or deleted without the key', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-removed-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	let present = true
	const swarm = {
		async agents() {
			const others = [{id: 'pc2', name: 'Other', online: false, allowed: true, on: true}]
			return present ? [{id: 'pc1', name: 'Study PC', online: true, allowed: true, on: true}, ...others] : others
		},
		async call() {
			return {added: 100, files: 2}
		},
		progress() {
			return null
		},
	}
	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const calls = []
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		swarm,
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => {
			calls.push(cmd)
			return cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)
		},
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})
	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas})
	await b.procedures['backups.setComputer'].run({id: 'pc1', folders: ['Documents'], enabled: true})
	await (await b.runComputer('pc1', 'manual')).done
	const store = join(home, 'Backups', 'Omarchy Server', 'computers', 'pc1')
	await plantSnapshot(store)
	const keyPath = join(dataDir, 'backups', 'computers', 'pc1.key')
	const key = (await readFile(keyPath, 'utf8')).trim()
	assert.ok(key.length > 8)
	await mkdir(join(home, 'Backups', 'Omarchy Server', 'computers', 'not-a-store'), {recursive: true})
	await assert.rejects(b.procedures['backups.setComputer'].run({id: 'pc1', remove: true}), /still in your swarm/)
	const before = await stat(join(store, 'config'))
	assert.ok(before.isFile())
	present = false
	const listed = await b.procedures['backups.computers'].run()
	assert.equal(JSON.stringify(listed).includes(key), false)
	const removed = listed.find((c) => c.id === 'pc1')
	const other = listed.find((c) => c.id === 'pc2')
	assert.ok(other)
	assert.equal(removed?.removed, true)
	assert.equal(removed?.name, 'Study PC')
	assert.equal(other.removed, undefined)
	assert.equal(listed.some((c) => c.id === 'not-a-store'), false)
	const snaps = await b.procedures['backups.computerSnapshots'].run({id: 'pc1'})
	assert.equal(JSON.stringify(snaps).includes(key), false)
	assert.ok(snaps.length >= 1)
	await assert.rejects(b.procedures['backups.computerSnapshots'].run({id: 'missing'}), /isn’t in your swarm/)
	const smbBefore = calls.filter((c) => c === 'smbclient').length
	const started = await b.procedures['backups.restoreComputer'].run({id: 'pc1', snapshotId: snaps[0].id})
	assert.equal(JSON.stringify(started).includes(key), false)
	const done = await until(async () => {
		const row = (await b.procedures['backups.computers'].run()).find((c) => c.id === 'pc1')
		return row?.lastRestore?.ok ? row : null
	})
	assert.ok(done, 'restore did not finish')
	assert.equal(JSON.stringify(done.lastRestore).includes(key), false)
	assert.match(done.lastRestore.folder, /Restored/)
	assert.ok(restic.calls.some((c) => c.args[0] === 'restore'))
	const deleted = await b.procedures['backups.setComputer'].run({id: 'pc1', remove: true})
	assert.equal(JSON.stringify(deleted).includes(key), false)
	assert.equal(calls.filter((c) => c === 'smbclient').length, smbBefore)
	const after = await b.procedures['backups.computers'].run()
	assert.equal(after.some((c) => c.id === 'pc1'), false)
	assert.equal(after.some((c) => c.id === 'pc2'), true)
	await assert.rejects(stat(keyPath))
	await assert.rejects(stat(store))
	const cfg = JSON.parse(await readFile(join(dataDir, 'backups', 'config.json'), 'utf8'))
	assert.equal(cfg.computers.pc1, undefined)
	assert.equal(cfg.computers.pc2, undefined)
})
