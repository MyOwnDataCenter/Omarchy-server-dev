// GPU list for the system page: NVIDIA through nvidia-smi, AMD through sysfs. No root needed.
import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'

import {forgetGpus, gpuUsage} from '../omarchyd/system.mjs'

beforeEach(() => forgetGpus())

const nvidiaCsv = `0, NVIDIA GeForce RTX 3060, GPU-aaa, 32, 1477, 12288, 39
1, NVIDIA GeForce RTX 3060, GPU-bbb, 0, 2, 12288, 36
`

const runNvidia = async (cmd) => (cmd === 'nvidia-smi' ? nvidiaCsv : '')

test('nvidia-smi: one entry per GPU with utilization, VRAM and temperature', async () => {
	const {gpus} = await gpuUsage({run: runNvidia, list: async () => [], read: async () => ''})
	assert.equal(gpus.length, 2)
	assert.deepEqual(gpus[0], {
		id: 'GPU-aaa',
		index: 0,
		name: 'NVIDIA GeForce RTX 3060',
		used: 32,
		memoryUsed: 1477 * 1024 * 1024,
		memoryTotal: 12288 * 1024 * 1024,
		temperature: 39,
	})
	assert.equal(gpus[1].id, 'GPU-bbb')
	assert.equal(gpus[1].index, 1)
	assert.equal(gpus[1].used, 0)
	assert.equal(gpus[1].memoryUsed, 2 * 1024 * 1024)
	assert.equal(gpus[1].temperature, 36)
})

test('nvidia-smi: [N/A] readings are null, the GPU still appears', async () => {
	const csv = '0, NVIDIA GeForce RTX 3060, GPU-aaa, [N/A], [N/A], 12288, [N/A]\n'
	const {gpus} = await gpuUsage({run: async (cmd) => (cmd === 'nvidia-smi' ? csv : ''), list: async () => [], read: async () => ''})
	assert.equal(gpus.length, 1)
	assert.equal(gpus[0].used, null)
	assert.equal(gpus[0].memoryUsed, null)
	assert.equal(gpus[0].memoryTotal, 12288 * 1024 * 1024)
	assert.equal(gpus[0].temperature, null)
})

test('no GPUs: empty list, not an error', async () => {
	const {gpus} = await gpuUsage({run: async () => '', list: async () => [], read: async () => ''})
	assert.deepEqual(gpus, [])
})

test('nvidia-smi missing: AMD cards from sysfs, connectors skipped', async () => {
	const files = {
		'/sys/class/drm/card0/device/gpu_busy_percent': '41\n',
		'/sys/class/drm/card0/device/mem_info_vram_used': String(3 * 1024 ** 3),
		'/sys/class/drm/card0/device/mem_info_vram_total': String(16 * 1024 ** 3),
		'/sys/class/drm/card0/device/hwmon/hwmon5/temp1_input': '62000\n',
		'/sys/class/drm/card0/device/product_name': 'AMD Radeon RX 7900 XTX\n',
	}
	const {gpus} = await gpuUsage({
		run: async () => '',
		list: async (dir) => {
			if (dir === '/sys/class/drm') return ['card0', 'card0-DP-1', 'renderD128', 'card1']
			if (dir === '/sys/class/drm/card0/device/hwmon') return ['hwmon5']
			if (dir === '/sys/class/drm/card1/device/hwmon') return []
			return []
		},
		read: async (p) => files[p] ?? '',
	})
	assert.equal(gpus.length, 1)
	assert.equal(gpus[0].id, 'drm-card0')
	assert.equal(gpus[0].index, 0)
	assert.equal(gpus[0].name, 'AMD Radeon RX 7900 XTX')
	assert.equal(gpus[0].used, 41)
	assert.equal(gpus[0].memoryUsed, 3 * 1024 ** 3)
	assert.equal(gpus[0].memoryTotal, 16 * 1024 ** 3)
	assert.equal(gpus[0].temperature, 62)
})

test('hybrid: NVIDIA from nvidia-smi and AMD from sysfs in one list', async () => {
	const files = {
		'/sys/class/drm/card0/device/vendor': '0x1002\n',
		'/sys/class/drm/card0/device/gpu_busy_percent': '41\n',
		'/sys/class/drm/card0/device/mem_info_vram_used': String(3 * 1024 ** 3),
		'/sys/class/drm/card0/device/mem_info_vram_total': String(16 * 1024 ** 3),
		'/sys/class/drm/card0/device/product_name': 'AMD Radeon RX 7900 XTX\n',
	}
	const {gpus} = await gpuUsage({
		run: runNvidia,
		list: async (dir) => (dir === '/sys/class/drm' ? ['card0'] : []),
		read: async (p) => files[p] ?? '',
	})
	assert.equal(gpus.length, 3)
	assert.equal(gpus[0].id, 'GPU-aaa')
	assert.equal(gpus[1].id, 'GPU-bbb')
	assert.equal(gpus[2].id, 'drm-card0')
	assert.equal(gpus[2].name, 'AMD Radeon RX 7900 XTX')
	assert.equal(gpus[2].used, 41)
})

