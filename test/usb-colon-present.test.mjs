import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import YAML from 'yaml'

import {createHelper} from '../helper/helper.mjs'
import {createUsb, hostdevXml, listHostUsb, usbComposeOverlay} from '../omarchyd/usb.mjs'

const COLON = '/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_F0:F5:BD:01:88:2C-if00'

test('a by-id path with a colon is passed through without the short host:container form', () => {
	const plain = usbComposeOverlay(['web'], [{path: COLON}])
	const doc = YAML.parse(plain)
	assert.ok(doc?.services?.web?.devices?.length, plain)
	assert.notEqual(doc.services.web.devices[0], `${COLON}:${COLON}`)
	const dev = doc.services.web.devices[0]
	const source = typeof dev === 'string' ? dev.split(':')[0] : dev.source
	assert.equal(source, COLON)

	const viaNode = YAML.parse(usbComposeOverlay(['web'], [{path: COLON, node: '/dev/ttyACM3'}]))
	assert.deepEqual(viaNode.services.web.devices, ['/dev/ttyACM3:/dev/ttyACM3'])

	assert.equal(usbComposeOverlay(['web'], [{path: '/etc/passwd'}]).trim(), '')
	assert.equal(usbComposeOverlay(['web'], [{path: '/dev/sda1'}]).trim(), '')
	assert.equal(usbComposeOverlay(['web'], [{path: '/dev/serial/by-id/usb-../../etc/passwd'}]).trim(), '')
	assert.equal(usbComposeOverlay(['web'], [{path: '/dev/serial/by-id/usb-name with space'}]).trim(), '')
	const ok = YAML.parse(usbComposeOverlay(['web'], [{path: '/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0'}]))
	assert.deepEqual(ok.services.web.devices, ['/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0:/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0'])
})

test('a colon in a USB serial is allowed in the udev rule and in VM xml', async () => {
	const serial = 'F0:F5:BD:01:88:2C'
	const xml = hostdevXml({vendorId: '303a', productId: '1001', serial})
	assert.match(xml, new RegExp(`<serial>${serial}</serial>`))
	const files = new Map()
	const h = createHelper({
		user: {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'},
		fs: {
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
		},
		run: async () => '',
	})
	await h.handle('usb-allow', [serial])
	const rules = files.get('/etc/udev/rules.d/69-omarchy-server-usb.rules')
	assert.match(rules, new RegExp(`=="${serial}"`))
	await assert.rejects(h.handle('usb-allow', ['../../etc/passwd']), /serial/i)
	await assert.rejects(h.handle('usb-allow', ['has space']), /serial/i)
})

test('usb.list says whether the host still sees the device', async () => {
	const usb = createUsb({
		enumerate: async () => [{id: 'cam', name: 'Webcam C270', vendorId: '046d', productId: '0825', serial: null, path: null, node: null}],
		guests: {
			bindings: async () => [
				{
					kind: 'machine',
					id: 'm1',
					name: 'Win',
					devices: [
						{id: 'cam', name: 'Webcam C270', vendorId: '046d', productId: '0825', serial: null, path: null},
						{id: 'gone', name: 'Old stick', vendorId: '1111', productId: '2222', serial: 'abc', path: '/dev/serial/by-id/usb-old'},
					],
				},
			],
		},
	})
	const {devices} = await usb.procedures['usb.list'].run()
	const cam = devices.find((d) => d.id === 'cam')
	const gone = devices.find((d) => d.id === 'gone')
	assert.equal(cam.path, null)
	assert.equal(cam.present, true)
	assert.equal(gone.present, false)
})

test('a webcam with no by-id link is still listed from sysfs', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'usb-cam-'))
	try {
		const sys = join(root, 'sys')
		const dev = join(root, 'dev/serial/by-id')
		await mkdir(join(sys, '1-2'), {recursive: true})
		await mkdir(dev, {recursive: true})
		await writeFile(join(sys, '1-2', 'idVendor'), '046d\n')
		await writeFile(join(sys, '1-2', 'idProduct'), '0825\n')
		await writeFile(join(sys, '1-2', 'product'), 'Webcam C270\n')
		await writeFile(join(sys, '1-2', 'bDeviceClass'), 'ef\n')
		const found = await listHostUsb({sysfs: sys, serialById: dev})
		assert.equal(found.length, 1)
		assert.equal(found[0].path, null)
		assert.equal(found[0].name, 'Webcam C270')
		const usb = createUsb({enumerate: async () => found, guests: {bindings: async () => []}})
		const {devices} = await usb.procedures['usb.list'].run()
		assert.equal(devices[0].present, true)
		assert.equal(devices[0].path, null)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a hub is still excluded when colon serials are allowed', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'usb-hub-'))
	try {
		const sys = join(root, 'sys')
		await mkdir(join(sys, '1-1'), {recursive: true})
		await writeFile(join(sys, '1-1', 'idVendor'), '1d6b\n')
		await writeFile(join(sys, '1-1', 'idProduct'), '0002\n')
		await writeFile(join(sys, '1-1', 'bDeviceClass'), '09\n')
		const found = await listHostUsb({sysfs: sys, serialById: join(root, 'missing-by-id')})
		assert.deepEqual(found, [])
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
