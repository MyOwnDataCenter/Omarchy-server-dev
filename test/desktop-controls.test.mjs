// Desktop controls: snap, launcher trim, Activities Enter, icon keys, scroll reset,
// keyboard-lock release, settings remount, sign-out, and byte-unit rounding.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {afterEach, describe, test} from 'node:test'

import {logout} from '../web/src/api.ts'
import {bytes} from '../web/src/formatBytes.ts'
import {desktopIconKeyOpens} from '../web/src/desktop/iconKeys.ts'
import {overviewEnterOpensApp} from '../web/src/desktop/overviewEnter.ts'
import {rememberSettingsPage, settingsPayloadFor, settingsRemountKey} from '../web/src/desktop/settingsPage.ts'
import {nextMaximizeSnap} from '../web/src/desktop/windowSnap.ts'
import {bindWindowScrollReset} from '../web/src/desktop/winScroll.ts'
import {grabToggleReleasesKeyboardLock, releaseKeyboardLock, toggleLock} from '../web/src/desktop/hyprland/grab.ts'
import {launcherRowMatches} from '../web/src/desktop/hyprland/launcherScroll.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('byte sizes round before the unit is chosen', () => {
	test('promotes a value that rounds onto the next unit', () => {
		assert.equal(bytes(999999), '1.0 MB')
		assert.equal(bytes(99950), '100 KB')
		assert.equal(bytes(999999999999999), '1.0 PB')
		assert.equal(bytes(1048575, 1, 1024), '1.0 MB')
		assert.equal(bytes(1023.6, 1, 1024), '1.0 KB')
	})

	test('keeps ordinary sizes and the empty value', () => {
		assert.equal(bytes(undefined), '–')
		assert.equal(bytes(Number.NaN), '–')
		assert.equal(bytes(0), '0 B')
		assert.equal(bytes(999), '999 B')
		assert.equal(bytes(1000), '1.0 KB')
		assert.equal(bytes(1536, 1, 1024), '1.5 KB')
		assert.equal(bytes(1024, 1, 1024), '1.0 KB')
		assert.equal(bytes(1023.4, 1, 1024), '1023 B')
	})
})

describe('desktop control decisions', () => {
	test('maximize restores only a window that is already maximized', () => {
		assert.equal(nextMaximizeSnap('left'), 'max')
		assert.equal(nextMaximizeSnap('right'), 'max')
		assert.equal(nextMaximizeSnap(null), 'max')
		assert.equal(nextMaximizeSnap('max'), null)
	})

	test('Activities Enter opens an app only when the grid is showing and not empty', () => {
		assert.equal(overviewEnterOpensApp('Enter', false, 4), false)
		assert.equal(overviewEnterOpensApp('Enter', true, 0), false)
		assert.equal(overviewEnterOpensApp('Enter', true, 1), true)
		assert.equal(overviewEnterOpensApp(' ', true, 1), false)
	})

	test('a focused desktop icon opens on Enter or Space', () => {
		assert.equal(desktopIconKeyOpens('Enter'), true)
		assert.equal(desktopIconKeyOpens(' '), true)
		assert.equal(desktopIconKeyOpens('Spacebar'), false)
		assert.equal(desktopIconKeyOpens('a'), false)
	})

	test('the Hyprland launcher ignores spaces around the query', () => {
		assert.equal(launcherRowMatches('Files', ' files'), true)
		assert.equal(launcherRowMatches('Files', 'files '), true)
		assert.equal(launcherRowMatches('Files', '   '), true)
		assert.equal(launcherRowMatches('Files', ''), true)
		assert.equal(launcherRowMatches('Files', 'zzz'), false)
		assert.equal(launcherRowMatches('Files', ' file'), true)
		assert.equal(launcherRowMatches('Files', ' nope '), false)
	})

	test('Scroll Lock releases a keyboard-lock grab and leaves a scroll grab alone', () => {
		const keyboard = {keysLocked: true, method: 'keyboard-lock', mode: 'keyboard-lock'}
		assert.equal(grabToggleReleasesKeyboardLock(keyboard, toggleLock(keyboard, 'scroll')), true)
		assert.equal(grabToggleReleasesKeyboardLock(keyboard, toggleLock(keyboard, 'f12')), true)
		const scroll = {keysLocked: true, method: 'scroll', mode: 'host'}
		assert.equal(grabToggleReleasesKeyboardLock(scroll, toggleLock(scroll, 'scroll')), false)
		const idle = {keysLocked: false, method: 'keyboard-lock', mode: 'keyboard-lock'}
		assert.equal(grabToggleReleasesKeyboardLock(idle, toggleLock(idle, 'scroll')), false)
	})

	test('settings payload changes the remount key and is stored for the first read', () => {
		const first = settingsPayloadFor('assistant', 10)
		const again = settingsPayloadFor('assistant', 11)
		assert.deepEqual(first, {page: 'assistant', pageNonce: 10})
		assert.equal(settingsRemountKey(first), 'assistant:10')
		assert.notEqual(settingsRemountKey(first), settingsRemountKey(again))
		assert.equal(settingsRemountKey(undefined), ':')
		const saved = []
		rememberSettingsPage({setItem: (k, v) => saved.push([k, v])}, 'assistant')
		assert.deepEqual(saved, [['omarchy-server:settings-page', 'assistant']])
	})
})

