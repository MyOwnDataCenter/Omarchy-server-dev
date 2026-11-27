# USB Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner bind host USB peripherals (serial/Zigbee sticks and similar) to one virtual machine or one app from a Devices tab, with exclusive-per-stick ownership.

**Architecture:** `omarchyd/usb.mjs` enumerates sysfs + `/dev/serial/by-id` and owns `usb.list` / `usb.attach` / `usb.detach`. Bindings persist on the machine record (`machines.json`) and the app record (`apps.json`). VMs get libvirt `<hostdev type='usb'>` and live `virsh attach-device` when QEMU allows it. Apps get a compose overlay `devices:` on start (rootless Podman cannot hot-plug a TTY). The root helper writes a udev `uaccess` rule so the owner’s session can open serial nodes.

**Tech Stack:** Node 20+ ESM, existing omarchyd JSON-RPC, Express `ALLOWED` allow-list, React + TanStack Query SPA, libvirt session (`qemu:///session`), rootless Podman via `docker-compose`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-18-usb-passthrough-design.md`

## Global Constraints

- Tabs, no semicolons, single quotes (match the repo).
- Product name is Omarchy Server.
- Do not bump `package.json` version, `OMARCHYD_VERSION`, `VERSION` in `server/app.mjs`, or `web/src/changelog.ts`.
- Do not add local clone paths, `OMARCHY_SERVER_SOURCE`, or `file://` app-store wiring.
- Do not mix isolation overlay, appearance_list, or live-turn into this branch.
- Work on `feat/usb-passthrough` cut from `upstream/main`. `node_modules` may be a symlink to the main clone; do not install a second copy.
- RpcError codes in this repo are `PRECONDITION_FAILED` (HTTP 412), `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`. The spec’s “FAILED_PRECONDITION” is this code.
- Owner-only writes: wrap `usb.attach` / `usb.detach` with `ownerOnly(auth, 'attach USB devices')` in `omarchyd/server.mjs`. Members may call `usb.list`.
- Never auto-restart a VM or app. Never add assistant tools in this feature.
- Helper SERIAL is `/^[A-Za-z0-9._-]{1,128}$/` only. No device node paths in the helper.
- Bump `INSTALLER_REVISION` in `install.sh` when helper verbs change. Leave version/changelog to the maintainer.
- Tests: fake sysfs; do not require real USB. Run `node --test --test-concurrency=1 test/usb.test.mjs` per task. Full `npm test` before a PR. Host `storage.test.mjs` `noPassword` may fail because the installed helper has `guest ok = yes`; mention that in the PR body. Unrelated `connector.test.mjs` theme-set fail on machines with `omarchy-theme-set` is also mention-only.
- Commit messages are sentence-case, like the rest of this repo (no `feat:` prefix).

## File map

Create:

- `omarchyd/usb.mjs` — `listHostUsb`, `hostdevXml`, `usbComposeOverlay`, `createUsb` (RPCs)
- `web/src/usb.tsx` — shared Devices tab (machines + apps)
- `test/usb.test.mjs` — enumerator, exclusive bind, XML, compose overlay, owner-only, helper udev

Modify:

- `omarchyd/server.mjs` — `usbOptions`, construct `createUsb`, merge procedures, `ownerOnly` on attach/detach
- `omarchyd/machines.mjs` — persist `usbDevices[]`, emit hostdev in `domainXml`, live attach/detach, `usbBindings` / `bindUsb` / `unbindUsb`
- `omarchyd/apps.mjs` — persist `usbDevices[]` + `usbApplied`, write `compose.usb.yml`, pass it to `docker-compose`, `usbBindings` / `bindUsb` / `unbindUsb`
- `omarchyd/storage.mjs` — export `helper` on the storage object so USB can call `usb-allow` / `usb-forget`
- `helper/helper.mjs` — verbs `usb-allow` / `usb-forget`; header comment
- `install.sh` — `INSTALLER_REVISION=2`
- `server/app.mjs` — `ALLOWED`: `usb.list` query, `usb.attach` / `usb.detach` mutations
- `web/src/api.ts` — `UsbDevice`, `UsbList`
- `web/src/data.ts` — invalidate `usb.list` after USB mutations
- `web/src/machines/panels.tsx` — `PanelId` + `PANELS` entry `usb`
- `web/src/screens/Machines.tsx` — render Devices panel
- `web/src/machines/Desktop.tsx` — render Devices panel
- `web/src/AppSheet.tsx` — Overview | Devices tabs
- `test/fake-omarchyd.mjs` — stub the three USB RPCs

Do not modify `omarchyd/assistant/tools.mjs`.

---

### Task 1: Enumerator and `usb.list`

**Files:**
- Create: `omarchyd/usb.mjs`
- Create: `test/usb.test.mjs`
- Modify: `omarchyd/server.mjs` (construct USB, register `usb.list`, accept `usbOptions`)
- Modify: `server/app.mjs` (`ALLOWED['usb.list'] = 'query'`)
- Modify: `test/fake-omarchyd.mjs` (`usb.list` returns `{devices: []}`)

**Interfaces:**
- Consumes: `node:fs/promises` `readdir` / `readFile` / `realpath`; `join` from `node:path`
- Produces:
  - `listHostUsb({readdir, readFile, realpath, sysfs = '/sys/bus/usb/devices', serialById = '/dev/serial/by-id'} = {})` → `Promise<HostUsb[]>`
  - `createUsb({enumerate, guests, helper})` → `{procedures: {'usb.list', 'usb.attach', 'usb.detach'}}` (attach/detach may throw `NOT_FOUND` until Task 2)
  - `HostUsb`: `{id, name, vendorId, productId, serial, path, node}` (`path`/`node`/`serial` are `string | null`; `vendorId`/`productId` are four lowercase hex chars)
  - `usb.list` returns `{devices: UsbDevice[]}` where `UsbDevice` is `HostUsb` plus `bound: null | {kind: 'machine' | 'app', id: string, name: string}` and `needsRestart: boolean`
- Guests adapter used later: `guests.bindings()` returns `[]` in this task

- [ ] **Step 1: Write the failing tests**

Create `test/usb.test.mjs` with a fake sysfs writer and enumerator tests. Do not create `omarchyd/usb.mjs` yet.

