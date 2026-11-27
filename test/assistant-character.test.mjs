// The assistant's character: which state it shows for what the assistant is doing, and the registry
// contributors add characters to. (The drawings themselves are checked in a browser.)
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {characterState, SLEEP_MS, SUCCESS_MS} from '../web/src/assistantActivity.ts'

const base = {phase: 'idle', pending: 0, composing: false, successAt: 0, activeAt: 1_000_000, open: true}
const at = (patch, opts = {}) => characterState({...base, ...patch}, {now: 1_000_000, ...opts})

test('the character shows what the assistant is actually doing, most important first', () => {
	assert.equal(at({}), 'idle')
	assert.equal(at({}, {hover: true}), 'hover')
	assert.equal(at({composing: true}), 'listening')
	assert.equal(at({phase: 'thinking'}), 'thinking')
	assert.equal(at({phase: 'responding'}), 'responding')
	assert.equal(at({phase: 'working'}), 'working')
	assert.equal(at({phase: 'error'}), 'error')
	// A problem outranks everything; work in progress outranks typing or hovering.
	assert.equal(at({phase: 'error', composing: true, successAt: 1_000_000}), 'error')
	assert.equal(at({phase: 'working', composing: true}, {hover: true}), 'working')
})

test('“done” only for a moment after a confirmed step; sleeping only after a long quiet spell', () => {
	assert.equal(at({successAt: 1_000_000 - 100}), 'success')
	assert.equal(at({successAt: 1_000_000 - SUCCESS_MS - 1}), 'idle')
	assert.equal(at({successAt: 0}), 'idle', 'never assumed')
	const quiet = {open: false, activeAt: 1_000_000 - SLEEP_MS - 1}
	assert.equal(at(quiet), 'sleeping')
	assert.equal(at({...quiet, open: true}), 'idle', 'not while the assistant is open')
	assert.equal(at({...quiet, pending: 1}), 'idle', 'not with a step waiting for you')
	assert.equal(at({...quiet}, {hover: true}), 'hover')
})

test('reactions off: the character stays idle (and still says hello on hover)', () => {
	assert.equal(at({phase: 'working'}, {reactions: false}), 'idle')
	assert.equal(at({phase: 'error'}, {reactions: false, hover: true}), 'hover')
})

test('the registry: six characters from the sheet, Oma first and the default, each with all nine frames', async () => {
	const src = await readFile(new URL('../web/src/character/registry.tsx', import.meta.url), 'utf8')
	const ids = [...src.matchAll(/^\t\tid: '([a-z0-9-]+)',$/gm)].map((m) => m[1])
	assert.deepEqual(ids, ['oma', 'patch', 'pixel', 'stack', 'pulse', 'orbit'])
	assert.match(src, /export const DEFAULT_CHARACTER = 'oma'/)
	const names = [...src.matchAll(/^\t\tname: '([^']+)',$/gm)].map((m) => m[1])
	assert.deepEqual(names, ['Oma', 'Patch', 'Pixel', 'Stack', 'Pulse', 'Orbit'])
	for (const field of ['tagline', 'description', 'accent', 'states', 'frame']) {
		assert.equal([...src.matchAll(new RegExp(`^\\t\\t${field}: `, 'gm'))].length, ids.length, `every character has ${field}`)
	}
	// Bundled frames only: every state of every character is in web/public/assistant, nothing remote.
	for (const id of ids) {
		for (const state of ['idle', 'hover', 'listening', 'thinking', 'responding', 'working', 'success', 'error', 'sleeping']) {
			const file = new URL(`../web/public/assistant/${id}/${state}.webp`, import.meta.url)
			const head = (await readFile(file)).subarray(0, 12).toString('latin1')
			assert.ok(head.startsWith('RIFF') && head.endsWith('WEBP'), `${id}/${state}.webp is a WebP`)
		}
	}
	assert.doesNotMatch(src, /https?:\/\//)
	const comp = await readFile(new URL('../web/src/character/AssistantCharacter.tsx', import.meta.url), 'utf8')
	assert.doesNotMatch(comp, /https?:\/\/|fetch\(/)
})

test('the frames have no background: every one is a WebP with an alpha channel', async () => {
	for (const id of ['oma', 'patch', 'pixel', 'stack', 'pulse', 'orbit']) {
		const b = await readFile(new URL(`../web/public/assistant/${id}/idle.webp`, import.meta.url))
		// VP8X (extended) with the alpha flag set, or VP8L (lossless, alpha in the bitstream)
		const chunk = b.subarray(12, 16).toString('latin1')
		assert.ok(chunk === 'VP8X' ? (b[20] & 0x10) !== 0 : chunk === 'VP8L', `${id}: transparent`)
	}
})
