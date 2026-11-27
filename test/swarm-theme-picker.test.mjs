import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {sameThemePicker} from '../web/src/swarm/themePicker.ts'

const picker = (over = {}) => ({themes: ['Jade Horse', 'Nord'], theme: 'jade-horse', disabled: false, ...over})

test('sameThemePicker treats a metrics-only update as unchanged', () => {
	const open = picker()
	const packet = picker({themes: ['Jade Horse', 'Nord']})
	assert.equal(sameThemePicker(open, packet), true)
})

test('sameThemePicker is true when the theme list is a new array with the same names', () => {
	const open = picker()
	assert.equal(sameThemePicker(open, picker({themes: [...open.themes]})), true)
})

test('sameThemePicker is false when the current theme changes', () => {
	assert.equal(sameThemePicker(picker(), picker({theme: 'nord'})), false)
})

test('sameThemePicker is false when the theme list changes', () => {
	assert.equal(sameThemePicker(picker(), picker({themes: ['Jade Horse']})), false)
})

test('sameThemePicker is false when the picker becomes disabled', () => {
	assert.equal(sameThemePicker(picker(), picker({disabled: true})), false)
})

test('the fleet theme <select> skips re-render when sameThemePicker is true', async () => {
	const swarm = await readFile(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	const picker = await readFile(new URL('../web/src/theme/ThemePicker.tsx', import.meta.url), 'utf8')
	assert.match(swarm, /from '\.\.\/theme\/ThemePicker'/)
	assert.match(picker, /from '\.\.\/swarm\/themePicker'/)
	assert.match(picker, /memo\(\s*function ThemePicker/)
	assert.match(picker, /sameThemePicker\(/)
})