```js
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {listHostUsb} from '../omarchyd/usb.mjs'

async function writeTree(root, files) {
	for (const [p, v] of Object.entries(files)) {
		const abs = join(root, p)
		await mkdir(dirname(abs), {recursive: true})
		if (v && typeof v === 'object' && v.link) await symlink(v.link, abs)
		else await writeFile(abs, v)
	}
}

describe('listHostUsb', () => {
	let root
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'usb-enum-'))
		await writeTree(root, {
			'sys/bus/usb/devices/usb1/bDeviceClass': '09\n',
			'sys/bus/usb/devices/1-1/idVendor': '1d6b\n',
			'sys/bus/usb/devices/1-1/idProduct': '0002\n',
			'sys/bus/usb/devices/1-1/bDeviceClass': '09\n',
			'sys/bus/usb/devices/1-2/idVendor': '10c4\n',
			'sys/bus/usb/devices/1-2/idProduct': 'ea60\n',
			'sys/bus/usb/devices/1-2/serial': '0001\n',
			'sys/bus/usb/devices/1-2/manufacturer': 'Silicon Labs\n',
			'sys/bus/usb/devices/1-2/product': 'CP210x UART Bridge\n',
			'sys/bus/usb/devices/1-2/bDeviceClass': '00\n',
			'sys/bus/usb/devices/1-2:1.0/bInterfaceClass': 'ff\n',
			'sys/bus/usb/devices/1-3/idVendor': '0781\n',
			'sys/bus/usb/devices/1-3/idProduct': '5583\n',
			'sys/bus/usb/devices/1-3/bDeviceClass': '00\n',
			'sys/bus/usb/devices/1-3:1.0/bInterfaceClass': '08\n',
			'sys/bus/usb/devices/1-4/idVendor': '046d\n',
			'sys/bus/usb/devices/1-4/idProduct': 'c31c\n',
			'sys/bus/usb/devices/1-4/bDeviceClass': '00\n',
			'sys/bus/usb/devices/1-4:1.0/bInterfaceClass': '03\n',
			'sys/bus/usb/devices/1-4:1.0/bInterfaceSubClass': '01\n',
			'sys/bus/usb/devices/1-4:1.0/bInterfaceProtocol': '01\n',
			'sys/bus/usb/devices/2-1/idVendor': '1a86\n',
			'sys/bus/usb/devices/2-1/idProduct': '55d4\n',
			'sys/bus/usb/devices/2-1/serial': 'a8e5c3c0\n',
			'sys/bus/usb/devices/2-1/product': 'SONOFF Zigbee 3.0 USB Dongle Plus V2\n',
			'sys/bus/usb/devices/2-1/bDeviceClass': '02\n',
			'dev/serial/by-id/usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0': {link: join(root, 'dev/ttyUSB0')},
			'dev/ttyUSB0': '',
			'dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0': {link: join(root, 'dev/ttyACM0')},
			'dev/ttyACM0': '',
		})
	})
	after(() => rm(root, {recursive: true, force: true}))

	const list = () =>
		listHostUsb({
			sysfs: join(root, 'sys/bus/usb/devices'),
			serialById: join(root, 'dev/serial/by-id'),
		})

	test('lists a Sonoff-style serial stick and omits hub, disk, and boot keyboard', async () => {
		const devices = await list()
		const ids = devices.map((d) => d.id)
		assert.ok(ids.includes('usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0'))
		assert.ok(ids.includes('usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0'))
		assert.equal(devices.some((d) => d.vendorId === '1d6b' || d.vendorId === '0781' || d.vendorId === '046d'), false)
	})

	test('stable id is the by-id basename; a new bus keeps the same id', async () => {
		const first = (await list()).find((d) => d.serial === '0001')
		assert.equal(first.id, 'usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0')
		assert.equal(first.vendorId, '10c4')
		assert.equal(first.productId, 'ea60')
		assert.equal(first.path, '/dev/serial/by-id/usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0')
		await mkdir(join(root, 'sys/bus/usb/devices/3-4'), {recursive: true})
		for (const [name, value] of [
			['idVendor', '10c4\n'],
			['idProduct', 'ea60\n'],
			['serial', '0001\n'],
			['product', 'CP210x UART Bridge\n'],
			['bDeviceClass', '00\n'],
		])
			await writeFile(join(root, 'sys/bus/usb/devices/3-4', name), value)
		await mkdir(join(root, 'sys/bus/usb/devices/3-4:1.0'), {recursive: true})
		await writeFile(join(root, 'sys/bus/usb/devices/3-4:1.0/bInterfaceClass'), 'ff\n')
		await rm(join(root, 'sys/bus/usb/devices/1-2'), {recursive: true, force: true})
		const again = (await list()).find((d) => d.serial === '0001')
		assert.equal(again.id, first.id)
	})
})
```

- [ ] **Step 2: Run the enumerator tests to verify they fail**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: FAIL with `Cannot find package` / `ERR_MODULE_NOT_FOUND` for `../omarchyd/usb.mjs`.

- [ ] **Step 3: Implement `listHostUsb` and a stub `createUsb`**

Create `omarchyd/usb.mjs`:

- Read `/sys/bus/usb/devices` entries matching `/^[0-9]+-[0-9.]+$/` (skip `usb1`, skip `1-2:1.0` interface dirs as top-level devices).
- Normalize `idVendor` / `idProduct` to four lowercase hex chars.
- Exclude: device class `09` (hub), `08` (mass storage); interface class `08` or `09`; HID boot keyboard/mouse (interface class `03`, subclass `01`, protocol `01` or `02`).
- Include serial TTYs and other non-excluded peripherals.
- Identity: if `/dev/serial/by-id/usb-*` matches (serial substring in the link name, else `vid_pid`), `id` is that basename and `path` is `/dev/serial/by-id/<basename>` (always this POSIX path, not the fake root). `node` is the resolved tty path from `realpath`.
- Else `id` is `{vendorId}-{productId}-{serial}` or `{vendorId}-{productId}` if no serial.
- `name` is `product`, else `manufacturer + product`, else `vid:pid`.

`createUsb({enumerate = listHostUsb, guests = {bindings: () => []}, helper = async () => 'ok'} = {})`:

- `usb.list` `kind: 'query'`. Map host devices through bindings (empty this task) so `bound` is `null` and `needsRestart` is `false`.
- `usb.attach` / `usb.detach` `kind: 'mutation'` throwing `new RpcError('NOT_FOUND', 'That stick isn’t plugged in')` until Task 2.

- [ ] **Step 4: Wire `usb.list` in omarchyd and the web allow-list**

