// Machine start, snapshot, and settings bugs. libvirt, qemu-img, xorriso, and openssl are stubbed.
import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'
import {hostdevXml} from '../omarchyd/usb.mjs'

const CATALOG = {
	version: 1,
	images: [{id: 'testos-amd64', familyId: 'debian', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/os.qcow2', checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo'}],
}

const HASH = '$6$testsalt$hashedpassword\n'

function disk(id, file, extra = {}) {
	return {id, file, device: 'disk', bus: 'virtio', format: 'qcow2', ...extra}
}

function baseMachine(id, {name = 'Box', disks, snapshots = [], cloudInit, osId = 'testos-amd64'} = {}) {
	return {
		id,
		name,
		osId,
		cores: 1,
		memoryGb: 1,
		memoryMb: 1024,
		diskSizeGb: 10,
		portForwards: [],
		createdAt: 1,
		mac: '52:54:00:11:22:33',
		vmid: 100 + Number.parseInt(id.slice(0, 2), 16) % 50,
		options: {},
		tasks: [],
		snapshots,
		...(cloudInit ? {cloudInit} : {}),
		layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks},
	}
}

async function open({machines = [], run, files = null}) {
	const root = await mkdtemp(join(os.tmpdir(), 'om-life-'))
	const dataDir = join(root, 'data')
	const catalogUrl = join(root, 'catalog.json')
	await writeFile(catalogUrl, JSON.stringify(CATALOG))
	await mkdir(join(dataDir, 'machines'), {recursive: true})
	if (machines.length) await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines}))
	const api = createMachines({
		dataDir,
		catalogUrl,
		fetchImpl: async () => {
			throw new Error('no network in this test')
		},
		run,
		kvmDevice: join(root, 'no-kvm'),
		files,
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
	})
	await api.ready
	const call = (name, input) => api.procedures[name].run(input)
	return {root, dataDir, api, call}
}

const until = async (fn, ms = 4000) => {
	const end = Date.now() + ms
	let last = null
	while (Date.now() < end) {
		last = await fn()
		if (last) return last
		await new Promise((r) => setTimeout(r, 20))
	}
	return last
}

test('#455 updateCloudInit rejects a password with NUL and does not call openssl', async () => {
	const calls = []
	const id = 'abcd1234'
	const dir = '/tmp/om-life-unused'
	const m = baseMachine(id, {
		disks: [disk('disk0', `${dir}/disk.qcow2`), {id: 'seed', role: 'seed', file: `${dir}/seed.iso`, device: 'cdrom', bus: 'sata', format: 'raw'}],
		cloudInit: {username: 'chris', hostname: 'box', sshKeys: []},
	})
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		calls.push([cmd, ...a].join(' '))
		if (cmd === 'openssl') return HASH
		if (cmd === 'virsh' && a[0] === 'define') return ''
		if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
		return ''
	}
	const {root, call} = await open({machines: [m], run})
	try {
		const openssl = () => calls.filter((c) => c.startsWith('openssl')).length
		const before = openssl()
		let error = null
		try {
			await call('machines.updateCloudInit', {id, password: 'ab\0cd'})
		} catch (e) {
			error = e
		}
		assert.equal(openssl(), before, 'openssl must not see a NUL password')
		assert.match(error?.message ?? '', /That password can’t be used/)
		error = null
		try {
			await call('machines.updateCloudInit', {id, password: '\0'})
		} catch (e) {
			error = e
		}
		assert.equal(openssl(), before, 'a password that is only NUL must not call openssl')
		assert.match(error?.message ?? '', /That password can’t be used/)
		await call('machines.updateCloudInit', {id, password: 'perfectly-fine'})
		assert.equal(openssl(), before + 1)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('#455 create rejects a password with NUL', async () => {
	const calls = []
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		calls.push([cmd, ...a].join(' '))
		if (cmd === 'openssl') return HASH
		if (cmd === 'virsh' && a[0] === '--version') return '10.0.0\n'
		if (cmd === 'qemu-img' && a[0] === '--version') return 'qemu-img version 9.0\n'
		return ''
	}
	const {root, call} = await open({run})
	try {
		const before = calls.filter((c) => c.startsWith('openssl')).length
		let error = null
		try {
			await call('machines.create', {name: 'Nulled', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'ab\0cd'})
		} catch (e) {
			error = e
		}
		assert.match(error?.message ?? '', /Enter a password for the machine/)
		assert.equal(calls.filter((c) => c.startsWith('openssl')).length, before)
	} finally {
		await rm(root, {recursive: true, force: true}).catch(() => {})
	}
})

test('#306 create rejects a name that XML cannot hold', async () => {
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === '--version') return '10.0.0\n'
		if (cmd === 'qemu-img' && a[0] === '--version') return 'qemu-img version 9.0\n'
		return ''
	}
	const {root, call} = await open({run})
	try {
		let error = null
		try {
			await call('machines.create', {name: 'Bad\x1bName', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'secret-pass'})
		} catch (e) {
			error = e
		}
		assert.match(error?.message ?? '', /That name can’t be used/)
		const listed = await call('machines.list')
		assert.equal(listed.some((m) => String(m.name).includes('\x1b')), false)
	} finally {
		await rm(root, {recursive: true, force: true}).catch(() => {})
	}
})

