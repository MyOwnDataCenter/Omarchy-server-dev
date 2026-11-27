// `omarchy-server uninstall`, run for real in a temporary home folder with stand-ins for sudo, systemctl,
// ufw, podman and virsh that only write down what they were asked. Nothing on this machine is touched.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'omarchy-server')
const root = await mkdtemp(join(os.tmpdir(), 'uninstall-'))
after(() => rm(root, {recursive: true, force: true}))

// The few ordinary tools the script uses, so a test can build a PATH that has no node on it.
const core = join(root, 'core')
await mkdir(core)
for (const tool of ['bash', 'cat', 'cut', 'du', 'grep', 'head', 'readlink', 'rm', 'sed', 'sort', 'tr']) {
	const found = spawnSync('sh', ['-c', `command -v ${tool}`], {encoding: 'utf8'}).stdout.trim()
	if (found) await symlink(found, join(core, tool))
}
// node can live anywhere (mise, nvm, /opt/...), so it is added by where this test run found it.
const withNode = (bin) => `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`

const exists = (p) => readFile(p).then(() => true, () => false)
const write = async (file, text = 'x') => {
	await mkdir(dirname(file), {recursive: true})
	await writeFile(file, text)
}

// An installed Omarchy Server in a fresh home folder, plus the fake commands.
async function install(name) {
	const home = join(root, name)
	const base = join(home, '.local/share/omarchy-server')
	const units = join(home, '.config/systemd/user')
	const launchers = join(home, '.local/share/applications')
	const bin = join(root, `${name}-bin`)
	const log = join(root, `${name}.log`)
	await mkdir(join(base, 'app/bin'), {recursive: true})
	await copyFile(SCRIPT, join(base, 'app/bin/omarchy-server'))
	await mkdir(join(home, '.local/bin'), {recursive: true})
	await symlink(join(base, 'app/bin/omarchy-server'), join(home, '.local/bin/omarchy-server'))
	await write(join(units, 'omarchyd.service'))
	await write(join(units, 'omarchy-server-web.service'), 'ExecStart=/usr/bin/node /x/server/cli.mjs --port 7780 --data /y\n')
	await write(join(units, 'omarchy-server-desktop.service'))
	await write(join(launchers, 'omarchy-server.desktop'))
	await write(join(launchers, 'omarchy-server-restart.desktop'))
	await write(join(base, 'install.log'))
	await write(join(base, '.widget-offered'))
	await write(join(base, 'omarchyd/accounts.json'), '{"owner":true}')
	await write(join(base, 'omarchyd/apps/installed/demo/data/notes.txt'), 'app data')
	await write(join(base, 'web/sessions.json'))
	await write(join(home, 'Pools/pool.txt'))
	await write(join(home, 'Documents/mine.txt'))
	await mkdir(bin, {recursive: true})
	const fakes = {
		// sudo never runs anything: it only writes down the command it was given.
		sudo: '[ -z "${FAKE_SUDO_FAILS:-}" ] || exit 1; echo "sudo $*" >>"$FAKE_LOG"',
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"',
		ufw: 'echo "ufw $*" >>"$FAKE_LOG"',
		// podman ps answers in JSON like the real one: FAKE_APPS is a list of compose project names.
		podman:
			'if [ "$1" = ps ]; then [ -z "${FAKE_PODMAN_FAILS:-}" ] || { echo "Error: boom" >&2; exit 125; }; printf "["; sep=; for p in ${FAKE_APPS:-}; do printf "%s{\\"Labels\\":{\\"com.docker.compose.project\\":\\"%s\\"}}" "$sep" "$p"; sep=,; done; printf "]"; else echo "podman $*" >>"$FAKE_LOG"; fi',
		virsh: '[ -z "${FAKE_VIRSH_FAILS:-}" ] || { echo "error: no daemon" >&2; exit 1; }; printf "%s" "${FAKE_VMS:-}"',
	}
	for (const [cmd, body] of Object.entries(fakes)) {
		await writeFile(join(bin, cmd), `#!/bin/sh\n${body}\n`)
		await chmod(join(bin, cmd), 0o755)
	}
	return {home, base, units, launchers, log, bin}
}