In `omarchyd/server.mjs`:

- Add `usbOptions = {}` to `startOmarchyd` args.
- After `createMachines` / `createApps` / `createStorage`:

```js
import {createUsb, listHostUsb} from './usb.mjs'
const usb = createUsb({
	enumerate: () => listHostUsb(usbOptions),
	guests: {bindings: () => []},
	helper: (verb, args) => storage.helper(verb, args),
})
```

`createStorage` does not export `helper` yet. For this task only, pass `helper: async () => 'ok'`. Exporting `helper` is Task 5.

- Spread `usb.procedures` into `procedures`. Do not wrap `usb.list` in `ownerOnly`.

In `server/app.mjs` `ALLOWED`, next to the machines block:

```js
'usb.list': 'query',
```

In `test/fake-omarchyd.mjs` procedures:

```js
'usb.list': {kind: 'query', run: () => ({devices: []})},
```

- [ ] **Step 5: Run the enumerator tests to verify they pass**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: PASS.

Also run: `node --test --test-concurrency=1 test/allowed.test.mjs`

Expected: PASS (`usb.list` is not yet called from `web/src`, so ALLOWED does not have to include attach/detach yet).

- [ ] **Step 6: Commit**

```bash
git add omarchyd/usb.mjs omarchyd/server.mjs server/app.mjs test/usb.test.mjs test/fake-omarchyd.mjs
git commit -m "List host USB devices with stable ids."
```

---

### Task 2: Attach and detach persistence, exclusive bind, owner-only

**Files:**
- Modify: `omarchyd/usb.mjs` (`attach` / `detach`)
- Modify: `omarchyd/machines.mjs` (`usbDevices` on the record, `usbBindings` / `bindUsb` / `unbindUsb`)
- Modify: `omarchyd/apps.mjs` (same three methods on the app record)
- Modify: `omarchyd/server.mjs` (wire guests adapter; `ownerOnly` on attach/detach)
- Modify: `server/app.mjs` (`usb.attach` / `usb.detach` mutations)
- Modify: `test/usb.test.mjs`
- Modify: `test/fake-omarchyd.mjs`

**Interfaces:**
- Consumes: `listHostUsb`; `RpcError` from `omarchyd/rpc.mjs`; `writeAtomic` already used by machines/apps `save()`
- Produces:
  - Machine record field `usbDevices: [{id, vendorId, productId, serial, path, name}]` (default `[]`)
  - App record field `usbDevices: [{id, vendorId, productId, serial, path, name}]` (default `[]`) plus `usbApplied: string[]` (ids applied at last successful start; default `[]`)
  - `machines.usbBindings()` / `apps.usbBindings()` → `{kind, id, name, devices, running, liveIds}[]`
  - `machines.bindUsb(id, rec)` / `apps.bindUsb(id, rec)` persist and `save()`; throw `NOT_FOUND` if the guest is missing; apps throw `PRECONDITION_FAILED` if `app.system`
  - `machines.unbindUsb(id, deviceId)` / `apps.unbindUsb(id, deviceId)`
  - `usb.attach` input `{deviceId, guest: {kind: 'machine' | 'app', id}}` → `{needsRestart: boolean, message?: string}`
  - `usb.detach` input `{deviceId}` → `{needsRestart: boolean, message?: string}`
- Live attach/compose inject still no-ops this task (`liveIds` always `[]`, so a running guest always yields `needsRestart: true` after attach). Helper calls are swallowed (`catch (() => {})`) until Task 5.

- [ ] **Step 1: Write the failing attach/detach tests**

Append to `test/usb.test.mjs`. Use in-memory guests plus a small `startOmarchyd` for owner-only.

```js
import {createUsb} from '../omarchyd/usb.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const stick = {
	id: 'usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0',
	name: 'SONOFF Zigbee 3.0 USB Dongle Plus V2',
	vendorId: '1a86',
	productId: '55d4',
	serial: 'a8e5c3c0',
	path: '/dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0',
	node: '/dev/ttyACM0',
}
const other = {
	id: 'usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0',
	name: 'CP210x UART Bridge',
	vendorId: '10c4',
	productId: 'ea60',
	serial: '0001',
	path: '/dev/serial/by-id/usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0',
	node: '/dev/ttyUSB0',
}

function memoryGuests() {
	const machines = [{id: 'vm1', name: 'Home', usbDevices: [], running: false, liveIds: []}]
	const apps = [{id: 'homeassistant', name: 'Home Assistant', usbDevices: [], running: false, liveIds: [], system: false}]
	const all = () => [
		...machines.map((m) => ({kind: 'machine', id: m.id, name: m.name, devices: m.usbDevices, running: m.running, liveIds: m.liveIds})),
		...apps.map((a) => ({kind: 'app', id: a.id, name: a.name, devices: a.usbDevices, running: a.running, liveIds: a.liveIds})),
	]
	const find = (kind, id) => (kind === 'machine' ? machines : apps).find((x) => x.id === id)
	return {
		machines,
		apps,
		guests: {
			bindings: all,
			bind: async (guest, rec) => {
				const g = find(guest.kind, guest.id)
				if (!g) throw new RpcError('NOT_FOUND', 'That machine doesn’t exist')
				if (g.system) throw new RpcError('PRECONDITION_FAILED', `${g.name} runs on the server itself, not in a container.`)
				if (!g.usbDevices.some((d) => d.id === rec.id)) g.usbDevices.push(rec)
			},
			unbind: async (_guest, deviceId) => {
				for (const g of [...machines, ...apps]) g.usbDevices = g.usbDevices.filter((d) => d.id !== deviceId)
			},
			liveAttach: async () => false,
			liveDetach: async () => false,
		},
	}
}

describe('createUsb attach', () => {
	test('one app may hold two sticks; a second guest is refused', async () => {
		const mem = memoryGuests()
		const usb = createUsb({enumerate: async () => [stick, other], guests: mem.guests, helper: async () => 'ok'})
		await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'app', id: 'homeassistant'}})
		await usb.procedures['usb.attach'].run({deviceId: other.id, guest: {kind: 'app', id: 'homeassistant'}})
		const listed = await usb.procedures['usb.list'].run()
		assert.equal(listed.devices.filter((d) => d.bound?.id === 'homeassistant').length, 2)
		await assert.rejects(
			usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'machine', id: 'vm1'}}),
			(e) => e instanceof RpcError && e.code === 'CONFLICT' && /Home Assistant/.test(e.message),
		)
	})

	test('already bound to this guest is a no-op; unplugged attach fails', async () => {
		const mem = memoryGuests()
		const usb = createUsb({enumerate: async () => [stick], guests: mem.guests, helper: async () => 'ok'})
		const a = await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'app', id: 'homeassistant'}})
		const b = await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'app', id: 'homeassistant'}})
		assert.equal(mem.apps[0].usbDevices.length, 1)
		assert.equal(a.needsRestart, false)
		assert.equal(b.needsRestart, false)
		await assert.rejects(
			usb.procedures['usb.attach'].run({deviceId: 'usb-missing', guest: {kind: 'app', id: 'homeassistant'}}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /Plug that stick in/.test(e.message),
		)
	})

	test('detach frees the stick; unplug does not clear the bind', async () => {
		const mem = memoryGuests()
		let plugged = [stick]
		const usb = createUsb({enumerate: async () => plugged, guests: mem.guests, helper: async () => 'ok'})
		await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'machine', id: 'vm1'}})
		plugged = []
		const gone = await usb.procedures['usb.list'].run()
		assert.equal(gone.devices.find((d) => d.id === stick.id).bound.id, 'vm1')
		assert.equal(gone.devices.find((d) => d.id === stick.id).path, null)
		await usb.procedures['usb.detach'].run({deviceId: stick.id})
		assert.equal(mem.machines[0].usbDevices.length, 0)
		assert.equal((await usb.procedures['usb.list'].run()).devices.some((d) => d.id === stick.id), false)
	})
})
```

