import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {createHelper} from '../helper/helper.mjs'

const user = {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'}

const lsblk = {
	blockdevices: [
		{
			name: 'sdb',
			path: '/dev/sdb',
			type: 'disk',
			size: 4e12,
			children: [
				{name: 'sdb1', path: '/dev/sdb1', type: 'part', fstype: 'zfs_member', label: 'tank', uuid: '111', mountpoints: [null]},
			],
		},
	],
}

function fakeFs() {
	return {
		readFile: async () => {
			throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
		},
		writeFile: async () => {},
		rename: async () => {},
		mkdir: async () => {},
		chown: async () => {},
		realpath: async (p) => p,
		readdir: async () => [],
	}
}

function runWith(log, zpoolList) {
	return async (cmd, args = []) => {
		log.push([cmd, ...args])
		if (cmd === 'lsblk') return JSON.stringify(lsblk)
		if (cmd === 'zpool') {
			if (zpoolList instanceof Error) throw zpoolList
			if (args[0] === 'get') return String(zpoolList).trim() ? '111\n' : ''
			return zpoolList
		}
		if (cmd === 'wipefs') return JSON.stringify({signatures: []})
		return ''
	}
}

function helper(log, zpoolList) {
	return createHelper({user, fs: fakeFs(), run: runWith(log, zpoolList)})
}

describe('helper zfs pool member', () => {
	test('format and umount refuse a disk in an imported ZFS pool', async () => {
		const log = []
		const h = helper(log, 'tank\n')
		await assert.rejects(h.handle('format', ['/dev/sdb', 'blank']), /\/dev\/sdb is in a pool/)
		await assert.rejects(h.handle('umount', ['/dev/sdb']), /\/dev\/sdb is in a pool/)
		assert.equal(log.some((l) => l[0] === 'wipefs' && l[1] === '-a'), false)
	})

	test('format still wipes a zfs_member when the pool is not imported', async () => {
		const missing = []
		const gone = helper(missing, new Error('zpool: not found'))
		assert.equal(await gone.handle('format', ['/dev/sdb', 'blank']), 'ok')
		assert.ok(missing.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdb'))
		const empty = []
		const exported = helper(empty, '')
		assert.equal(await exported.handle('format', ['/dev/sdb', 'blank']), 'ok')
		assert.ok(empty.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdb'))
	})

	test('format allows a leftover disk whose pool name matches but whose guid does not', async () => {
		const real = '1111111111111111111'
		const foreign = '2222222222222222222'
		const tree = {
			blockdevices: [
				{name: 'sda', path: '/dev/sda', type: 'disk', size: 4e12, children: [{name: 'sda1', path: '/dev/sda1', type: 'part', fstype: 'zfs_member', label: 'tank', uuid: real, mountpoints: [null]}]},
				{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 4e12, children: [{name: 'sdb1', path: '/dev/sdb1', type: 'part', fstype: 'zfs_member', label: 'tank', uuid: foreign, mountpoints: [null]}]},
			],
		}
		const log = []
		const run = async (cmd, args = []) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(tree)
			if (cmd === 'zpool' && args[0] === 'list') return 'tank\n'
			if (cmd === 'zpool' && args[0] === 'get') return `${real}\n`
			if (cmd === 'wipefs') return JSON.stringify({signatures: []})
			return ''
		}
		const h = createHelper({user, fs: fakeFs(), run})
		await assert.rejects(h.handle('format', ['/dev/sda', 'blank']), /\/dev\/sda is in a pool/)
		assert.equal(log.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sda'), false)
		assert.equal(await h.handle('format', ['/dev/sdb', 'blank']), 'ok')
		assert.ok(log.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdb'))
	})

	test('a failed guid lookup still refuses a disk whose label is an imported pool', async () => {
		const log = []
		const run = async (cmd, args = []) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(lsblk)
			if (cmd === 'zpool' && args[0] === 'list') return 'tank\n'
			if (cmd === 'zpool' && args[0] === 'get') throw new Error('zpool get failed')
			if (cmd === 'wipefs') return JSON.stringify({signatures: []})
			return ''
		}
		const h = createHelper({user, fs: fakeFs(), run})
		await assert.rejects(h.handle('format', ['/dev/sdb', 'blank']), /\/dev\/sdb is in a pool/)
		assert.equal(log.some((l) => l[0] === 'wipefs' && l[1] === '-a'), false)
	})
})