// detached: true puts the script in its own session, so it has no terminal even when the tests run in one.
function run(box, args, extra = {}) {
	const r = spawnSync('bash', [join(box.home, '.local/bin/omarchy-server'), 'uninstall', ...args], {
		env: {HOME: box.home, PATH: withNode(box.bin), FAKE_LOG: box.log, ...extra},
		encoding: 'utf8',
		detached: true,
		timeout: 20000,
	})
	return {status: r.status, out: `${r.stdout}${r.stderr}`}
}
const calls = (box) => readFile(box.log, 'utf8').catch(() => '')

const programGone = async (box) => {
	assert.equal(await exists(join(box.base, 'app/bin/omarchy-server')), false, 'the program folder is gone')
	assert.equal(await exists(join(box.home, '.local/bin/omarchy-server')), false, 'the command is gone')
	assert.equal(await exists(join(box.units, 'omarchyd.service')), false)
	assert.equal(await exists(join(box.units, 'omarchy-server-web.service')), false)
	assert.equal(await exists(join(box.units, 'omarchy-server-desktop.service')), false)
	assert.equal(await exists(join(box.launchers, 'omarchy-server.desktop')), false)
	assert.equal(await exists(join(box.launchers, 'omarchy-server-restart.desktop')), false)
	assert.equal(await exists(join(box.base, 'install.log')), false)
}
const filesKept = async (box) => {
	assert.equal(await exists(join(box.home, 'Pools/pool.txt')), true, '~/Pools is never touched')
	assert.equal(await exists(join(box.home, 'Documents/mine.txt')), true, 'your files are never touched')
}

// Root files the helper wrote. A successful uninstall logs their removal and does not tell the
// user they were left behind. `sudo` only records the command, so smb.conf itself is not rewritten here.
const rootLeftovers = [
	['udev sleep rule', /sudo rm -f[^\n]*\/etc\/udev\/rules\.d\/69-omarchy-server-sleep\.rules/],
	['udev usb rule', /sudo rm -f[^\n]*\/etc\/udev\/rules\.d\/69-omarchy-server-usb\.rules/],
	['udev reload', /sudo udevadm control --reload/],
	['port sysctl file', /sudo rm -f \/etc\/sysctl\.d\/60-omarchy-server-ports\.conf/],
	['sysctl reload', /sudo sysctl --system/],
	['shares conf', /sudo rm -f \/etc\/samba\/omarchy-server-shares\.conf/],
	['445', /sudo ufw delete allow 445\/tcp\n/],
	['445 lan 10', /sudo ufw delete allow from 10\.0\.0\.0\/8 to any port 445 proto tcp\n/],
	['445 lan 172', /sudo ufw delete allow from 172\.16\.0\.0\/12 to any port 445 proto tcp\n/],
	['445 lan 192', /sudo ufw delete allow from 192\.168\.0\.0\/16 to any port 445 proto tcp\n/],
]
const notLeftBehind = (out) => {
	assert.doesNotMatch(out, /69-omarchy-server-(?:sleep|usb)\.rules/)
	assert.doesNotMatch(out, /60-omarchy-server-ports\.conf/)
	assert.doesNotMatch(out, /omarchy-server-shares\.conf/)
	assert.doesNotMatch(out, /SMB shares/)
}

test('uninstall removes udev rules, the port sysctl file and Samba shares', async () => {
	for (const args of [['-y'], ['--purge', '-y']]) {
		const box = await install(`root-${args.includes('--purge') ? 'purge' : 'keep'}`)
		const r = run(box, args)
		assert.equal(r.status, 0, r.out)
		const c = await calls(box)
		for (const [name, pattern] of rootLeftovers) assert.match(c, pattern, name)
		notLeftBehind(r.out)
	}
})

test('when sudo cannot run, the commands to remove udev rules, the sysctl file and Samba shares are printed', async () => {
	for (const args of [['-y'], ['--purge', '-y']]) {
		const box = await install(`root-nosudo-${args.includes('--purge') ? 'purge' : 'keep'}`)
		const r = run(box, args, {FAKE_SUDO_FAILS: '1'})
		assert.equal(r.status, 1, r.out)
		for (const [name, pattern] of rootLeftovers) assert.match(r.out, pattern, name)
		assert.match(r.out, /include = \/etc\/samba\/omarchy-server-shares\.conf/)
		assert.ok(!(await calls(box)).includes('sudo '), 'sudo was never run')
	}
})

