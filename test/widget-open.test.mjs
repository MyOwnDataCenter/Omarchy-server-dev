// Waybar widget edits and `omarchy-server open` when a browser cannot be shown.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'omarchy-server')
const root = await mkdtemp(join(os.tmpdir(), 'omarchy-widget-open-'))
after(() => rm(root, {recursive: true, force: true}))

const toolPath = (name) => {
	const found = spawnSync('bash', ['-lc', `command -v ${name}`], {encoding: 'utf8'}).stdout.trim()
	if (!found) throw new Error(`required tool not on PATH: ${name}`)
	return found
}

async function sandbox(name) {
	const home = join(root, name)
	const bin = join(root, `${name}-bin`)
	const log = join(root, `${name}.log`)
	await mkdir(bin, {recursive: true})
	await mkdir(home, {recursive: true})
	for (const cmd of ['awk', 'sed', 'grep', 'cp', 'head', 'node']) {
		await symlink(toolPath(cmd), join(bin, cmd))
	}
	await writeFile(join(bin, 'pkill'), '#!/bin/sh\necho "pkill $*" >>"$FAKE_LOG"\nexit 0\n')
	await chmod(join(bin, 'pkill'), 0o755)
	return {home, bin, log}
}

function run(box, args, extraEnv = {}) {
	const result = spawnSync('/usr/bin/bash', [SCRIPT, ...args], {
		env: {
			HOME: box.home,
			PATH: box.bin,
			FAKE_LOG: box.log,
			OMARCHY_PATH: join(box.home, 'no-omarchy'),
			...extraEnv,
		},
		encoding: 'utf8',
		timeout: 15_000,
	})
	return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
}

const readLog = (box) => readFile(box.log, 'utf8').catch(() => '')

// JSONC as Waybar accepts it: // comments, which JSON.parse does not.
function parseJsonc(text) {
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => {
			let out = ''
			let inString = false
			let escaped = false
			for (let i = 0; i < line.length; i++) {
				const ch = line[i]
				if (inString) {
					out += ch
					if (escaped) escaped = false
					else if (ch === '\\') escaped = true
					else if (ch === '"') inString = false
					continue
				}
				if (ch === '"') {
					inString = true
					out += ch
					continue
				}
				if (ch === '/' && line[i + 1] === '/') break
				out += ch
			}
			return out
		})
		.join('\n')
	return JSON.parse(stripped)
}

const ONE_LINE_RIGHT = `{
  "layer": "top",
  "modules-left": ["workspaces"],
  "modules-right": ["tray", "clock"],
  "clock": {"format": "{:%H:%M}"}
}
`

const MULTI_LINE_RIGHT = `{
  "layer": "top",
  "modules-left": ["workspaces"],
  "modules-right": [
    "tray",
    "clock"
  ],
  "clock": {"format": "{:%H:%M}"}
}
`

async function writeWaybar(box, text) {
	const dir = join(box.home, '.config', 'waybar')
	await mkdir(dir, {recursive: true})
	const file = join(dir, 'config.jsonc')
	await writeFile(file, text)
	return file
}

async function installOpenStubs(box, {running = true, xdg = 'ok', ip = 'route'} = {}) {
	const active = running ? 'exit 0' : 'exit 3'
	await writeFile(
		join(box.bin, 'systemctl'),
		`#!/bin/sh
echo "systemctl $*" >>"$FAKE_LOG"
case "$*" in
  *is-active*) ${active} ;;
esac
exit 0
`,
	)
	await chmod(join(box.bin, 'systemctl'), 0o755)
	const ipBody = ip === 'addr'
		? `case "$*" in
  "-4 route get 1.1.1.1") exit 0 ;;
  "-4 -o addr show scope global")
    echo "2: eth0    inet 198.51.100.8/24 brd 198.51.100.255 scope global eth0"
    echo "3: eth1    inet 203.0.113.9/24 brd 203.0.113.255 scope global eth1"
    ;;
esac
`
		: ip === 'none'
			? 'exit 0\n'
			: 'echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10"\n'
	await writeFile(join(box.bin, 'ip'), `#!/bin/sh\n${ipBody}`)
	await chmod(join(box.bin, 'ip'), 0o755)
	if (xdg === 'missing') return
	const exitCode = xdg === 'fail' ? 1 : 0
	await writeFile(
		join(box.bin, 'xdg-open'),
		`#!/bin/sh
echo "xdg-open $*" >>"$FAKE_LOG"
exit ${exitCode}
`,
	)
	await chmod(join(box.bin, 'xdg-open'), 0o755)
}