Add an omarchyd integration test (same file) that starts a server, logs in as owner and as member (copy the `accounts.json` member push from `test/omarchyd.test.mjs` “network shares are owner-only”), and asserts:

- member `usb.list` succeeds (200)
- member `usb.attach` is 403 and message matches `/Only the server’s owner can attach USB devices/`
- owner attach to a missing guest is `NOT_FOUND`

Pass `usbOptions: {sysfs, serialById}` pointing at a tiny fake tree with the Sonoff stick, and `machineOptions: {run: async () => '', kvmDevice: join(root, 'kvm')}` plus `appOptions: {run: async () => '', defaultStores: [], systemApps: null}` so omarchyd starts without libvirt/compose.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: FAIL (`usb.attach` still throws `NOT_FOUND` / `That stick isn’t plugged in`, or `createUsb` has no real attach).

- [ ] **Step 3: Implement persist + exclusive + owner-only**

`createUsb` attach algorithm:

1. `deviceId` must be a non-empty string; else `BAD_REQUEST`.
2. `guest.kind` is `'machine'` or `'app'`; else `BAD_REQUEST`.
3. Host list. If the device is not plugged in → `PRECONDITION_FAILED` `'Plug that stick in, then try again'`.
4. `guests.bindings()`. If bound to this guest already → `{needsRestart: false}`.
5. If bound to another guest → `CONFLICT` ``That stick is already used by ${name}``.
6. `guests.bind(guest, {id, vendorId, productId, serial, path, name})`.
7. If the guest is running, `liveAttach` (always false this task). `needsRestart = running && !live`. Message when needsRestart: ``Restart ${name} to use this stick.``
8. If `serial` matches `/^[A-Za-z0-9._-]{1,128}$/`, `helper('usb-allow', [serial]).catch(() => {})`.
9. Return `{needsRestart, message}`.

Detach:

1. Find binding; if none → `{needsRestart: false}`.
2. If running, `liveDetach` (false this task).
3. `guests.unbind(guest, deviceId)`.
4. `helper('usb-forget', [serial]).catch(() => {})` when serial is valid and no remaining bind uses it.
5. Return `{needsRestart: running && !liveDetached, message}` with ``Restart ${name} to apply`` when needed.

`usb.list` must also emit unplugged-but-bound rows from `bindings()` whose `id` is missing from the host list (`path: null`, `node: null`, `bound` set). `needsRestart` is true only when `running` and the device id is not in `liveIds`.

In `omarchyd/machines.mjs`:

- `normalize`: `m.usbDevices = Array.isArray(m.usbDevices) ? m.usbDevices : []`
- On the returned object (next to `procedures`):

```js
usbBindings() {
	return machines.map((m) => ({
		kind: 'machine',
		id: m.id,
		name: m.name,
		devices: m.usbDevices ?? [],
		running: busy.get(m.id)?.state === 'starting' ? false : false, // live state filled in Task 3
		liveIds: m.usbLive ?? [],
	}))
},
async bindUsb(id, rec) {
	await ready
	const m = find(id)
	if (!(m.usbDevices ?? []).some((d) => d.id === rec.id)) m.usbDevices = [...(m.usbDevices ?? []), rec]
	await save()
	return m
},
async unbindUsb(id, deviceId) {
	await ready
	const m = find(id)
	m.usbDevices = (m.usbDevices ?? []).filter((d) => d.id !== deviceId)
	await save()
	return m
},
```

For `running` this task, a cheap read is enough: `const live = STATE[(await domainStates()).get(domain(m.id))]` — if virsh is missing, `domainStates` already catches and returns empty, so `running` is false in USB-only tests. Use that rather than hardcoding false if it is a one-liner; do not add attach-device yet.

In `omarchyd/apps.mjs` the same three methods. `bindUsb` uses `findInstalled`. If `app.system`, throw `PRECONDITION_FAILED` with ``${app.name} runs on the server itself, not in a container.``. `running` is `!['stopped', 'error'].includes(app.state)` and not busy-stopping — for tests that never start the app, `state` is `stopped` after install; default missing state from `list()` is treated as running only when compose ps says so. Simplest v1: `running` is true when `busy` is empty and `app.state` is not `'stopped'`/`'error'` and the in-memory compose-up set is not available here. Use `statesCache` if already populated, else `app.state === 'running'`. Tests in this task leave apps stopped.

In `omarchyd/server.mjs` replace the empty guests adapter:

```js
const usb = createUsb({
	enumerate: () => listHostUsb(usbOptions),
	guests: {
		bindings: () => [...machines.usbBindings(), ...apps.usbBindings()],
		bind: (guest, rec) => (guest.kind === 'machine' ? machines.bindUsb(guest.id, rec) : apps.bindUsb(guest.id, rec)),
		unbind: (guest, deviceId) => (guest.kind === 'machine' ? machines.unbindUsb(guest.id, deviceId) : apps.unbindUsb(guest.id, deviceId)),
		liveAttach: async () => false,
		liveDetach: async () => false,
	},
	helper: async () => 'ok',
})
```

