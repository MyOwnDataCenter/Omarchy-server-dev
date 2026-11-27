// The clock/system menu scrim must cover the screen so a click outside the menu closes it.
// Inside <header class="desk-top"> it can't: the header's backdrop-filter makes it the containing
// block for position: fixed children, and `.desk-top button` sizes every button to 26px.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const TSX = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

test('the top-bar scrim renders before the header, not inside it', () => {
	const fn = TSX.slice(TSX.indexOf('function TopBar('))
	const header = fn.indexOf('<header className="desk-top">')
	const end = fn.indexOf('</header>')
	const scrim = fn.indexOf('menu-scrim top-scrim')
	assert.ok(header > 0 && end > header, 'TopBar header not found')
	assert.ok(scrim > 0 && scrim < header, 'top-scrim must be rendered before <header className="desk-top">')
	assert.doesNotMatch(fn.slice(header, end), /menu-scrim/)
})

test('the top-bar scrim stacks with the bar, above the dock', () => {
	const z = (sel) => Number(CSS.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{[^}]*?z-index: (\\d+)`))?.[1])
	assert.equal(z('.menu-scrim.top-scrim'), z('.desk-top'))
	assert.ok(z('.menu-scrim.top-scrim') > z('.desk-dock'), 'scrim must cover the dock')
})

test('pointerdown outside the popover and its switching triggers dismisses the menu (including blank header and Activities)', () => {
	const fn = TSX.slice(TSX.indexOf('function TopBar('), TSX.indexOf('function MiniCalendar('))
	assert.match(fn, /addEventListener\('pointerdown', onDown, true\)/)
	assert.match(fn, /closest\('\.top-pop, \.top-clock, \.top-bell, \.top-sys, \.menu-scrim'\)/)
})
