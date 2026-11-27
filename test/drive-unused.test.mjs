// Unused space on the system drive is unallocated room plus a filesystem that lags its partition,
// not the whole disk minus the filesystem (that counts other partitions and metadata).
import assert from 'node:assert/strict'
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {diskUsage, forgetDrive, unusedDriveBytes} from '../omarchyd/system.mjs'

const GiB = 1024 ** 3

test('unallocated space ignores other partitions and filesystem overhead', () => {
	const fsSize = 23.5 * GiB
	const overhead = 0.47 * GiB
	const efi = 1 * GiB
	const swap = 8 * GiB
	const root = fsSize + overhead
	const partLag = 100 * GiB
	const diskSize = efi + swap + root + partLag
	const unused = unusedDriveBytes({diskSize, partSizes: [efi, swap, root], fsPartitionSize: root, fsSize})
	assert.ok(Math.abs(unused / GiB - 100) < 0.05, `expected about 100 GiB, got ${unused / GiB}`)
	const old = Math.max(0, diskSize - fsSize)
	assert.ok(Math.abs(old / GiB - 109.47) < 0.05)
	assert.ok(unused < old - GiB, 'other partitions are not unused')
	const behind = unusedDriveBytes({diskSize: partLag + root, partSizes: [root], fsPartitionSize: root, fsSize: root - 10 * GiB})
	assert.ok(Math.abs(behind / GiB - 110) < 0.05, 'partition gap plus a filesystem that is far behind its partition')
})

test('diskUsage reports that unused figure for a drive with other partitions', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unused-drive-'))
	const bin = join(dir, 'bin')
	await import('node:fs/promises').then((fs) => fs.mkdir(bin))
	const efi = 1 * GiB
	const swap = 8 * GiB
	const root = 40 * GiB
	const partLag = 100 * GiB
	const disk = efi + swap + root + partLag
	const chain = JSON.stringify({
		blockdevices: [{name: 'sda3', path: '/dev/sda3', size: root, type: 'part', children: [{name: 'sda', path: '/dev/sda', size: disk, type: 'disk'}]}],
	})
	const tree = JSON.stringify({
		blockdevices: [
			{
				name: 'sda',
				path: '/dev/sda',
				size: disk,
				type: 'disk',
				children: [
					{name: 'sda1', path: '/dev/sda1', size: efi, type: 'part', start: 2048},
					{name: 'sda2', path: '/dev/sda2', size: swap, type: 'part', start: 3_000_000},
					{name: 'sda3', path: '/dev/sda3', size: root, type: 'part', start: 20_000_000},
				],
			},
		],
	})
	await writeFile(join(bin, 'findmnt'), '#!/bin/sh\necho "/dev/sda3 ext4"\n', {mode: 0o755})
	await writeFile(join(bin, 'lsblk'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-s" ] && printf '%s\\n' '${chain.replace(/'/g, "'\\''")}' && exit 0; done\nprintf '%s\\n' '${tree.replace(/'/g, "'\\''")}'\n`, {mode: 0o755})
	await chmod(join(bin, 'findmnt'), 0o755)
	await chmod(join(bin, 'lsblk'), 0o755)
	const prev = process.env.PATH
	process.env.PATH = `${bin}:${prev}`
	try {
		forgetDrive()
		const r = await diskUsage(dir)
		assert.ok(r.drive, 'drive layout was read')
		assert.equal(r.drive.size, disk)
		assert.deepEqual(r.drive.steps, ['partition', 'filesystem'])
		const expected = unusedDriveBytes({diskSize: disk, partSizes: [efi, swap, root], fsPartitionSize: root, fsSize: r.size})
		assert.equal(r.drive.notInUse, expected)
		assert.notEqual(r.drive.notInUse, Math.max(0, disk - r.size))
		assert.ok(r.drive.notInUse <= partLag + root)
		assert.ok(Math.abs(r.drive.notInUse - partLag) <= root, 'EFI and swap are not counted as free')
	} finally {
		process.env.PATH = prev
		forgetDrive()
		await rm(dir, {recursive: true, force: true})
	}
})
