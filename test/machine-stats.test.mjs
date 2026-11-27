// VM live stats: background virsh samples; RPCs return the last snapshot.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const id = 'abcd1234'
const domain = `omarchy-${id}`
const tempDirs = []
after(async () => {
	for (const dir of tempDirs) await rm(dir, {recursive: true, force: true})
})

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

test('machines.stats without an id returns every machine’s last sample', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'mx-stats-'))
	tempDirs.push(root)
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines'), {recursive: true})
	await writeFile(
		join(dataDir, 'machines', 'machines.json'),
		JSON.stringify({
			machines: [
				{
					id,
					name: 'Box',
					state: 'running',
					cores: 2,
					sockets: 1,
					memoryMb: 2048,
					layout: {machineType: 'q35', disks: [{id: 'disk0', device: 'disk', bus: 'virtio', file: 'disk.qcow2', sizeGb: 10}]},
				},
			],
		}),
	)
	let cpuNs = 1e9
	const run = async (cmd, args) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'domstats') {
			cpuNs += 2e9
			return `Domain: '${domain}'\n  cpu.time=${cpuNs}\n  balloon.rss=${64 * 1024 * 1024}\n  net.0.rx.bytes=0\n  net.0.tx.bytes=0\n  block.0.rd.bytes=0\n  block.0.wr.bytes=0\n`
		}
		if (cmd === 'virsh' && a[0] === 'list') return ` Id   Name   State\n------------------\n -    ${domain}   running\n`
		if (cmd === 'virsh' && a[0] === 'version') return 'Compiled against library: libvirt 10.0.0\nRunning hypervisor: QEMU 9.0.0\n'
		if (cmd === 'virsh' && a[0] === '--version') return '10.0.0\n'
		return ''
	}
	const mx = createMachines({dataDir, run, catalogUrl: 'https://example.test/catalog.json', fetchImpl: async () => new Response('{}'), statsIntervalMs: 20, seriesIntervalMs: 40})
	await mx.procedures['machines.list'].run()
	await wait(70)
	const all = await mx.procedures['machines.stats'].run()
	assert.ok(all[id], 'combined snapshot is keyed by machine id')
	assert.equal(all[id].vcpus, 2)
	assert.ok(all[id].last, 'last sample is present without waiting on virsh')
	assert.equal(typeof all[id].last.cpu, 'number')
	assert.equal(typeof all[id].last.memMb, 'number')
	const one = await mx.procedures['machines.stats'].run({id})
	assert.equal(one.last.cpu, all[id].last.cpu)
	assert.ok(Array.isArray(one.points))
})

function machineFile(state) {
	return JSON.stringify({
		machines: [
			{
				id,
				name: 'Box',
				state,
				cores: 2,
				sockets: 1,
				memoryMb: 2048,
				layout: {machineType: 'q35', disks: [{id: 'disk0', device: 'disk', bus: 'virtio', file: 'disk.qcow2', sizeGb: 10}]},
			},
		],
	})
}

async function openMachines({state, listState, statsIntervalMs = 20, watchIdleMs, onDomstats}) {
	const root = await mkdtemp(join(os.tmpdir(), 'mx-poll-'))
	tempDirs.push(root)
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines'), {recursive: true})
	await writeFile(join(dataDir, 'machines', 'machines.json'), machineFile(state))
	let domstats = 0
	const run = async (cmd, args) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'domstats') {
			domstats++
			if (onDomstats) return onDomstats(domstats)
			return ''
		}
		if (cmd === 'virsh' && a[0] === 'list') return ` Id   Name   State\n------------------\n -    ${domain}   ${listState}\n`
		if (cmd === 'virsh' && a[0] === 'version') return 'Compiled against library: libvirt 10.0.0\nRunning hypervisor: QEMU 9.0.0\n'
		if (cmd === 'virsh' && a[0] === '--version') return '10.0.0\n'
		return ''
	}
	const mx = createMachines({dataDir, run, catalogUrl: 'https://example.test/catalog.json', fetchImpl: async () => new Response('{}'), statsIntervalMs, ...(watchIdleMs ? {watchIdleMs} : {})})
	return {mx, domstats: () => domstats}
}

test('nobody looking does not spawn domstats, even when a machine exists', async () => {
	const {mx, domstats} = await openMachines({state: 'stopped', listState: 'shut off', statsIntervalMs: 20})
	await mx.ready
	await wait(150)
	assert.equal(domstats(), 0)
})

test('a stopped machine is not passed to domstats while someone is looking', async () => {
	const {mx, domstats} = await openMachines({state: 'stopped', listState: 'shut off', statsIntervalMs: 20})
	await mx.procedures['machines.list'].run()
	await wait(150)
	assert.equal(domstats(), 0)
})

test('machine sampling stops about 15s after the last look', async () => {
	const {mx, domstats} = await openMachines({state: 'running', listState: 'running', statsIntervalMs: 20, watchIdleMs: 60})
	await mx.procedures['machines.list'].run()
	await wait(50)
	assert.ok(domstats() >= 1)
	await wait(180)
	const settled = domstats()
	await wait(80)
	assert.equal(domstats(), settled)
	await mx.procedures['machines.stats'].run()
	await wait(50)
	assert.ok(domstats() > settled)
})

test('a slow domstats does not overlap or spike the rate', async () => {
	const t0 = Date.now()
	let inflight = 0
	let peak = 0
	const {mx} = await openMachines({
		state: 'running',
		listState: 'running',
		statsIntervalMs: 80,
		onDomstats: async (n) => {
			inflight++
			peak = Math.max(peak, inflight)
			const started = Date.now()
			if (n === 2) await wait(600)
			inflight--
			const secs = (started - t0) / 1000
			const cpuNs = Math.round(secs * 1e9)
			const rx = Math.round(secs * 1e6)
			return `Domain: '${domain}'\n  cpu.time=${cpuNs}\n  balloon.rss=${64 * 1024 * 1024}\n  net.0.rx.bytes=${rx}\n  net.0.tx.bytes=0\n  block.0.rd.bytes=0\n  block.0.wr.bytes=0\n`
		},
	})
	await mx.procedures['machines.list'].run()
	await wait(1100)
	const all = await mx.procedures['machines.stats'].run()
	const points = all[id].points
	assert.ok(points.length >= 1)
	assert.equal(peak, 1)
	for (const point of points) {
		assert.ok(point.cpu >= 40 && point.cpu <= 60, `cpu ${point.cpu}`)
		assert.ok(point.netIn >= 800_000 && point.netIn <= 1_200_000, `net ${point.netIn}`)
	}
})