describe('window scroll follows the screen that asked to go to the top', () => {
	test('a click inside a window resets that .win-scroll when the page scrolls to the top', async () => {
		const box = {
			scrollTop: 420,
			closest(sel) {
				return sel === '.win-scroll' ? box : null
			},
		}
		const other = {
			scrollTop: 80,
			closest() {
				return null
			},
		}
		const calls = []
		const win = {
			scrollTo(...args) {
				calls.push(args)
			},
		}
		const listeners = new Map()
		const doc = {
			addEventListener(type, fn) {
				listeners.set(type, fn)
			},
			removeEventListener(type) {
				listeners.delete(type)
			},
		}
		const stop = bindWindowScrollReset(win, doc)
		const onClick = listeners.get('click')
		onClick({target: box})
		win.scrollTo({top: 0, behavior: 'auto'})
		assert.equal(box.scrollTop, 0)
		assert.equal(calls.length, 1)

		box.scrollTop = 150
		await new Promise((resolve) => queueMicrotask(resolve))
		win.scrollTo({top: 0})
		assert.equal(box.scrollTop, 150)

		onClick({target: box})
		win.scrollTo(0, 40)
		assert.equal(box.scrollTop, 150)

		onClick({target: box})
		win.scrollTo(0, 0)
		assert.equal(box.scrollTop, 0)

		box.scrollTop = 90
		onClick({target: other})
		win.scrollTo({top: 0})
		assert.equal(box.scrollTop, 90)
		assert.equal(other.scrollTop, 80)
		stop()
		assert.equal(listeners.has('click'), false)
	})
})

describe('signing out clears the installer Later flag', () => {
	const prevFetch = globalThis.fetch
	const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

	afterEach(() => {
		globalThis.fetch = prevFetch
		if (prevWindow) Object.defineProperty(globalThis, 'window', prevWindow)
		else delete globalThis.window
	})

	test('dispatches touch:signed-out only after logout succeeds', async () => {
		const events = []
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: {
				dispatchEvent(event) {
					events.push(event.type)
					return true
				},
			},
		})
		globalThis.fetch = async () => new Response(JSON.stringify({ok: true}), {status: 200, headers: {'content-type': 'application/json'}})
		await logout()
		assert.deepEqual(events, ['touch:signed-out'])

		events.length = 0
		globalThis.fetch = async () => new Response(JSON.stringify({error: {code: 'ERROR', message: 'nope'}}), {status: 500, headers: {'content-type': 'application/json'}})
		await assert.rejects(() => logout())
		assert.deepEqual(events, [])
	})
})

describe('keyboard lock release', () => {
	test('unlocks the browser keyboard and leaves fullscreen', async () => {
		let unlocked = 0
		let exited = 0
		const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
		const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: {keyboard: {lock() {}, unlock() { unlocked += 1 }}},
		})
		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: {
				exitFullscreen() {
					exited += 1
					return Promise.resolve()
				},
			},
		})
		try {
			releaseKeyboardLock()
			await Promise.resolve()
			assert.equal(unlocked, 1)
			assert.equal(exited, 1)
		} finally {
			if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav)
			if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc)
			else delete globalThis.document
		}
	})
})

test('the running desktop wires these decisions', () => {
	const desktop = read('../web/src/desktop/Desktop.tsx')
	assert.match(desktop, /onPointerLeave=\{\(\) => setHover\(false\)\}/)
	assert.match(desktop, /nextMaximizeSnap\(win\.snap\)/)
	assert.match(desktop, /desktopIconKeyOpens\(e\.key\)/)
	assert.match(desktop, /overviewEnterOpensApp\(/)
	assert.match(desktop, /grabToggleReleasesKeyboardLock\(/)
	assert.match(desktop, /releaseKeyboardLock\(/)
	assert.match(desktop, /settingsRemountKey\(win\.payload\)/)
	assert.match(desktop, /rememberSettingsPage\(sessionStorage, settingsPayload\.page\)/)
	assert.match(desktop, /bindWindowScrollReset\(window, document\)/)
	assert.match(desktop, /desk\.open\('settings', \{page: 'assistant'\}\)/)
	assert.match(desktop, /return <Files windowId=\{win\.id\} initialPath=\{win\.payload\?\.path\} \/>/)
	const launcher = read('../web/src/desktop/hyprland/Launcher.tsx')
	assert.match(launcher, /launcherRowMatches\(r\.label, q\)/)
	const ui = read('../web/src/ui.tsx')
	assert.match(ui, /export \{bytes\} from '\.\/formatBytes'/)
	assert.doesNotMatch(ui, /while \(n >= base/)
	const backups = read('../web/src/backups.tsx')
	assert.match(backups, /bytes/)
	assert.doesNotMatch(backups, /const bytes =/)
	const api = read('../web/src/api.ts')
	assert.match(api, /export const logout = \(\) =>\s*post\('\/api\/auth\/logout'\)\.then/)
	assert.match(api, /err\.message === 'Incorrect password'/)
})