Wrap mutations:

```js
...Object.fromEntries(
	Object.entries(usb.procedures).map(([name, p]) =>
		name === 'usb.list' ? [name, p] : [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'attach USB devices'), p.run(input))}],
	),
),
```

`ALLOWED`:

```js
'usb.attach': 'mutation',
'usb.detach': 'mutation',
```

`fake-omarchyd.mjs`: attach/detach return `{needsRestart: false}`.

- [ ] **Step 4: Run the USB tests to verify they pass**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omarchyd/usb.mjs omarchyd/machines.mjs omarchyd/apps.mjs omarchyd/server.mjs server/app.mjs test/usb.test.mjs test/fake-omarchyd.mjs
git commit -m "Bind a USB stick to one machine or app."
```

---

### Task 3: Libvirt hostdev and live attach

**Files:**
- Modify: `omarchyd/usb.mjs` (`hostdevXml`)
- Modify: `omarchyd/machines.mjs` (`domainXml` emits hostdev; `attachHostdev` / `detachHostdev`; `usbBindings().running` and `liveIds`)
- Modify: `omarchyd/server.mjs` (`liveAttach` / `liveDetach` call machines)
- Modify: `test/usb.test.mjs`

**Interfaces:**
- Consumes: machines `virsh` / `define` / `domainXml` / `liveState`
- Produces:
  - `hostdevXml({vendorId, productId, serial})` → XML string
  - `domainXml` includes one `<hostdev mode='subsystem' type='usb' managed='yes'>` per `m.usbDevices` entry (vendor/product as `0x####`; `<serial>` only when `serial` is non-null and matches `/^[A-Za-z0-9._-]{1,128}$/`)
  - `machines.attachHostdev(id, rec)` → `true` if `virsh attach-device DOMAIN FILE --live` succeeded, else `false` (never throws out of USB)
  - `machines.detachHostdev(id, rec)` → same with `detach-device`
  - After persist, always `define(m)` so the next start has hostdev
  - `usbBindings().liveIds` from `virsh dumpxml` hostdev vendor/product (+ serial when present). If dumpxml fails, `liveIds` is `m.usbLive` (in-memory, last successful live attach this process)

- [ ] **Step 1: Write the failing tests**

```js
import {hostdevXml} from '../omarchyd/usb.mjs'
import {createMachines} from '../omarchyd/machines.mjs'

test('hostdevXml is a managed USB hostdev with vid/pid', () => {
	const xml = hostdevXml({vendorId: '10c4', productId: 'ea60', serial: '0001'})
	assert.match(xml, /<hostdev mode='subsystem' type='usb' managed='yes'>/)
	assert.match(xml, /<vendor id='0x10c4'\/>/)
	assert.match(xml, /<product id='0xea60'\/>/)
	assert.match(xml, /<serial>0001<\/serial>/)
})

describe('machine USB hostdev', () => {
	test('define writes hostdev; live attach failure still persists and needsRestart', async () => {
		const root = await mkdtemp(join(os.tmpdir(), 'usb-vm-'))
		const dataDir = join(root, 'data')
		const kvm = join(root, 'kvm')
		await writeFile(kvm, '')
		const calls = []
		let dump = '<domain></domain>'
		const run = async (cmd, args) => {
			calls.push([cmd, ...(args[0] === '-c' ? args.slice(2) : args)].join(' '))
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'virsh' && a[0] === 'define') return ''
			if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n -    omarchy-abcd1234   running\n'
			if (cmd === 'virsh' && a[0] === 'dumpxml') return dump
			if (cmd === 'virsh' && a[0] === 'attach-device') throw new Error("qemu: unexpected error: usb device not supported")
			if (cmd === 'virsh' && a[0] === 'detach-device') return ''
			if (cmd === 'virsh' && a[0] === 'version') return 'QEMU 9.0.0\n'
			if (cmd === 'qemu-img') return ''
			return ''
		}
		await mkdir(join(dataDir, 'machines', 'vms', 'abcd1234'), {recursive: true})
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{id: 'abcd1234', name: 'Box', osId: 'testos-amd64', cores: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 10, portForwards: [], state: 'running', createdAt: 1}],
			}),
		)
		const machines = createMachines({dataDir, run, kvmDevice: kvm, catalogUrl: 'https://example.invalid/catalog.json', fetchImpl: async () => ({ok: false})})
		await machines.ready
		const rec = {id: stick.id, vendorId: '10c4', productId: 'ea60', serial: '0001', path: stick.path, name: 'CP210x'}
		await machines.bindUsb('abcd1234', rec)
		assert.match(await readFile(join(dataDir, 'machines', 'vms', 'abcd1234', 'domain.xml'), 'utf8'), /<hostdev type='usb'|type='usb' managed='yes'/)
		const usb = createUsb({
			enumerate: async () => [{...stick, vendorId: '10c4', productId: 'ea60', serial: '0001'}],
			guests: {
				bindings: () => machines.usbBindings(),
				bind: (g, r) => machines.bindUsb(g.id, r),
				unbind: (g, id) => machines.unbindUsb(g.id, id),
				liveAttach: (g, r) => machines.attachHostdev(g.id, r),
				liveDetach: (g, r) => machines.detachHostdev(g.id, r),
			},
			helper: async () => 'ok',
		})
		const result = await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'machine', id: 'abcd1234'}})
		assert.equal(result.needsRestart, true)
		assert.match(result.message, /Restart Box/)
		assert.ok(calls.some((c) => c.includes('attach-device')))
		const listed = await usb.procedures['usb.list'].run()
		assert.equal(listed.devices.find((d) => d.id === stick.id).needsRestart, true)
		assert.equal(listed.devices.find((d) => d.id === stick.id).bound.name, 'Box')
		await rm(root, {recursive: true, force: true})
	})
})
```

Fix the hostdev assert to whatever `domainXml` actually emits (`<hostdev mode='subsystem' type='usb' managed='yes'>`). The test above accepts either.

A second test in the same describe: `attach-device` succeeds, `dumpxml` contains the vendor, `needsRestart` is false.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: FAIL (`hostdevXml` not exported and/or `domain.xml` has no hostdev; `attachHostdev` missing).

