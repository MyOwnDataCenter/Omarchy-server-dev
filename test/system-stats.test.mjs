// Sampler: hardware is read on its own interval; snapshot() is a memory read.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createSampler, DEFAULT_INTERVALS, IDLE_MS} from '../omarchyd/stats.mjs'

const cpu = (n) => ({threads: 8, totalUsed: n, system: n, apps: [], machines: []})
const mem = (n) => ({size: 16e9, totalUsed: n, system: n, apps: [], machines: []})
const gpu = (used) => ({gpus: [{id: 'g0', index: 0, name: 'GPU', used, memoryUsed: null, memoryTotal: null, temperature: null}]})

function readers() {
	const counts = {cpu: 0, memory: 0, gpu: 0, temp: 0, battery: 0, disk: 0, uptime: 0, breakdown: 0}
	const read = {
		cpu: async () => (counts.cpu++, cpu(counts.cpu * 10)),
		memory: async () => (counts.memory++, mem(counts.memory * 1e9)),
		gpu: async () => (counts.gpu++, gpu(counts.gpu)),
		temp: async () => (counts.temp++, ({warning: 'normal', temperature: 40 + counts.temp})),
		battery: async () => (counts.battery++, ({batteries: []})),
		disk: async () => (counts.disk++, ({size: 1e12, totalUsed: 1e11, available: 9e11, system: 1e11, files: 0, apps: [], machines: [], measuring: false, drive: null})),
		uptime: async () => (counts.uptime++, counts.uptime * 60),
		breakdown: async () => (counts.breakdown++, ({apps: [{id: 'immich', cpuShare: 0.16, memBytes: 2e9}], machines: []})),
	}
	return {counts, read}
}

test('first tick samples every field', async () => {
	const {counts, read} = readers()
	const s = createSampler({now: () => 0, read})
	await s.tick()
	assert.equal(counts.cpu, 1)
	assert.equal(counts.memory, 1)
	assert.equal(counts.gpu, 1)
	assert.equal(counts.temp, 1)
	assert.equal(counts.battery, 1)
	assert.equal(counts.disk, 1)
	assert.equal(counts.uptime, 1)
	assert.equal(counts.breakdown, 1)
	assert.equal(s.snapshot().cpu.totalUsed, 10)
	assert.equal(s.snapshot().gpu.gpus[0].used, 1)
	assert.equal(s.snapshot().uptime, 60)
})

test('each field is resampled only when its interval has elapsed', async () => {
	const {counts, read} = readers()
	let t = 0
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, cpu: 1000, memory: 1000, gpu: 3000, temp: 5000, battery: 5000, disk: 30_000, uptime: 60_000, breakdown: 15_000},
		read,
	})
	await s.tick()
	t = 1000
	await s.tick()
	assert.equal(counts.cpu, 2)
	assert.equal(counts.memory, 2)
	assert.equal(counts.gpu, 1)
	assert.equal(counts.temp, 1)
	assert.equal(counts.disk, 1)
	t = 3000
	await s.tick()
	assert.equal(counts.gpu, 2)
	assert.equal(counts.cpu, 3)
	assert.equal(counts.temp, 1)
	t = 5000
	await s.tick()
	assert.equal(counts.temp, 2)
})

test('snapshot() does not read hardware', async () => {
	const {counts, read} = readers()
	const s = createSampler({now: () => 0, read})
	await s.tick()
	const a = s.snapshot()
	const b = s.snapshot()
	assert.equal(counts.cpu, 1)
	assert.equal(a.cpu.totalUsed, 10)
	assert.equal(b.cpu.totalUsed, 10)
})

test('breakdown is applied to cpu and memory and refreshed on its own interval', async () => {
	const {counts, read} = readers()
	let t = 0
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, cpu: 1000, memory: 1000, breakdown: 15_000},
		read,
	})
	await s.tick()
	const first = s.snapshot()
	assert.equal(first.cpu.apps[0].id, 'immich')
	assert.equal(first.cpu.apps[0].used, 2) // 0.16 share / 8 threads * 100
	assert.equal(first.memory.apps[0].used, 2e9)
	assert.equal(counts.breakdown, 1)
	t = 1000
	await s.tick()
	assert.equal(counts.breakdown, 1)
	assert.equal(s.snapshot().cpu.apps[0].id, 'immich')
	t = 15_000
	await s.tick()
	assert.equal(counts.breakdown, 2)
})

test('get() returns cpu without waiting for a slow gpu sample', async () => {
	let resolveGpu
	const gpuP = new Promise((r) => (resolveGpu = r))
	const s = createSampler({
		now: () => 0,
		read: {
			cpu: async () => cpu(7),
			memory: async () => mem(1),
			gpu: () => gpuP.then(() => gpu(9)),
		},
	})
	const got = await s.get()
	assert.equal(got.cpu.totalUsed, 7)
	assert.deepEqual(got.gpu.gpus, [])
	resolveGpu()
	await gpuP
	await Promise.resolve()
	assert.equal(s.snapshot().gpu.gpus[0].used, 9)
})

