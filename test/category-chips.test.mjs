import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {chipEdgeFade, chipScrollEnds, chipScrollTarget} from '../web/src/categoryChips.ts'

test('category arrows stay quiet when every chip fits', () => {
	assert.deepEqual(chipScrollEnds(0, 400, 400), {back: false, more: false})
	assert.deepEqual(chipScrollEnds(0, 390, 400), {back: false, more: false})
})

test('category arrows follow which end is still out of sight', () => {
	assert.deepEqual(chipScrollEnds(0, 800, 300), {back: false, more: true})
	assert.deepEqual(chipScrollEnds(200, 800, 300), {back: true, more: true})
	assert.deepEqual(chipScrollEnds(500, 800, 300), {back: true, more: false})
})

test('a clipped chip fades, and a whole chip does not', () => {
	const width = 300
	assert.deepEqual(chipEdgeFade(width, [{left: 8, right: 80}, {left: 88, right: 160}]), {fadeStart: false, fadeEnd: false})
	assert.deepEqual(chipEdgeFade(width, [{left: -40, right: 30}]), {fadeStart: true, fadeEnd: false})
	assert.deepEqual(chipEdgeFade(width, [{left: 260, right: 340}]), {fadeStart: false, fadeEnd: true})
	assert.deepEqual(chipEdgeFade(width, [{left: -20, right: 40}, {left: 270, right: 360}]), {fadeStart: true, fadeEnd: true})
	// The cut falls in the gap, so neither chip is sliced.
	assert.deepEqual(chipEdgeFade(width, [{left: -80, right: -8}, {left: 0, right: 70}]), {fadeStart: false, fadeEnd: false})
})

test('one arrow press moves almost a screen and stops at the end', () => {
	assert.equal(chipScrollTarget(0, 800, 300, 1), 264)
	assert.equal(chipScrollTarget(400, 800, 300, 1), 500)
	assert.equal(chipScrollTarget(40, 800, 300, -1), 0)
	assert.equal(chipScrollTarget(0, 200, 40, 1), 80)
})

test('the category row is its own control and the shared chips row does not wrap', async () => {
	const css = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8')
	const chips = css.slice(css.indexOf('.chips {'), css.indexOf('.chip {'))
	assert.doesNotMatch(chips, /flex-wrap/)
	assert.match(css, /\.category-chips-arrow:disabled/)
	assert.match(css, /\.category-chips-scroller\.fade-start\.fade-end/)
	const store = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	assert.match(store, /<CategoryChips label="Categories">/)
	const plugins = await readFile(new URL('../web/src/screens/Plugins.tsx', import.meta.url), 'utf8')
	assert.match(plugins, /<CategoryChips label="Plugin categories">/)
})