- [ ] **Step 3: Implement XML + live attach**

In `omarchyd/usb.mjs`:

```js
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c])
export function hostdevXml({vendorId, productId, serial}) {
	const ser = serial && /^[A-Za-z0-9._-]{1,128}$/.test(serial) ? `<serial>${xml(serial)}</serial>` : ''
	return `<hostdev mode='subsystem' type='usb' managed='yes'><source><vendor id='0x${vendorId}'/><product id='0x${productId}'/>${ser}</source></hostdev>`
}
```

In `domainXml`, inside `<devices>` after the rng line, append:

```js
${(m.usbDevices ?? []).map((d) => hostdevXml(d)).join('\n    ')}
```

Import `hostdevXml` from `./usb.mjs`. (`usb.mjs` must not import `machines.mjs`.)

`bindUsb`: after `save()`, `await define(m).catch(() => {})`.

`attachHostdev`:

```js
async function attachHostdev(id, rec) {
	await ready
	const m = find(id)
	const file = join(vmsDir, m.id, 'usb-hostdev.xml')
	await writeFile(file, hostdevXml(rec), {mode: 0o600})
	try {
		await virsh('attach-device', domain(m.id), file, '--live')
		m.usbLive = [...new Set([...(m.usbLive ?? []), rec.id])]
		await save()
		return true
	} catch (error) {
		m.lastUsbError = error.message
		await save()
		return false
	}
}
```

`detachHostdev` uses `detach-device` and removes from `usbLive`.

`usb.attach` live path: `const live = running ? await guests.liveAttach(guest, rec) : false`. If running and `live === false`, `needsRestart: true` and `message` is ``Restart ${name} to use this stick.`` If `m.lastUsbError` is set, append it in the return `message` (toast shows the QEMU text). Then clear `lastUsbError` after reading.

`usbBindings` `running`: `(await liveState(m)) === 'running'` — `usbBindings` is sync in Task 2. Change it to sync using the last `domainStates` if already sampled, or make `bindings()` async.

Prefer: `createUsb` `list`/`attach` already `await` bind. Change `guests.bindings` to `async () => [...]` and `await` it in list/attach/detach. `machines.usbBindings` becomes `async`. Update Task 2 unit tests: `bindings: all` stays sync (a sync function is awaitable). `usbBindings` in machines:

```js
async usbBindings() {
	await ready
	const states = await domainStates()
	return machines.map((m) => ({
		kind: 'machine',
		id: m.id,
		name: m.name,
		devices: m.usbDevices ?? [],
		running: STATE[states.get(domain(m.id))] === 'running',
		liveIds: m.usbLive ?? [],
	}))
}
```

Optional dumpxml parse can wait; in-memory `usbLive` is enough if we set it only on successful attach-device and clear it on detach and on omarchyd start (so after a process restart a running VM with hostdev in domain.xml but empty `usbLive` shows needsRestart until dumpxml is parsed). Spec wants accuracy after restart: parse `dumpxml` when running.

Add `parseUsbLive(xml)` in `usb.mjs` that returns ids matching vendor/product against `m.usbDevices`. Call it from `usbBindings` when running.

- [ ] **Step 4: Run the USB tests to verify they pass**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omarchyd/usb.mjs omarchyd/machines.mjs omarchyd/server.mjs test/usb.test.mjs
git commit -m "Pass USB through to a running virtual machine."
```

---

### Task 4: App record, compose `devices:`, needsRestart

**Files:**
- Modify: `omarchyd/usb.mjs` (`usbComposeOverlay`)
- Modify: `omarchyd/apps.mjs` (`compose` extra `-f`, write overlay on start/restart, skip missing paths)
- Modify: `omarchyd/server.mjs` (app `liveAttach` always returns false; `liveDetach` always false)
- Modify: `test/usb.test.mjs`

**Interfaces:**
- Consumes: `yaml` (already a runtime dependency); `prepareCompose` unchanged
- Produces:
  - `usbComposeOverlay(serviceNames, devices)` → YAML string `{services: { [name]: {devices: ['path:path', ...]} }}` using only entries whose `path` is a string starting with `/dev/serial/by-id/` or `/dev/ttyUSB` or `/dev/ttyACM` (reject anything else)
  - `apps.writeUsbOverlay(app)` writes `compose.usb.yml` next to `compose.omarchy.yml`, or deletes it when there are no live paths
  - `compose(app, ...args)` becomes `docker-compose -p … -f compose.omarchy.yml [-f compose.usb.yml] …`
  - On `apps.start` / `apps.restart` (`lifecycle` args `up` or `restart`): write overlay, then compose, then `app.usbApplied = (app.usbDevices ?? []).map((d) => d.id)`, `save()`
  - `apps.usbBindings().liveIds` is `app.usbApplied` when the current `usbDevices` ids equal `usbApplied` (same members); else `[]` so `needsRestart` is true while running after a bind
  - A running app is never recreated by `usb.attach`

- [ ] **Step 1: Write the failing tests**

```js
import {usbComposeOverlay} from '../omarchyd/usb.mjs'
import YAML from 'yaml'

test('usbComposeOverlay injects path:path on every service', () => {
	const text = usbComposeOverlay(['homeassistant', 'db'], [{path: '/dev/serial/by-id/usb-x'}, {path: null}])
	const doc = YAML.parse(text)
	assert.deepEqual(doc.services.homeassistant.devices, ['/dev/serial/by-id/usb-x:/dev/serial/by-id/usb-x'])
	assert.deepEqual(doc.services.db.devices, ['/dev/serial/by-id/usb-x:/dev/serial/by-id/usb-x'])
})

