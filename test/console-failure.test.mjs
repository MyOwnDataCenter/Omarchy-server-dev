// A screen that never comes up says why, instead of "Reconnecting…" forever.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {consoleFailureMessage} from '../web/src/consoleHelpers.ts'

test('the computer’s reason is shown, or a plain one when there is none', () => {
	assert.equal(consoleFailureMessage(' The screen sharing program (wayvnc) stopped straight away: x '), 'The screen sharing program (wayvnc) stopped straight away: x')
	assert.match(consoleFailureMessage(''), /didn’t come up/)
})

test('the viewer stops retrying when the screen never appeared, and keeps reconnecting once it has', async () => {
	const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
	assert.match(src, /if \(!shown && !everShown\)/)
	assert.match(src, /setMessage\(consoleFailureMessage\(closeReason\)\)/)
})

test('every wayvnc MODC starts has its own control socket', async () => {
	for (const file of ['../omarchyd/server.mjs', '../install.sh']) {
		const src = await readFile(new URL(file, import.meta.url), 'utf8')
		assert.match(src, /wayvnc --max-fps=30 -S %t\/omarchy-server\/wayvncctl --unix-socket/, file)
	}
	const server = await readFile(new URL('../omarchyd/server.mjs', import.meta.url), 'utf8')
	assert.match(server, /'\/usr\/bin\/wayvnc', '--max-fps=30', '-S'/)
	const agent = await readFile(new URL('../connector/agent.py', import.meta.url), 'utf8')
	assert.match(agent, /\["wayvnc", "--max-fps=30", "-S"/)
})