test('a read starts the timer and it stops 15s after the last read', async () => {
	const {counts, read} = readers()
	let t = 0
	const timers = []
	const timeouts = []
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, cpu: 1000},
		read,
		setIntervalFn: (fn, ms) => {
			const id = {fn, ms}
			timers.push(id)
			return id
		},
		clearIntervalFn: (id) => {
			const i = timers.indexOf(id)
			if (i >= 0) timers.splice(i, 1)
		},
		setTimeoutFn: (fn, ms) => {
			const id = {fn, ms}
			timeouts.push(id)
			return id
		},
	})
	s.start()
	assert.equal(timers.length, 0, 'starting omarchyd does not sample')
	const first = await s.get()
	assert.equal(first.cpu.totalUsed, 10)
	assert.equal(counts.cpu, 1)
	assert.equal(timers.length, 1)
	assert.equal(timers[0].ms, 250)
	t = 1000
	await timers[0].fn()
	assert.equal(counts.cpu, 2)
	t = 1000 + IDLE_MS
	await timers[0].fn()
	assert.equal(timers.length, 0)
	assert.equal(counts.cpu, 2)
	const again = await s.get()
	assert.equal(again.cpu.totalUsed, 20)
	assert.equal(counts.cpu, 2, 'the read returns the last snapshot without waiting')
	assert.equal(timeouts.length, 1)
	assert.equal(timers.length, 1)
	await timeouts[0].fn()
	assert.equal(counts.cpu, 3)
	s.stop()
	assert.equal(timers.length, 0)
	t += 1000
	await s.get()
	assert.equal(counts.cpu, 3)
})

test('stop() does not sample hardware on later ticks', async () => {
	const {counts, read} = readers()
	let t = 0
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, cpu: 1000, disk: 1000},
		read,
	})
	await s.tick()
	s.stop()
	t = 1000
	await s.tick()
	assert.equal(counts.cpu, 1)
	assert.equal(counts.disk, 1)
})

test('a failing reader keeps the last snapshot', async () => {
	let t = 0
	let boom = false
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, cpu: 1000},
		read: {
			cpu: async () => {
				if (boom) throw new Error('ENOENT: statfs')
				return cpu(10)
			},
		},
	})
	await s.tick()
	boom = true
	t = 1000
	await s.tick()
	assert.equal(s.snapshot().cpu.totalUsed, 10)
})

test('an in-flight reader after stop does not reject', async () => {
	let rejectDisk
	const diskP = new Promise((_, rej) => (rejectDisk = rej))
	const s = createSampler({
		now: () => 0,
		read: {
			cpu: async () => cpu(1),
			disk: () => diskP,
		},
	})
	const p = s.tick()
	s.stop()
	rejectDisk(Object.assign(new Error('ENOENT: no such file or directory, statfs'), {code: 'ENOENT'}))
	await p
	assert.equal(s.snapshot().cpu.totalUsed, 1)
})

test('a slow disk read is not started again while it is still running', async () => {
	let disk = 0
	let release
	const pending = new Promise((r) => (release = r))
	const s = createSampler({
		now: () => 0,
		read: {
			cpu: async () => cpu(1),
			disk: () => {
				disk++
				return pending
			},
		},
	})
	const ticks = [s.tick(), s.tick(), s.tick()]
	assert.equal(disk, 1)
	release({size: 1, totalUsed: 0, available: 1, system: 0, files: 0, apps: [], machines: [], measuring: false, drive: null})
	await Promise.all(ticks)
})

test('a failing reading waits for its own interval', async () => {
	let n = 0
	let t = 0
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, temp: 5000},
		read: {
			temp: async () => {
				n++
				throw new Error('sensor')
			},
		},
	})
	await s.tick()
	t = 1000
	await s.tick()
	assert.equal(n, 1)
	t = 5000
	await s.tick()
	assert.equal(n, 2)
})

test('stepping the clock backward does not freeze the next samples', async () => {
	let clock = 1_800_000_000_000
	let n = 0
	const s = createSampler({
		now: () => clock,
		read: {cpu: async () => cpu(++n)},
	})
	await s.get()
	clock -= 3_600_000
	for (let i = 0; i < 5; i++) {
		clock += 1000
		await s.tick()
	}
	assert.equal(n, 6)
})

test('a wall-clock step does not move the schedule', async () => {
	let wall = 1_000_000
	let m = 0
	let n = 0
	const s = createSampler({
		now: () => wall,
		mono: () => m,
		intervals: {...DEFAULT_INTERVALS, cpu: 1000},
		read: {cpu: async () => cpu(++n)},
	})
	await s.get()
	const stamped = s.snapshot().sampledAt.cpu
	wall -= 3_600_000
	await s.tick()
	assert.equal(n, 1)
	assert.equal(s.snapshot().sampledAt.cpu, stamped)
	m = 1000
	wall += 1000
	await s.tick()
	assert.equal(n, 2)
	assert.equal(s.snapshot().sampledAt.cpu, wall)
})

test('a slow gpu read is not started again while it is still running', async () => {
	let n = 0
	let t = 0
	let release
	const pending = new Promise((r) => (release = r))
	const s = createSampler({
		now: () => t,
		intervals: {...DEFAULT_INTERVALS, gpu: 1000},
		read: {
			gpu: () => {
				n++
				return pending
			},
		},
	})
	const first = s.tick({waitGpu: false})
	t = 1000
	await s.tick({waitGpu: false})
	assert.equal(n, 1)
	release(gpu(1))
	await first
})

test('a failing gpu sample after get() is not an unhandled rejection', async () => {
	let rejectGpu
	const gpuP = new Promise((_, rej) => (rejectGpu = rej))
	const s = createSampler({
		now: () => 0,
		read: {
			cpu: async () => cpu(1),
			gpu: () => gpuP,
		},
	})
	await s.get()
	const unhandled = []
	const on = (err) => unhandled.push(err)
	process.on('unhandledRejection', on)
	rejectGpu(new Error('nvidia-smi'))
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
	process.off('unhandledRejection', on)
	assert.deepEqual(unhandled, [])
	assert.deepEqual(s.snapshot().gpu.gpus, [])
})