test('usbComposeOverlay ignores a path that is not a serial node', () => {
	assert.equal(usbComposeOverlay(['web'], [{path: '/etc/passwd'}]).trim() === '' || !YAML.parse(usbComposeOverlay(['web'], [{path: '/etc/passwd'}])).services.web.devices?.length, true)
})
```

Add an apps integration: reuse the `test/apps.test.mjs` store fixture pattern (git file:// store with `demo-app`, simulated `docker-compose`). After install, `usb.attach` to `demo-app` while stopped, then `apps.start`, then assert the compose invocation includes `-f` `compose.usb.yml` and that file contains the serial path. Then attach a second time while the app is running: `needsRestart: true`, and no extra `docker-compose up`/`restart` in the call log.

Skip missing path: bind a stick, unplug it in the fake enumerator (path gone), `apps.start` still succeeds; overlay omitted or empty; list shows Unplugged (`path: null`).

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: FAIL (`usbComposeOverlay` not exported; compose does not receive a second `-f`).

- [ ] **Step 3: Implement overlay inject**

`usbComposeOverlay`:

```js
const SERIAL_PATH = /^\/dev\/(serial\/by-id\/usb-[A-Za-z0-9._+-]+|ttyUSB[0-9]+|ttyACM[0-9]+)$/
export function usbComposeOverlay(serviceNames, devices) {
	const binds = (devices ?? []).map((d) => d.path).filter((p) => SERIAL_PATH.test(p)).map((p) => `${p}:${p}`)
	if (!binds.length) return ''
	const services = Object.fromEntries(serviceNames.map((name) => [name, {devices: binds}]))
	return YAML.stringify({services})
}
```

Import `yaml` in `usb.mjs` the same way `apps.mjs` does (`import YAML from 'yaml'`).

In `apps.mjs`:

- `usbFile = (id) => join(appDir(id), 'compose.usb.yml')`
- `writeUsbOverlay(app)`: parse service names from `compose.omarchy.yml`; write overlay or `rm` the file.
- Change `compose` to include `-f usbFile` when the file exists.
- In `lifecycle`, before `compose(app, ...args)`, if `args[0] === 'up' || args[0] === 'restart'`, `await writeUsbOverlay(app)`. After success, `app.usbApplied = (app.usbDevices ?? []).map((d) => d.id)`, `await save()`.
- `bindUsb` / `unbindUsb` do **not** call compose.

`usb.attach` for apps: `liveAttach` stays `async () => false`. Running → `needsRestart: true`.

- [ ] **Step 4: Run the USB tests to verify they pass**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omarchyd/usb.mjs omarchyd/apps.mjs omarchyd/server.mjs test/usb.test.mjs
git commit -m "Hand a USB serial stick to an app on start."
```

---

### Task 5: Helper udev rules and installer revision

**Files:**
- Modify: `helper/helper.mjs` (verbs + header comment)
- Modify: `install.sh` (`INSTALLER_REVISION=2`)
- Modify: `omarchyd/storage.mjs` (export `helper` on the returned object)
- Modify: `omarchyd/server.mjs` (real `storage.helper` for USB)
- Modify: `test/usb.test.mjs`

**Interfaces:**
- Consumes: existing `writeAtomic`, `createHelper` `fs` / `run`
- Produces:
  - `usb-allow SERIAL` writes/keeps `/etc/udev/rules.d/69-omarchy-server-usb.rules` with:
    - `SUBSYSTEM=="tty", ENV{ID_USB_SERIAL_SHORT}=="SERIAL", TAG+="uaccess"`
    - `SUBSYSTEM=="tty", ENV{ID_SERIAL_SHORT}=="SERIAL", TAG+="uaccess"`
    - then `udevadm control --reload` and `udevadm trigger`
  - `usb-forget SERIAL` drops those lines; deletes the file if only comments remain (write `''` like sleep)
  - SERIAL must match `/^[A-Za-z0-9._-]{1,128}$/` else `HelperError`
  - `createStorage(...).helper` is the existing sudo wrapper

- [ ] **Step 1: Write the failing helper tests**

Reuse `fakeFs` / `fakeRun` shape from `test/storage.test.mjs` (inline a copy in `test/usb.test.mjs`; do not import from that file).

```js
import {createHelper} from '../helper/helper.mjs'

test('usb-allow writes uaccess; usb-forget removes it; traversal is rejected', async () => {
	const user = {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'}
	const fs = fakeFs()
	const log = []
	const h = createHelper({
		user,
		fs,
		run: async (cmd, args) => (log.push([cmd, ...args]), ''),
	})
	await h.handle('usb-allow', ['a8e5c3c0'])
	const rules = fs.files.get('/etc/udev/rules.d/69-omarchy-server-usb.rules')
	assert.match(rules, /ID_USB_SERIAL_SHORT}=="a8e5c3c0".*TAG\+="uaccess"/)
	assert.ok(log.some((l) => l[0] === 'udevadm' && l[1] === 'control'))
	await assert.rejects(h.handle('usb-allow', ['../../etc/passwd']), /serial/i)
	await h.handle('usb-forget', ['a8e5c3c0'])
	assert.equal(fs.files.get('/etc/udev/rules.d/69-omarchy-server-usb.rules'), '')
})
```

Add a test that `createUsb` attach with a helper that throws still persists the bind (helper missing/old).

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: FAIL (`Unknown action: usb-allow`).

- [ ] **Step 3: Implement helper verbs, export `storage.helper`, bump installer revision**

In `helper/helper.mjs`:

- Header comment: add `usb-allow SERIAL` / `usb-forget SERIAL`.
- `const UDEV_USB = '/etc/udev/rules.d/69-omarchy-server-usb.rules'`
- `const USB_SERIAL = /^[A-Za-z0-9._-]{1,128}$/`
- Verbs (same style as `sleep`):

