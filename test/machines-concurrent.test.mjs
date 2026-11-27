// Concurrent machine creates and drive additions must serialize cleanly and keep unique names and drive ids.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function setupStoppedMachine(t, {failFirstCreate = false} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-m-conc-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	const id = 'aabbccdd'
	const vmDir = join(dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'disk0')
	const diskFile = join(vmDir, 'disk.qcow2')
	await writeFile(
		join(dataDir, 'machines', 'machines.json'),
		JSON.stringify({
			machines: [
				{
					id,
					vmid: 100,
					name: 'Box',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					diskSizeGb: 10,
					portForwards: [],
					createdAt: 1,
					layout: {
						firmware: 'bios',
						machineType: 'q35',
						nic: 'virtio',
						video: 'vga',
						disks: [{id: 'disk0', file: diskFile, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}],
					},
				},
			],
		}),
	)
	const createdFiles = []
	const definedXmls = []
	let createAttempt = 0
	const run = async (cmd, args) => {
		if (cmd === 'qemu-img') {
			if (args[0] === 'create') {
				const attempt = ++createAttempt
				await wait(25)
				if (failFirstCreate && attempt === 1) throw new Error('qemu-img create failed')
				createdFiles.push(args[3])
				await writeFile(args[3], 'new-disk')
				return ''
			}
			if (args[0] === 'info') return JSON.stringify({'virtual-size': 10 * 1024 ** 3, 'actual-size': 0})
			return ''
		}
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === 'list') {
				await wait(25)
				return ` Id   Name   State\n------------------\n -    omarchy-${id}   shut off\n`
			}
			if (a[0] === 'define') {
				definedXmls.push(await readFile(a[1], 'utf8'))
				return ''
			}
			return ''
		}
		return ''
	}
	const machines = createMachines({
		dataDir,
		run,
		kvmDevice: join(root, 'kvm'),
		watchIdleMs: 50,
		statsIntervalMs: 50,
	})
	await machines.ready
	return {id, machines, createdFiles, definedXmls}
}

test('concurrent addCdrom requests get distinct drive ids and targets', async (t) => {
	const {id, machines, definedXmls} = await setupStoppedMachine(t)
	const [a, b] = await Promise.all([
		machines.procedures['machines.addCdrom'].run({id}),
		machines.procedures['machines.addCdrom'].run({id}),
	])
	assert.deepEqual([a.diskId, b.diskId].sort(), ['cd0', 'cd1'])
	const details = await machines.procedures['machines.details'].run({id})
	assert.deepEqual(details.hardware.disks.map((d) => d.id), ['disk0', 'cd0', 'cd1'])
	const targetList = details.hardware.disks.map((d) => d.target)
	assert.equal(new Set(targetList).size, 3)
	const lastXml = definedXmls.at(-1)
	const xmlTargets = [...lastXml.matchAll(/<target dev='([^']+)'/g)].map((m) => m[1])
	assert.equal(new Set(xmlTargets).size, xmlTargets.length)
})

test('concurrent addDisk requests get distinct drive ids, image files, and targets', async (t) => {
	const {id, machines, createdFiles} = await setupStoppedMachine(t)
	const [a, b] = await Promise.all([
		machines.procedures['machines.addDisk'].run({id, sizeGb: 5}),
		machines.procedures['machines.addDisk'].run({id, sizeGb: 6}),
	])
	assert.deepEqual([a.diskId, b.diskId].sort(), ['disk1', 'disk2'])
	assert.deepEqual(createdFiles.map((f) => f.split('/').pop()).sort(), ['disk1.qcow2', 'disk2.qcow2'])
	const details = await machines.procedures['machines.details'].run({id})
	assert.deepEqual(details.hardware.disks.map((d) => d.id), ['disk0', 'disk1', 'disk2'])
	assert.equal(new Set(details.hardware.disks.map((d) => d.target)).size, 3)
})

