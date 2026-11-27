// Machines: clone history follows the copy (#662), node counts (#665), usage sampler clock (#746), ISO labels (#781).
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function setup(t, records, run) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-quartet-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines', 'vms'), {recursive: true})
	await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines: records}))
	const kvmDevice = join(root, 'kvm')
	await writeFile(kvmDevice, '')
	return {root, dataDir, kvmDevice, run}
}

const record = (id, extra = {}) => ({
	id,
	name: `Box ${id}`,
	osId: 'testos-amd64',
	cores: 2,
	sockets: 1,
	memoryGb: 1,
	memoryMb: 1024,
	diskSizeGb: 10,
	state: 'stopped',
	portForwards: [],
	createdAt: 1,
	mac: '52:54:00:11:22:33',
	layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: '', device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]},
	...extra,
})

const list = (...rows) => ` Id   Name   State\n------------------\n${rows.map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`

test('clone: the source history follows the copy and ends in error when the copy fails (#662)', async (t) => {
	const id = 'a1b2c3d4'
	const env = await setup(t, [record(id)])
	const vm = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vm, {recursive: true})
	const disk = join(vm, 'disk.qcow2')
	await writeFile(disk, 'x')
	env.run = async (cmd, args) => {
		if (cmd === 'virsh') return (args[0] === '-c' ? args[2] : args[0]) === 'list' ? list() : ''
		if (cmd === 'qemu-img' && args[0] === 'convert') {
			await wait(300)
			throw new Error('qemu-img: No space left on device')
		}
		return ''
	}
	const mx = createMachines({dataDir: env.dataDir, run: env.run, kvmDevice: env.kvmDevice})
	await mx.ready
	await mx.procedures['machines.clone'].run({id, name: 'Copy'})
	const sourceTask = async () => (await mx.procedures['machines.tasks'].run()).find((x) => x.machineId === id && x.type === 'clone')
	assert.equal((await sourceTask()).status, 'running')
	await wait(600)
	const done = await sourceTask()
	assert.equal(done.status, 'error')
	assert.match(done.message, /No space left on device/)
})

test('clone: the source history ends ok when the copy succeeds (#662)', async (t) => {
	const id = 'a1b2c3d4'
	const env = await setup(t, [record(id)])
	const vm = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vm, {recursive: true})
	await writeFile(join(vm, 'disk.qcow2'), 'x')
	env.run = async (cmd, args) => {
		if (cmd === 'virsh') return (args[0] === '-c' ? args[2] : args[0]) === 'list' ? list() : ''
		if (cmd === 'qemu-img' && args[0] === 'convert') {
			await wait(100)
			await writeFile(args.at(-1), 'copy')
		}
		return ''
	}
	const mx = createMachines({dataDir: env.dataDir, run: env.run, kvmDevice: env.kvmDevice})
	await mx.ready
	await mx.procedures['machines.clone'].run({id, name: 'Copy'})
	const sourceTask = async () => (await mx.procedures['machines.tasks'].run()).find((x) => x.machineId === id && x.type === 'clone')
	assert.equal((await sourceTask()).status, 'running')
	await wait(500)
	assert.equal((await sourceTask()).status, 'ok')
})

test('node counts only domains that belong to a listed machine (#665)', async (t) => {
	const id = 'a1b2c3d4'
	const env = await setup(t, [record(id, {state: 'running'})])
	env.run = async (cmd, args) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'list') return list([`omarchy-${id}`, 'running'], ['my-own-vm', 'running'], ['another', 'running'])
		return ''
	}
	const mx = createMachines({dataDir: env.dataDir, run: env.run, kvmDevice: env.kvmDevice, statsIntervalMs: 60_000})
	await mx.ready
	const node = await mx.procedures['machines.node'].run()
	assert.deepEqual(node.counts, {total: 1, running: 1})
})

test('usage sampler survives the wall clock stepping back (#746)', async (t) => {
	const id = 'abcd1234'
	const env = await setup(t, [record(id, {state: 'running'})])
	let calls = 0
	let fake = 1_700_000_000_000
	t.mock.method(Date, 'now', () => fake)
	env.run = async (cmd, args) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'domstats') {
			calls++
			fake += calls === 5 ? -3_600_000 : 1000
			return `Domain: 'omarchy-${id}'\n  cpu.time=${calls * 1e9}\n  balloon.rss=1024\n  net.0.rx.bytes=${calls * 1_000_000}\n  net.0.tx.bytes=0\n  block.0.rd.bytes=0\n  block.0.wr.bytes=0\n`
		}
		if (cmd === 'virsh' && a[0] === 'list') return list([`omarchy-${id}`, 'running'])
		return ''
	}
	const mx = createMachines({dataDir: env.dataDir, run: env.run, kvmDevice: env.kvmDevice, statsIntervalMs: 20, seriesIntervalMs: 1})
	await mx.procedures['machines.list'].run()
	const real = performance.now()
	while (calls < 5 && performance.now() - real < 5000) await wait(10)
	const before = (await mx.procedures['machines.stats'].run({id})).points.length
	await wait(300)
	const s = await mx.procedures['machines.stats'].run({id})
	assert.ok(calls > 6, `sampler kept running (${calls} calls)`)
	for (const p of [...s.points, s.last]) {
		assert.ok(p.netIn >= 0 && p.cpu >= 0, `no negative rate: ${JSON.stringify(p)}`)
	}
	assert.ok(s.points.length > before, `series still grows after the step (${before} -> ${s.points.length})`)
})

test('localIsos keeps the whole volume label, spaces included (#781)', async (t) => {
	const env = await setup(t, [])
	const home = join(env.root, 'home')
	await mkdir(home, {recursive: true})
	await writeFile(join(home, 'ubuntu-24.04-desktop-amd64.iso'), 'u')
	await writeFile(join(home, 'mint.iso'), 'm')
	await writeFile(join(home, 'quoted.iso'), 'q')
	const labels = {'ubuntu-24.04-desktop-amd64.iso': 'Ubuntu 24.04 LTS amd64', 'mint.iso': 'Linux Mint 21.3 Cinnamon 64-bit', 'quoted.iso': "'Debian 12.5.0 amd64 n'"}
	const run = async (cmd, args) => {
		if (cmd === 'xorriso' && args.includes('-pvd_info')) return `Volume Id    : ${labels[args[1].split('/').at(-1)]}\n`
		return ''
	}
	const mx = createMachines({dataDir: env.dataDir, run, kvmDevice: env.kvmDevice, statsIntervalMs: 60_000, files: {resolve: async () => ({real: home})}})
	await mx.ready
	const isos = await mx.procedures['machines.localIsos'].run()
	const by = (n) => isos.find((i) => i.name === n)?.version
	assert.equal(by('ubuntu-24.04-desktop-amd64'), 'Ubuntu 24.04 LTS amd64')
	assert.equal(by('mint'), 'Linux Mint 21.3 Cinnamon 64-bit')
	assert.equal(by('quoted'), 'Debian 12.5.0 amd64 n')
})
