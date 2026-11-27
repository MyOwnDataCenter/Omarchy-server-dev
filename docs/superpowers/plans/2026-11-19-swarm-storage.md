# Storage and Format on Swarm Computers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner Format and Unmount extra disks on this Omarchy Server and on Local swarm computers from the same Storage screens, with SMART health, HDD sleep, and pools on swarm.

**Architecture:** Host `helper.mjs` gains `umount` / `format` (refuse system, pool, mounted). Swarm computers get a Python helper with the same rules, installed by the connector when pairing ability `storage` is on. The SPA reuses `Storage.tsx` with `target: 'host' | {agentId}`. Gauges keep using mount-usage `metrics.disks`; Storage queries `storage.*` or `swarm.storage.*` on demand.

**Tech Stack:** Node 20+ ESM, omarchyd JSON-RPC, Express `ALLOWED`, React + TanStack Query, Python 3.8+ connector (stdlib), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-19-swarm-storage-design.md`

## Global Constraints

- Tabs, no semicolons, single quotes (match the repo).
- Product name is Omarchy Server.
- Do not bump `package.json` version, `OMARCHYD_VERSION`, `VERSION` in `server/app.mjs`, or `web/src/changelog.ts`.
- Do not add local clone paths, `OMARCHY_SERVER_SOURCE`, or `file://` app-store wiring.
- Do not mix isolation overlay, USB passthrough, or assistant Approve-copy into this branch.
- Work on `feat/swarm-storage` cut from `upstream/main`. `node_modules` may be a symlink to the main clone; do not install a second copy.
- RpcError codes are `PRECONDITION_FAILED` (HTTP 412), `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`.
- Format / Unmount / pool writes / sleep are owner-only. Do not add assistant tools.
- Helper DEV is a whole disk: `/dev/sdX`, `/dev/vdX`, `/dev/nvmeXnY`, `/dev/hdX`, or `/dev/disk/by-id/…` that realpath’s to one. No `..`, no `-partN`.
- Filesystem after Format is `blank` | `ext4` | `exfat`. No partition table in v1. Format does not unmount.
- Bump host `INSTALLER_REVISION` by 1 when host helper verbs change (this branch: `1` → `2`). Swarm helper is the connector install, not that revision.
- Tests: fake lsblk / fake helper; do not require a real USB disk. Run the task’s `node --test --test-concurrency=1` file. Full `npm test` before a PR. Host `storage.test.mjs` `noPassword` may fail because the installed helper has `guest ok = yes`; mention that in the PR body.
- Commit messages are sentence-case, like the rest of this repo (no `feat:` prefix).

## File map

Create:

- `web/src/storageTools.ts` — `formatConfirmToken`, `canFormat`, `canUnmount`
- `connector/helper.py` — root helper for swarm (ping, smart, umount, format, then pools/sleep)
- `connector/test_helper.py` — unittest for helper.py
- `test/storage-tools.test.mjs` — confirm token / canFormat
- `test/swarm-storage.test.mjs` — swarm.storage RPCs with a fake agent helper

Modify:

- `helper/helper.mjs` — verbs `umount`, `format`; `resolveDisk`; header comment; blankDisk copy
- `install.sh` — `INSTALLER_REVISION=2`
- `omarchyd/storage.mjs` — `mounted` / `mounts` / `id` on disks; `storage.unmount` / `storage.format`
- `omarchyd/server.mjs` — ownerOnly on format/unmount; register `swarm.storage.*`
- `omarchyd/connector.mjs` — ability `storage`; `swarm.storage.*` procedures
- `server/app.mjs` — ALLOWED + SLOW for new RPCs
- `connector/agent.py` — ability `storage`; storage call names; sudo helper
- `connector/install.sh` — helper, sudoers, packages, `NoNewPrivileges` only when storage is off
- `web/src/screens/Storage.tsx` — Format / Unmount; `target` prop
- `web/src/screens/Settings.tsx` — pass `target="host"`
- `web/src/swarm/Swarm.tsx` — Storage ability checkbox; Storage row; open StoragePage
- `web/src/api.ts` — Drive fields if the type lives here (it currently lives in Storage.tsx)
- `test/storage.test.mjs` — helper format/unmount; omarchyd RPCs
- `test/connector.test.mjs` — pairing ability `storage` is stored
- `test/allowed.test.mjs` — no extra work if ALLOWED is updated (it asserts automatically)

Do not modify `omarchyd/assistant/tools.mjs`.

---

### Task 1: Host helper Format / Unmount and this server’s Storage sheet

**Files:**
- Modify: `helper/helper.mjs` (header, `resolveDisk`, verbs `umount` / `format`, blankDisk message)
- Modify: `omarchyd/storage.mjs` (`disks()` fields, procedures)
- Modify: `omarchyd/server.mjs` (ownerOnly wrap for format/unmount)
- Modify: `server/app.mjs` (`ALLOWED`, `SLOW`)
- Modify: `install.sh` (`INSTALLER_REVISION=2`)
- Modify: `test/storage.test.mjs`
- Create: `web/src/storageTools.ts`
- Create: `test/storage-tools.test.mjs`
- Modify: `web/src/screens/Storage.tsx` (Drive type + DriveSheet)