test('#608: widget on and off keep a one-line modules-right list valid', async () => {
	const box = await sandbox('waybar-one-line')
	const file = await writeWaybar(box, ONE_LINE_RIGHT)
	const on = run(box, ['widget', 'on'])
	assert.equal(on.status, 0, on.stdout + on.stderr)
	assert.match(on.stdout, /Added the MODC icon/)
	const added = parseJsonc(await readFile(file, 'utf8'))
	assert.deepEqual(added['modules-left'], ['workspaces'])
	assert.deepEqual(added['modules-right'], ['custom/omarchy-server', 'tray', 'clock'])
	assert.equal(added.clock.format, '{:%H:%M}')
	assert.equal(added['custom/omarchy-server']['return-type'], 'json')

	const off = run(box, ['widget', 'off'])
	assert.equal(off.status, 0, off.stdout + off.stderr)
	assert.match(off.stdout, /Removed the MODC icon/)
	const removed = parseJsonc(await readFile(file, 'utf8'))
	assert.deepEqual(removed['modules-left'], ['workspaces'])
	assert.deepEqual(removed['modules-right'], ['tray', 'clock'])
	assert.equal(removed.clock.format, '{:%H:%M}')
	assert.equal(removed['custom/omarchy-server'], undefined)
	assert.doesNotMatch(await readFile(file, 'utf8'), /omarchy-server widget/)
})

test('#608: widget on and off keep a multi-line modules-right list valid', async () => {
	const box = await sandbox('waybar-multi-line')
	const file = await writeWaybar(box, MULTI_LINE_RIGHT)
	const on = run(box, ['widget', 'on'])
	assert.equal(on.status, 0, on.stdout + on.stderr)
	const added = parseJsonc(await readFile(file, 'utf8'))
	assert.deepEqual(added['modules-right'], ['custom/omarchy-server', 'tray', 'clock'])
	assert.equal(added['modules-left'][0], 'workspaces')

	const off = run(box, ['widget', 'off'])
	assert.equal(off.status, 0, off.stdout + off.stderr)
	const removed = parseJsonc(await readFile(file, 'utf8'))
	assert.deepEqual(removed['modules-right'], ['tray', 'clock'])
	assert.equal(removed['custom/omarchy-server'], undefined)
	assert.equal(removed.clock.format, '{:%H:%M}')
})

