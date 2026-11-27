// A server with no screen or keyboard: install.sh --headless (TPM disk unlock, BIOS reminder), the
// Settings status for it, and the virtual screen the desktop view shares when no monitor is attached.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {HEADLESS_SCREEN, createHyprland} from '../omarchyd/hyprland.mjs'

const INSTALL = fileURLToPath(new URL('../install.sh', import.meta.url))
const script = await readFile(INSTALL, 'utf8')

test('--headless is a listed installer option', () => {
	const r = spawnSync('bash', [INSTALL, '--help'], {encoding: 'utf8', timeout: 10_000})
	assert.equal(r.status, 0)
	assert.match(r.stdout, /--headless/)
})

test('--headless refuses to run from the app’s unattended update (it asks questions and the disk password)', () => {
	const r = spawnSync('bash', [INSTALL, '--headless'], {encoding: 'utf8', timeout: 10_000, env: {...process.env, OMARCHY_SERVER_FROM_APP: '1'}})
	assert.notEqual(r.status, 0)
	assert.match(r.stderr, /run it yourself in a terminal/)
})

test('the TPM step asks first, keeps the disk password, and only adds clevis right before encrypt', () => {
	const block = script.slice(script.indexOf('headless_disk() {'), script.indexOf('if [ "$HEADLESS" = 1 ]; then\n\tmkdir'))
	assert.match(block, /read -r -p "    Unlock the disk with the TPM at startup\? \[y\/N\] "/)
	assert.match(block, /pcr_ids":"7"/)
	assert.match(block, /--tpm2-pcrs=7/)
	// Never removes a key slot or the password.
	assert.doesNotMatch(block, /luksKillSlot|luksRemoveKey|--wipe-slot=password|unbind -d "\$luks"/)
	// sd-encrypt is checked before encrypt (grep -w would match both).
	assert.ok(block.indexOf("grep -qw 'sd-encrypt'") < block.indexOf("grep -qw 'encrypt'"))
	// A failed initramfs rebuild puts HOOKS back.
	assert.match(block, /modc-bak" "\$hooks_file"/)
	const sed = /sudo sed -i -E '([^']+)'/.exec(block)[1]
	const run = (line) => spawnSync('sed', ['-E', sed], {input: `${line}\n`, encoding: 'utf8'}).stdout.trim()
	assert.equal(
		run('HOOKS=(base udev plymouth keyboard autodetect microcode modconf kms keymap consolefont block encrypt filesystems fsck btrfs-overlayfs)'),
		'HOOKS=(base udev plymouth keyboard autodetect microcode modconf kms keymap consolefont block clevis encrypt filesystems fsck btrfs-overlayfs)',
	)
	assert.equal(run('HOOKS="base udev encrypt filesystems"'), 'HOOKS="base udev clevis encrypt filesystems"')
	assert.equal(run('HOOKS=(base systemd sd-encrypt filesystems)'), 'HOOKS=(base systemd sd-encrypt filesystems)')
	assert.equal(run('MODULES=(encrypt)'), 'MODULES=(encrypt)')
})

test('--headless reminds about the BIOS power-on setting and records the unlock for Settings', () => {
	assert.match(script, /Restore on AC power loss/)
	assert.match(script, /"\$BASE\/omarchyd\/disk-unlock"/)
})

async function hyprWith(monitors) {
	const dir = await mkdtemp(join(os.tmpdir(), 'hypr-headless-'))
	await writeFile(join(dir, 'wayland-1'), '')
	await mkdir(join(dir, 'hypr', 'sig1'), {recursive: true})
	await writeFile(join(dir, 'hypr', 'sig1', '.socket.sock'), '')
	const calls = []
	const hypr = createHyprland({
		dataDir: join(dir, 'data'),
		runtimeDir: dir,
		vaapiDevice: join(dir, 'none'),
		async exec(cmd, args) {
			if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: JSON.stringify(monitors), stderr: ''}
			calls.push(args.join(' '))
			return {ok: true, stdout: 'ok\n', stderr: ''}
		},
	})
	return {hypr, calls, done: () => (hypr.close(), rm(dir, {recursive: true, force: true}))}
}

test('no monitor: a 1920x1080 virtual screen is added for the desktop view', async () => {
	const t = await hyprWith([{id: 1, name: 'RAIL-1', width: 3840, height: 2160}])
	try {
		assert.equal(await t.hypr.ensureHeadlessScreen(), HEADLESS_SCREEN)
		assert.ok(t.calls.includes(`output create headless ${HEADLESS_SCREEN}`), t.calls.join('\n'))
		assert.ok(t.calls.some((c) => c.includes('1920x1080@60')))
	} finally {
		await t.done()
	}
})

test('a real monitor: the virtual screen is taken away, and none is added', async () => {
	const t = await hyprWith([
		{id: 0, name: 'HDMI-A-1', width: 1920, height: 1080},
		{id: 2, name: HEADLESS_SCREEN, width: 1920, height: 1080},
	])
	try {
		assert.equal(await t.hypr.ensureHeadlessScreen(), null)
		assert.ok(t.calls.includes(`output remove ${HEADLESS_SCREEN}`))
		assert.ok(!t.calls.some((c) => c.startsWith('output create')))
	} finally {
		await t.done()
	}
})

test('the virtual screen already there is kept, not added twice', async () => {
	const t = await hyprWith([{id: 2, name: HEADLESS_SCREEN, width: 1920, height: 1080}])
	try {
		assert.equal(await t.hypr.ensureHeadlessScreen(), HEADLESS_SCREEN)
		assert.ok(!t.calls.some((c) => c.startsWith('output')))
	} finally {
		await t.done()
	}
})

test('Settings gets the --headless command from the repository this copy updates from', async () => {
	const {openAccounts} = await import('../omarchyd/accounts.mjs')
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-headless-'))
	const accounts = await openAccounts(join(root, 'd'))
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const raw = 'https://raw.githubusercontent.com/MyOwnDataCenter/omarchy-server-dev'
	const d = await startOmarchyd({port: 0, dataDir: join(root, 'd'), home: root, machineOptions: {diskLock: {encrypted: true, unlocksItself: false, tpm: true}}, updaterOptions: {autoCheck: false, raw}})
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 's'}})})).json()
		const res = await (await fetch(`${d.url}/trpc/system.bootStart`, {headers: {authorization: `Bearer ${login.result.data.accessToken}`}})).json()
		assert.equal(res.result.data.headlessCommand, `curl -fsSL ${raw}/main/install.sh | bash -s -- --headless`)
		assert.equal(res.result.data.diskLock.tpm, true)
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
