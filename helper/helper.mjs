#!/usr/bin/node
// omarchy-server helper: the only part of Omarchy Server that runs as root.
//
// Installed root-owned at /usr/local/libexec/omarchy-server/helper.mjs. A sudoers rule lets the
// owner run it (and nothing else) without a password, so omarchyd can manage storage, network
// shares and the firewall while it runs as the owner. Every argument is treated as hostile and checked
// here, and each verb does one fixed thing:
//
//   ping                              is the helper installed and allowed?
//   smart DEV                         drive health (smartctl JSON)
//   sleep DEV MINUTES                 spin-down time for a hard drive (0 = never), kept across boots
//   usb-allow SERIAL                  udev uaccess so the owner’s session can open that USB serial
//   usb-forget SERIAL                 drop that serial from the USB udev rule
//   umount DEV                        unmount every mountpoint on a non-system, non-pool whole disk
//   mount DEV                         mount each filesystem on a non-system, non-pool extra disk at /run/media/$USER
//   format DEV FS                     wipe a non-system, non-pool, unmounted whole disk (FS is blank, ext4 or exfat)
//   pool-create NAME PROFILE DEV...   new Btrfs pool on BLANK drives only, mounted at ~/Pools/NAME
//   pool-add NAME DEV                 add a BLANK drive to a pool, then rebalance in the background
//   pool-import NAME UUID             mount an existing Btrfs filesystem at ~/Pools/NAME (no changes to it)
//   pool-forget NAME                  unmount a pool and stop mounting it at boot (data untouched)
//   pool-scrub NAME                   start an error check
//   pool-status NAME                  profile, per-drive error counters, last error check
//   zfs-available                     is ZFS installed and loaded?
//   zfs-pools                         imported ZFS pools: layout, health, space, last check
//   zfs-importable                    ZFS pools on connected drives that aren't imported yet
//   zfs-create NAME LAYOUT DEV...     new ZFS pool on BLANK drives, mounted at ~/Pools/NAME
//   zfs-import NAME [force]           import an existing pool (setuid and devices off), shown at ~/Pools/NAME
//   zfs-scrub NAME                    start an error check
//   zfs-export NAME                   stop using a pool (data untouched; can be imported again)
//   shares-apply                      network shares from stdin JSON, folders inside the owner's home only
//   smb-password                      set the owner's network-share password from stdin
//   firewall-open PORT | firewall-close PORT   an app’s port (TCP and UDP); not 22, 2021 or 5900
//   low-ports N                       let your containers use ports from N up (only ever lowered)
//   harden-pools                      add nosuid,nodev to pools set up by earlier versions
//   grow-system                       after the system drive was made bigger: grow its last partition,
//                                     encryption (disk password on stdin) and filesystem into the space
//   tailscale-setup                   install Tailscale as Omarchy's menu does (official package, the
//                                     tailscaled service) and make the owner its operator
//   tailscale-remove                  sign this server out of Tailscale, stop it and remove the package
import {execFile} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {access as fileAccess, chown, constants as fsConstants, mkdir, readdir, readFile, realpath, rename, writeFile} from 'node:fs/promises'
import {join, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const DEV = /^\/dev\/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme\d{1,2}n\d{1,2}|mmcblk\d{1,2}|hd[a-z])$/
const BY_ID = /^\/dev\/disk\/by-id\/[A-Za-z0-9._:+-]+$/
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const ZFS_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SYSTEM_MOUNTS = new Set(['/', '/home', '[SWAP]'])
const SYSTEM_MOUNT_PREFIXES = ['/boot', '/efi', '/var', '/usr', '/opt', '/srv', '/nix']
const cleanMount = (m) => (typeof m === 'string' && m.length > 1 ? m.replace(/\/+$/, '') || '/' : m)
function isSystemMount(m, home) {
	const p = cleanMount(m)
	if (!p) return false
	if (SYSTEM_MOUNTS.has(p)) return true
	const ownerHome = cleanMount(home)
	if (ownerHome && p === ownerHome) return true
	return SYSTEM_MOUNT_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))
}
const SKIP_FS = new Set(['crypto_LUKS', 'swap', 'LVM2_member', 'linux_raid_member', 'zfs_member'])
const FAT_FS = new Set(['vfat', 'exfat', 'ntfs', 'msdos', 'fuseblk'])
function safeMountName(s) {
	const n = String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '')
	if (!n || n === '.' || n === '..') return ''
	return n.slice(0, 64)
}
const FSTAB_MARK = '# omarchy-server pool'
// nosuid,nodev: a program or device file on a pool (an imported drive could carry one) can never
// gain root.
const POOL_OPTIONS = 'defaults,noatime,nosuid,nodev,compress=zstd:3,nofail,x-systemd.device-timeout=10s'
const ZFS_MARK = '# omarchy-server zfs'
// Mountpoints an imported pool must never land on.
const PROTECTED = ['/', '/boot', '/efi', '/etc', '/usr', '/var', '/home', '/root', '/opt', '/srv', '/bin', '/sbin', '/lib', '/lib64', '/dev', '/proc', '/sys', '/run', '/tmp']
const SMB_CONF = '/etc/samba/smb.conf'
const SMB_INCLUDE = '/etc/samba/omarchy-server-shares.conf'
const SMB_MARK = '# Managed by Omarchy Server'
const UDEV_SLEEP = '/etc/udev/rules.d/69-omarchy-server-sleep.rules'
const UDEV_USB = '/etc/udev/rules.d/69-omarchy-server-usb.rules'
const USB_SERIAL = /^[A-Za-z0-9._:-]{1,128}$/
// One-time sign-in to the Omarchy desktop (the same drop-in Omarchy's own first boot writes, removed again
// as soon as the session starts).
const SDDM_ONCE = '/etc/sddm.conf.d/zz-omarchy-server-sign-in.conf'
const SESSIONS = ['/usr/share/wayland-sessions/omarchy.desktop', '/usr/share/wayland-sessions/hyprland-uwsm.desktop', '/usr/share/wayland-sessions/hyprland.desktop']
const SLEEP_MINUTES = {0: 0, 10: 120, 20: 240, 30: 241, 60: 242, 120: 244, 240: 248}
const HELPER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'

export class HelperError extends Error {}
const fail = (message) => {
	throw new HelperError(message)
}

export function defaultRun(cmd, args, {input} = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, {timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: {PATH: HELPER_PATH, LC_ALL: 'C'}}, (error, stdout, stderr) => {
			if (error && !(cmd === 'smartctl' && stdout)) return reject(new HelperError(`${cmd}: ${(stderr || error.message).toString().trim().split('\n').slice(-2).join(' ')}`))
			resolve(stdout.toString())
		})
		if (input !== undefined) child.stdin.end(input)
	})
}

