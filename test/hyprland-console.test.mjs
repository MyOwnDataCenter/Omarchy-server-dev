import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {injectConsoleKey, keysymFromEvent, lastMinimizedOn, releaseConsoleSuper, setConsoleKeyHandler, topVisibleWindow} from '../web/src/desktop/hyprland/consoleBridge.ts'

describe('hyprland console inject', () => {
	test('routes keys only to the registered window id', () => {
		const a = []
		const b = []
		setConsoleKeyHandler('a', (e) => a.push(e.code))
		setConsoleKeyHandler('b', (e) => b.push(e.code))
		injectConsoleKey('b', {type: 'keydown', code: 'ArrowLeft', key: 'ArrowLeft'})
		assert.deepEqual(a, [])
		assert.deepEqual(b, ['ArrowLeft'])
		setConsoleKeyHandler('b', null)
		injectConsoleKey('b', {type: 'keydown', code: 'ArrowLeft', key: 'ArrowLeft'})
		assert.deepEqual(b, ['ArrowLeft'])
		setConsoleKeyHandler('a', null)
	})

	test('releaseConsoleSuper sends Super up to that window', () => {
		const got = []
		setConsoleKeyHandler('c', (e) => got.push(e))
		releaseConsoleSuper('c')
		assert.equal(got[0].type, 'keyup')
		assert.equal(got[0].code, 'MetaLeft')
		setConsoleKeyHandler('c', null)
	})

	test('keysymFromEvent maps Super, arrows, F-keys, and letters', () => {
		assert.equal(keysymFromEvent({code: 'MetaLeft', key: 'Meta'}), 'super')
		assert.deepEqual(keysymFromEvent({code: 'ArrowLeft', key: 'ArrowLeft'}), {keysym: 0xff51, code: 'ArrowLeft'})
		assert.deepEqual(keysymFromEvent({code: 'F5', key: 'F5'}), {keysym: 0xffc2, code: 'F5'})
		assert.deepEqual(keysymFromEvent({code: 'KeyA', key: 'a'}), {keysym: 97, code: 'KeyA'})
		assert.equal(keysymFromEvent({code: 'Unidentified', key: 'Unidentified'}), null)
	})

	test('topVisibleWindow ignores other workspaces and minimized windows', () => {
		const wins = [
			{id: 'old', kind: 'console', min: false, z: 3, workspace: 2},
			{id: 'min', kind: 'console', min: true, z: 9, workspace: 1},
			{id: 'term', kind: 'terminal', min: false, z: 4, workspace: 1},
			{id: 'vm', kind: 'console', min: false, z: 2, workspace: 1},
		]
		assert.equal(topVisibleWindow(wins, 1, true)?.id, 'term')
		assert.equal(topVisibleWindow(wins, 2, true)?.id, 'old')
		assert.equal(topVisibleWindow(wins, 1, false)?.id, 'term')
	})

	test('lastMinimizedOn picks the highest-z minimized window on that workspace', () => {
		const wins = [
			{id: 'a', kind: 'terminal', min: true, z: 1, workspace: 1},
			{id: 'b', kind: 'terminal', min: true, z: 4, workspace: 1},
			{id: 'c', kind: 'terminal', min: true, z: 9, workspace: 2},
		]
		assert.equal(lastMinimizedOn(wins, 1)?.id, 'b')
	})

	test('lastMinimizedOn prefers later minimize time over z-order', () => {
		const wins = [
			{id: 'first', kind: 'terminal', min: true, z: 9, workspace: 1, minAt: 1},
			{id: 'second', kind: 'terminal', min: true, z: 1, workspace: 1, minAt: 2},
		]
		assert.equal(lastMinimizedOn(wins, 1)?.id, 'second')
	})
})