test('a failed addDisk does not consume the drive id for the next request', async (t) => {
	const {id, machines} = await setupStoppedMachine(t, {failFirstCreate: true})
	const [first, second] = await Promise.allSettled([
		machines.procedures['machines.addDisk'].run({id, sizeGb: 5}),
		machines.procedures['machines.addDisk'].run({id, sizeGb: 6}),
	])
	assert.equal(first.status, 'rejected')
	assert.equal(second.status, 'fulfilled')
	assert.equal(second.value.diskId, 'disk1')
	const details = await machines.procedures['machines.details'].run({id})
	assert.deepEqual(details.hardware.disks.map((d) => d.id), ['disk0', 'disk1'])
})

async function setupCreateMachines(t) {
	const origArch = os.arch
	os.arch = () => 'x64'
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-m-create-'))
	t.after(async () => {
		os.arch = origArch
		await rm(root, {recursive: true, force: true})
	})
	const dataDir = join(root, 'data')
	const catalog = join(root, 'catalog.json')
	await writeFile(
		catalog,
		JSON.stringify({
			version: 1,
			images: [{id: 'testos-amd64', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/test.qcow2', sha256: 'a'.repeat(64), sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	const kvmDevice = join(root, 'kvm')
	await writeFile(kvmDevice, '')
	const run = async (cmd, args) => {
		if (cmd === 'openssl') return '$6$salt$fakehash\n'
		if (cmd === 'xorriso') {
			await writeFile(args[args.indexOf('-output') + 1], 'iso')
			return ''
		}
		if (cmd === 'qemu-img' && args[0] === 'convert') {
			await writeFile(args.at(-1), 'disk')
			return ''
		}
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === '--version') {
				await wait(25)
				return '10.0.0\n'
			}
			if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
			return ''
		}
		return ''
	}
	const machines = createMachines({
		dataDir,
		catalogUrl: `file://${catalog}`,
		fetchImpl: async () => {
			throw new Error('catalog image should already be on disk')
		},
		run,
		kvmDevice,
		watchIdleMs: 50,
		statsIntervalMs: 50,
	})
	await machines.ready
	await mkdir(join(dataDir, 'machines', 'images'), {recursive: true})
	await writeFile(join(dataDir, 'machines', 'images', 'testos-amd64.qcow2'), 'cloud-image-bytes')
	return machines
}

async function waitDone(machines, id) {
	const end = Date.now() + 5000
	while (!machines.importState(id).done) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${id}`)
		await wait(15)
	}
}

test('concurrent creates with the same name allow one and refuse the duplicate', async (t) => {
	const machines = await setupCreateMachines(t)
	const spec = {osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'}
	const results = await Promise.allSettled([
		machines.procedures['machines.create'].run({...spec, name: 'Dup'}),
		machines.procedures['machines.create'].run({...spec, name: 'dup'}),
	])
	const fulfilled = results.filter((r) => r.status === 'fulfilled')
	const rejected = results.filter((r) => r.status === 'rejected')
	for (const r of fulfilled) await waitDone(machines, r.value.id)
	assert.equal(fulfilled.length, 1)
	assert.equal(rejected.length, 1)
	assert.ok(rejected[0].reason instanceof RpcError)
	assert.equal(rejected[0].reason.code, 'CONFLICT')
	assert.match(rejected[0].reason.message, /already exists/)
	const list = await machines.procedures['machines.list'].run()
	assert.equal(list.length, 1)
})

test('concurrent creates with different names both succeed with unique ids and vmids', async (t) => {
	const machines = await setupCreateMachines(t)
	const spec = {osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'}
	const [a, b] = await Promise.all([
		machines.procedures['machines.create'].run({...spec, name: 'Alpha'}),
		machines.procedures['machines.create'].run({...spec, name: 'Beta'}),
	])
	await Promise.all([waitDone(machines, a.id), waitDone(machines, b.id)])
	assert.notEqual(a.id, b.id)
	const list = await machines.procedures['machines.list'].run()
	assert.equal(list.length, 2)
	assert.equal(new Set(list.map((m) => m.vmid)).size, 2)
	assert.deepEqual(list.map((m) => m.name).sort(), ['Alpha', 'Beta'])
})
