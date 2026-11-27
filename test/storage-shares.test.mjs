// Drive sleep, reserved Samba names, a failed share apply, and the share password read path.
import assert from 'node:assert/strict'
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {createStorage} from '../omarchyd/storage.mjs'

const lsblk = {
	blockdevices: [{name: 'sda', path: '/dev/sda', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'SER1', mountpoints: [null]}],
}

function diskRun(log) {
	return async (cmd, args) => {
		if (cmd === 'lsblk') return JSON.stringify(lsblk)
		const verb = args?.[2]
		log.push(verb)
		if (verb === 'ping') return 'ok\n'
		if (verb === 'zfs-available') return 'no\n'
		if (verb === 'smart') return JSON.stringify({smart_status: {passed: true}, temperature: {current: 30}})
		if (verb === 'sleep') return 'ok\n'
		return 'ok\n'
	}
}

function sambaRun(log, {failApply} = {}) {
	return async (cmd, args, opts) => {
		if (cmd === 'sh') return '/usr/bin/omarchy\n'
		if (cmd === 'pacman' && args?.[0] === '-Q') return `${args[1]} 1\n`
		const verb = args?.[2]
		const entry = {verb, input: opts?.input, ok: false}
		log.push(entry)
		if (verb === 'shares-apply' && opts?.input) {
			for (const share of JSON.parse(opts.input).shares ?? []) {
				if (/^(global|homes|printers)$/i.test(share.name)) throw new Error(`Bad share name: ${share.name}`)
			}
		}
		if (verb === 'shares-apply' && failApply?.()) throw new Error('samba failed')
		entry.ok = true
		if (verb === 'ping' || verb === 'shares-apply' || verb === 'smb-password') return 'ok\n'
		return 'ok\n'
	}
}

describe('drive-sleep.json', () => {
	let root
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchy-sleep-'))
	})
	after(() => rm(root, {recursive: true, force: true}))

	test('storage.disks lists drives when drive-sleep.json is missing, empty, or damaged', async () => {
		const cases = ['missing', '', '{"a":', 'null', '[]', '"x"', '{}', '{"SER1":12}']
		for (const contents of cases) {
			const data = join(root, `disks-${contents.length}-${contents.includes('SER1') ? 'ok' : contents === 'missing' ? 'miss' : 'bad' + cases.indexOf(contents)}`)
			await mkdir(data)
			if (contents !== 'missing') await writeFile(join(data, 'drive-sleep.json'), contents)
			const s = createStorage({
				dataDir: data,
				home: '/home/chris',
				files: {resolve: async () => ({real: '/home/chris', top: 'Home'})},
				run: diskRun([]),
				fstabPath: join(data, 'fstab'),
			})
			const disks = await s.procedures['storage.disks'].run()
			assert.equal(disks.length, 1, `listed drives for ${JSON.stringify(contents)}`)
			assert.equal(disks[0].name, 'sda')
			assert.equal(disks[0].sleepMinutes, contents === '{"SER1":12}' ? 12 : null)
			if (contents !== 'missing') assert.equal(await readFile(join(data, 'drive-sleep.json'), 'utf8'), contents, 'drive-sleep.json was left unchanged')
		}
	})

	test('storage.setSleep reads drive-sleep.json before changing the drive', async () => {
		const damaged = ['{"a":', 'null', '[]', '"x"']
		for (const contents of damaged) {
			const data = join(root, `set-${damaged.indexOf(contents)}`)
			await mkdir(data)
			const file = join(data, 'drive-sleep.json')
			await writeFile(file, contents)
			const log = []
			const s = createStorage({
				dataDir: data,
				home: '/home/chris',
				files: {resolve: async () => ({real: '/home/chris', top: 'Home'})},
				run: diskRun(log),
				fstabPath: join(data, 'fstab'),
			})
			const before = log.filter((v) => v === 'sleep').length
			let error
			try {
				await s.procedures['storage.setSleep'].run({device: '/dev/sda', minutes: 10})
			} catch (e) {
				error = e
			}
			assert.equal(log.filter((v) => v === 'sleep').length, before, `helper sleep already ran for ${JSON.stringify(contents)}`)
			assert.equal(error?.code, 'PRECONDITION_FAILED', `expected a named error for ${JSON.stringify(contents)}`)
			assert.match(error.message, /drive-sleep\.json/)
			assert.match(error.message, /left unchanged/)
			assert.equal(await readFile(file, 'utf8'), contents)
		}

		for (const contents of ['missing', '']) {
			const data = join(root, `set-ok-${contents === '' ? 'empty' : 'miss'}`)
			await mkdir(data)
			if (contents === '') await writeFile(join(data, 'drive-sleep.json'), '')
			const log = []
			const s = createStorage({
				dataDir: data,
				home: '/home/chris',
				files: {resolve: async () => ({real: '/home/chris', top: 'Home'})},
				run: diskRun(log),
				fstabPath: join(data, 'fstab'),
			})
			assert.equal(await s.procedures['storage.setSleep'].run({device: '/dev/sda', minutes: 10}), true, contents)
			assert.equal(log.filter((v) => v === 'sleep').length, 1, contents)
			assert.deepEqual(JSON.parse(await readFile(join(data, 'drive-sleep.json'), 'utf8')), {SER1: 10})
		}
	})
})