test('uninstall removes the program and keeps the account, the apps’ data and your files', async () => {
	const box = await install('keep')
	const r = run(box, ['-y'])
	assert.equal(r.status, 0, r.out)
	assert.match(r.out, /Your data is still in .*omarchy-server/)
	await programGone(box)
	await filesKept(box)
	assert.equal(await exists(join(box.base, 'omarchyd/accounts.json')), true, 'the account is kept')
	assert.equal(await exists(join(box.base, 'omarchyd/apps/installed/demo/data/notes.txt')), true, 'apps’ data is kept')
	assert.equal(await exists(join(box.base, 'web/sessions.json')), true)
	const c = await calls(box)
	assert.match(c, /systemctl --user disable --now omarchyd.service omarchy-server-web.service omarchy-server-desktop.service/)
	assert.match(c, /systemctl --user daemon-reload/)
	assert.match(c, /sudo rm -f \/etc\/sudoers.d\/omarchy-server/)
	assert.match(c, /sudo rm -rf \/usr\/local\/libexec\/omarchy-server/)
	for (const rule of ['7780/tcp', '40000:49999/tcp', '40000:49999/udp', '7800:7899/tcp']) assert.match(c, new RegExp(`sudo ufw delete allow ${rule}\\n`))
	assert.ok(!c.includes('podman unshare'), 'nothing is deleted from the data folder')
})

test('uninstall uses the port from the installed service for its firewall rule', async () => {
	const box = await install('port')
	await write(join(box.units, 'omarchy-server-web.service'), 'ExecStart=/usr/bin/node /x/server/cli.mjs --port 7791 --data /y\n')
	assert.equal(run(box, ['-y']).status, 0)
	assert.match(await calls(box), /sudo ufw delete allow 7791\/tcp\n/)
})

test('uninstall leaves a command that is not ours alone, and says what keeps running', async () => {
	const box = await install('theirs')
	await rm(join(box.home, '.local/bin/omarchy-server'))
	await write(join(box.home, 'elsewhere/omarchy-server'), '#!/bin/sh\n')
	await symlink(join(box.home, 'elsewhere/omarchy-server'), join(box.home, '.local/bin/omarchy-server'))
	const r = spawnSync('bash', [join(box.base, 'app/bin/omarchy-server'), 'uninstall', '-y'], {
		env: {HOME: box.home, PATH: withNode(box.bin), FAKE_LOG: box.log, FAKE_APPS: 'omarchy-nextcloud someone-elses', FAKE_VMS: 'omarchy-3\nother-vm\n'},
		encoding: 'utf8',
		detached: true,
	})
	assert.equal(r.status, 0, r.stderr)
	assert.equal(await exists(join(box.home, '.local/bin/omarchy-server')), true, 'a link that points somewhere else stays')
	assert.match(r.stdout, /keep running[\s\S]*app: nextcloud\nmachine: 3\n/)
	assert.ok(!r.stdout.includes('other-vm') && !r.stdout.includes('someone'), 'only Omarchy Server’s own apps and machines are listed')
})

test('--purge refuses while apps or machines still exist, and changes nothing', async () => {
	const box = await install('refuse')
	const r = run(box, ['--purge', '-y'], {FAKE_APPS: 'omarchy-immich omarchy-immich', FAKE_VMS: 'omarchy-7\n'})
	assert.equal(r.status, 1)
	assert.match(r.out, /app: immich\nmachine: 7\n/)
	assert.match(r.out, /Nothing was changed/)
	assert.equal(await exists(join(box.base, 'app/bin/omarchy-server')), true)
	assert.equal(await exists(join(box.units, 'omarchyd.service')), true)
	assert.equal(await exists(join(box.base, 'omarchyd/accounts.json')), true)
	assert.equal(await calls(box), '', 'no command ran, not even sudo')
})

