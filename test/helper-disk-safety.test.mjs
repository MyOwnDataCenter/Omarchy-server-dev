import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdir, mkdtemp, rm, symlink} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {describe, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {createHelper} from '../helper/helper.mjs'

const user = {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'}
const helperPath = fileURLToPath(new URL('../helper/helper.mjs', import.meta.url))

function fakeFs(initial = {}) {
	const files = new Map(Object.entries(initial))
	return {
		files,
		readFile: async (p) => {
			if (!files.has(p)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
			return files.get(p)
		},
		writeFile: async (p, t) => void files.set(p, t),
		rename: async (a, b) => void (files.set(b, files.get(a)), files.delete(a)),
		mkdir: async () => {},
		chown: async () => {},
		realpath: async (p) => p,
		readdir: async () => [],
	}
}

function invoke(script) {
	return new Promise((resolve) => {
		execFile(process.execPath, ['--experimental-strip-types', script, 'ping'], {timeout: 20_000}, (error, stdout, stderr) => {
			resolve({code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '')})
		})
	})
}

describe('helper disk safety', () => {
	test('format names a missing mkfs program and does not wipe the drive', async () => {
		const blank = {blockdevices: [{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 1e12, mountpoints: [null]}]}
		for (const [fsKind, prog, message] of [
			['exfat', 'mkfs.exfat', /exFAT tools aren't installed on this computer \(exfatprogs\)/],
			['ext4', 'mkfs.ext4', /mkfs\.ext4 isn't installed on this computer/],
		]) {
			const log = []
			const fs = fakeFs()
			fs.access = async (p) => {
				if (p.endsWith(`/${prog}`)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
			}
			const run = async (cmd, args = []) => {
				log.push([cmd, ...args])
				if (cmd === 'lsblk') return JSON.stringify(blank)
				if (cmd === 'zpool') return ''
				if (cmd === prog) throw Object.assign(new Error(`spawn ${prog} ENOENT`), {code: 'ENOENT'})
				return ''
			}
			const h = createHelper({user, fs, run})
			await assert.rejects(h.handle('format', ['/dev/sdb', fsKind]), message)
			await assert.rejects(h.handle('format', ['/dev/sdb', fsKind]), new RegExp(prog.replace('.', '\\.')))
			assert.equal(log.some((l) => l[0] === 'wipefs' && l[1] === '-a'), false, `${prog} missing must not wipe`)
		}
	})

	test('zfs-export exports before it unmounts, and a failed export leaves the mount and fstab', async () => {
		const line = '/tank /home/chris/Pools/tank none bind,nosuid,nodev,nofail,x-systemd.requires=zfs-mount.service 0 0 # omarchy-server zfs tank'
		const original = `UUID=1 / ext4 defaults 0 0\n${line}\n`
		const fs = fakeFs({'/etc/fstab': original})
		const log = []
		let exportFails = true
		const run = async (cmd, args = []) => {
			log.push([cmd, ...args])
			if (cmd === 'zpool' && args[0] === 'list') return 'tank\n'
			if (cmd === 'zpool' && args[0] === 'export') {
				if (exportFails) throw new Error('pool is busy')
				return ''
			}
			if (cmd === 'umount' && exportFails) throw new Error('umount: target is busy')
			return ''
		}
		const h = createHelper({user, fs, run})
		await assert.rejects(h.handle('zfs-export', ['tank']), /tank is in use/)
		assert.equal(fs.files.get('/etc/fstab'), original)
		assert.equal(log.some((l) => l[0] === 'umount'), false)
		assert.ok(log.some((l) => l[0] === 'zpool' && l[1] === 'export' && l[2] === 'tank'))

		exportFails = false
		log.length = 0
		assert.equal(await h.handle('zfs-export', ['tank']), 'ok')
		const exportAt = log.findIndex((l) => l[0] === 'zpool' && l[1] === 'export')
		const umountAt = log.findIndex((l) => l[0] === 'umount' && l[1] === '/home/chris/Pools/tank')
		assert.ok(exportAt >= 0 && umountAt > exportAt, 'export runs before the bind is unmounted')
		assert.equal(fs.files.get('/etc/fstab').includes('# omarchy-server zfs tank'), false)
		assert.ok(log.some((l) => l[0] === 'systemctl' && l[1] === 'daemon-reload'))
	})

	test('umount unmounts a nested mount before its parent', async () => {
		const tree = {
			blockdevices: [
				{
					name: 'sdb',
					path: '/dev/sdb',
					type: 'disk',
					size: 1e12,
					children: [{name: 'sdb1', path: '/dev/sdb1', type: 'part', fstype: 'btrfs', mountpoints: ['/media/me/data', '/media/me/data/photos']}],
				},
			],
		}
		const mounted = new Set(['/media/me/data', '/media/me/data/photos'])
		const log = []
		const run = async (cmd, args = []) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(tree)
			if (cmd === 'zpool') return ''
			if (cmd === 'umount') {
				const target = args[0]
				for (const m of mounted) if (m !== target && m.startsWith(`${target}/`)) throw new Error(`umount: ${target}: target is busy.`)
				mounted.delete(target)
				return ''
			}
			return ''
		}
		const h = createHelper({user, fs: fakeFs(), run})
		assert.equal(await h.handle('umount', ['/dev/sdb']), 'ok')
		assert.deepEqual(
			log.filter((l) => l[0] === 'umount').map((l) => l[1]),
			['/media/me/data/photos', '/media/me/data'],
		)
	})

	test('zfs-pools counts K and M error suffixes', async () => {
		const status = `  pool: p
 state: ONLINE
  scan: scrub repaired 1.50M in 01:00:00 with 3 errors on Sun Nov  8 00:24:04 2026
config:

	NAME        STATE     READ WRITE CKSUM
	p           ONLINE       0     0 1.50M
	  /dev/sda  ONLINE      12K    0 1.50M

errors: 3 data errors, use '-v' for a list
`
		const run = async (cmd, args = []) => {
			if (cmd === 'zpool' && args[0] === 'list') return 'p\t1000\t100\t900\tONLINE\n'
			if (cmd === 'zpool' && args[0] === 'status') return status
			if (cmd === 'zfs') return '/home/chris/Pools/p\n'
			return ''
		}
		const h = createHelper({user, fs: fakeFs(), run})
		const [pool] = JSON.parse(await h.handle('zfs-pools'))
		assert.equal(pool.devices[0].path, '/dev/sda')
		assert.equal(pool.devices[0].errors, 12000 + 1500000)
	})

	test('direct-run guard runs through a symlink and a path with a space', async () => {
		const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-helper-'))
		try {
			const link = join(dir, 'helper-link.mjs')
			await symlink(helperPath, link)
			const spaced = join(dir, 'sp ace')
			await mkdir(spaced)
			const spacedHelper = join(spaced, 'helper.mjs')
			await symlink(helperPath, spacedHelper)
			for (const script of [link, spacedHelper]) {
				const result = await invoke(script)
				assert.equal(result.code, 2, result.stderr || result.stdout)
				assert.match(result.stderr, /Run this through sudo as the owner of this server/)
			}
		} finally {
			await rm(dir, {recursive: true, force: true})
		}
	})
})
