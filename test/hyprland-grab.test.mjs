import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {canUseKeyboardLock, coerceMode, defaultMode, onBlur, onCaptureModeChange, onFullscreenChange, resolveMode, toggleLock} from '../web/src/desktop/hyprland/grab.ts'

const unlocked = (mode) => ({keysLocked: false, method: 'none', mode})

describe('hyprland grab', () => {
	test('toggle on and off', () => {
		const on = toggleLock(unlocked('host'), 'scroll')
		assert.deepEqual(on, {keysLocked: true, method: 'scroll', mode: 'host'})
		assert.deepEqual(toggleLock(on, 'f12'), unlocked('host'))
	})

	test('HTTP coerces keyboard-lock to host', () => {
		assert.equal(coerceMode('keyboard-lock', false), 'host')
		assert.equal(coerceMode('keyboard-lock', true), 'keyboard-lock')
		assert.equal(resolveMode('keyboard-lock', false, true), 'host')
	})

	test('default mode', () => {
		assert.equal(defaultMode(false, true), 'host')
		assert.equal(defaultMode(true, true), 'keyboard-lock')
		assert.equal(defaultMode(true, false), 'host')
		assert.equal(canUseKeyboardLock(true, true), true)
		assert.equal(canUseKeyboardLock(false, true), false)
	})

	test('leaving fullscreen unlocks keyboard-lock; blur does not', () => {
		const locked = {keysLocked: true, method: 'keyboard-lock', mode: 'keyboard-lock'}
		assert.deepEqual(onFullscreenChange(locked, false), {keysLocked: false, method: 'none', mode: 'keyboard-lock'})
		assert.deepEqual(onFullscreenChange(locked, true), locked)
		const hostLocked = toggleLock(unlocked('host'), 'scroll')
		assert.deepEqual(onFullscreenChange(hostLocked, false), hostLocked)
		assert.deepEqual(onBlur(hostLocked), hostLocked)
	})

	test('chip in keyboard-lock mode uses that method', () => {
		const on = toggleLock(unlocked('keyboard-lock'), 'chip')
		assert.equal(on.method, 'keyboard-lock')
		assert.equal(on.keysLocked, true)
	})

	test('leaving keyboard-lock capture unlocks that method', () => {
		const locked = {keysLocked: true, method: 'keyboard-lock', mode: 'keyboard-lock'}
		assert.deepEqual(onCaptureModeChange(locked, 'host'), {keysLocked: false, method: 'none', mode: 'host'})
		assert.deepEqual(onCaptureModeChange(toggleLock(unlocked('host'), 'scroll'), 'keyboard-lock'), {
			keysLocked: true,
			method: 'scroll',
			mode: 'keyboard-lock',
		})
	})
})

test('the snippet comes in both Omarchy config formats, each toggling the same passthrough submap', async () => {
	const {SNIPPETS} = await import('../web/src/desktop/hyprland/grab.ts')
	const lua = SNIPPETS.lua.text
	assert.match(lua, /o\.bind\("SCROLL_LOCK", [^\n]*hl\.dsp\.submap\("passthrough"\), \{ non_consuming = true \}\)/)
	assert.match(lua, /hl\.define_submap\("passthrough", function\(\)[\s\S]*hl\.dsp\.submap\("reset"\)[\s\S]*end\)/)
	assert.equal(SNIPPETS.lua.file, '~/.config/hypr/bindings.lua')
	const conf = SNIPPETS.conf.text.split('\n')
	// Non-consuming binds (bindn) on, then the submap, its way back out, and the end of the submap.
	assert.deepEqual(conf, ['bindn = , Scroll_Lock, submap, passthrough', 'bindn = SUPER, F12, submap, passthrough', 'submap = passthrough', 'bindn = , Scroll_Lock, submap, reset', 'bindn = SUPER, F12, submap, reset', 'submap = reset'])
	assert.equal(SNIPPETS.conf.file, '~/.config/hypr/bindings.conf')
})
