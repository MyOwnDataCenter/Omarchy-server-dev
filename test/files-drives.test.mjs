// Files › Drives (/External): the drives mounted in Storage, browsable like Home.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {extraDrives} from '../omarchyd/system.mjs'

async function scratch({mounted = true} = {}) {
	const root = await mkdtemp(join(tmpdir(), 'files-drives-'))
	const home = join(root, 'home')
	const drivesDir = join(root, 'media')
	await mkdir(home, {recursive: true})
	if (mounted) {
		await mkdir(join(drivesDir, 'Backup', 'photos'), {recursive: true})
		await writeFile(join(drivesDir, 'Backup', 'photos', 'a.txt'), 'hello')
	}
	const files = createFiles({home, dataDir: join(root, 'data'), drivesDir})
	const call = (name, input) => files.procedures[name].run(input)
	return {root, home, drivesDir, call}
}

test('a mounted drive shows in Drives, and its files open, copy and move like Home’s', async () => {
	const {root, home, call} = await scratch()
	try {
		const top = await call('files.list', {path: '/External'})
		assert.equal(top.name, 'Drives')
		assert.deepEqual(top.files.map((f) => f.name), ['Backup'])
		// The drive itself stays put: no move, rename or trash.
		assert.deepEqual(top.files[0].operations.filter((o) => ['move', 'rename', 'trash'].includes(o)), [])
		const inside = await call('files.list', {path: '/External/Backup/photos'})
		assert.deepEqual(inside.files.map((f) => f.name), ['a.txt'])
		assert.ok(inside.files[0].operations.includes('trash'))
		await call('files.createDirectory', {path: '/External/Backup/new'})
		await call('files.copy', {path: '/External/Backup/photos/a.txt', toDirectory: '/Home'})
		assert.equal(await readFile(join(home, 'a.txt'), 'utf8'), 'hello')
		const trashed = await call('files.trash', {path: '/External/Backup/new'})
		assert.match(trashed, /^\/Trash\//)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('nothing is made beside the drives, and a drive can’t be moved, renamed or trashed', async () => {
	const {root, call} = await scratch()
	try {
		await assert.rejects(call('files.createDirectory', {path: '/External/new'}), /cannot-create-here/)
		await assert.rejects(call('files.rename', {path: '/External/Backup', newName: 'x'}), /drive-root/)
		await assert.rejects(call('files.move', {path: '/External/Backup', toDirectory: '/Home'}), /drive-root/)
		await assert.rejects(call('files.trash', {path: '/External/Backup'}), /drive-root/)
		await assert.rejects(call('files.copy', {path: '/External/Backup/photos', toDirectory: '/External'}), /cannot-move/)
		await assert.rejects(call('files.list', {path: '/External/../home'}), /invalid-path/)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('with nothing mounted, Drives is empty, not an error', async () => {
	const {root, call} = await scratch({mounted: false})
	try {
		const top = await call('files.list', {path: '/External'})
		assert.deepEqual(top.files, [])
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('the server’s space counts drives mounted in Storage and pools, once each, not Home’s drive', async () => {
	const devs = {'/home/me': 1, '/run/media/me/Backup': 2, '/home/me/Pools/tank': 3, '/home/me/Pools/tank/sub': 3, '/run/media/me/Backup/deep': 2, '/mnt/other': 4}
	const mountsText = Object.keys(devs)
		.concat('/run/media/me/My\\040Disk')
		.map((m) => `/dev/x ${m} ext4 rw 0 0`)
		.join('\n')
	const got = await extraDrives('/home/me', {
		mountsText,
		user: 'me',
		pathStat: async (p) => ({dev: devs[p] ?? (p === '/run/media/me/My Disk' ? 5 : 0)}),
		fsStat: async () => ({blocks: 100, bsize: 1000, bfree: 40, bavail: 30}),
	})
	assert.deepEqual(
		got.map((d) => [d.name, d.folder, d.size, d.used, d.available]),
		[
			['Backup', '/External/Backup', 100000, 60000, 30000],
			['tank', '/Home/Pools/tank', 100000, 60000, 30000],
			['My Disk', '/External/My Disk', 100000, 60000, 30000],
		],
	)
})
