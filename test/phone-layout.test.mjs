import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import {emptyFolderUploadHint, filesSearching} from '../web/src/filesHelpers.ts'
import {inAppBackTarget, markInAppHistory, readInAppHistoryFlag} from '../web/src/inAppHistory.ts'
import {initials} from '../web/src/initials.ts'
import {paddingBottomPlus} from '../web/src/scrollPad.ts'

describe('phone layout helpers', () => {
	test('initials keeps one emoji and the next letter, not a broken surrogate', () => {
		const mark = initials('😀 Ada')
		assert.equal(mark, '😀A')
		assert.equal([...mark].length, 2)
		assert.equal(mark.codePointAt(0), 0x1f600)
		assert.notEqual(mark, '\uD83DA')
		assert.equal(initials('Ada Lovelace'), 'AL')
		assert.equal(initials('grace hopper'), 'GH')
		assert.equal(initials('sam'), 'S')
		assert.equal(initials(''), '•')
	})

	test('in-app Back goes home without a flag and back when go() has set one', () => {
		assert.equal(inAppBackTarget(null), 'home')
		assert.equal(inAppBackTarget(''), 'home')
		assert.equal(inAppBackTarget('1'), 'back')
		assert.equal(readInAppHistoryFlag(() => { throw new Error('blocked') }), null)
		assert.doesNotThrow(() => markInAppHistory(() => { throw new Error('blocked') }))
		const bag = new Map()
		markInAppHistory((key, value) => bag.set(key, value))
		assert.equal(inAppBackTarget(readInAppHistoryFlag((key) => bag.get(key) ?? null)), 'back')
	})

	test('files search waits for two trimmed characters', () => {
		assert.equal(filesSearching(''), false)
		assert.equal(filesSearching('a'), false)
		assert.equal(filesSearching(' a'), false)
		assert.equal(filesSearching('ab'), true)
		assert.equal(filesSearching('  ab'), true)
	})

	test('empty folders mention Upload only when uploading is allowed', () => {
		assert.equal(emptyFolderUploadHint(true), 'Use Upload to add files.')
		assert.equal(emptyFolderUploadHint(false), null)
	})

	test('keyboard nudge adds 2px to the current padding instead of replacing it', () => {
		assert.equal(paddingBottomPlus('114px'), '116px')
		assert.equal(paddingBottomPlus('0px'), '2px')
		assert.equal(paddingBottomPlus(''), '2px')
	})

	test('Files uses one searching flag and the upload sentence', async () => {
		const src = await readFile(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')
		assert.match(src, /filesSearching\(q\)/)
		assert.match(src, /emptyFolderUploadHint\(canUpload\)/)
		assert.doesNotMatch(src, /Tap \+ to upload/)
		assert.doesNotMatch(src, /q\.trim\(\)\.length/)
	})
})