```js
'usb-allow': async ([serial]) => {
	if (!USB_SERIAL.test(serial ?? '')) fail('Use the USB serial, letters numbers . _ - only')
	const keep = (await fs.readFile(UDEV_USB, 'utf8').catch(() => '')).split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(`=="${serial}"`))
	keep.push(
		`SUBSYSTEM=="tty", ENV{ID_USB_SERIAL_SHORT}=="${serial}", TAG+="uaccess"`,
		`SUBSYSTEM=="tty", ENV{ID_SERIAL_SHORT}=="${serial}", TAG+="uaccess"`,
	)
	await writeAtomic(UDEV_USB, `# USB serial access, set by Omarchy Server\n${keep.join('\n')}\n`)
	await run('udevadm', ['control', '--reload']).catch(() => {})
	await run('udevadm', ['trigger']).catch(() => {})
	return 'ok'
},
'usb-forget': async ([serial]) => {
	if (!USB_SERIAL.test(serial ?? '')) fail('Use the USB serial, letters numbers . _ - only')
	const keep = (await fs.readFile(UDEV_USB, 'utf8').catch(() => '')).split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(`=="${serial}"`))
	await writeAtomic(UDEV_USB, keep.length ? `# USB serial access, set by Omarchy Server\n${keep.join('\n')}\n` : '')
	await run('udevadm', ['control', '--reload']).catch(() => {})
	return 'ok'
},
```

In `omarchyd/storage.mjs` return object, add `helper` next to `firewall`.

In `omarchyd/server.mjs`, `helper: (verb, args) => storage.helper(verb, args)`.

`install.sh`: `INSTALLER_REVISION=2`.

- [ ] **Step 4: Run the USB tests to verify they pass**

Run: `node --test --test-concurrency=1 test/usb.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add helper/helper.mjs install.sh omarchyd/storage.mjs omarchyd/server.mjs test/usb.test.mjs
git commit -m "Let rootless apps open USB serial nodes."
```

---

### Task 6: Devices tab on machines and apps

**Files:**
- Create: `web/src/usb.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/data.ts`
- Modify: `web/src/machines/panels.tsx`
- Modify: `web/src/screens/Machines.tsx`
- Modify: `web/src/machines/Desktop.tsx`
- Modify: `web/src/AppSheet.tsx`
- Modify: `web/src/styles.css` (only if Overview | Devices needs a compact tab strip that `.mx-tabs` does not already cover)

**Interfaces:**
- Consumes: `query('usb.list')`, `mutate` via `useAction` paths `usb.attach` / `usb.detach`, `useUser().data?.role !== 'member'`, existing `Icon` `usb`
- Produces: shared `DevicesPanel({guest: {kind, id, name}})`
- No Playwright. `test/allowed.test.mjs` is the UI RPC gate.

- [ ] **Step 1: Add types and invalidate `usb.list`**

In `web/src/api.ts`:

```ts
export type UsbBound = {kind: 'machine' | 'app'; id: string; name: string}
export type UsbDevice = {
	id: string
	name: string
	vendorId: string
	productId: string
	serial: string | null
	path: string | null
	node: string | null
	bound: UsbBound | null
	needsRestart: boolean
}
export type UsbList = {devices: UsbDevice[]}
```

In `web/src/data.ts` `useAction` `onSettled`, after the machines block:

```ts
if (domain === 'usb') qc.invalidateQueries({queryKey: ['usb.list']})
```

- [ ] **Step 2: Build `DevicesPanel`**

`web/src/usb.tsx`:

- `useQuery({queryKey: ['usb.list'], queryFn: () => query<UsbList>('usb.list'), refetchInterval: 5000})`
- `useAction()` for attach/detach
- `const owner = useUser().data?.role !== 'member'`
- Empty: “Plug a serial adapter or Zigbee stick into this server.”
- Each row: name, `vid:pid`, serial path when present
- Free + owner: button **Use with this {machine|app}** → `usb.attach` `{deviceId, guest}` with `done` from the result message or ``${name} can use this stick``
- Bound here: **Remove** → `usb.detach` `{deviceId}`; if `needsRestart`, muted “Restart {name} to apply”
- Bound elsewhere: muted “Used by {name}”, no attach button
- Bound here and `path` is null: muted “Unplugged”, Remove still available
- Members: list and “Used by” / Unplugged labels; no Use/Remove
- If `useQuery` on `system.installerStatus` has `needed`, a muted note: “The server helper needs an update to hand this stick to apps.”
- Match Port forwarding markup: `section` + `h4.list-head` + `div.glass.group` + `div.row.static` + `button.btn.small`

Label the section **Devices**. Icon `usb`.

- [ ] **Step 3: Machine Devices tab**

`web/src/machines/panels.tsx`:

- Extend `PanelId` with `'usb'`
- Insert `{id: 'usb', label: 'Devices', icon: 'usb'}` in `PANELS` after `network` (Port forwarding)

`web/src/screens/Machines.tsx` `MachineSheet` switch: `tab === 'usb'` → `<DevicesPanel guest={{kind: 'machine', id: m.id, name: m.name}} />` (import from `../usb`)

`web/src/machines/Desktop.tsx` `VmView` switch: `panel === 'usb'` → same panel inside `div.mx-panel`

- [ ] **Step 4: App sheet Overview | Devices**

`web/src/AppSheet.tsx`:

- `const [tab, setTab] = useState<'overview' | 'usb'>('overview')`
- Reset tab when `app.id` changes
- Compact tab strip above the current body (`div.mx-tabs` / `chip`, same as MachineSheet): **Overview** | **Devices**
- Overview: existing header, actions, KV, uninstall
- Devices: `<DevicesPanel guest={{kind: 'app', id: app.id, name}} />` (keep SheetHeader so the app is still identified)

This covers phone (`App.tsx`) and desktop (`desktop/Desktop.tsx`) because both render `AppSheet`.

- [ ] **Step 5: Typecheck and allowed-list tests**

Run:

```bash
npx tsc --noEmit -p web
node --test --test-concurrency=1 test/allowed.test.mjs test/usb.test.mjs
```

Expected: PASS. If `allowed.test.mjs` reports `usb.attach` / `usb.detach` missing, add them to `ALLOWED` (Task 2 should already have).

If typecheck fails on `PanelId` exhaustiveness, fix the switch fallbacks (today the last branch is Monitor; `usb` must be handled before that).

- [ ] **Step 6: Commit**

```bash
git add web/src/usb.tsx web/src/api.ts web/src/data.ts web/src/machines/panels.tsx web/src/screens/Machines.tsx web/src/machines/Desktop.tsx web/src/AppSheet.tsx web/src/styles.css
git commit -m "Add a Devices tab on machines and apps."
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Enumerator, stable id, eligibility | 1 |
| `usb.list` shape, unplugged-but-bound | 1–2 |
| Exclusive bind, many sticks per guest, owner-only | 2 |
| Persist on machine/app records | 2 |
| Libvirt hostdev + live attach/detach + needsRestart | 3 |
| App compose `devices:` on start, no hot-plug | 4 |
| Helper udev + INSTALLER_REVISION | 5 |
| Devices tab on machine PANELS and app sheet | 6 |
| No assistant tools, no auto-restart, no version bump | Global Constraints |
| Tests listed in spec §12 | 1–5 (`test/usb.test.mjs`) |

**Placeholder scan:** none remaining. Error code is `PRECONDITION_FAILED` throughout.

**Type consistency:** `HostUsb` / `UsbDevice` / `usbDevices[]` records share `id, vendorId, productId, serial, path, name`. `guest: {kind: 'machine' | 'app', id}`. Attach/detach return `{needsRestart, message?}`. `liveIds` is `string[]`. Helper SERIAL is the USB serial string, never a path.