test('#317 an installer seed drive is not cloud-init', async () => {
	const calls = []
	const installer = 'abcd1234'
	const cloud = 'abcd1235'
	const seed = {id: 'seed', role: 'seed', file: '/tmp/seed.iso', device: 'cdrom', bus: 'sata', format: 'raw'}
	const machines = [
		baseMachine(installer, {name: 'Omarchy', osId: 'omarchy-9-amd64', disks: [disk('disk0', '/tmp/disk.qcow2'), seed]}),
		baseMachine(cloud, {
			name: 'Cloud',
			disks: [disk('disk0', '/tmp/cloud.qcow2'), {...seed, file: '/tmp/cloud-seed.iso'}],
			cloudInit: {username: 'chris', hostname: 'cloud-1', sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl chris@laptop']},
		}),
	]
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		calls.push([cmd, ...a].join(' '))
		if (cmd === 'openssl') return HASH
		return ''
	}
	const {root, call} = await open({machines, run})
	try {
		assert.equal((await call('machines.details', {id: installer})).cloudInit, null)
		const before = calls.length
		await assert.rejects(call('machines.updateCloudInit', {id: installer, username: 'chris', hostname: 'omarchy-1', password: 'secret'}), /doesn’t use cloud-init/)
		assert.equal(calls.slice(before).some((c) => c.startsWith('xorriso')), false)
		assert.deepEqual((await call('machines.details', {id: cloud})).cloudInit, machines[1].cloudInit)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('#477 revertSnapshot checks every drive before applying', async () => {
	const calls = []
	let secondHasSnap = false
	const id = 'abcd1234'
	const disk0 = '/tmp/om-life-s1/disk0.qcow2'
	const disk1 = '/tmp/om-life-s1/disk1.qcow2'
	const snap = {
		name: 's1',
		description: '',
		createdAt: 1,
		config: {sockets: 1, cores: 1, memoryMb: 1024, cpuType: 'host', layout: {firmware: 'bios', machineType: 'q35', video: 'vga', nic: 'virtio'}, disks: ['disk0', 'disk1']},
	}
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		calls.push([cmd, ...a].join(' '))
		if (cmd === 'qemu-img' && a[0] === 'snapshot' && a[1] === '-l') {
			const tag = a[2] === disk1 && !secondHasSnap ? '' : '1         s1                    0 B 2026-01-01 00:00:00 00:00:00.000\n'
			return `Snapshot list:\nID        TAG               VM SIZE                DATE     VM CLOCK\n${tag}`
		}
		return ''
	}
	const {root, dataDir, call} = await open({machines: [baseMachine(id, {disks: [disk('disk0', disk0), disk('disk1', disk1)], snapshots: [snap]})], run})
	await mkdir(join(dataDir, 'machines', 'vms', id), {recursive: true})
	try {
		const applied = () => calls.filter((c) => c.includes('snapshot -a'))
		let error = null
		try {
			await call('machines.revertSnapshot', {id, name: 's1'})
		} catch (e) {
			error = e
		}
		assert.deepEqual(applied(), [], 'a missing snapshot must not apply any drive')
		assert.ok(error, 'revertSnapshot should throw')
		secondHasSnap = true
		await call('machines.revertSnapshot', {id, name: 's1'})
		const again = applied()
		assert.equal(again.length, 2)
		assert.ok(again.some((c) => c.includes(disk0)) && again.some((c) => c.includes(disk1)))
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('#602 a failed domjobinfo does not finish a live backup', async () => {
	const calls = []
	const failId = 'abcd1234'
	const okId = 'abcd1235'
	const jobs = new Map()
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		calls.push([cmd, ...a].join(' '))
		if (cmd === 'virsh' && a[0] === 'list') return ` Id   Name   State\n------------------\n -    omarchy-${failId}   running\n -    omarchy-${okId}   running\n`
		if (cmd === 'virsh' && a[0] === 'domjobinfo') {
			const dom = a.find((x) => String(x).startsWith('omarchy-'))
			const id = dom.slice('omarchy-'.length)
			if (a.includes('--completed')) return id === okId ? 'Job type:         Completed\n' : 'Job type:         Completed\n'
			const n = (jobs.get(id) ?? 0) + 1
			jobs.set(id, n)
			if (id === failId && n === 1) throw new Error('virsh domjobinfo: unable to query')
			if (id === failId) return 'Job type:         Unbounded\n'
			return 'Job type:         None\n'
		}
		return ''
	}
	const home = await mkdtemp(join(os.tmpdir(), 'om-life-home-'))
	const files = {resolve: async () => ({real: home})}
	const machine = (id, file) => baseMachine(id, {name: id === failId ? 'Live' : 'Live ok', disks: [disk('disk0', file)]})
	const {root, call} = await open({machines: [machine(failId, '/tmp/a.qcow2'), machine(okId, '/tmp/b.qcow2')], run, files})
	try {
		const {backupId} = await call('machines.backup', {id: failId})
		const settled = await until(async () => {
			const list = await call('machines.backups', {id: failId})
			if (list.some((b) => b.id === backupId && b.live)) return 'listed'
			if (calls.some((c) => c.startsWith(`virsh domjobabort omarchy-${failId}`))) return 'aborted'
			return null
		})
		assert.equal(settled, 'aborted')
		assert.equal((await call('machines.backups', {id: failId})).some((b) => b.live), false)
		const {backupId: okBackup} = await call('machines.backup', {id: okId})
		const listed = await until(async () => (await call('machines.backups', {id: okId})).some((b) => b.id === okBackup && b.live))
		assert.equal(listed, true)
	} finally {
		await rm(root, {recursive: true, force: true})
		await rm(home, {recursive: true, force: true})
	}
})

test('#315 deleteSnapshot only ignores a missing snapshot', async () => {
	const id = 'abcd1234'
	let mode = 'io'
	const snap = {
		name: 's1',
		description: '',
		createdAt: 1,
		config: {sockets: 1, cores: 1, memoryMb: 1024, cpuType: 'host', layout: {firmware: 'bios', machineType: 'q35', video: 'vga', nic: 'virtio'}, disks: ['disk0']},
	}
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'qemu-img' && a[0] === 'snapshot' && a[1] === '-d') {
			if (mode === 'io') throw new Error('qemu-img: Could not delete snapshot: I/O error')
			throw new Error("qemu-img: Could not delete snapshot 's1': snapshot not found")
		}
		return ''
	}
	const {root, call} = await open({machines: [baseMachine(id, {disks: [disk('disk0', '/tmp/disk.qcow2')], snapshots: [snap]})], run})
	try {
		await assert.rejects(call('machines.deleteSnapshot', {id, name: 's1'}), /I\/O error/)
		assert.ok((await call('machines.details', {id})).snapshots.some((s) => s.name === 's1'))
		mode = 'missing'
		await call('machines.deleteSnapshot', {id, name: 's1'})
		assert.deepEqual((await call('machines.details', {id})).snapshots, [])
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('#311 a backup that fails before it starts does not leave the machine busy', async () => {
	const id = 'abcd1234'
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
		if (cmd === 'virsh' && a[0] === 'start') return ''
		return ''
	}
	const home = await mkdtemp(join(os.tmpdir(), 'om-life-bak-'))
	const backups = join(home, 'Backups', 'Machines')
	await mkdir(backups, {recursive: true})
	await chmod(backups, 0o555)
	const files = {resolve: async () => ({real: home})}
	const {root, dataDir, call} = await open({machines: [baseMachine(id, {disks: [disk('disk0', '/tmp/disk.qcow2')]})], run, files})
	try {
		await assert.rejects(call('machines.backup', {id}))
		await chmod(backups, 0o755)
		// Start writes the domain before libvirt boots. This machine was never created on disk.
		await mkdir(join(dataDir, 'machines', 'vms', id), {recursive: true})
		let startError = null
		try {
			await call('machines.start', {id})
		} catch (e) {
			startError = e
		}
		if (startError) assert.fail(startError.message)
	} finally {
		await chmod(backups, 0o755).catch(() => {})
		await rm(root, {recursive: true, force: true})
		await rm(home, {recursive: true, force: true})
	}
})

test('#306 a control character in notes or the name does not stick', async () => {
	const id = 'abcd1234'
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'define') {
			const xml = await readFile(a[1], 'utf8')
			if (xml.includes('\x1b')) throw new Error('virsh define: XML rejected')
			return ''
		}
		if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
		return ''
	}
	const {root, dataDir, call} = await open({machines: [baseMachine(id, {disks: [disk('disk0', '/tmp/disk.qcow2')]})], run})
	await mkdir(join(dataDir, 'machines', 'vms', id), {recursive: true})
	try {
		await assert.rejects(call('machines.updateOptions', {id, notes: 'hello\x1b'}), /Those notes can’t be used/)
		assert.equal((await call('machines.details', {id})).options.notes, '')
		await call('machines.updateOptions', {id, onBoot: true})
		assert.equal((await call('machines.details', {id})).options.onBoot, true)
		await assert.rejects(call('machines.updateOptions', {id, name: 'Bad\x1bname'}), /That name can’t be used/)
		assert.equal((await call('machines.details', {id})).name, 'Box')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('#747 a failed create does not keep the name', async () => {
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === '--version') return '10.0.0\n'
		if (cmd === 'qemu-img' && a[0] === '--version') return 'qemu-img version 9.0\n'
		if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
		return ''
	}
	const input = {name: 'Fresh VM', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'}
	const {root, dataDir, call} = await open({run})
	const dir = join(dataDir, 'machines')
	try {
		await chmod(dir, 0o555)
		await assert.rejects(call('machines.create', input))
		assert.equal((await call('machines.list')).some((m) => m.name === 'Fresh VM'), false)
		await chmod(dir, 0o755)
		const {id} = await call('machines.create', input)
		assert.equal((await call('machines.list')).some((m) => m.id === id && m.name === 'Fresh VM'), true)
	} finally {
		await chmod(dir, 0o755).catch(() => {})
		await rm(root, {recursive: true, force: true})
	}
})

test('#666 a CD/DVD source is optional when the ISO is missing', async () => {
	const id = 'abcd1234'
	const run = async (cmd, args = []) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && (a[0] === 'define' || a[0] === 'list')) return ''
		return ''
	}
	const cd = '/tmp/missing-installer.iso'
	const qcow = '/tmp/disk.qcow2'
	const {root, dataDir, call} = await open({
		machines: [baseMachine(id, {disks: [disk('disk0', qcow), {id: 'cd0', file: cd, device: 'cdrom', bus: 'sata', format: 'raw'}]})],
		run,
	})
	await mkdir(join(dataDir, 'machines', 'vms', id), {recursive: true})
	try {
		// Notes still rewrite the domain. Starting at boot does not.
		await call('machines.updateOptions', {id, notes: 'cd'})
		const xml = await readFile(join(dataDir, 'machines', 'vms', id, 'domain.xml'), 'utf8')
		const cdXml = /<disk type='file' device='cdrom'>[\s\S]*?<\/disk>/.exec(xml)[0]
		const diskXml = /<disk type='file' device='disk'>[\s\S]*?<\/disk>/.exec(xml)[0]
		assert.match(cdXml, /<source [^>]*startupPolicy='optional'[^>]*\/>/)
		assert.match(cdXml, new RegExp(`file='${cd}'`))
		assert.doesNotMatch(diskXml, /startupPolicy/)
		assert.match(diskXml, /<source file='[^']+'\/><target/)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('#805 a USB hostdev source is optional when the stick is unplugged', () => {
	const xml = hostdevXml({vendorId: '10c4', productId: 'ea60', serial: '0001'})
	assert.match(xml, /<source [^>]*startupPolicy='optional'/)
	assert.match(xml, /<vendor id='0x10c4'\/>/)
	assert.match(xml, /<product id='0xea60'\/>/)
	assert.match(xml, /<serial>0001<\/serial>/)
})
