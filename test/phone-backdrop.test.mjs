// Phone wallpaper must stay pinned to the large viewport, above a document
// that does not rubber-band, so a swipe cannot recrop or drag the picture.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/src/styles.css'), 'utf8')

function decls(selector) {
	const start = css.indexOf(`\n${selector} {`)
	assert.notEqual(start, -1, `missing rule for ${selector}`)
	const open = css.indexOf('{', start)
	const close = css.indexOf('\n}', open)
	assert.notEqual(close, -1, `unclosed rule for ${selector}`)
	return css.slice(open + 1, close)
}

test('phone wallpaper is a stable large-viewport layer, not under the page', () => {
	const b = decls('.backdrop')
	assert.match(b, /z-index:\s*0/)
	assert.doesNotMatch(b, /z-index:\s*-1/)
	assert.match(b, /100lvh/)
	assert.doesNotMatch(b, /inset:\s*0/)
})

test('phone shell sits above the wallpaper and is the scroller', () => {
	const s = decls('.shell')
	assert.match(s, /position:\s*relative/)
	assert.match(s, /z-index:\s*1/)
	assert.match(s, /overflow-y:\s*auto/)
	assert.doesNotMatch(s, /min-height:\s*100dvh/)
})

test('the document itself does not scroll on the phone', () => {
	const root = decls('html,\nbody')
	assert.match(root, /overflow:\s*hidden/)
	assert.match(root, /height:\s*100%/)
})

test('nothing is pushed by an iOS gap (the wallpaper and bottom bar keep their own positions)', () => {
	assert.doesNotMatch(css, /--ios-gap/)
	assert.doesNotMatch(css, /\n\.backdrop,\n\.scrim,/)
})

test('the height chain and lock classes freeze the phone scroller', () => {
	assert.match(decls('#root'), /height:\s*100%/)
	const auth = decls('.auth')
	assert.match(auth, /z-index:\s*1/)
	assert.match(auth, /overflow-y:\s*auto/)
	assert.match(css, /html\.page-locked \.shell/)
	assert.match(css, /html\.screen-locked \.shell/)
})

test('no later .backdrop rule puts the wallpaper under the page again', () => {
	const matches = [...css.matchAll(/\n\.backdrop \{([^}]+)\}/g)]
	assert.ok(matches.length >= 1, 'missing .backdrop')
	for (const m of matches) {
		assert.doesNotMatch(m[1], /z-index:\s*-1/)
		assert.doesNotMatch(m[1], /inset:\s*0/)
	}
})