describe('saved shares', () => {
	let root
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchy-share-fix-'))
	})
	after(() => rm(root, {recursive: true, force: true}))

	test('a saved share named Printers, Global, or Homes is renamed so later share changes work', async () => {
		const data = join(root, 'reserved')
		await mkdir(data)
		const saved = [
			{name: 'Printers', path: '/Home/Printers'},
			{name: 'Printers 2', path: '/Home/Kept'},
			{name: 'Global', path: '/Home/Global'},
			{name: 'homes', path: '/Home/Homes'},
			{name: 'Documents', path: '/Home/Documents'},
		]
		await writeFile(join(data, 'shares.json'), JSON.stringify(saved))
		const log = []
		const files = {resolve: async (p) => ({real: p.replace('/Home', '/home/chris'), top: p.startsWith('/Home') ? 'Home' : 'Other'})}
		const s = createStorage({
			dataDir: data,
			home: '/home/chris',
			files,
			run: sambaRun(log),
			fstabPath: join(data, 'fstab'),
			smbConf: join(data, 'smb.conf'),
		})
		await writeFile(join(data, 'smb.conf'), '')
		await s.procedures['files.addShare'].run({path: '/Home/Music'})
		await s.procedures['files.updateShare'].run({path: '/Home/Documents', readOnly: true})
		await s.procedures['files.removeShare'].run({path: '/Home/Documents'})
		const list = await s.procedures['files.shares'].run()
		const names = list.map((x) => x.name)
		assert.equal(names.some((n) => /^(global|homes|printers)$/i.test(n)), false)
		assert.ok(list.some((x) => x.path === '/Home/Printers' && x.name === 'Printers 3'))
		assert.ok(list.some((x) => x.path === '/Home/Kept' && x.name === 'Printers 2'))
		assert.ok(list.some((x) => x.path === '/Home/Global' && x.name === 'Global 2'))
		assert.ok(list.some((x) => x.path === '/Home/Homes' && x.name === 'Homes 2'))
		assert.ok(list.some((x) => x.path === '/Home/Music'))
		assert.equal(list.some((x) => x.path === '/Home/Documents'), false)
		const onDisk = JSON.parse(await readFile(join(data, 'shares.json'), 'utf8'))
		assert.equal(onDisk.some((x) => /^(global|homes|printers)$/i.test(x.name)), false)
		assert.ok(onDisk.some((x) => x.path === '/Home/Printers' && x.name === 'Printers 3'))
		const applied = log.filter((c) => c.verb === 'shares-apply').map((c) => JSON.parse(c.input).shares)
		assert.ok(applied.length > 0)
		assert.equal(applied.some((shares) => shares.some((x) => /^(global|homes|printers)$/i.test(x.name))), false)
	})

	test('a failed Samba apply after a shared folder is renamed is reported and retried', async () => {
		const scratch = await mkdtemp(join(root, 'move-'))
		await mkdir(join(scratch, 'home'))
		const home = await realpath(join(scratch, 'home'))
		const data = join(scratch, 'data')
		await mkdir(join(home, 'Documents', 'p'), {recursive: true})
		await mkdir(data)
		let failApply = false
		const log = []
		const run = sambaRun(log, {failApply: () => failApply})
		const files = createFiles({home, dataDir: data})
		const storage = createStorage({dataDir: data, home, files, run, fstabPath: join(scratch, 'fstab'), smbConf: join(scratch, 'smb.conf')})
		await storage.procedures['files.addShare'].run({path: '/Home/Documents/p'})
		const applied = () => log.filter((c) => c.verb === 'shares-apply' && c.ok && c.input).map((c) => JSON.parse(c.input).shares.map((s) => s.path))
		assert.ok(applied().at(-1).some((p) => p.endsWith('/Documents/p')))

		failApply = true
		await assert.rejects(files.procedures['files.rename'].run({path: '/Home/Documents/p', newName: 'q'}), /samba failed/)
		const saved = JSON.parse(await readFile(join(data, 'shares.json'), 'utf8'))
		assert.equal(saved.find((s) => s.name === 'p').path, '/Home/Documents/q')
		assert.equal(applied().some((list) => list.some((p) => p.endsWith('/Documents/q'))), false, 'Samba still has the old path')
		const attempts = log.filter((c) => c.verb === 'shares-apply').length
		await assert.rejects(storage.procedures['files.shares'].run(), /samba failed/)
		assert.ok(log.filter((c) => c.verb === 'shares-apply').length > attempts, 'the next share call retried the apply')
		assert.equal(JSON.parse(await readFile(join(data, 'shares.json'), 'utf8')).find((s) => s.name === 'p').path, '/Home/Documents/q')

		failApply = false
		let startupPaths
		const seen = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('startup did not retry shares-apply')), 2000)
			startupPaths = (paths) => {
				clearTimeout(timer)
				resolve(paths)
			}
		})
		const run2 = async (cmd, args, opts) => {
			if (cmd === 'sh') return '/usr/bin/omarchy\n'
			if (cmd === 'pacman' && args?.[0] === '-Q') return `${args[1]} 1\n`
			if (args?.[2] === 'shares-apply') {
				const paths = JSON.parse(opts.input).shares.map((s) => s.path)
				if (paths.some((p) => p.endsWith('/Documents/q'))) startupPaths(paths)
				return 'ok\n'
			}
			if (args?.[2] === 'ping' || args?.[2] === 'smb-password') return 'ok\n'
			return 'ok\n'
		}
		createStorage({dataDir: data, home, files: createFiles({home, dataDir: data}), run: run2, fstabPath: join(scratch, 'fstab'), smbConf: join(scratch, 'smb.conf')})
		const paths = await seen
		assert.ok(paths.some((p) => p.endsWith('/Documents/q')))
		await access(join(home, 'Documents', 'q'))
	})

	test('a share password with leading or trailing spaces is shown unchanged', async () => {
		const data = join(root, 'pw')
		await mkdir(data)
		const smb = join(data, 'smb.conf')
		await writeFile(smb, '')
		const log = []
		const s = createStorage({
			dataDir: data,
			home: '/home/chris',
			files: {resolve: async (p) => ({real: p.replace('/Home', '/home/chris'), top: 'Home'})},
			run: sambaRun(log),
			fstabPath: join(data, 'fstab'),
			smbConf: smb,
		})
		await s.procedures['files.setSharePassword'].run({password: '  secret pass  '})
		assert.equal(log.filter((c) => c.verb === 'smb-password').at(-1).input, '  secret pass  \n')
		assert.equal(await readFile(join(data, 'share-password'), 'utf8'), '  secret pass  ')
		assert.equal(await s.procedures['files.sharePassword'].run(), '  secret pass  ')
		await s.procedures['files.setSharePassword'].run({password: '        '})
		assert.equal(await s.procedures['files.sharePassword'].run(), '        ')
	})

	test('a folder named _Archive, -old, or with a leading space still gets a share name', async () => {
		const scratch = await mkdtemp(join(root, 'odd-'))
		await mkdir(join(scratch, 'home'))
		const home = await realpath(join(scratch, 'home'))
		const data = join(scratch, 'data')
		await mkdir(data)
		for (const name of ['_Archive', '-old', ' notes']) await mkdir(join(home, name))
		const log = []
		const files = createFiles({home, dataDir: data})
		const storage = createStorage({dataDir: data, home, files, run: sambaRun(log), fstabPath: join(scratch, 'fstab'), smbConf: join(scratch, 'smb.conf')})
		const add = (path) => storage.procedures['files.addShare'].run({path})
		assert.equal(await add('/Home/_Archive'), 'Archive')
		assert.equal(await add('/Home/-old'), 'old')
		assert.equal(await add('/Home/ notes'), 'notes')
		const saved = JSON.parse(await readFile(join(data, 'shares.json'), 'utf8'))
		assert.deepEqual(
			saved.map((s) => s.name),
			['Archive', 'old', 'notes'],
		)
		const applied = log.filter((c) => c.verb === 'shares-apply' && c.ok).at(-1)
		assert.deepEqual(JSON.parse(applied.input).shares.map((s) => s.name), ['Archive', 'old', 'notes'])
	})

	test('sudo for storage tools is spawned with LC_ALL=C', async () => {
		const data = join(root, 'locale')
		await mkdir(data)
		await mkdir(join(root, 'locale-home', 'Music'), {recursive: true})
		const home = await realpath(join(root, 'locale-home'))
		const calls = []
		const run = async (cmd, args, opts) => {
			calls.push({cmd, args, env: opts?.env})
			if (cmd === 'sh') return '/usr/bin/omarchy\n'
			if (cmd === 'pacman' && args?.[0] === '-Q') return `${args[1]} 1\n`
			if (cmd === 'lsblk') return JSON.stringify(lsblk)
			const verb = args?.[2]
			if (verb === 'ping' || verb === 'shares-apply' || verb === 'smb-password') return 'ok\n'
			return 'ok\n'
		}
		const files = createFiles({home, dataDir: data})
		const storage = createStorage({dataDir: data, home, files, run, fstabPath: join(data, 'fstab'), smbConf: join(data, 'smb.conf')})
		await storage.procedures['storage.status'].run()
		await storage.procedures['files.addShare'].run({path: '/Home/Music'})
		const sudos = calls.filter((c) => c.cmd === 'sudo')
		assert.ok(sudos.length >= 2, 'status and the share helper both call sudo')
		for (const call of sudos) assert.equal(call.env?.LC_ALL, 'C')
	})

	test('a damaged shares.json does not fail a rename that already finished, and a real Samba failure still does', async () => {
		const scratch = await mkdtemp(join(root, 'reloc-'))
		await mkdir(join(scratch, 'home'))
		const home = await realpath(join(scratch, 'home'))
		const data = join(scratch, 'data')
		await mkdir(join(home, 'Music'), {recursive: true})
		await mkdir(data)
		const file = join(data, 'shares.json')
		const secret = 'super-secret-share'
		let failApply = false
		const log = []
		const run = async (cmd, args, opts) => {
			if (cmd === 'sh') return '/usr/bin/omarchy\n'
			if (cmd === 'pacman' && args?.[0] === '-Q') return `${args[1]} 1\n`
			const verb = args?.[2]
			log.push(verb)
			if (verb === 'shares-apply' && failApply) throw new Error('samba failed')
			if (verb === 'ping' || verb === 'shares-apply' || verb === 'smb-password') return 'ok\n'
			return 'ok\n'
		}
		const files = createFiles({home, dataDir: data})
		const storage = createStorage({dataDir: data, home, files, run, fstabPath: join(scratch, 'fstab'), smbConf: join(scratch, 'smb.conf')})
		const errors = []
		const orig = console.error
		console.error = (...parts) => errors.push(parts.map(String).join(' '))
		try {
			for (const contents of [`{"password":"${secret}"`, `{"password":"${secret}"}`]) {
				await writeFile(file, contents)
				const before = log.filter((v) => v === 'shares-apply').length
				const renamed = contents.startsWith('{"password":"super-secret-share"}') ? 'TunesObj' : 'TunesCut'
				const from = contents.includes('}') ? '/Home/Music' : '/Home/Music'
				// First case starts at Music. Second case starts wherever the first rename left the folder.
				const current = contents.includes('}') ? '/Home/TunesCut' : '/Home/Music'
				await files.procedures['files.rename'].run({path: current, newName: renamed})
				assert.equal(await readFile(file, 'utf8'), contents, 'shares.json bytes stay as they were')
				assert.equal(log.filter((v) => v === 'shares-apply').length, before, 'the helper is not asked')
				await access(join(home, renamed))
			}
			assert.ok(errors.some((line) => line.includes('shares.json')))
			assert.equal(errors.some((line) => line.includes(secret)), false)
			await assert.rejects(storage.procedures['files.shares'].run(), (error) => {
				assert.equal(error.code, 'PRECONDITION_FAILED')
				assert.match(error.message, /shares\.json is damaged and was left unchanged/)
				return true
			})

			const valid = [{name: 'Kept', path: '/Home/TunesObj'}]
			await writeFile(file, JSON.stringify(valid))
			const beforeOk = log.filter((v) => v === 'shares-apply').length
			await files.procedures['files.rename'].run({path: '/Home/TunesObj', newName: 'Library'})
			assert.ok(log.filter((v) => v === 'shares-apply').length > beforeOk, 'a real path change still applies')
			assert.equal(JSON.parse(await readFile(file, 'utf8')).find((s) => s.name === 'Kept').path, '/Home/Library')

			failApply = true
			await assert.rejects(files.procedures['files.rename'].run({path: '/Home/Library', newName: 'Stacks'}), /samba failed/)
		} finally {
			console.error = orig
		}
	})
})
