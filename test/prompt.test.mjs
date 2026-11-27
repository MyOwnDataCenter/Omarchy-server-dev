// The terminal password prompt: typed one key at a time, or pasted with its Enter in one go.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {takeLine} from '../omarchyd/prompt.mjs'

test('a password pasted together with its Enter is taken without the Enter', () => {
	assert.deepEqual(takeLine('', 'correct horse\r'), {done: true, value: 'correct horse', rest: ''})
	assert.deepEqual(takeLine('', 'correct horse\r\n'), {done: true, value: 'correct horse', rest: ''})
})

test('two passwords pasted at once: the second is kept for the next question', () => {
	const a = takeLine('', 'pw one\rpw one\r')
	assert.deepEqual(a, {done: true, value: 'pw one', rest: 'pw one\r'})
	assert.deepEqual(takeLine('', a.rest), {done: true, value: 'pw one', rest: ''})
})

test('typed a key at a time, with backspace and Ctrl+C', () => {
	let r = {value: ''}
	for (const k of ['a', 'b', 'x', '\u007f', 'c']) r = takeLine(r.value, k)
	assert.deepEqual(r, {done: false, value: 'abc'})
	assert.deepEqual(takeLine(r.value, '\r'), {done: true, value: 'abc', rest: ''})
	assert.deepEqual(takeLine('abc', '\u0003'), {interrupted: true})
	assert.deepEqual(takeLine('', 'pässwörd\r').value, 'pässwörd')
	assert.equal(takeLine('', 'a\u001bb\r').value, 'ab', 'other control characters are ignored')
})

test('arrow and Delete keys are not written into the password', () => {
	let r = {value: ''}
	for (const k of ['a', 'b', 'c', '\x1b[D', '\x1b[3~', '\r']) r = takeLine(r.value, k)
	assert.deepEqual(r, {done: true, value: 'abc', rest: ''})
})

test('Home is not written into the password', () => {
	assert.equal(takeLine('', 'ab\x1b[Hc\r').value, 'abc')
	assert.equal(takeLine('', 'ab\x1b[Hc\r').value.includes('[H'), false)
})

test('an application-cursor escape (ESC O) is not written into the password', () => {
	assert.equal(takeLine('', 'a\x1bODb\r').value, 'ab')
})