// Everything the helper touches comes through ctx, so tests can run it without root.
export function createHelper({run = defaultRun, user, fs = {readFile, writeFile, mkdir, chown, realpath, rename, readdir, access: fileAccess}}) {
	if (!user?.name || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user.name) || !Number.isInteger(user.uid) || user.uid === 0 || !user.home?.startsWith('/')) fail('Run this through sudo as the owner of this server')
	const poolsDir = join(user.home, 'Pools')
	const mountOf = (name) => join(poolsDir, name)

	async function blockDevices() {
		const j = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,SERIAL']))
		return j.blockdevices ?? []
	}
	const flat = (d) => [d, ...(d.children ?? []).flatMap(flat)]
	const mounts = (d) => flat(d).flatMap((x) => (x.mountpoints ?? []).filter(Boolean))
	async function disk(path) {
		if (!DEV.test(path)) fail(`Not a drive: ${path}`)
		const d = (await blockDevices()).find((x) => x.path === path && x.type === 'disk')
		if (!d) fail(`No drive at ${path}`)
		return d
	}
	async function resolveDisk(path) {
		let p = String(path ?? '')
		if (BY_ID.test(p) && !/-part\d+$/.test(p)) p = await fs.realpath(p).catch(() => fail(`No drive at ${path}`))
		return disk(p)
	}
	async function commandOnPath(name) {
		// Tests replace fs and do not carry the machine's programs. The real helper's fs does.
		if (typeof fs.access !== 'function') return true
		for (const dir of HELPER_PATH.split(':')) {
			try {
				await fs.access(join(dir, name), fsConstants.X_OK)
				return true
			} catch {
				// Another directory on the helper PATH may still have it.
			}
		}
		return false
	}
	// Imported pools are identified by GUID. Two pools can share a name; lsblk stores the GUID as the
	// zfs_member UUID, and `zpool get guid` is the imported pool's GUID.
	async function zfsPoolGuids() {
		const guids = new Set()
		// A pool zpool list named, but whose guid we could not read, still protects disks by name.
		// An empty guid set must not make those disks look free to format.
		const namesWithoutGuid = new Set()
		for (const name of await zfsPoolNames()) {
			const guid = (await zpool('get', '-H', '-o', 'value', 'guid', name).catch(() => '')).trim()
			if (guid && guid !== '-') guids.add(guid)
			else namesWithoutGuid.add(name)
		}
		return {guids, namesWithoutGuid}
	}
	async function poolMember(d) {
		if (mounts(d).some((m) => /\/Pools\//.test(m))) return true
		const text = await fstab()
		const uuids = new Set(flat(d).map((x) => x.uuid).filter(Boolean))
		if (text.some((l) => l.includes(FSTAB_MARK) && [...uuids].some((u) => l.includes(u)))) return true
		const {guids, namesWithoutGuid} = await zfsPoolGuids()
		return flat(d).some((x) => x.fstype === 'zfs_member' && ((x.uuid && guids.has(x.uuid)) || (x.label && namesWithoutGuid.has(x.label))))
	}
	// Blank: no partitions, no filesystem or RAID signature, nothing mounted, not the system drive.
	async function blankDisk(path) {
		const d = await disk(path)
		if (mounts(d).some((m) => isSystemMount(m, user.home))) fail(`${path} holds the system`)
		if (mounts(d).length) fail(`${path} is in use`)
		if ((d.children ?? []).length || d.fstype) fail(`${path} isn’t blank. Format this drive first (choose blank).`)
		const sig = (await run('wipefs', ['--no-act', '--json', path]).catch(() => '')).trim()
		if (sig && (JSON.parse(sig).signatures ?? []).length) fail(`${path} isn’t blank. Format this drive first (choose blank).`)
		return d
	}

	async function fstab() {
		return (await fs.readFile('/etc/fstab', 'utf8').catch(() => '')).split('\n')
	}
	async function writeAtomic(file, text) {
		const tmp = `${file}.omarchy-server.tmp`
		await fs.writeFile(tmp, text, {mode: 0o644})
		await fs.rename(tmp, file)
	}
	async function addFstab(name, uuid) {
		const lines = (await fstab()).filter((l) => !l.endsWith(`${FSTAB_MARK} ${name}`))
		while (lines.length && lines.at(-1) === '') lines.pop()
		lines.push(`UUID=${uuid} ${mountOf(name)} btrfs ${POOL_OPTIONS} 0 0 ${FSTAB_MARK} ${name}`, '')
		await writeAtomic('/etc/fstab', lines.join('\n'))
	}
	async function poolMount(name) {
		if (!NAME.test(name)) fail('Pool names use a-z, 0-9 and -')
		if (!(await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`))) fail(`No pool called ${name}`)
		return mountOf(name)
	}
	async function mountPool(name, uuid) {
		await fs.mkdir(mountOf(name), {recursive: true})
		await fs.chown(poolsDir, user.uid, user.gid)
		await addFstab(name, uuid)
		try {
			await run('systemctl', ['daemon-reload'])
			await run('mount', [mountOf(name)])
		} catch (error) {
			await writeAtomic('/etc/fstab', (await fstab()).filter((l) => !l.endsWith(`${FSTAB_MARK} ${name}`)).join('\n')).catch(() => {})
			await run('systemctl', ['daemon-reload']).catch(() => {})
			throw error
		}
		await fs.chown(mountOf(name), user.uid, user.gid)
	}

	async function inHome(path) {
		const home = await fs.realpath(user.home)
		const real = await fs.realpath(path).catch(() => fail(`No folder at ${path}`))
		if (real === home || !real.startsWith(home + sep)) fail('Only folders inside your home can be shared')
		if (real.slice(home.length + 1).split(sep).some((part) => part.startsWith('.'))) fail('Hidden folders can’t be shared')
		return real
	}
	// Rules are added whenever ufw is installed, even while it's off, so they're in place the
	// moment it's turned on (Omarchy turns it on during its own install).
	async function ufwActive() {
		return run('ufw', ['status']).then(() => true, () => false)
	}
	// SMB (445) is for the home LAN only. Tailscale is a second network (100.64.0.0/10) and is not
	// included, so shares stay off the tailnet unless you add a rule yourself. Applying or removing
	// shares closes an older world-open 445 rule and replaces the LAN rules, so they do not stack.
	const SMB_LAN = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
	async function ufwDelete(port, proto) {
		if (!(await ufwActive())) return
		await run('ufw', ['delete', 'allow', `${port}/${proto}`]).catch(() => {})
		if (Number(port) === 445) for (const cidr of SMB_LAN) await run('ufw', ['delete', 'allow', 'from', cidr, 'to', 'any', 'port', '445', 'proto', proto]).catch(() => {})
	}
	async function ufwAllow(port, proto, comment) {
		if (!(await ufwActive())) return
		if (Number(port) === 445) {
			await ufwDelete(445, proto)
			for (const cidr of SMB_LAN) await run('ufw', ['allow', 'from', cidr, 'to', 'any', 'port', '445', 'proto', proto, 'comment', comment])
			return
		}
		await run('ufw', ['allow', `${port}/${proto}`, 'comment', comment])
	}

	// ---- ZFS --------------------------------------------------------------------------------------
	const zpool = (...a) => run('zpool', a)
	const zfs = (...a) => run('zfs', a)
	async function zfsPoolNames() {
		return (await zpool('list', '-H', '-o', 'name').catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean)
	}
	// Stable names (/dev/disk/by-id/…) so a pool survives drives being re-lettered.
	async function byId(dev) {
		const dir = '/dev/disk/by-id'
		const names = await fs.readdir(dir).catch(() => [])
		const target = await fs.realpath(dev)
		const matches = []
		for (const n of names) if (!/-part\d+$/.test(n) && (await fs.realpath(join(dir, n)).catch(() => null)) === target) matches.push(n)
		const best = matches.find((n) => /^(nvme|ata|scsi|usb)-/.test(n)) ?? matches.find((n) => !n.startsWith('wwn-')) ?? matches[0]
		return best ? join(dir, best) : dev
	}
	// Parse `zpool status -P NAME` into what the app shows.
	function parseStatus(text) {
		const state = /^\s*state:\s*(\S+)/m.exec(text)?.[1] ?? 'UNKNOWN'
		const scan = /^\s*scan:\s*(.+(?:\n\t.+)*)/m.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
		const errors = /^errors:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
		const cfg = text.split(/^\s*config:\s*$/m)[1]?.split(/^errors:/m)[0] ?? ''
		const layout = new Set()
		const devices = []
		let section = 'data'
		for (const line of cfg.split('\n')) {
			const sec = /^\s+(logs|cache|spares|special|dedup)\s*$/.exec(line)
			if (sec) {
				section = sec[1]
				continue
			}
			if (section !== 'data') continue
			const m = /^\s+(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED)\s+(\d+\S*)\s+(\d+\S*)\s+(\d+\S*)/.exec(line)
			if (!m) continue
			if (/^(mirror|raidz[123]?|draid)/.test(m[1])) layout.add(m[1].replace(/-\d+$/, ''))
			else if (m[1].startsWith('/')) devices.push({path: m[1], state: m[2], errors: [m[3], m[4], m[5]].map(zfsCounter).reduce((a, b) => a + b, 0)})
		}
		return {state, scan, errors, layout: layout.size ? [...layout].sort().join('+') : 'stripe', devices}
	}
	// zpool status prints large counters as 12K or 1.50M. The suffix is a power of 1000.
	function zfsCounter(raw) {
		const m = /^(\d+(?:\.\d+)?)([KMGTP])?$/i.exec(raw)
		if (!m) return 0
		const unit = (m[2] ?? '').toUpperCase()
		const mult = {K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15}[unit] ?? 1
		return Math.round(Number(m[1]) * mult)
	}
	async function zfsPoolMount(name) {
		if (!ZFS_NAME.test(name ?? '')) fail('Bad pool name')
		if (!(await zfsPoolNames()).includes(name)) fail(`No ZFS pool called ${name}`)
		return name
	}
	async function ensureZfsServices() {
		for (const unit of ['zfs-import-cache.service', 'zfs-mount.service', 'zfs-import.target', 'zfs.target']) await run('systemctl', ['enable', unit]).catch(() => {})
	}

	// Graphical sessions on this machine: [{user, type, state}].
	async function graphicalSessions() {
		const out = []
		for (const line of (await run('loginctl', ['list-sessions', '--no-legend']).catch(() => '')).split('\n')) {
			const id = line.trim().split(/\s+/)[0]
			if (!id || !/^[\w-]+$/.test(id)) continue
			const props = Object.fromEntries(
				(await run('loginctl', ['show-session', id, '-p', 'Name', '-p', 'Type', '-p', 'State', '-p', 'Class']).catch(() => ''))
					.split('\n')
					.map((l) => l.split('='))
					.filter((kv) => kv.length === 2),
			)
			if ((props.Type === 'wayland' || props.Type === 'x11') && props.Class === 'user') out.push({user: props.Name, type: props.Type, state: props.State})
		}
		return out
	}
	const exists = (p) => fs.readFile(p).then(() => true, () => false)

	// Samba's programs and libraries come from different packages. After a partial update (one package
	// installed from a newer package list without updating the rest, which Arch doesn't support) they
	// no longer match, and every Samba program fails with "version … not found". Say what fixes it.
	const samba = async (fn) => {
		try {
			return await fn()
		} catch (error) {
			if (/version [`'"]?SAMBA_[^ ]+ not found|cannot open shared object file|undefined symbol/i.test(String(error?.message ?? error)))
				fail('Samba on this server is half-updated (its programs and libraries are different versions). Update the whole system once (Omarchy menu → Update, or omarchy update in a terminal), then try again.')
			throw error
		}
	}

	const verbs = {
		ping: async () => 'ok',
		// Sign the owner in to the Omarchy desktop when it's sitting at the sign-in screen (or after
		// too many wrong passwords): clear the failed-attempt lockout, then let SDDM start the owner's
		// session once. Only when nobody has a desktop session, so no one's open session is touched.
		'desktop-sign-in': async () => {
			const sessions = await graphicalSessions()
			if (sessions.some((x) => x.user === user.name)) return 'already'
			if (sessions.length) fail('Someone else is signed in to this desktop, so it was left alone.')
			if (!(await exists('/usr/lib/systemd/system/sddm.service'))) fail('This desktop doesn’t use SDDM, so this server can’t sign it in.')
			let session = null
			for (const f of SESSIONS) if (await exists(f)) (session ??= f.split('/').pop())
			if (!session) fail('No Omarchy desktop session was found to start.')
			await run('faillock', ['--user', user.name, '--reset']).catch(() => {})
			await fs.mkdir('/etc/sddm.conf.d', {recursive: true})
			await fs.writeFile(SDDM_ONCE, `# MODC: one-time sign-in, removed once the session starts\n[Autologin]\nUser=${user.name}\nSession=${session}\nRelogin=false\n`, {mode: 0o644})
			try {
				await run('systemctl', ['restart', 'sddm.service'])
				for (let i = 0; i < 40; i++) {
					if ((await graphicalSessions()).some((x) => x.user === user.name)) return 'signed-in'
					await new Promise((r) => setTimeout(r, 500))
				}
				fail('The desktop didn’t start a session. Check the server’s screen.')
			} finally {
				// Never left in place: later sign-ins need the password as usual.
				await run('rm', ['-f', SDDM_ONCE]).catch(() => {})
			}
		},
		// Restart or shut down the server (Settings → Restart server / Shut down server).
		power: async ([what]) => {
			if (what !== 'reboot' && what !== 'poweroff') fail('Use reboot or poweroff')
			await run('systemctl', ['--no-block', what])
			return 'ok'
		},
		// The server's device name on the network (Settings → Device name).
		hostname: async ([name]) => {
			if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name ?? '')) fail('Use letters, numbers and dashes for the device name')
			await run('hostnamectl', ['set-hostname', name])
			return 'ok'
		},
		// Remove a one-time sign-in left behind by an interrupted attempt.
		'desktop-sign-in-cleanup': async () => (await run('rm', ['-f', SDDM_ONCE]), 'ok'),

		smart: async ([dev]) => {
			await disk(dev)
			return run('smartctl', ['-n', 'standby', '-j', '-a', dev])
		},

		sleep: async ([dev, minutes]) => {
			const d = await disk(dev)
			const m = Number(minutes)
			if (!(m in SLEEP_MINUTES)) fail('Choose 0, 10, 20, 30, 60, 120 or 240 minutes')
			if (!(d.rota === true || d.rota === '1' || d.rota === 1)) fail('Only spinning hard drives sleep')
			if (!d.serial || !/^[\w.-]{1,64}$/.test(d.serial)) fail('This drive doesn’t report a serial number, so its setting can’t be kept')
			await run('hdparm', ['-S', String(SLEEP_MINUTES[m]), dev])
			const lines = (await fs.readFile(UDEV_SLEEP, 'utf8').catch(() => '')).split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(`ENV{ID_SERIAL_SHORT}=="${d.serial}"`))
			if (m) lines.push(`ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="${d.serial}", RUN+="/usr/bin/hdparm -S ${SLEEP_MINUTES[m]} /dev/%k"`)
			await writeAtomic(UDEV_SLEEP, lines.length ? `# Drive sleep, set by Omarchy Server\n${lines.join('\n')}\n` : '')
			return 'ok'
		},

		'usb-allow': async ([serial]) => {
			if (!USB_SERIAL.test(serial ?? '')) fail('Use the USB serial, letters numbers . _ - only')
			const keep = (await fs.readFile(UDEV_USB, 'utf8').catch(() => '')).split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(`=="${serial}"`))
			// OWNER makes the stick the server user's even with nobody signed in to the desktop (a headless
			// server), which is where its apps and VMs run; uaccess alone only reaches the signed-in seat.
			keep.push(
				`SUBSYSTEM=="tty", ENV{ID_USB_SERIAL_SHORT}=="${serial}", OWNER="${user.name}", MODE="0660", TAG+="uaccess"`,
				`SUBSYSTEM=="tty", ENV{ID_SERIAL_SHORT}=="${serial}", OWNER="${user.name}", MODE="0660", TAG+="uaccess"`,
			)
			await writeAtomic(UDEV_USB, `# USB serial access, set by Omarchy Server\n${keep.join('\n')}\n`)
			await run('udevadm', ['control', '--reload']).catch(() => {})
			// Only serial devices: re-checking every device on the machine could disturb disks and network.
			await run('udevadm', ['trigger', '--subsystem-match=tty', '--action=change']).catch(() => {})
			return 'ok'
		},
		'usb-forget': async ([serial]) => {
			if (!USB_SERIAL.test(serial ?? '')) fail('Use the USB serial, letters numbers . _ - only')
			const keep = (await fs.readFile(UDEV_USB, 'utf8').catch(() => '')).split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(`=="${serial}"`))
			await writeAtomic(UDEV_USB, keep.length ? `# USB serial access, set by Omarchy Server\n${keep.join('\n')}\n` : '')
			await run('udevadm', ['control', '--reload']).catch(() => {})
			// Hand the stick back to its default owner straight away, not at the next replug.
			await run('udevadm', ['trigger', '--subsystem-match=tty', '--action=change']).catch(() => {})
			return 'ok'
		},

		umount: async ([path]) => {
			const d = await resolveDisk(path)
			if (mounts(d).some((m) => isSystemMount(m, user.home))) fail(`${d.path} holds the system`)
			if (await poolMember(d)) fail(`${d.path} is in a pool`)
			// A mount inside another mount on this drive is busy until the child is gone.
			for (const m of mounts(d).slice().sort((a, b) => b.length - a.length)) await run('umount', [m])
			return 'ok'
		},
		mount: async ([path]) => {
			const d = await resolveDisk(path)
			if (mounts(d).some((m) => isSystemMount(m, user.home))) fail(`${d.path} holds the system`)
			if (await poolMember(d)) fail(`${d.path} is in a pool`)
			if (mounts(d).length) fail(`${d.path} is already mounted`)
			const nodes = (d.children ?? []).length ? flat(d).filter((x) => x !== d) : [d]
			const targets = nodes.filter((x) => x.fstype && !SKIP_FS.has(x.fstype))
			if (!targets.length) fail('Nothing to mount')
			// Names already mounted under /run/media/$USER, so a second stick with the same label
			// is placed beside the first instead of on top of it. A path under that name counts too.
			const media = join('/run/media', user.name)
			const used = new Set()
			for (const dev of await blockDevices()) {
				for (const m of flat(dev).flatMap((x) => (x.mountpoints ?? []).filter(Boolean))) {
					if (!m.startsWith(`${media}${sep}`)) continue
					const name = m.slice(media.length + 1).split(sep)[0]
					if (name) used.add(name)
				}
			}
			for (const t of targets) {
				let name = safeMountName(t.label) || safeMountName(t.uuid) || safeMountName(t.name) || 'disk'
				const base = name
				let n = 2
				while (used.has(name)) name = `${base}-${n++}`
				used.add(name)
				const parent = join('/run/media', user.name)
				const dest = join(parent, name)
				await fs.mkdir(dest, {recursive: true})
				await fs.chown(parent, user.uid, user.gid).catch(() => {})
				await fs.chown(dest, user.uid, user.gid)
				const flags = ['nosuid', 'nodev']
				if (FAT_FS.has(t.fstype)) flags.push(`uid=${user.uid}`, `gid=${user.gid}`)
				await run('mount', ['-o', flags.join(','), t.path, dest])
				if (!FAT_FS.has(t.fstype)) await fs.chown(dest, user.uid, user.gid)
			}
			return 'ok'
		},
		format: async ([path, fsKind]) => {
			if (!['blank', 'ext4', 'exfat'].includes(fsKind)) fail('Choose blank, ext4 or exfat')
			const d = await resolveDisk(path)
			if (mounts(d).some((m) => isSystemMount(m, user.home))) fail(`${d.path} holds the system`)
			if (await poolMember(d)) fail(`${d.path} is in a pool`)
			if (mounts(d).length) fail(`${d.path} is in use. Unmount it first.`)
			// Unlocked encryption, LVM or a running RAID array on it (lsblk shows them as its children),
			// even with nothing mounted: those are in use.
			if (flat(d).some((x) => x !== d && x.type !== 'part')) fail(`${d.path} is in use by encryption, LVM or RAID. Stop that first.`)
			if (fsKind === 'ext4' || fsKind === 'exfat') {
				const prog = fsKind === 'ext4' ? 'mkfs.ext4' : 'mkfs.exfat'
				if (!(await commandOnPath(prog))) fail(fsKind === 'exfat' ? `exFAT tools aren't installed on this computer (exfatprogs): mkfs.exfat` : `mkfs.ext4 isn't installed on this computer`)
			}
			await run('wipefs', ['-a', d.path])
			if (fsKind === 'ext4') await run('mkfs.ext4', ['-F', d.path])
			if (fsKind === 'exfat') await run('mkfs.exfat', [d.path])
			return 'ok'
		},

		'pool-create': async ([name, profile, ...devs]) => {
			if (!NAME.test(name ?? '')) fail('Pool names use a-z, 0-9 and -, starting with a letter')
			if (!['single', 'raid1', 'raid10'].includes(profile)) fail('Choose single, raid1 or raid10')
			if (!devs.length || devs.length > 16 || new Set(devs).size !== devs.length) fail('Choose the drives for the pool')
			if (profile === 'raid1' && devs.length < 2) fail('Mirroring needs at least 2 drives')
			if (profile === 'raid10' && devs.length < 4) fail('RAID 10 needs at least 4 drives')
			if ((await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`))) fail(`There’s already a pool called ${name}`)
			for (const d of devs) await blankDisk(d)
			const meta = devs.length === 1 ? 'dup' : profile === 'raid10' ? 'raid10' : 'raid1'
			await run('mkfs.btrfs', ['-L', `omarchy-${name}`, '-d', profile, '-m', meta, ...devs])
			await run('udevadm', ['settle']).catch(() => {})
			const uuid = (await run('blkid', ['-s', 'UUID', '-o', 'value', devs[0]])).trim()
			if (!UUID.test(uuid)) fail('The new pool has no UUID')
			await mountPool(name, uuid)
			return JSON.stringify({name, uuid, mountpoint: mountOf(name)})
		},

		'pool-add': async ([name, dev]) => {
			const mnt = await poolMount(name)
			await blankDisk(dev)
			await run('btrfs', ['device', 'add', dev, mnt])
			await run('btrfs', ['balance', 'start', '--bg', '--full-balance', mnt])
			return 'ok'
		},

		'pool-import': async ([name, uuid]) => {
			if (!NAME.test(name ?? '')) fail('Pool names use a-z, 0-9 and -, starting with a letter')
			if (!UUID.test(uuid ?? '')) fail('Choose a filesystem to import')
			const fs0 = (await blockDevices()).flatMap(flat).filter((x) => x.uuid === uuid)
			if (!fs0.length || fs0.some((x) => x.fstype !== 'btrfs')) fail('Only Btrfs filesystems can be imported')
			if (fs0.some((x) => (x.mountpoints ?? []).some(Boolean))) fail('That filesystem is already mounted')
			if ((await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`) || l.includes(`UUID=${uuid} `))) fail('That pool or filesystem is already set up')
			await mountPool(name, uuid)
			return 'ok'
		},

		'pool-forget': async ([name]) => {
			const mnt = await poolMount(name)
			await run('umount', [mnt]).catch((e) => {
				if (!/not mounted/.test(e.message)) throw new HelperError(`${name} is in use. Stop apps and shares using it, then try again.`)
			})
			await writeAtomic('/etc/fstab', (await fstab()).filter((l) => !l.endsWith(`${FSTAB_MARK} ${name}`)).join('\n'))
			await run('systemctl', ['daemon-reload'])
			return 'ok'
		},

		// Pools set up by earlier versions: add nosuid,nodev to their mounts (now and at boot).
		'harden-pools': async () => {
			const ours = (l) => l.includes(FSTAB_MARK) || l.includes(ZFS_MARK)
			let changed = 0
			const out = (await fstab()).map((l) => {
				const f = l.trim().split(/\s+/)
				if (!ours(l) || l.trim().startsWith('#') || f.length < 4) return l
				const opts = f[3].split(',')
				if (opts.includes('nosuid') && opts.includes('nodev')) return l
				changed++
				f[3] = [...opts, ...['nosuid', 'nodev'].filter((o) => !opts.includes(o))].join(',')
				return f.join(' ')
			})
			if (changed) {
				await writeAtomic('/etc/fstab', out.join('\n'))
				await run('systemctl', ['daemon-reload']).catch(() => {})
				for (const l of out) if (ours(l) && !l.trim().startsWith('#')) await run('mount', ['-o', 'remount,nosuid,nodev', l.trim().split(/\s+/)[1]]).catch(() => {})
			}
			let zfsChanged = 0
			const tab = await fstab()
			for (const name of await zfsPoolNames().catch(() => [])) {
				const mp = (await zfs('get', '-H', '-o', 'value', 'mountpoint', name).catch(() => '')).trim()
				if (!(mp.startsWith(`${poolsDir}/`) || tab.some((l) => l.endsWith(`${ZFS_MARK} ${name}`)))) continue
				for (const prop of ['setuid', 'devices']) {
					const v = (await zfs('get', '-H', '-o', 'value,source', prop, name).catch(() => '')).trim().split('\t')
					// Leave a value someone set on purpose alone; only change the default.
					if (v[0] === 'on' && v[1] !== 'local') { await zfs('set', `${prop}=off`, name).catch(() => {}); zfsChanged++ }
				}
			}
			return JSON.stringify({fstab: changed, zfs: zfsChanged})
		},

		// The drive the system (the owner's home) is on got bigger: grow into the space. Only ever grows,
		// only the last partition, and only partition → (LUKS) → Btrfs/ext4/XFS; anything else (LVM,
		// RAID, a partition in the middle) is refused with what to do instead. The disk password, when
		// the drive is encrypted, comes on stdin and goes to cryptsetup the same way; it's never stored.
		'grow-system': async (_args, stdin) => {
			const passphrase = String(stdin ?? '').replace(/\n$/, '')
			const [source, fstype, target] = (await run('findmnt', ['-n', '-o', 'SOURCE,FSTYPE,TARGET', '-T', user.home])).trim().split(/\s+/)
			const dev = (source ?? '').replace(/\[.*\]$/, '')
			if (!dev.startsWith('/dev/')) fail('The system drive couldn’t be found')
			const chain = JSON.parse(await run('lsblk', ['-J', '-b', '-s', '-o', 'NAME,PATH,SIZE,TYPE', dev])).blockdevices?.[0]
			const layers = []
			for (let n = chain; n; n = n.children?.[0]) layers.push(n)
			if (layers.some((n) => n.type === 'lvm' || /^raid/.test(n.type))) fail('The system is on LVM or RAID. Grow it with lvextend / mdadm instead.')
			const part = layers.find((n) => n.type === 'part')
			const crypt = layers.find((n) => n.type === 'crypt')
			const disk = layers.find((n) => n.type === 'disk')
			if (!part || !disk) fail('The system isn’t on a partition of a drive, so there’s nothing to grow')
			if (layers.indexOf(part) !== layers.length - 2) fail('This layout isn’t supported for growing')
			const tree = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,START', disk.path])).blockdevices?.[0]
			const parts = (tree?.children ?? []).filter((c) => c.type === 'part')
			const last = parts.reduce((a, c) => (Number(c.start ?? 0) > Number(a?.start ?? -1) ? c : a), null)
			if (last?.path !== part.path) fail(`${part.path} isn’t the last partition on ${disk.path}, so it can’t grow into the new space. Use a partition tool (GParted) from a live USB.`)
			const number = Number(/(\d+)$/.exec(part.name)?.[1])
			if (!Number.isInteger(number)) fail('The partition number couldn’t be read')
			const free = Number(disk.size) - parts.reduce((t, c) => t + Number(c.size || 0), 0)
			const done = []
			// 1. The partition: move a GPT's backup header to the new end, then extend the last
			//    partition to the end of the drive and tell the kernel (works while it's mounted).
			if (free > 16 * 1024 * 1024) {
				const table = (await run('sfdisk', ['--dump', disk.path])).match(/^label:\s*(\w+)/m)?.[1]
				if (table === 'gpt') await run('sfdisk', ['--relocate', 'gpt-bak-std', disk.path])
				await run('sfdisk', ['--no-reread', '--force', '-N', String(number), disk.path], {input: ', +\n'})
				await run('partx', ['-u', '-n', String(number), disk.path])
				done.push('partition')
			}
			// 2. The encryption layer, if any.
			if (crypt) {
				try {
					await run('cryptsetup', ['resize', crypt.name, ...(passphrase ? ['--key-file', '-'] : [])], passphrase ? {input: passphrase} : {})
				} catch (e) {
					if (/passphrase|key|No key available/i.test(e.message)) fail(passphrase ? 'That disk password didn’t unlock the drive' : 'NEEDS_PASSWORD: The drive is encrypted. Enter its disk password (the one you type when the computer starts).')
					throw e
				}
				done.push('encryption')
			}
			// 3. The filesystem.
			if (fstype === 'btrfs') await run('btrfs', ['filesystem', 'resize', 'max', target])
			else if (fstype === 'ext4' || fstype === 'ext3') await run('resize2fs', [dev])
			else if (fstype === 'xfs') await run('xfs_growfs', [target])
			else fail(`Growing a ${fstype} filesystem isn’t supported`)
			done.push('filesystem')
			return JSON.stringify({grown: done, disk: disk.path, partition: part.path})
		},

		// Tailscale on the system itself, the way Omarchy's own menu installs it (omarchy-install-service-
		// tailscale): the "tailscale" package from Arch's repositories, the tailscaled service, and the
		// owner as its operator, so omarchyd (running as the owner) can sign it in and out without root.
		// Nothing else changes: no routes accepted, no exit node, no Tailscale SSH.
		'tailscale-setup': async () => {
			const had = await run('pacman', ['-Q', 'tailscale']).then(() => true, () => false)
			if (!had) {
				// Never a partial update (see install.sh): with updates waiting, the whole system goes first.
				const waiting = await run('pacman', ['-Qu']).then((t) => String(t).trim(), () => '')
				if (waiting) fail('This server has system updates waiting. Update it first (Omarchy menu → Update, or omarchy update in a terminal), then install Tailscale.')
				await run('pacman', ['-S', '--needed', '--noconfirm', 'tailscale'])
			}
			await run('systemctl', ['enable', '--now', 'tailscaled.service'])
			// tailscaled takes a moment to open its socket after starting.
			let lastError = null
			for (let i = 0; i < 30; i++) {
				try {
					await run('tailscale', ['set', `--operator=${user.name}`])
					return JSON.stringify({installedPackage: !had})
				} catch (error) {
					lastError = error
					await new Promise((r) => setTimeout(r, 500))
				}
			}
			throw lastError
		},
		// Only called for a Tailscale that Omarchy Server installed (one you set up yourself stays).
		'tailscale-remove': async () => {
			if (!(await run('pacman', ['-Q', 'tailscale']).then(() => true, () => false))) return 'ok'
			// Signed out first, so this server leaves your tailnet instead of lingering there as offline.
			await run('tailscale', ['logout']).catch(() => {})
			await run('systemctl', ['disable', '--now', 'tailscaled.service']).catch(() => {})
			await run('pacman', ['-Rns', '--noconfirm', 'tailscale'])
			return 'ok'
		},

		'pool-scrub': async ([name]) => {
			await run('btrfs', ['scrub', 'start', await poolMount(name)])
			return 'ok'
		},

		'pool-status': async ([name]) => {
			const mnt = await poolMount(name)
			const df = await run('btrfs', ['filesystem', 'df', '-b', mnt])
			const profile = /^Data,\s*(\w+)/m.exec(df)?.[1]?.toLowerCase() ?? 'unknown'
			const stats = await run('btrfs', ['device', 'stats', mnt])
			const devices = {}
			for (const m of stats.matchAll(/^\[(\/dev\/[^\]]+)\]\.(\w+)\s+(\d+)/gm)) (devices[m[1]] ??= {})[m[2]] = Number(m[3])
			const scrub = await run('btrfs', ['scrub', 'status', mnt]).catch(() => '')
			const scrubState = /Status:\s*(\w+)/.exec(scrub)?.[1] ?? (/no stats available/.test(scrub) ? 'never' : 'unknown')
			const scrubErrors = /Error summary:\s*(.*)/.exec(scrub)?.[1]?.trim() ?? ''
			const started = /Scrub started:\s*(.*)/.exec(scrub)?.[1]?.trim() ?? null
			return JSON.stringify({profile, devices, scrub: {state: scrubState, errors: scrubErrors === 'no errors found' ? '' : scrubErrors, started}})
		},

		'zfs-available': async () => ((await run('zpool', ['version']).then(() => true, () => false)) ? 'yes' : 'no'),

		'zfs-pools': async () => {
			const out = []
			const tab = await fstab()
			for (const line of (await zpool('list', '-H', '-p', '-o', 'name,size,alloc,free,health').catch(() => '')).split('\n')) {
				const [name, size, alloc, free, health] = line.split('\t')
				if (!name) continue
				const st = parseStatus(await zpool('status', '-P', name).catch(() => ''))
				const mountpoint = (await zfs('get', '-H', '-o', 'value', 'mountpoint', name).catch(() => '')).trim()
				const space = (await zfs('list', '-H', '-p', '-o', 'used,avail', name).catch(() => '')).trim().split('\n')[0]?.split('\t') ?? []
				const usable = space.length >= 2 && /^\d+$/.test(space[0]) && /^\d+$/.test(space[1])
				const usedBytes = usable ? Number(space[0]) : Number(alloc) || 0
				const freeBytes = usable ? Number(space[1]) : Number(free) || 0
				const sizeBytes = usable ? usedBytes + freeBytes : Number(size) || 0
				const bind = tab.find((l) => l.endsWith(`${ZFS_MARK} ${name}`))
				const folder = bind ? bind.split(/\s+/)[1] : mountpoint.startsWith(`${poolsDir}/`) ? mountpoint : null
				out.push({name, size: sizeBytes, used: usedBytes, free: freeBytes, health, mountpoint, folder, ...st})
			}
			return JSON.stringify(out)
		},

		'zfs-importable': async () => {
			const text = await zpool('import').catch((e) => (/no pools available/i.test(e.message) ? '' : Promise.reject(e)))
			const pools = []
			for (const block of text.split(/^\s*pool:\s*/m).slice(1)) {
				const name = block.split('\n')[0].trim()
				pools.push({
					name,
					id: /^\s*id:\s*(\d+)/m.exec(block)?.[1] ?? null,
					state: /^\s*state:\s*(\S+)/m.exec(block)?.[1] ?? 'UNKNOWN',
					// "last accessed by another system": importing needs a deliberate "force".
					otherSystem: /another system|was last accessed by|-f flag/i.test(block),
					note: /^\s*status:\s*(.+(?:\n\s{2,}.+)*)/m.exec(block)?.[1]?.replace(/\s+/g, ' ').trim() ?? '',
				})
			}
			return JSON.stringify(pools)
		},

		'zfs-create': async ([name, layout, ...devs]) => {
			if (!NAME.test(name ?? '')) fail('Pool names use a-z, 0-9 and -, starting with a letter')
			const min = {stripe: 1, mirror: 2, raidz1: 3, raidz2: 4}[layout]
			if (!min) fail('Choose combined, mirror, raidz1 or raidz2')
			if (!devs.length || devs.length > 24 || new Set(devs).size !== devs.length) fail('Choose the drives for the pool')
			if (devs.length < min) fail(`That layout needs at least ${min} drives`)
			if ((await zfsPoolNames()).includes(name)) fail(`There’s already a ZFS pool called ${name}`)
			if ((await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`) || l.endsWith(`${ZFS_MARK} ${name}`))) fail(`There’s already a pool called ${name}`)
			for (const d of devs) await blankDisk(d)
			const ids = []
			for (const d of devs) ids.push(await byId(d))
			await fs.mkdir(poolsDir, {recursive: true})
			await fs.chown(poolsDir, user.uid, user.gid)
			const vdev = layout === 'stripe' ? ids : [layout, ...ids]
			await zpool('create', '-o', 'ashift=12', '-O', 'compression=lz4', '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl', '-O', 'setuid=off', '-O', 'devices=off', '-O', `mountpoint=${mountOf(name)}`, name, ...vdev)
			await zpool('set', 'cachefile=/etc/zfs/zpool.cache', name)
			await ensureZfsServices()
			await fs.chown(mountOf(name), user.uid, user.gid)
			return JSON.stringify({name, mountpoint: mountOf(name)})
		},

		'zfs-import': async ([name, force]) => {
			if (!ZFS_NAME.test(name ?? '')) fail('Bad pool name')
			if (force !== undefined && force !== 'force') fail('Bad option')
			if ((await zfsPoolNames()).includes(name)) fail(`${name} is already imported`)
			// Import without mounting, check where its datasets would land, then mount.
			await zpool('import', '-N', ...(force ? ['-f'] : []), name)
			const datasets = (await zfs('list', '-H', '-o', 'name,mountpoint,canmount', '-r', name)).split('\n').filter(Boolean).map((l) => l.split('\t'))
			const bad = datasets.find(([, mp, can]) => can !== 'off' && mp.startsWith('/') && PROTECTED.some((p) => mp === p || (p !== '/' && mp.startsWith(`${p}/`) && !mp.startsWith(`${poolsDir}/`))))
			if (bad) {
				await zpool('export', name).catch(() => {})
				fail(`${bad[0]} would be mounted at ${bad[1]}, a system folder, so the pool wasn’t imported. Change its mountpoint on the system it came from, or import it by hand.`)
			}
			// No setuid programs or device files from a pool brought in from elsewhere. Undo with
			// `sudo zfs inherit setuid NAME` and `sudo zfs inherit devices NAME` for a pool you trust.
			await zfs('set', 'setuid=off', name)
			await zfs('set', 'devices=off', name)
			await zfs('mount', '-a')
			await zpool('set', 'cachefile=/etc/zfs/zpool.cache', name)
			await ensureZfsServices()
			// Show it at ~/Pools/NAME without changing the pool: a bind mount of its top folder.
			const top = (datasets.find(([n]) => n === name) ?? [])[1]
			const pretty = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, 'p')
			if (top && top.startsWith('/') && top !== mountOf(pretty)) {
				await fs.mkdir(mountOf(pretty), {recursive: true})
				await fs.chown(poolsDir, user.uid, user.gid)
				const lines = (await fstab()).filter((l) => !l.endsWith(`${ZFS_MARK} ${name}`))
				while (lines.length && lines.at(-1) === '') lines.pop()
				lines.push(`${top} ${mountOf(pretty)} none bind,nosuid,nodev,nofail,x-systemd.requires=zfs-mount.service 0 0 ${ZFS_MARK} ${name}`, '')
				await writeAtomic('/etc/fstab', lines.join('\n'))
				await run('systemctl', ['daemon-reload'])
				await run('mount', [mountOf(pretty)])
			}
			return 'ok'
		},

		'zfs-scrub': async ([name]) => {
			await zpool('scrub', await zfsPoolMount(name))
			return 'ok'
		},

		'zfs-export': async ([name]) => {
			await zfsPoolMount(name)
			const bind = (await fstab()).find((l) => l.endsWith(`${ZFS_MARK} ${name}`))
			// Export first: a busy pool fails here and the bind mount and fstab line stay.
			await zpool('export', name).catch(() => fail(`${name} is in use. Stop apps and shares using it, then try again.`))
			if (bind) {
				const mnt = bind.split(/\s+/)[1]
				await run('umount', [mnt]).catch((e) => {
					if (!/not mounted/.test(e.message)) throw new HelperError(`${name} is in use. Stop apps and shares using it, then try again.`)
				})
				await writeAtomic('/etc/fstab', (await fstab()).filter((l) => l !== bind).join('\n'))
				await run('systemctl', ['daemon-reload'])
			}
			return 'ok'
		},

		'shares-apply': async (_args, stdin) => {
			let body
			try {
				body = JSON.parse(stdin)
			} catch {
				fail('Bad share list')
			}
			if (!Array.isArray(body?.shares) || body.shares.length > 64) fail('Bad share list')
			const seen = new Set()
			const blocks = []
			// A share can be open to anyone on your LAN, without a password (guest ok). Guest writes
			// stay as nobody, not as you. Only when at least one such share exists does Samba accept guests at all.
			const anyGuest = body.shares.some((s) => s?.guest === true)
			for (const s of body.shares) {
				const name = String(s?.name ?? '')
				// global, homes, and printers are Samba's own sections. A second [Global] would merge into [global].
				if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/.test(name) || /^(global|homes|printers)$/i.test(name) || seen.has(name.toLowerCase())) fail(`Bad share name: ${name}`)
				seen.add(name.toLowerCase())
				const path = await inHome(String(s?.path ?? ''))
				if (/[\n\r]/.test(path)) fail('Bad folder')
				// The path parameter substitutes %u and %m. %% is a literal percent.
				const written = path.replace(/%/g, '%%')
				const who = s.guest === true ? `   guest ok = yes\n` : `   valid users = ${user.name}\n   force user = ${user.name}\n`
				blocks.push(`[${name}]\n   path = ${written}\n${who}   read only = ${s.readOnly ? 'yes' : 'no'}\n   browseable = yes\n`)
			}
			const shares = `${SMB_MARK}. Edit shares in My Own Data Center.\n\n${blocks.join('\n')}`
			const current = await fs.readFile(SMB_CONF, 'utf8').catch(() => null)
			const guests = anyGuest ? `   map to guest = bad user\n   guest account = nobody\n   restrict anonymous = 0\n` : `   map to guest = never\n   restrict anonymous = 2\n`
			const globalSection = `[global]\n   server string = MODC\n   server min protocol = SMB2_10\n${guests}   disable netbios = yes\n   smb ports = 445\n`
			if (current === null || current.startsWith(SMB_MARK)) await writeAtomic(SMB_CONF, `${SMB_MARK}\n${globalSection}\n${blocks.join('\n')}`)
			else {
				// Your own Samba setup: its [global] section is yours, so guests stay as you set them.
				if (anyGuest) fail('This server has its own Samba settings, so shares without a password aren’t available. Use a password instead.')
				await writeAtomic(SMB_INCLUDE, shares)
				if (!current.includes(`include = ${SMB_INCLUDE}`)) await writeAtomic(SMB_CONF, `${current.replace(/\n*$/, '\n')}\n# Added by Omarchy Server\n   include = ${SMB_INCLUDE}\n`)
			}
			if (blocks.length) {
				// Samba's own check first: a half-updated Samba can't start, and says so here.
				await samba(() => run('smbd', ['-b']))
				await run('systemctl', ['enable', '--now', 'smb.service'])
				await run('smbcontrol', ['smbd', 'reload-config']).catch(() => run('systemctl', ['restart', 'smb.service']))
				await ufwAllow(445, 'tcp', 'Omarchy Server shares')
			} else {
				await run('systemctl', ['disable', '--now', 'smb.service']).catch(() => {})
				await ufwDelete(445, 'tcp')
			}
			return 'ok'
		},

		'smb-password': async (_args, stdin) => {
			const pw = String(stdin ?? '').replace(/\n$/, '')
			if (pw.length < 8 || pw.length > 128 || /[\r\n]/.test(pw)) fail('Bad password')
			// smbpasswd won't run without an smb.conf, and Arch's samba package doesn't ship one: start
			// with Omarchy Server's own (no shares yet; shares-apply fills it in).
			if ((await fs.readFile(SMB_CONF, 'utf8').catch(() => null)) === null)
				await writeAtomic(SMB_CONF, `${SMB_MARK}\n[global]\n   server string = MODC\n   server min protocol = SMB2_10\n   map to guest = never\n   restrict anonymous = 2\n   disable netbios = yes\n   smb ports = 445\n`)
			await samba(() => run('smbpasswd', ['-s', '-a', user.name], {input: `${pw}\n${pw}\n`}))
			return 'ok'
		},

		// An app's port through the firewall (TCP and UDP). Ports below 1024 only for apps you allowed
		// to use them (omarchyd asks you first); never SSH, omarchyd or the desktop share.
		'firewall-open': async ([port]) => {
			const p = Number(port)
			if (!Number.isInteger(p) || p < 1 || p > 65535 || [22, 2021, 5900].includes(p)) fail('Bad port')
			for (const proto of ['tcp', 'udp']) await ufwAllow(p, proto, 'Omarchy Server app')
			return 'ok'
		},
		// Let your (rootless) containers listen on ports from N up, for apps you allowed to use
		// system ports such as 53 or 443. Only ever lowers the limit; kept across restarts.
		'low-ports': async ([n]) => {
			const want = Number(n)
			if (!Number.isInteger(want) || want < 1 || want > 1024) fail('Bad port')
			const now = Number((await run('sysctl', ['-n', 'net.ipv4.ip_unprivileged_port_start'])).trim())
			if (Number.isInteger(now) && now <= want) return 'ok'
			await fs.writeFile('/etc/sysctl.d/60-omarchy-server-ports.conf', `# MODC: apps you allowed to use system ports\nnet.ipv4.ip_unprivileged_port_start = ${want}\n`, {mode: 0o644})
			await run('sysctl', ['-w', `net.ipv4.ip_unprivileged_port_start=${want}`])
			return 'ok'
		},
		'firewall-close': async ([port]) => {
			const p = Number(port)
			if (!Number.isInteger(p) || p < 1 || p > 65535 || [22, 2021, 5900, 7780].includes(p)) fail('Bad port')
			for (const proto of ['tcp', 'udp']) await ufwDelete(p, proto)
			return 'ok'
		},
	}

	return {
		async handle(verb, args = [], stdin = '') {
			if (!Object.hasOwn(verbs, verb)) fail(`Unknown action: ${verb}`)
			return verbs[verb](args, stdin)
		},
	}
}