test('--purge will not guess when podman or libvirt cannot answer, and changes nothing', async () => {
	for (const broken of [{FAKE_PODMAN_FAILS: '1'}, {FAKE_VIRSH_FAILS: '1'}]) {
		const box = await install(`cannotask${Object.keys(broken)[0]}`)
		const r = run(box, ['--purge', '-y'], broken)
		assert.equal(r.status, 1, r.out)
		assert.match(r.out, /Couldn't ask podman and libvirt/)
		assert.equal(await exists(join(box.base, 'omarchyd/accounts.json')), true)
		assert.equal(await calls(box), '', 'no command ran, not even sudo')
	}
})

test('--purge will not run when node is missing from the PATH, because it could not see the apps', async () => {
	const box = await install('nonode')
	const r = run(box, ['--purge', '-y'], {FAKE_APPS: 'omarchy-demo', PATH: `${box.bin}:${core}`})
	assert.equal(r.status, 1, r.out)
	assert.match(r.out, /Couldn't ask podman and libvirt[\s\S]*node/)
	assert.ok(!r.out.includes('are gone'), 'it must not go ahead')
	assert.equal(await exists(join(box.base, 'omarchyd/accounts.json')), true)
	assert.equal(await exists(join(box.base, 'omarchyd/apps/installed/demo/data/notes.txt')), true)
	assert.equal(await calls(box), '', 'no command ran, not even sudo')
})

test('when sudo cannot run, the user-level parts are still removed and the rest is listed to run by hand', async () => {
	const box = await install('nosudo')
	const r = run(box, ['-y'], {FAKE_SUDO_FAILS: '1'})
	assert.equal(r.status, 1, r.out)
	assert.match(r.out, /steps that need sudo could not be done here[\s\S]*sudo rm -f \/etc\/sudoers\.d\/omarchy-server[\s\S]*sudo rm -rf \/usr\/local\/libexec\/omarchy-server[\s\S]*sudo ufw delete allow 7780\/tcp/)
	assert.ok(!r.out.includes('Removing the storage helper'), 'it does not claim to be doing a step it cannot do')
	await programGone(box)
	assert.equal(await exists(join(box.base, 'omarchyd/accounts.json')), true, 'data is kept')
	assert.ok(!(await calls(box)).includes('sudo '), 'sudo was never run')
})

test('--purge deletes everything Omarchy Server keeps, but never your files', async () => {
	const box = await install('purge')
	const r = run(box, ['--purge', '-y'])
	assert.equal(r.status, 0, r.out)
	assert.match(r.out, /My Own Data Center and its data are gone/)
	assert.equal(await exists(join(box.base, 'omarchyd/accounts.json')), false)
	assert.equal(await exists(join(box.base, 'omarchyd/apps/installed/demo/data/notes.txt')), false)
	assert.equal((await readdir(join(box.home, '.local/share'))).includes('omarchy-server'), false, 'the whole data folder is gone')
	await programGone(box)
	await filesKept(box)
	assert.match(await calls(box), new RegExp(`podman unshare rm -rf ${box.base}/omarchyd/apps\\n`), 'app folders are removed through podman')
})

test('without a terminal and without -y it asks nothing and does nothing', async () => {
	const box = await install('noask')
	const r = run(box, [])
	assert.equal(r.status, 1)
	assert.match(r.out, /no terminal to ask in/i)
	assert.equal(await exists(join(box.base, 'app/bin/omarchy-server')), true)
	assert.equal(await calls(box), '')
})

test('#551: root cleanup is issued even when stopping the user service would kill the script', async () => {
	const box = await install('killed-by-stop')
	await writeFile(
		join(box.bin, 'systemctl'),
		`#!/bin/sh
echo "systemctl $*" >>"$FAKE_LOG"
case " $* " in
  *" disable --now "*omarchyd.service*)
    kill -TERM "$PPID" 2>/dev/null || true
    ;;
esac
exit 0
`,
	)
	const r = run(box, ['-y'])
	const c = await calls(box)
	const stopAt = c.search(/systemctl --user disable --now omarchyd\.service/)
	assert.ok(stopAt >= 0, `stop was not recorded\n${c}\n${r.out}`)
	const before = c.slice(0, stopAt)
	assert.match(before, /sudo rm -f \/etc\/sudoers\.d\/omarchy-server/, 'sudoers removed before the service stop')
	assert.match(before, /sudo rm -rf \/usr\/local\/libexec\/omarchy-server/)
	assert.match(before, /sudo ufw delete allow 7780\/tcp/)
	assert.match(before, /sudo rm -f \/etc\/udev\/rules\.d\/69-omarchy-server-sleep\.rules/)
	assert.match(before, /sudo rm -f \/etc\/sysctl\.d\/60-omarchy-server-ports\.conf/)
	assert.equal(await exists(join(box.base, 'app/bin/omarchy-server')), false, 'the program is removed before the stop')
	assert.equal(await exists(join(box.units, 'omarchyd.service')), false, 'the unit file is removed before the stop')
	assert.equal(await exists(join(box.home, '.local/bin/omarchy-server')), false)
})

test('#758: when the low-ports sysctl file existed, uninstall restores the kernel default', async () => {
	const box = await install('sysctl-was')
	const conf = join(root, '60-omarchy-server-ports.conf')
	await write(conf, 'net.ipv4.ip_unprivileged_port_start = 53\n')
	const r = run(box, ['-y'], {OMARCHY_SERVER_PORTS_CONF: conf})
	assert.equal(r.status, 0, r.out)
	const c = await calls(box)
	const rmAt = c.indexOf(`sudo rm -f ${conf}`)
	const wAt = c.indexOf('sudo sysctl -w net.ipv4.ip_unprivileged_port_start=1024')
	assert.ok(rmAt >= 0, c)
	assert.ok(wAt > rmAt, c)

	const absent = await install('sysctl-absent')
	const missing = join(root, 'no-such-ports.conf')
	const r2 = run(absent, ['-y'], {OMARCHY_SERVER_PORTS_CONF: missing})
	assert.equal(r2.status, 0, r2.out)
	assert.doesNotMatch(await calls(absent), /ip_unprivileged_port_start=1024/)
})

test('#758: the manual sudo list restores the unprivileged port start', async () => {
	const box = await install('sysctl-manual')
	const r = run(box, ['-y'], {FAKE_SUDO_FAILS: '1'})
	assert.equal(r.status, 1, r.out)
	assert.match(r.out, /sudo sysctl -w net\.ipv4\.ip_unprivileged_port_start=1024/)
})

test('#757: smb.service is stopped only when smb.conf is managed by Omarchy Server', async () => {
	const managed = await install('smb-managed')
	const managedConf = join(root, 'smb-managed.conf')
	await write(managedConf, '# Managed by Omarchy Server\n[global]\n')
	const r1 = run(managed, ['-y'], {OMARCHY_SERVER_SMB_CONF: managedConf})
	assert.equal(r1.status, 0, r1.out)
	assert.match(await calls(managed), /sudo systemctl disable --now smb\.service/)
	assert.doesNotMatch(r1.out, /Samba was not touched/)

	const own = await install('smb-own')
	const ownConf = join(root, 'smb-own.conf')
	await write(ownConf, '# a file the owner keeps\n[global]\n   workgroup = HOME\n')
	const r2 = run(own, ['-y'], {OMARCHY_SERVER_SMB_CONF: ownConf})
	assert.equal(r2.status, 0, r2.out)
	assert.doesNotMatch(await calls(own), /disable --now smb\.service/)
	assert.match(r2.out, /Samba was not touched/)

	const none = await install('smb-none')
	const missing = join(root, 'smb-missing.conf')
	const r3 = run(none, ['-y'], {OMARCHY_SERVER_SMB_CONF: missing})
	assert.equal(r3.status, 0, r3.out)
	assert.doesNotMatch(await calls(none), /disable --now smb\.service/)
	assert.match(r3.out, /Samba was not touched/)
})

test('#757: the manual sudo list disables Samba only for the managed smb.conf', async () => {
	const managed = await install('smb-manual-managed')
	const managedConf = join(root, 'smb-manual-managed.conf')
	await write(managedConf, '# Managed by Omarchy Server\n')
	const listed = run(managed, ['-y'], {FAKE_SUDO_FAILS: '1', OMARCHY_SERVER_SMB_CONF: managedConf})
	assert.equal(listed.status, 1, listed.out)
	assert.match(listed.out, /sudo systemctl disable --now smb\.service/)

	const own = await install('smb-manual-own')
	const ownConf = join(root, 'smb-manual-own.conf')
	await write(ownConf, '# owner\n')
	const left = run(own, ['-y'], {FAKE_SUDO_FAILS: '1', OMARCHY_SERVER_SMB_CONF: ownConf})
	assert.equal(left.status, 1, left.out)
	assert.match(left.out, /Samba was not touched/)
	assert.doesNotMatch(left.out, /disable --now smb\.service/)
})

test('an unknown option is refused, and help lists the command', async () => {
	const box = await install('usage')
	const r = run(box, ['--everything'])
	assert.equal(r.status, 2)
	assert.match(r.out, /Use: omarchy-server uninstall \[--purge\] \[-y\]/)
	assert.equal(await exists(join(box.base, 'app/bin/omarchy-server')), true)
	const help = spawnSync('bash', [SCRIPT, 'help'], {encoding: 'utf8'})
	assert.match(help.stdout, /omarchy-server uninstall/)
})
