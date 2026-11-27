// A keystroke in the moment a shell exits must not kill omarchyd. `script` closes its
// stdout while the stdin pipe is still marked writable; a write then raises EPIPE, and
// with no listener that error takes down the process.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {test} from 'node:test'

import {createTerminalSessions} from '../omarchyd/terminal.mjs'

const hasScript = spawnSync('sh', ['-c', 'command -v script'], {encoding: 'utf8'}).status === 0

test('a keystroke as the shell exits is dropped and the process stays up', {skip: hasScript ? false : 'script is not installed'}, async () => {
	const sessions = createTerminalSessions()
	const ws = Object.assign(new EventEmitter(), {
		OPEN: 1,
		readyState: 1,
		sent: [],
		send(m) {this.sent.push(m)},
		close(code, reason) {
			this.readyState = 3
			this.closeCode = code
			this.closeReason = String(reason)
			this.emit('close')
		},
	})
	// stdout is subscribed first, and it closes while stdin is still writable. A keystroke
	// queued on that close is the gap that used to raise an unhandled EPIPE.
	const origOn = EventEmitter.prototype.on
	let stdout = null
	let struck = false
	EventEmitter.prototype.on = function (event, fn) {
		const ret = origOn.call(this, event, fn)
		if (event === 'data' && stdout === null && this?.constructor?.name === 'Socket') {
			stdout = this
			origOn.call(this, 'close', () => {
				struck = true
				ws.emit('message', 'q', false)
			})
		}
		return ret
	}
	let attached
	try {
		attached = sessions.attach(ws, {userId: 'owner', cols: 80, rows: 24, shell: {command: ['true'], cwd: '/tmp', home: '/tmp'}})
	} finally {
		EventEmitter.prototype.on = origOn
	}
	try {
		await attached
		const ended = await Promise.race([
			new Promise((resolve) => ws.once('close', () => resolve(true))),
			new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
		])
		// The EPIPE follows the write on a later turn. Stay alive long enough for it to surface.
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(struck, true, 'the keystroke was sent as the shell output closed')
		assert.equal(ended, true, 'the shell exit still closes the terminal')
		assert.equal(ws.closeCode, 1000)
		assert.equal(ws.closeReason, 'Shell ended')
		assert.equal(sessions.list().length, 0)
	} finally {
		sessions.close()
	}
})