// ---- run as a program (through sudo) ------------------------------------------------------------
async function main() {
	const [verb, ...args] = process.argv.slice(2)
	try {
		const name = process.env.SUDO_USER
		const uid = Number(process.env.SUDO_UID)
		const gid = Number(process.env.SUDO_GID)
		if (process.getuid() !== 0 || !name || !uid) fail('Run this through sudo as the owner of this server')
		const passwd = (await readFile('/etc/passwd', 'utf8')).split('\n').map((l) => l.split(':')).find((f) => f[0] === name && Number(f[2]) === uid)
		if (!passwd) fail('Unknown user')
		let stdin = ''
		if (verb === 'shares-apply' || verb === 'smb-password' || verb === 'grow-system') for await (const c of process.stdin) stdin += c
		const helper = createHelper({user: {name, uid, gid, home: passwd[5]}})
		process.stdout.write(`${await helper.handle(verb, args, stdin)}\n`)
	} catch (error) {
		process.stderr.write(`${error instanceof HelperError ? error.message : 'The helper failed'}\n`)
		if (!(error instanceof HelperError)) process.stderr.write(`${error?.stack ?? error}\n`)
		process.exit(error instanceof HelperError ? 2 : 1)
	}
}
function ranAsMain() {
	if (typeof import.meta.main === 'boolean') return import.meta.main
	try {
		return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
	} catch {
		return false
	}
}
if (ranAsMain()) main()