test('#262: widget sideways exits 2 before shell.json or Waybar, and bare widget means on', async () => {
	const shellBox = await sandbox('widget-sideways-shell')
	const shellDir = join(shellBox.home, '.config', 'omarchy')
	await mkdir(shellDir, {recursive: true})
	const shellJson = join(shellDir, 'shell.json')
	const original = '{"bar":{"layout":{"right":["clock"]}}}\n'
	await writeFile(shellJson, original)
	const sideways = run(shellBox, ['widget', 'sideways'])
	assert.equal(sideways.status, 2, sideways.stdout + sideways.stderr)
	assert.match(sideways.stderr, /Use: omarchy-server widget on\|off/)
	assert.doesNotMatch(sideways.stdout + sideways.stderr, /Couldn't update the top bar/)
	assert.doesNotMatch(sideways.stdout + sideways.stderr, /No Omarchy top bar settings found/)
	assert.equal(await readFile(shellJson, 'utf8'), original)

	const waybarBox = await sandbox('widget-sideways-waybar')
	const waybar = await writeWaybar(waybarBox, ONE_LINE_RIGHT)
	const noConfig = run(waybarBox, ['widget', 'sideways'])
	assert.equal(noConfig.status, 2, noConfig.stdout + noConfig.stderr)
	assert.match(noConfig.stderr, /Use: omarchy-server widget on\|off/)
	assert.doesNotMatch(noConfig.stdout + noConfig.stderr, /No Omarchy top bar settings found/)
	assert.doesNotMatch(noConfig.stdout + noConfig.stderr, /Couldn't update the top bar/)
	assert.equal(await readFile(waybar, 'utf8'), ONE_LINE_RIGHT)

	const bare = await sandbox('widget-bare')
	const bareFile = await writeWaybar(bare, ONE_LINE_RIGHT)
	const on = run(bare, ['widget'])
	assert.equal(on.status, 0, on.stdout + on.stderr)
	assert.match(on.stdout, /Added the MODC icon/)
	const added = parseJsonc(await readFile(bareFile, 'utf8'))
	assert.deepEqual(added['modules-right'], ['custom/omarchy-server', 'tray', 'clock'])
})

test('#615: open prints the address when xdg-open is missing, fails, or has no display', async () => {
	const address = /Open http:\/\/192\.0\.2\.10:7780 \(or http:\/\/localhost:7780 on this machine\)/

	const missing = await sandbox('open-missing')
	await installOpenStubs(missing, {running: true, xdg: 'missing'})
	const missingRun = run(missing, ['open'])
	assert.equal(missingRun.status, 1, missingRun.stdout + missingRun.stderr)
	assert.match(missingRun.stdout, address)
	assert.doesNotMatch(missingRun.stdout, /Added|Opened|Running at/)
	assert.doesNotMatch(await readLog(missing), /xdg-open/, 'xdg-open must not be launched when it is not installed')

	const failed = await sandbox('open-fail')
	await installOpenStubs(failed, {running: true, xdg: 'fail'})
	const failedRun = run(failed, ['open'], {DISPLAY: ':1'})
	assert.equal(failedRun.status, 1, failedRun.stdout + failedRun.stderr)
	assert.match(failedRun.stdout, address)
	assert.match(await readLog(failed), /xdg-open http:\/\/localhost:7780/)
	assert.notEqual(`${failedRun.stdout}${failedRun.stderr}`.trim(), '')

	const headless = await sandbox('open-headless')
	await installOpenStubs(headless, {running: true, xdg: 'ok'})
	const headlessRun = run(headless, ['open'])
	assert.equal(headlessRun.status, 1, headlessRun.stdout + headlessRun.stderr)
	assert.match(headlessRun.stdout, address)
	assert.doesNotMatch(await readLog(headless), /xdg-open/)

	const wayland = await sandbox('open-wayland')
	await installOpenStubs(wayland, {running: true, xdg: 'ok'})
	const waylandRun = run(wayland, ['open'], {WAYLAND_DISPLAY: 'wayland-1'})
	assert.equal(waylandRun.status, 0, waylandRun.stdout + waylandRun.stderr)
	assert.equal(waylandRun.stdout, '')
	assert.match(await readLog(wayland), /xdg-open http:\/\/localhost:7780/)

	const down = await sandbox('open-down')
	await installOpenStubs(down, {running: false, xdg: 'ok'})
	const downRun = run(down, ['open'], {DISPLAY: ':1'})
	assert.match(downRun.stdout, /not running/)
	assert.match(downRun.stdout, address)
	assert.match(await readLog(down), /xdg-open http:\/\/localhost:7780/)

	const downHeadless = await sandbox('open-down-headless')
	await installOpenStubs(downHeadless, {running: false, xdg: 'missing'})
	const downHeadlessRun = run(downHeadless, ['open'])
	assert.equal(downHeadlessRun.status, 1, downHeadlessRun.stdout + downHeadlessRun.stderr)
	assert.match(downHeadlessRun.stdout, /not running/)
	assert.match(downHeadlessRun.stdout, address)

	const custom = await sandbox('open-port')
	await installOpenStubs(custom, {running: true, xdg: 'missing'})
	const unitDir = join(custom.home, '.config', 'systemd', 'user')
	await mkdir(unitDir, {recursive: true})
	await writeFile(join(unitDir, 'omarchy-server-web.service'), 'ExecStart=/usr/bin/node server/cli.mjs --port 7791\n')
	const customRun = run(custom, ['open'])
	assert.equal(customRun.status, 1, customRun.stdout + customRun.stderr)
	assert.match(customRun.stdout, /Open http:\/\/192\.0\.2\.10:7791 \(or http:\/\/localhost:7791 on this machine\)/)
})

test('address falls back to the first global IPv4, and is left out when there is none', async () => {
	const fallback = await sandbox('open-fallback')
	await installOpenStubs(fallback, {running: true, xdg: 'missing', ip: 'addr'})
	const open = run(fallback, ['open'])
	assert.equal(open.status, 1, open.stdout + open.stderr)
	assert.match(open.stdout, /Open http:\/\/198\.51\.100\.8:7780 \(or http:\/\/localhost:7780 on this machine\)/)
	assert.doesNotMatch(open.stdout, /203\.0\.113\.9/)

	const status = run(fallback, ['status'])
	assert.match(status.stdout, /Open http:\/\/198\.51\.100\.8:7780 \(or http:\/\/localhost:7780 on this machine\)/)

	const bar = run(fallback, ['waybar'])
	assert.equal(bar.status, 0, bar.stdout + bar.stderr)
	const tip = JSON.parse(bar.stdout)
	assert.match(tip.tooltip, /http:\/\/198\.51\.100\.8:7780/)
	assert.doesNotMatch(tip.tooltip, /203\.0\.113\.9/)

	const started = run(fallback, ['start'])
	assert.equal(started.status, 0, started.stdout + started.stderr)
	assert.match(started.stdout, /Running at http:\/\/198\.51\.100\.8:7780/)

	const none = await sandbox('open-no-addr')
	await installOpenStubs(none, {running: true, xdg: 'missing', ip: 'none'})
	for (const args of [['open'], ['status'], ['waybar'], ['start']]) {
		const result = run(none, args)
		const text = `${result.stdout}${result.stderr}`
		assert.doesNotMatch(text, /http:\/\/:/, args.join(' '))
		assert.doesNotMatch(text, /http:\/\/:7780/, args.join(' '))
	}
	const opened = run(none, ['open'])
	assert.match(opened.stdout, /Open http:\/\/localhost:7780 on this machine/)
	const waybar = JSON.parse(run(none, ['waybar']).stdout)
	assert.equal(waybar.class, 'running')
	assert.doesNotMatch(waybar.tooltip, /http:\/\//)
	assert.match(run(none, ['start']).stdout, /^Running$/m)
})
