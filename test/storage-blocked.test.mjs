// A browser that refuses storage must not blank Files or stop Settings pages from opening (#586),
// and Settings must match what the server accepts and report a refused update (#165, #166).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {afterEach, describe, test} from 'node:test'

import {safeLocal, safeSession} from '../web/src/safeStorage.ts'
import {MIN_PASSWORD_LENGTH, updateStartFailure} from '../web/src/screens/settingsHelpers.ts'

const source = (path) => readFileSync(new URL(`../web/src/${path}`, import.meta.url), 'utf8')
const original = {session: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), local: Object.getOwnPropertyDescriptor(globalThis, 'localStorage')}

function restore(name, desc) {
	if (desc) Object.defineProperty(globalThis, name, desc)
	else delete globalThis[name]
}
afterEach(() => {
	restore('sessionStorage', original.session)
	restore('localStorage', original.local)
})

function blocked() {
	const boom = () => {
		throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
	}
	return {getItem: boom, setItem: boom, removeItem: boom}
}

describe('storage that throws', () => {
	test('safe helpers swallow write, read and remove errors', () => {
		Object.defineProperty(globalThis, 'sessionStorage', {value: blocked(), configurable: true})
		Object.defineProperty(globalThis, 'localStorage', {value: blocked(), configurable: true})
		for (const store of [safeSession, safeLocal]) {
			assert.doesNotThrow(() => store.set('k', 'v'))
			assert.doesNotThrow(() => store.remove('k'))
			assert.equal(store.get('k'), null)
		}
	})

	test('safe helpers swallow storage that cannot even be reached', () => {
		for (const name of ['sessionStorage', 'localStorage']) {
			Object.defineProperty(globalThis, name, {
				get() {
					throw new DOMException('denied', 'SecurityError')
				},
				configurable: true,
			})
		}
		assert.equal(safeSession.get('k'), null)
		assert.doesNotThrow(() => safeLocal.set('k', 'v'))
	})

	test('safe helpers still store when storage works', () => {
		const data = new Map()
		const ok = {getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k)}
		Object.defineProperty(globalThis, 'sessionStorage', {value: ok, configurable: true})
		safeSession.set('a', '1')
		assert.equal(safeSession.get('a'), '1')
		safeSession.remove('a')
		assert.equal(safeSession.get('a'), null)
	})

	test('Files, Settings, App and Unraid no longer call storage directly (inAppHistory guards its own)', () => {
		const files = source('screens/Files.tsx')
		const settings = source('screens/Settings.tsx')
		const app = source('App.tsx')
		const unraid = source('unraid.tsx')
		for (const [name, text] of [['Files', files], ['Settings', settings], ['App', app], ['unraid', unraid]]) {
			assert.equal(/\b(sessionStorage|localStorage)\.(get|set|remove)Item/.test(text.replace(/\(key(, value)?\) => sessionStorage\.(set|get)Item\(key(, value)?\)/g, '')), false, `${name} still calls storage directly`)
		}
	})
})

describe('settings fixes', () => {
	test('the password form asks for as many characters as the server does', () => {
		assert.equal(MIN_PASSWORD_LENGTH, 8)
		const accounts = source('../../omarchyd/accounts.mjs')
		assert.match(accounts, /at least 8 characters/)
		const settings = source('screens/Settings.tsx')
		assert.equal(settings.includes('newPassword.length < MIN_PASSWORD_LENGTH'), true)
		assert.equal(/length < 6|At least 6/.test(settings), false)
	})

	test('a refusal from system.update is shown, a dropped connection is not', () => {
		assert.equal(updateStartFailure({status: 412, code: 'PRECONDITION_FAILED', message: "This copy can't update itself."}), "This copy can't update itself.")
		assert.equal(updateStartFailure({status: 502, message: "Couldn't check for updates: offline"}), "Couldn't check for updates: offline")
		assert.equal(updateStartFailure({status: 0, code: 'NETWORK', message: "Can't reach the server"}), null)
		assert.equal(updateStartFailure(new TypeError('x')), null)
		assert.equal(updateStartFailure({status: 502, code: 'UNREACHABLE', message: 'My Own Data Center is restarting or not answering. Wait a moment and try again.'}), null)
		assert.equal(updateStartFailure({status: 504, code: 'TIMEOUT', message: 'took too long'}), null)
		assert.equal(updateStartFailure(null), null)
		const settings = source('screens/Settings.tsx')
		assert.equal(settings.includes('updateStartFailure(e)'), true)
	})
})