**Interfaces:**
- Consumes: existing `createHelper({user, run, fs})`, `createStorage({run, ...})`, `DEV`, `SYSTEM_MOUNTS`, `blankDisk`
- Produces:
  - `resolveDisk(path)` → lsblk disk object (whole disk only)
  - `handle('umount', [path])` → `'ok'`
  - `handle('format', [path, fs])` → `'ok'` with `fs` in `blank|ext4|exfat`
  - `storage.unmount` `{device}` mutation
  - `storage.format` `{device, filesystem}` mutation
  - `disks()` items gain `id: string`, `mounted: boolean`, `mounts: string[]`
  - `formatConfirmToken(d)` → string
  - `canFormat(d)` / `canUnmount(d)` → boolean

- [ ] **Step 1: Write the failing helper tests**

Add to `test/storage.test.mjs` inside `describe('helper')`. Do not implement the verbs yet.

```js
test('umount and format: refuse system, pool, mounted, and junk paths; format wipes then mkfs', async () => {
	const log = []
	const lsblkMounted = {
		blockdevices: [
			...lsblk.blockdevices,
			{
				name: 'sde',
				path: '/dev/sde',
				type: 'disk',
				size: 32e9,
				rota: false,
				tran: 'usb',
				serial: 'USB1',
				model: 'SanDisk',
				children: [{name: 'sde1', path: '/dev/sde1', type: 'part', fstype: 'exfat', mountpoints: ['/run/media/chris/stick']}],
			},
		],
	}
	const run = async (cmd, args) => {
		log.push([cmd, ...args])
		if (cmd === 'lsblk') return JSON.stringify(lsblkMounted)
		if (cmd === 'wipefs') return JSON.stringify({signatures: []})
		return ''
	}
	const fs = fakeFs({
		'/etc/fstab': 'UUID=22222222-2222-2222-2222-222222222222 /home/chris/Pools/media btrfs d 0 0 # omarchy-server pool media\n',
		'/dev/disk/by-id/usb-SanDisk_USB1': '/dev/sde',
	})
	fs.realpath = async (p) => {
		if (p === '/dev/disk/by-id/usb-SanDisk_USB1') return '/dev/sde'
		if (p.includes('..')) throw new Error('ENOENT')
		return p
	}
	const h = createHelper({user, run, fs})
	await assert.rejects(h.handle('umount', ['/dev/nvme0n1']), /holds the system/)
	await assert.rejects(h.handle('format', ['/dev/nvme0n1', 'blank']), /holds the system/)
	await assert.rejects(h.handle('format', ['/dev/sdd', 'blank']), /pool|in a pool/)
	await assert.rejects(h.handle('format', ['/dev/sde', 'ext4']), /in use|Unmount/)
	await assert.rejects(h.handle('format', ['/etc/passwd', 'blank']), /Not a drive/)
	await assert.rejects(h.handle('format', ['/dev/disk/by-id/../passwd', 'blank']), /Not a drive/)
	await assert.rejects(h.handle('format', ['/dev/sda', 'ntfs']), /blank, ext4 or exfat/)
	assert.ok(!log.some((l) => l[0] === 'wipefs' && l[1] === '-a'), 'refused format never wipes')
	assert.ok(!log.some((l) => l[0] === 'umount'))

	const h2 = createHelper({user, run: fakeRun(log), fs: fakeFs()})
	assert.equal(await h2.handle('format', ['/dev/sdc', 'blank']), 'ok')
	assert.ok(log.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdc'))
	assert.ok(!log.some((l) => l[0] === 'mkfs.ext4' || l[0] === 'mkfs.exfat'))
	log.length = 0
	assert.equal(await h2.handle('format', ['/dev/sdc', 'ext4']), 'ok')
	assert.ok(log.some((l) => l[0] === 'mkfs.ext4' && l.includes('-F') && l.includes('/dev/sdc')))
	log.length = 0
	assert.equal(await h2.handle('format', ['/dev/sdc', 'exfat']), 'ok')
	assert.ok(log.some((l) => l[0] === 'mkfs.exfat' && l.includes('/dev/sdc')))
	log.length = 0
	assert.equal(await h2.handle('umount', ['/dev/sde']), 'ok')
	assert.ok(log.some((l) => l[0] === 'umount' && l[1] === '/run/media/chris/stick'))
})
```