test('Intel iGPU is listed even without AMD sysfs busy/vram files', async () => {
	const files = {
		'/sys/class/drm/card0/device/vendor': '0x8086\n',
		'/sys/class/drm/card0/device/product_name': 'Intel Arc Graphics\n',
		'/sys/class/drm/card0/device/hwmon/hwmon2/temp1_input': '48000\n',
	}
	const {gpus} = await gpuUsage({
		run: async () => '',
		list: async (dir) => {
			if (dir === '/sys/class/drm') return ['card0', 'card0-eDP-1']
			if (dir === '/sys/class/drm/card0/device/hwmon') return ['hwmon2']
			return []
		},
		read: async (p) => files[p] ?? '',
	})
	assert.equal(gpus.length, 1)
	assert.equal(gpus[0].id, 'drm-card0')
	assert.equal(gpus[0].name, 'Intel Arc Graphics')
	assert.equal(gpus[0].used, null)
	assert.equal(gpus[0].memoryUsed, null)
	assert.equal(gpus[0].memoryTotal, null)
	assert.equal(gpus[0].temperature, 48)
})

test('Intel Arc discrete: VRAM from lmem sysfs', async () => {
	const files = {
		'/sys/class/drm/card0/device/vendor': '0x8086\n',
		'/sys/class/drm/card0/device/product_name': 'Intel Arc A770\n',
		'/sys/class/drm/card0/device/lmem_total_bytes': String(16 * 1024 ** 3),
		'/sys/class/drm/card0/device/lmem_free_bytes': String(12 * 1024 ** 3),
	}
	const {gpus} = await gpuUsage({
		run: async () => '',
		list: async (dir) => (dir === '/sys/class/drm' ? ['card0'] : []),
		read: async (p) => files[p] ?? '',
	})
	assert.equal(gpus.length, 1)
	assert.equal(gpus[0].memoryTotal, 16 * 1024 ** 3)
	assert.equal(gpus[0].memoryUsed, 4 * 1024 ** 3)
})

test('a management chip or virtio display with no readings is not a GPU', async () => {
	const aspeed = await gpuUsage({
		run: async () => '',
		list: async (d) => (d === '/sys/class/drm' ? ['card0', 'card0-VGA-1'] : []),
		read: async (p) => (p.endsWith('/vendor') ? '0x1a03\n' : p.endsWith('/product_name') ? 'ASPEED Graphics Family\n' : ''),
	})
	assert.deepEqual(aspeed.gpus, [])
	const virtio = await gpuUsage({
		run: async () => '',
		list: async (d) => (d === '/sys/class/drm' ? ['card0'] : []),
		read: async (p) => (p.endsWith('/vendor') ? '0x1af4\n' : ''),
	})
	assert.deepEqual(virtio.gpus, [])
})

test('hybrid Intel and NVIDIA cards get distinct indexes', async () => {
	const smi = async (cmd) => (cmd === 'nvidia-smi' ? '0, NVIDIA GeForce RTX 3050, GPU-aaa, 12, 100, 4096, 50\n' : '')
	const files = {
		'/sys/class/drm/card0/device/vendor': '0x8086\n',
		'/sys/class/drm/card1/device/vendor': '0x10de\n',
	}
	const {gpus} = await gpuUsage({
		run: smi,
		list: async (d) => (d === '/sys/class/drm' ? ['card0', 'card1'] : []),
		read: async (p) => files[p] ?? '',
	})
	assert.deepEqual(
		gpus.map((g) => [g.id, g.index, g.name]),
		[
			['GPU-aaa', 0, 'NVIDIA GeForce RTX 3050'],
			['drm-card0', 1, 'Intel Graphics'],
		],
	)
})

test('NVIDIA DRM nodes are not double-counted next to nvidia-smi', async () => {
	const files = {
		'/sys/class/drm/card0/device/vendor': '0x10de\n',
		'/sys/class/drm/card0/device/gpu_busy_percent': '99\n',
		'/sys/class/drm/card0/device/product_name': 'NVIDIA GeForce RTX 3060\n',
	}
	const {gpus} = await gpuUsage({
		run: runNvidia,
		list: async (dir) => (dir === '/sys/class/drm' ? ['card0'] : []),
		read: async (p) => files[p] ?? '',
	})
	assert.equal(gpus.length, 2)
	assert.ok(gpus.every((g) => g.id.startsWith('GPU-')))
})

