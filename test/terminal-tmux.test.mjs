// With tmux installed, your shell outlives omarchyd: a restart or an update, then the same shell.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {TMUX_CONF, createTerminalSessions, createTmux} from '../omarchyd/terminal.mjs'

let hasTmux = true
try {
	execFileSync('tmux', ['-V'], {stdio: 'ignore'})
} catch {
	hasTmux = false
}

const fake = () => {
	const ws = Object.assign(new EventEmitter(), {OPEN: 1, readyState: 1, out: '', send(m) {
		if (typeof m !== 'string') this.out += Buffer.from(m).toString()
	}, close() {
		this.readyState = 3
		this.emit('close')
	}})
	return ws
}
const until = async (fn, ms = 8000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return
	throw new Error('timed out')
}

test('the settings keep the terminal’s own scrollback and hide the status bar', () => {
	assert.match(TMUX_CONF, /set -g status off/)
	assert.match(TMUX_CONF, /smcup@:rmcup@/)
})

test('your shell is the same after omarchyd restarts', {skip: !hasTmux && 'tmux isn’t installed'}, async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-tmux-'))
	const socket = `omarchy-test-${process.pid}`
	const tmux = createTmux({conf: join(root, 'tmux.conf'), socket})
	const shell = {home: root, cwd: root, env: {...process.env, SHELL: '/bin/bash'}}
	try {
		const first = createTerminalSessions({tmux})
		const a = fake()
		assert.equal((await first.attach(a, {userId: 'owner', cols: 80, rows: 24, shell})).resumed, false)
		await new Promise((r) => setTimeout(r, 400))
		a.emit('message', 'export KEPT=still-$((20+3)); echo set-$KEPT\r', false)
		await until(() => a.out.includes('set-still-23'))
		assert.match(await readFile(join(root, 'tmux.conf'), 'utf8'), /status off/)
		// omarchyd stops (restart, update): its sessions go, the tmux session stays.
		first.close()
		await new Promise((r) => setTimeout(r, 400))

		const second = createTerminalSessions({tmux})
		const b = fake()
		assert.equal((await second.attach(b, {userId: 'owner', cols: 80, rows: 24, shell})).resumed, true)
		await new Promise((r) => setTimeout(r, 400))
		b.emit('message', 'echo got-$KEPT\r', false)
		await until(() => b.out.includes('got-still-23'))

		// New session: a fresh shell, without what the old one had.
		const c = fake()
		assert.equal((await second.attach(c, {userId: 'owner', cols: 80, rows: 24, fresh: true, shell})).resumed, false)
		await new Promise((r) => setTimeout(r, 400))
		c.emit('message', 'echo fresh-[$KEPT]\r', false)
		await until(() => c.out.includes('fresh-[]'))
		second.close()

		// An app's shell never uses tmux.
		const third = createTerminalSessions({tmux})
		const d = fake()
		await third.attach(d, {userId: 'owner', appId: 'immich', cols: 80, rows: 24, shell: {...shell, command: ['/bin/sh']}})
		third.close()
	} finally {
		try {
			execFileSync('tmux', ['-L', socket, 'kill-server'], {stdio: 'ignore'})
		} catch {
			// already gone
		}
		await rm(root, {recursive: true, force: true})
	}
})
