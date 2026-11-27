// A tab that closes while a resumed shell is being resized must not stay counted as attached.
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {test} from 'node:test'

import {createTerminalSessions} from '../omarchyd/terminal.mjs'

const fake = () => Object.assign(new EventEmitter(), {OPEN: 1, readyState: 1, sent: [], send(m) {this.sent.push(m)}, close() {this.readyState = 3}})

test('a socket that closes during the resume await is not left attached', async () => {
	const sessions = createTerminalSessions()
	const shell = {command: ['sleep', '30'], cwd: '/tmp', home: '/tmp'}
	try {
		const first = fake()
		assert.equal((await sessions.attach(first, {userId: 'owner', cols: 80, rows: 24, shell})).resumed, false)
		const second = fake()
		const pending = sessions.attach(second, {userId: 'owner', cols: 100, rows: 30, shell})
		// Close while attach is still inside the resume resize await, before it returns.
		second.readyState = 3
		second.emit('close')
		assert.equal((await pending).resumed, true)
		const mine = sessions.list().find((s) => s.key === 'owner:')
		assert.equal(mine.attached, 1, 'the closed tab is not left in the session')
		assert.equal(first.listenerCount('close'), 1)
		assert.equal(second.listenerCount('close'), 1)
		assert.equal(second.listenerCount('error'), 1)
	} finally {
		sessions.close()
	}
})