test('sleeping NVIDIA still lists a sibling Intel iGPU', async () => {
	const {nvidiaAsleep} = await import('../omarchyd/system.mjs')
	let status = 'active'
	const files = {
		'/sys/bus/pci/devices/0000:01:00.0/vendor': '0x10de\n',
		'/sys/bus/pci/devices/0000:01:00.0/class': '0x030000\n',
		'/sys/class/drm/card0/device/vendor': '0x8086\n',
		'/sys/class/drm/card0/device/product_name': 'Intel Graphics\n',
	}
	const run = async (cmd) => (cmd === 'nvidia-smi' ? nvidiaCsv : '')
	const read = async (p) => (p.endsWith('runtime_status') && p.includes('01:00.0') ? status : (files[p] ?? ''))
	const list = async (p) => {
		if (p === '/sys/bus/pci/devices') return ['0000:01:00.0']
		if (p === '/sys/class/drm') return ['card0']
		return []
	}
	assert.equal(await nvidiaAsleep({list, read}), false)
	const awake = await gpuUsage({run, list, read})
	assert.equal(awake.gpus.length, 3)
	assert.equal(awake.gpus[2].id, 'drm-card0')
	status = 'suspended'
	assert.equal(await nvidiaAsleep({list, read}), true)
	const asleep = await gpuUsage({run, list, read})
	assert.equal(asleep.gpus.length, 3)
	assert.equal(asleep.gpus[0].used, 0)
	assert.equal(asleep.gpus[2].name, 'Intel Graphics')
})

test('nvidia-smi is reused for 3s; DRM sysfs is still read every call', async () => {
	let t = 0
	let smi = 0
	const files = {
		'/sys/class/drm/card0/device/vendor': '0x1002\n',
		'/sys/class/drm/card0/device/gpu_busy_percent': '10\n',
		'/sys/class/drm/card0/device/product_name': 'AMD Radeon\n',
	}
	const run = async (cmd) => (cmd === 'nvidia-smi' ? (smi++, nvidiaCsv) : '')
	const list = async (dir) => (dir === '/sys/class/drm' ? ['card0'] : [])
	const read = async (p) => files[p] ?? ''
	const once = () => gpuUsage({run, list, read, now: () => t})
	assert.equal((await once()).gpus.find((g) => g.id === 'drm-card0').used, 10)
	assert.equal(smi, 1)
	t = 1000
	files['/sys/class/drm/card0/device/gpu_busy_percent'] = '22\n'
	assert.equal((await once()).gpus.find((g) => g.id === 'drm-card0').used, 22)
	assert.equal(smi, 1)
	t = 3000
	await once()
	assert.equal(smi, 2)
})

test('a sleeping NVIDIA card is not woken: the last reading shows as idle', async () => {
	const {nvidiaAsleep} = await import('../omarchyd/system.mjs')
	let status = 'active'
	let smi = 0
	const run = async (cmd) => (cmd === 'nvidia-smi' ? (smi++, nvidiaCsv) : '')
	const files = {
		'/sys/bus/pci/devices/0000:01:00.0/vendor': '0x10de\n',
		'/sys/bus/pci/devices/0000:01:00.0/class': '0x030000\n',
		'/sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086\n',
		'/sys/bus/pci/devices/0000:00:02.0/class': '0x030000\n',
	}
	const read = async (p) => (p.endsWith('runtime_status') && p.includes('01:00.0') ? status : (files[p] ?? ''))
	const list = async (p) => (p === '/sys/bus/pci/devices' ? ['0000:00:02.0', '0000:01:00.0'] : [])
	assert.equal(await nvidiaAsleep({list, read}), false)
	assert.equal((await gpuUsage({run, list, read})).gpus[0].used, 32)
	assert.equal(smi, 1)
	status = 'suspended'
	assert.equal(await nvidiaAsleep({list, read}), true)
	const asleep = await gpuUsage({run, list, read})
	assert.equal(smi, 1, 'nvidia-smi not run while the card sleeps')
	assert.deepEqual(asleep.gpus.map((g) => [g.id, g.used, g.temperature]), [['GPU-aaa', 0, null], ['GPU-bbb', 0, null]])
	status = 'active'
	await gpuUsage({run, list, read})
	assert.equal(smi, 2)
	// No NVIDIA device at all: never counted as asleep.
	assert.equal(await nvidiaAsleep({list: async () => ['0000:00:02.0'], read}), false)
})