The umount success case needs the mounted lsblk. Split if `fakeRun`’s stock `lsblk` has no sde: use `lsblkMounted` for the umount-ok helper too.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test --test-concurrency=1 test/storage.test.mjs`

Expected: FAIL — `Unknown action: umount` / `Unknown action: format`.

- [ ] **Step 3: Implement helper verbs**

In `helper/helper.mjs`:

1. Change the file header line that says drives are never erased. New text: `format DEV FS wipes a non-system, non-pool, unmounted whole disk (FS is blank, ext4 or exfat). umount DEV unmounts every mountpoint on that disk.`

2. Next to `DEV`, add:

```js
const BY_ID = /^\/dev\/disk\/by-id\/[A-Za-z0-9._:+-]+$/
```

3. Inside `createHelper`, after `disk()`:

```js
async function resolveDisk(path) {
	let p = String(path ?? '')
	if (BY_ID.test(p) && !/-part\d+$/.test(p)) p = await fs.realpath(p).catch(() => fail(`No drive at ${path}`))
	return disk(p)
}
async function poolMember(d) {
	if (mounts(d).some((m) => /\/Pools\//.test(m))) return true
	const text = await fstab()
	const uuids = new Set(flat(d).map((x) => x.uuid).filter(Boolean))
	return text.some((l) => l.includes(FSTAB_MARK) && [...uuids].some((u) => l.includes(u)))
}
```

`/dev/sdd` in the existing `lsblk` fixture is a pool member (btrfs uuid `2222…` / `# omarchy-server pool media`).

4. Add verbs (same `verbs` object as `sleep`):

```js
umount: async ([path]) => {
	const d = await resolveDisk(path)
	if (mounts(d).some((m) => SYSTEM_MOUNTS.has(m))) fail(`${d.path} holds the system`)
	if (await poolMember(d)) fail(`${d.path} is in a pool`)
	for (const m of mounts(d)) await run('umount', [m])
	return 'ok'
},
format: async ([path, fsKind]) => {
	if (!['blank', 'ext4', 'exfat'].includes(fsKind)) fail('Choose blank, ext4 or exfat')
	const d = await resolveDisk(path)
	if (mounts(d).some((m) => SYSTEM_MOUNTS.has(m))) fail(`${d.path} holds the system`)
	if (await poolMember(d)) fail(`${d.path} is in a pool`)
	if (mounts(d).length) fail(`${d.path} is in use. Unmount it first.`)
	await run('wipefs', ['-a', d.path])
	if (fsKind === 'ext4') await run('mkfs.ext4', ['-F', d.path])
	if (fsKind === 'exfat') await run('mkfs.exfat', [d.path])
	return 'ok'
},
```

5. Change `blankDisk`’s “isn’t blank” messages from `first erase it yourself in a terminal: sudo wipefs -a` to `Format this drive first (choose blank).`

- [ ] **Step 4: Run helper tests**

Run: `node --test --test-concurrency=1 test/storage.test.mjs`

Expected: the new test PASS. Existing pool-create still PASS (it may still mention wipefs in an assertion — update that assertion to the new blankDisk copy).

- [ ] **Step 5: Write failing omarchyd storage tests**

In `describe('omarchyd storage')` add:

```js
test('storage.format and storage.unmount go through the helper; disks report mounts', async () => {
	const calls = []
	const run = async (cmd, args) => {
		if (cmd === 'lsblk') return JSON.stringify(lsblk)
		if (cmd === 'sudo') {
			calls.push(args.slice(2))
			const verb = args[2]
			if (verb === 'ping') return 'ok\n'
			if (verb === 'smart') return JSON.stringify({smart_status: {passed: true}, temperature: {current: 34}})
			if (verb === 'format' || verb === 'umount') return 'ok\n'
			return 'ok\n'
		}
		return ''
	}
	const s = createStorage({dataDir: data, home: '/home/chris', files, run, fstabPath: fstab, smbConf})
	const disks = await s.procedures['storage.disks'].run()
	const sdc = disks.find((d) => d.name === 'sdc')
	assert.equal(sdc.role, 'data')
	assert.equal(sdc.mounted, false)
	assert.deepEqual(sdc.mounts, [])
	assert.ok(sdc.id)
	const sys = disks.find((d) => d.name === 'nvme0n1')
	assert.equal(sys.mounted, true)
	assert.ok(sys.mounts.includes('/'))
	await s.procedures['storage.format'].run({device: '/dev/sdc', filesystem: 'ext4'})
	assert.deepEqual(calls.filter((a) => a[0] === 'format').at(-1), ['format', '/dev/sdc', 'ext4'])
	await s.procedures['storage.unmount'].run({device: '/dev/sdc'})
	assert.deepEqual(calls.filter((a) => a[0] === 'umount').at(-1), ['umount', '/dev/sdc'])
	await assert.rejects(s.procedures['storage.format'].run({device: '/dev/sdc', filesystem: 'ntfs'}), /blank, ext4 or exfat/)
})
```

Reuse the existing `files` / `data` / `fstab` from the sibling test, or make this test self-contained with its own `mkdtemp`.

- [ ] **Step 6: Run and confirm the RPC test fails**

Run: `node --test --test-concurrency=1 test/storage.test.mjs`

Expected: FAIL — `storage.format` is undefined.

- [ ] **Step 7: Implement storage RPCs and disk fields**

In `omarchyd/storage.mjs` `disks()` map, add:

```js
const mountList = mounts.filter(Boolean)
const id = d.path
return {
	path: d.path,
	id,
	// existing fields...
	mounted: mountList.length > 0,
	mounts: mountList,
}
```

Add procedures next to `storage.setSleep`:

```js
'storage.unmount': {
	kind: 'mutation',
	run: async (input) => (await helper('umount', [String(input?.device ?? '')]), true),
},
'storage.format': {
	kind: 'mutation',
	run: async (input) => {
		const filesystem = String(input?.filesystem ?? '')
		if (!['blank', 'ext4', 'exfat'].includes(filesystem)) throw new RpcError('BAD_REQUEST', 'Choose blank, ext4 or exfat')
		await helper('format', [String(input?.device ?? ''), filesystem])
		return true
	},
},
```

In `omarchyd/server.mjs`, extend the storage wrap so format/unmount are owner-only (growSystem already is). In the `Object.entries(storage.procedures).map` block, treat `storage.format` and `storage.unmount` like shares:

```js
;['files.shares', 'files.sharePassword', 'files.shareOptions', 'files.addShare', 'files.updateShare', 'files.removeShare', 'files.setSharePassword', 'storage.format', 'storage.unmount'].includes(name)
	? [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, name.startsWith('storage.') ? 'change storage' : 'manage network shares'), p.run(input))}]
	: [name, p]
```

In `server/app.mjs` ALLOWED, under storage:

```js
'storage.unmount': 'mutation',
'storage.format': 'mutation',
```

Add `'storage.unmount'` and `'storage.format'` to `SLOW`.

In `install.sh`: `INSTALLER_REVISION=2`.

- [ ] **Step 8: Run storage tests**

Run: `node --test --test-concurrency=1 test/storage.test.mjs test/allowed.test.mjs`

Expected: PASS except the known host `noPassword` case if this machine’s helper has `guest ok = yes`.

- [ ] **Step 9: Write failing UI helper tests**

Create `web/src/storageTools.ts` only after the test exists. Create `test/storage-tools.test.mjs`:

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {canFormat, canUnmount, formatConfirmToken} from '../web/src/storageTools.ts'

const disk = (over) => ({path: '/dev/sdb', name: 'sdb', model: 'SanDisk Ultra', serial: 'AA11BB22', role: 'data', mounted: false, pool: null, ...over})

test('formatConfirmToken prefers model, then last 4 of serial, then kernel name', () => {
	assert.equal(formatConfirmToken(disk({})), 'SanDisk Ultra')
	assert.equal(formatConfirmToken(disk({model: '  '})), 'BB22')
	assert.equal(formatConfirmToken(disk({model: null, serial: null})), 'sdb')
})

test('canFormat only for unmounted non-system non-pool disks', () => {
	assert.equal(canFormat(disk({})), true)
	assert.equal(canFormat(disk({role: 'blank'})), true)
	assert.equal(canFormat(disk({role: 'system'})), false)
	assert.equal(canFormat(disk({role: 'pool', pool: 'media'})), false)
	assert.equal(canFormat(disk({mounted: true})), false)
})

test('canUnmount only for mounted non-system non-pool disks', () => {
	assert.equal(canUnmount(disk({mounted: true})), true)
	assert.equal(canUnmount(disk({mounted: false})), false)
	assert.equal(canUnmount(disk({mounted: true, role: 'system'})), false)
	assert.equal(canUnmount(disk({mounted: true, role: 'pool'})), false)
})
```

- [ ] **Step 10: Run UI helper tests (red)**

Run: `node --test --test-concurrency=1 test/storage-tools.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 11: Implement storageTools and DriveSheet**

`web/src/storageTools.ts`:

```ts
export type FormatKind = 'blank' | 'ext4' | 'exfat'

export function formatConfirmToken(d: {model?: string | null; serial?: string | null; name: string}) {
	const model = String(d.model ?? '').trim()
	if (model) return model
	const serial = String(d.serial ?? '').trim()
	if (serial.length >= 4) return serial.slice(-4)
	return d.name
}

export function canFormat(d: {role: string; mounted: boolean}) {
	return (d.role === 'data' || d.role === 'blank') && !d.mounted
}

export function canUnmount(d: {role: string; mounted: boolean}) {
	return (d.role === 'data' || d.role === 'blank') && d.mounted
}

export function formatPhraseMatches(d: {model?: string | null; serial?: string | null; name: string}, typed: string) {
	return typed.trim().toLowerCase() === formatConfirmToken(d).toLowerCase()
}
```

Extend `Drive` in `Storage.tsx` with `id: string`, `mounted: boolean`, `mounts: string[]` (default `mounted`/`mounts` from the RPC).

Replace the wipefs card in `DriveSheet` with:

- If `canUnmount(d)`: button **Unmount** calling `mutate('storage.unmount', {device: d.id || d.path})`, then `onChanged()`.
- If `d.mounted && d.role !== 'system' && d.role !== 'pool'`: muted “Unmount this drive before formatting.”
- If `canFormat(d)`: button **Format** opening a small `FormatDialog`.
- If `d.role === 'system'`: muted “This is the system disk.”
- If `d.role === 'pool'`: muted `In pool “${d.pool}”.`

`FormatDialog`: filesystem `Segmented` with blank / ext4 / exFAT, text field, primary disabled until `formatPhraseMatches`. On confirm: `mutate('storage.format', {device: d.id || d.path, filesystem})`. While the mutation is pending, disable both buttons.

Add a test for `formatPhraseMatches` in `test/storage-tools.test.mjs`.

- [ ] **Step 12: Typecheck and commit**

Run: `npx tsc --noEmit -p web && node --test --test-concurrency=1 test/storage.test.mjs test/storage-tools.test.mjs test/allowed.test.mjs`

```bash
git add helper/helper.mjs install.sh omarchyd/storage.mjs omarchyd/server.mjs server/app.mjs web/src/storageTools.ts web/src/screens/Storage.tsx test/storage.test.mjs test/storage-tools.test.mjs
git commit -m "Let the owner format and unmount extra disks on this server."
```

---

### Task 2: Connector `storage` ability and Python helper

**Files:**
- Create: `connector/helper.py`
- Create: `connector/test_helper.py`
- Modify: `connector/agent.py` (`ABILITIES`, enroll, `call`, storage actions)
- Modify: `connector/install.sh`
- Modify: `omarchyd/connector.mjs` (`ABILITIES` includes `storage`)
- Modify: `web/src/swarm/Swarm.tsx` (`Abilities`, ABOUT, AddComputer default)
- Modify: `test/connector.test.mjs`

**Interfaces:**
- Consumes: Task 1 helper rules (same refuse list)
- Produces:
  - Ability key `'storage'`
  - `connector/helper.py` verbs: `ping`, `smart`, `umount`, `format` (pools/sleep in Task 5)
  - Agent `call` names this task: `storage-status` (disks/unmount/format in later tasks)
  - Install: `/usr/local/libexec/omarchy-connector/helper.py`, sudoers, drop `NoNewPrivileges=yes` only when `storage` is in `--allow`

- [ ] **Step 1: Write failing Python helper tests**

Create `connector/test_helper.py` (do not create `helper.py` yet beyond what import needs — the test imports `helper`).

```python
import json
import unittest

# Filled in Step 3: from helper import handle

LSBLK = {
    "blockdevices": [
        {"name": "nvme0n1", "path": "/dev/nvme0n1", "type": "disk", "size": 512000000000, "children": [
            {"name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "fstype": "btrfs", "uuid": "11111111-1111-1111-1111-111111111111", "mountpoints": ["/", "/home"]}
        ]},
        {"name": "sdc", "path": "/dev/sdc", "type": "disk", "size": 2000000000000, "children": [
            {"name": "sdc1", "path": "/dev/sdc1", "type": "part", "fstype": "ntfs", "mountpoints": [None]}
        ]},
    ]
}

class Fake:
    def __init__(self):
        self.log = []
    def run(self, cmd, args):
        self.log.append([cmd, *args])
        if cmd == "lsblk":
            return json.dumps(LSBLK)
        return ""

class Helper(unittest.TestCase):
    def setUp(self):
        from helper import handle
        self.handle = handle
        self.fake = Fake()
        self.kw = dict(run=self.fake.run, user={"name": "chris", "uid": 1000, "home": "/home/chris"})

    def test_ping(self):
        self.assertEqual(self.handle("ping", [], **self.kw), "ok")

    def test_refuse_system_and_junk(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("format", ["/dev/nvme0n1", "blank"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("format", ["../../etc/passwd", "blank"], **self.kw)
        self.assertFalse(any(x[0] == "wipefs" for x in self.fake.log))

    def test_format_blank_then_ext4(self):
        self.assertEqual(self.handle("format", ["/dev/sdc", "blank"], **self.kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdc"], self.fake.log)
        self.fake.log.clear()
        self.handle("format", ["/dev/sdc", "ext4"], **self.kw)
        self.assertTrue(any(x[0] == "mkfs.ext4" for x in self.fake.log))

if __name__ == "__main__":
    unittest.main()
```

Add a node wrapper in `test/swarm-storage.test.mjs` for now:

```js
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

test('connector helper.py unit tests', () => {
	execFileSync('python3', [fileURLToPath(new URL('../connector/test_helper.py', import.meta.url))], {stdio: 'inherit'})
})
```

- [ ] **Step 2: Run Python tests (red)**

Run: `node --test --test-concurrency=1 test/swarm-storage.test.mjs`

Expected: FAIL — `No module named helper` / file missing.

- [ ] **Step 3: Implement `connector/helper.py`**

Keep it small: stdlib only. Mirror Task 1 rules. `DEV` regex same as JS. `handle(verb, args, run=default_run, user=from_sudo)`. `default_run` uses `subprocess.run`. When executed as a program (`if __name__ == '__main__'`), require root + `SUDO_USER` like the Node helper.

Verbs: `ping` → `ok`; `smart DEV` → `smartctl -j -a`; `umount`; `format`.

Put the file next to tests so `from helper import handle` works when cwd is `connector/` OR make `test_helper.py` add the directory:

```python
sys.path.insert(0, os.path.dirname(__file__))
from helper import handle
```

- [ ] **Step 4: Run Python tests (green)**

Run: `node --test --test-concurrency=1 test/swarm-storage.test.mjs`

Expected: PASS.

- [ ] **Step 5: Ability `storage` on server, agent, and pairing UI**

`omarchyd/connector.mjs`: `const ABILITIES = ['terminal', 'desktop', 'manage', 'storage']`

`connector/agent.py`:
- Docstring manage line plus `storage  extra disks: list, unmount, format (helper)`
- enroll: `for k in ("terminal", "desktop", "manage", "storage")`
- `call`: if name starts with `storage-` or is in a `STORAGE_ACTIONS` dict, require `self.allowed.get("storage")` (not `manage`). Implement:

```python
HELPER = "/usr/local/libexec/omarchy-connector/helper.py"

def helper(verb, *args):
    r = subprocess.run(["sudo", "-n", HELPER, verb, *args], capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout or "Storage helper failed").strip().split("\n")[-1][:300])
    return r.stdout.strip()

def storage_status(_args):
    try:
        ok = helper("ping") == "ok"
    except Exception:
        ok = False
    zfs = False
    if ok:
        try:
            zfs = helper("zfs-available") == "yes"
        except Exception:
            zfs = False
    return {"helperAvailable": ok, "zfsAvailable": zfs}

```

For this task, only add `storage-status` that pings the helper. `STORAGE_ACTIONS = {"storage-status": storage_status}`. Do not add `storage-disks` yet. Unknown storage names still “Unknown action”.

`web/src/swarm/Swarm.tsx`:
- `type Abilities = {terminal: boolean; desktop: boolean; manage: boolean; storage: boolean}`
- ABOUT: `storage: {label: 'Storage', icon: 'disk', what: 'See its drives, format extra disks, and manage pools on that computer'}`
- AddComputer default `storage: false` (opt-in; Format is destructive). Owner can tick it.

- [ ] **Step 6: install.sh**

When `has storage`:

- Packages: `smartmontools`, `e2fsprogs`, and exFAT (`exfatprogs` on apt/dnf/zypper, `exfatprogs` on pacman). Warn if a package is missing; do not fail the whole install.
- Install helper: `curl` `${SOURCE%/}/main/connector/helper.py` to a temp file, `python3 -m py_compile`, then `sudo install -D -m 755` to `/usr/local/libexec/omarchy-connector/helper.py`.
- Sudoers: `sudo tee /etc/sudoers.d/omarchy-connector` with `"$USER ALL=(root) NOPASSWD: /usr/local/libexec/omarchy-connector/helper.py"` and `chmod 440`.
- Unit `[Service]`: omit `NoNewPrivileges=yes` when `has storage`; keep it otherwise.
- Uninstall: `sudo rm -f /usr/local/libexec/omarchy-connector/helper.py /etc/sudoers.d/omarchy-connector`

`--allow` regex already `^[a-z,]*$`, so `storage` is fine.

- [ ] **Step 7: Connector pairing test**

In `test/connector.test.mjs`, after an existing pair+enroll, assert abilities can include storage:

```js
test('pairing can allow storage', async () => {
	const p = await pair({terminal: false, desktop: false, manage: false, storage: true})
	assert.equal(p.abilities.storage, true)
})
```

If `pair()` / enroll currently drops unknown keys, the ABILITIES change makes this pass.

- [ ] **Step 8: Run tests and commit**

Run: `node --test --test-concurrency=1 test/swarm-storage.test.mjs test/connector.test.mjs`

```bash
git add connector/helper.py connector/test_helper.py connector/agent.py connector/install.sh omarchyd/connector.mjs web/src/swarm/Swarm.tsx test/swarm-storage.test.mjs test/connector.test.mjs
git commit -m "Add a Storage ability and helper on swarm computers."
```

---

### Task 3: `swarm.storage.status` / `disks` and the Storage row

**Files:**
- Modify: `connector/helper.py` (verb `disks` — lsblk JSON plus optional smart)
- Modify: `connector/agent.py` (`storage-disks`)
- Modify: `omarchyd/connector.mjs` (procedures `swarm.storage.status`, `swarm.storage.disks`)
- Modify: `omarchyd/server.mjs` (register those names in the swarm ownerOnly list)
- Modify: `server/app.mjs` ALLOWED
- Modify: `web/src/screens/Storage.tsx` (`target` prop)
- Modify: `web/src/screens/Settings.tsx`
- Modify: `web/src/swarm/Swarm.tsx` (Storage row)
- Modify: `test/swarm-storage.test.mjs`

**Interfaces:**
- Consumes: Task 2 helper ping / ability; Task 1 Drive shape
- Produces:
  - `helper('disks')` → JSON array matching host `storage.disks` items (`path`, `id`, `name`, `model`, `serial`, `size`, `kind`, `transport`, `removable`, `role`, `pool`, `mounted`, `mounts`, `btrfs`, `zfs`, `sleepMinutes`, `health`)
  - `swarm.storage.status` `{id}` → `{helperAvailable, zfsAvailable, storageAllowed}`
  - `swarm.storage.disks` `{id}` → `Drive[]`
  - `StoragePage({onBack, target}: {onBack, target: 'host' | {agentId: string; name: string}})`

- [ ] **Step 1: Write failing RPC tests**

In `test/swarm-storage.test.mjs`, add tests that use `createConnector` if exported, or a fake `call` injected later. Prefer testing `connector.mjs` procedures with a stub live agent:

If `createConnector` is not easy to stub, test the helper `disks` JSON in Python (extend `test_helper.py`) and test omarchyd mapping with a mock `call` by exporting a small `storageRpc({call, find, may, live})` from `connector.mjs`. Prefer not to restructure: add procedures next to `swarm.action` that use existing `call(id, name, args)`.

Write a test file that starts omarchyd like `test/connector.test.mjs` only if cheaper stubs fail. Minimum:

```js
test('swarm.storage.status: ability off is FORBIDDEN, offline is PRECONDITION_FAILED', async () => {
	// Use the same startOmarchyd + pair pattern as test/connector.test.mjs, or call procedures on a harness.
})
```

Copy the harness bootstrap from `test/connector.test.mjs` (tls, accounts, fetch `call`). Pair without storage, enroll, then:

```js
await assert.rejects(q('swarm.storage.disks', {id: agentId}), /Pair .* Storage/)
```

Pair with storage but no helper installed:

```js
await assert.rejects(q('swarm.storage.disks', {id: agentId}), /connector install/)
```

That needs the agent to implement `storage-disks`. Implement agent + helper `disks` in the same task after the test exists.

- [ ] **Step 2: Run (red)**

Run: `node --test --test-concurrency=1 test/swarm-storage.test.mjs`

Expected: FAIL — `swarm.storage.status` unknown / allowed as nothing.

- [ ] **Step 3: helper `disks` + agent + RPCs**

`helper.py` verb `disks`: run `lsblk -J -b -o NAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,LABEL,UUID,MOUNTPOINTS,RM,HOTPLUG`, skip zram/loop/sr/ram, classify role like `omarchyd/storage.mjs` (`SYSTEM_MOUNTS`, blank, pool via `/proc/mounts` paths containing `/Pools/` or fstype zfs_member). `id`: first `/dev/disk/by-id/` symlink whose realpath is `path` and does not end in `-partN`, else `path`. `health`: `smartctl -j -a` or null.

Agent:

```python
def storage_disks(_args):
    return json.loads(helper("disks"))
```

`connector.mjs`:

```js
async function requireAgent(input, needStorage) {
	await loaded
	const a = find(String(input?.id ?? ''))
	if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
	if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', 'That computer is offline right now')
	if (needStorage && !may(a, 'storage')) throw new RpcError('FORBIDDEN', `Pair ${a.name} again with Storage switched on`)
	return a
}
```

```js
'swarm.storage.status': {
	kind: 'query',
	run: async (input) => {
		const a = await requireAgent(input, false)
		const storageAllowed = may(a, 'storage')
		if (!storageAllowed) return {helperAvailable: false, zfsAvailable: false, storageAllowed: false}
		try {
			const s = await call(a.id, 'storage-status', {})
			return {helperAvailable: !!s?.helperAvailable, zfsAvailable: !!s?.zfsAvailable, storageAllowed: true}
		} catch (e) {
			if (/allow Storage|doesn’t allow/i.test(e.message)) return {helperAvailable: false, zfsAvailable: false, storageAllowed: false}
			throw new RpcError('PRECONDITION_FAILED', `Run the connector install again on ${a.name}.`)
		}
	},
},
'swarm.storage.disks': {
	kind: 'query',
	run: async (input) => {
		const a = await requireAgent(input, true)
		try {
			return await call(a.id, 'storage-disks', {})
		} catch (e) {
			throw new RpcError('PRECONDITION_FAILED', /offline/i.test(e.message) ? e.message : `Run the connector install again on ${a.name}.`)
		}
	},
},
```

Register `swarm.storage.status` and `swarm.storage.disks` in `omarchyd/server.mjs` swarm name list (queries). ALLOWED: both `'query'`. Add disks to `SLOW`.

- [ ] **Step 4: Parameterize StoragePage**

`StoragePage({onBack, target = 'host'})`.

```ts
const rpc = (name: string) => (target === 'host' ? `storage.${name}` : `swarm.storage.${name}`)
const input = (extra: object = {}) => (target === 'host' ? extra : {id: target.agentId, ...extra})
```

Queries: `query(rpc('disks'), input())` etc. Mutations: `mutate(rpc('format'), input({device, filesystem}))`.

Settings: `<StoragePage onBack={...} target="host" />`.

Agent sheet: Storage row (icon `disk`) after gauges.

- Online + `may(a, 'storage')`: opens StoragePage with `{agentId: a.id, name: a.name}`.
- Online + storage off: sub “Pair this computer again with Storage switched on.”
- Offline: row disabled.
- Helper missing: StoragePage already shows the installer empty state; change copy when `target !== 'host'` to “Run the connector install again on this computer (Machines → Local swarm → Add a computer).”

Subtitle / header: when swarm, `Storage · {name}`.

Gauges on the agent sheet stay `metrics.disks` (mounts). Do not replace them with `swarm.storage.disks`.

- [ ] **Step 5: Tests, typecheck, commit**

Run: `npx tsc --noEmit -p web && node --test --test-concurrency=1 test/swarm-storage.test.mjs test/allowed.test.mjs`

```bash
git add connector/helper.py connector/agent.py omarchyd/connector.mjs omarchyd/server.mjs server/app.mjs web/src/screens/Storage.tsx web/src/screens/Settings.tsx web/src/swarm/Swarm.tsx test/swarm-storage.test.mjs
git commit -m "Show a swarm computer’s disks on the Storage screen."
```

---

### Task 4: Swarm Unmount / Format

**Files:**
- Modify: `connector/agent.py` (`storage-unmount`, `storage-format`)
- Modify: `omarchyd/connector.mjs` (mutations)
- Modify: `omarchyd/server.mjs` (register mutations)
- Modify: `server/app.mjs` ALLOWED + SLOW
- Modify: `web/src/screens/Storage.tsx` (already uses `rpc('format')` if Task 3 did it)
- Modify: `test/swarm-storage.test.mjs`

**Interfaces:**
- Consumes: Task 1 FormatDialog; Task 2 helper umount/format; Task 3 `requireAgent`
- Produces:
  - `swarm.storage.unmount` `{id, device}`
  - `swarm.storage.format` `{id, device, filesystem}`

- [ ] **Step 1: Write failing tests**

```js
test('swarm.storage.format requires storage ability and a helper', async () => {
	// agent without storage
	await assert.rejects(call('swarm.storage.format', {id, device: '/dev/sdc', filesystem: 'blank'}), /Storage/)
})
```

Add a Python test that `handle('format', ['/dev/sdc', 'ntfs'])` raises.

- [ ] **Step 2: Run (red)**

Run: `node --test --test-concurrency=1 test/swarm-storage.test.mjs`

Expected: FAIL — unknown mutation.

- [ ] **Step 3: Implement mutations**

Agent:

```python
def storage_unmount(args):
    helper("umount", args["device"])
    return True

def storage_format(args):
    fs = args.get("filesystem")
    if fs not in ("blank", "ext4", "exfat"):
        raise RuntimeError("Choose blank, ext4 or exfat")
    helper("format", args["device"], fs)
    return True
```

`connector.mjs`:

```js
'swarm.storage.unmount': {
	kind: 'mutation',
	run: async (input) => {
		const a = await requireAgent(input, true)
		try {
			await call(a.id, 'storage-unmount', {device: String(input?.device ?? '')})
			return true
		} catch (e) {
			throw new RpcError('PRECONDITION_FAILED', e.message)
		}
	},
},
'swarm.storage.format': {
	kind: 'mutation',
	run: async (input) => {
		const a = await requireAgent(input, true)
		const filesystem = String(input?.filesystem ?? '')
		if (!['blank', 'ext4', 'exfat'].includes(filesystem)) throw new RpcError('BAD_REQUEST', 'Choose blank, ext4 or exfat')
		try {
			await call(a.id, 'storage-format', {device: String(input?.device ?? ''), filesystem})
			return true
		} catch (e) {
			throw new RpcError('PRECONDITION_FAILED', e.message)
		}
	},
},
```

ALLOWED mutations; add to SLOW. Storage.tsx Format/Unmount already call `rpc(...)` + `input({device, filesystem})` from Task 3 — verify; if Task 3 left host-only mutate strings, switch them now.

exFAT missing: helper `format` for exfat fails with the mkfs.exfat error; toast it. Optional: `storage.status` can include `exfat: boolean` later. v1: fail clearly.

- [ ] **Step 4: Tests, typecheck, commit**

Run: `npx tsc --noEmit -p web && node --test --test-concurrency=1 test/swarm-storage.test.mjs test/allowed.test.mjs`

```bash
git add connector/agent.py omarchyd/connector.mjs omarchyd/server.mjs server/app.mjs web/src/screens/Storage.tsx test/swarm-storage.test.mjs
git commit -m "Let the owner format extra disks on a swarm computer."
```

---

### Task 5: Swarm pools and HDD sleep

**Files:**
- Modify: `connector/helper.py` (sleep, pool-*, zfs-available/pools/importable/create/import/scrub/export)
- Modify: `connector/test_helper.py`
- Modify: `connector/agent.py` (storage-pools, storage-importable, storage-setSleep, storage-createPool, storage-addToPool, storage-importPool, storage-forgetPool, storage-scrub)
- Modify: `omarchyd/connector.mjs` + `omarchyd/server.mjs` + `server/app.mjs`
- Modify: `web/src/screens/Storage.tsx` (already parameterized)
- Modify: `test/swarm-storage.test.mjs`

**Interfaces:**
- Consumes: host pool semantics in `helper/helper.mjs` (`pool-create` blank only, `~/Pools/NAME`, FSTAB_MARK `# omarchy-server pool`)
- Produces: the same Storage pool UI on swarm via `swarm.storage.pools` / `importable` / `createPool` / `addToPool` / `importPool` / `forgetPool` / `scrub` / `setSleep`

Port safety, not the Node file. Marks may say `# omarchy-connector pool` so a box that later becomes an Omarchy Server does not collide — **use `# omarchy-connector pool` and `# omarchy-connector zfs` on swarm**. Mount at `{home}/Pools/{name}`.

- [ ] **Step 1: Write failing Python pool tests**

Mirror `test/storage.test.mjs` `pool-create: blank drives only…` in `connector/test_helper.py`: refuse system, refuse `/dev/sdc` (has ntfs), accept two blank disks, write fstab mark, call `mkfs.btrfs`. Fake `run` like the Node test.

- [ ] **Step 2: Run (red)**

Run: `python3 connector/test_helper.py`

Expected: FAIL — unknown verb `pool-create`.

- [ ] **Step 3: Implement pool/sleep verbs in helper.py**

Copy the checks from `helper/helper.mjs`: `blankDisk`, `NAME`, `UUID`, `pool-create` / `pool-add` / `pool-import` / `pool-forget` / `pool-scrub` / `pool-status`, `sleep` (hdparm + `/etc/udev/rules.d/69-omarchy-connector-sleep.rules`), `zfs-available` (`command -v zpool`), and the zfs verbs if zfs tools exist. `zfs-available` returns `yes` or `no`.

Sleep: same minutes map `{0,10,20,30,60,120,240}`. Refuse system disk.

- [ ] **Step 4: Agent + RPCs**

Map 1:1 to helper verbs. `createPool` input `{id, name, fs, profile, devices}` like host `storage.createPool`. `setSleep` `{id, device, minutes}`.

FORBIDDEN without storage ability. PRECONDITION_FAILED if helper ping fails.

- [ ] **Step 5: Storage.tsx**

Host NewPool / AddDrive / sleep Segmented already call `rpc('createPool')` etc. if Task 3 parameterized every `storage.*` mutate. Grep `mutate('storage.` and `query('storage.` in Storage.tsx and switch any leftovers.

Do not add Files / SMB / grow-system on swarm.

- [ ] **Step 6: Tests, full suite, commit**

Run: `npx tsc --noEmit -p web && node --test --test-concurrency=1 test/swarm-storage.test.mjs test/storage.test.mjs test/connector.test.mjs test/allowed.test.mjs`

Then `npm test` and record the host `noPassword` fail for the PR body.

```bash
git add connector/helper.py connector/test_helper.py connector/agent.py omarchyd/connector.mjs omarchyd/server.mjs server/app.mjs web/src/screens/Storage.tsx test/swarm-storage.test.mjs
git commit -m "Manage pools and drive sleep on swarm computers."
```

---

## Self-review (spec coverage)

| Spec | Task |
|---|---|
| Host Format / Unmount, drop wipefs card, INSTALLER_REVISION | 1 |
| Drive `id` / `mounted` / `mounts`, type-to-confirm, canFormat | 1 |
| Connector helper, sudoers, NoNewPrivileges, ability `storage` | 2 |
| Pairing checkbox | 2 |
| `swarm.storage.status` / `disks`, Storage row, gauges unchanged | 3 |
| Swarm Format / Unmount, owner-only, refuse system/pool/mounted | 4 |
| Swarm pools + HDD sleep, Files/SMB stay host-only | 5 |
| No assistant tools, no VM disks, no fsck-as-drive-tool | constraints |
| Fake tests, mention storage noPassword | constraints / Task 5 |
