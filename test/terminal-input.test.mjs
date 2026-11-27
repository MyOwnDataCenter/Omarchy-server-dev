import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {forwardTerminalInput, ignoreOpeningFocus} from '../web/src/terminalInput.ts'

test('replayed focus reports are not typed into the shell', () => {
	assert.equal(forwardTerminalInput('\x1b[I', false), false)
	assert.equal(forwardTerminalInput('\x1b[O', false), false)
	assert.equal(forwardTerminalInput('\x1b[I', true), true)
	assert.equal(forwardTerminalInput('\x1b[O', true), true)
	assert.equal(forwardTerminalInput('a', false), true)
	assert.equal(forwardTerminalInput('\x1b[A', false), true)
})

test('the tap that opens the terminal is ignored on a phone', () => {
	assert.equal(ignoreOpeningFocus(true, 0), true)
	assert.equal(ignoreOpeningFocus(true, 499), true)
	assert.equal(ignoreOpeningFocus(true, 500), false)
	assert.equal(ignoreOpeningFocus(false, 0), false)
})

test('the terminal screen wires both guards in', async () => {
	const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	assert.match(src, /forwardTerminalInput\(data, focusReportFromUser\)/)
	assert.match(src, /ignoreOpeningFocus\(coarsePointer\(\), performance\.now\(\) - openedAt\.current\)/)
	assert.match(src, /addEventListener\('focus', markFocusReport, true\)/)
	assert.match(src, /addEventListener\('blur', markFocusReport, true\)/)
	assert.doesNotMatch(src, /term\.focus\(\) \/\/ types straight away/)
})
