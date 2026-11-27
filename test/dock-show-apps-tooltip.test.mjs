// Dock Show Applications polish and tooltip anchoring/scoping regressions.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const TSX = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

test('Show Applications renders as a bare glyph without a second grey tile', () => {
	const block = CSS.match(/\n\.show-apps \{[^}]*\}/)?.[0]
	assert.ok(block, '.show-apps rule not found')
	assert.match(block, /background:\s*transparent;/)
})

test('dock padding is symmetric and floating side docks centre below the top bar', () => {
	assert.match(CSS, /\.dock-left \.desk-dock,\n\.dock-right \.desk-dock \{[^}]*padding:\s*10px 0;/)
	assert.match(CSS, /\.dock-bottom \.desk-dock,\n\.dock-top \.desk-dock \{[^}]*padding:\s*0 10px;/)
	assert.match(CSS, /\.dock-floating\.dock-left \.desk-dock,\n\.dock-floating\.dock-right \.desk-dock \{[^}]*top:\s*calc\(50% \+ var\(--top-h\) \/ 2\);/)
})

test('reduced-motion resets hover lift on .show-apps as well as .dock-art', () => {
	assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.dock-hover-lift \.dock-item:hover \.show-apps/)
})

test('dock tooltip portals inside .desk, clamps/bounds width, reveals auto-hidden dock on focus, and uses mouse-only hover', () => {
	const tipFn = TSX.slice(TSX.indexOf('function useTooltip('), TSX.indexOf('// ---- dock'))
	assert.match(tipFn, /closest\('\.desk'\)/, 'tooltip must portal into .desk so .style-daylight matches')
	assert.match(tipFn, /node\.style\.translate/, 'tooltip must clamp on both axes via translate')
	assert.match(tipFn, /clearTimeout\(t\.current\)/, 'tooltip must clean up pending timeout')
	assert.match(tipFn, /addEventListener\('resize', refresh\)/, 'tooltip must remeasure on viewport resize')
	assert.match(tipFn, /addEventListener\('transitionend', onTransition\)/, 'tooltip must remeasure after dock reveal transition')
	const dockFn = TSX.slice(TSX.indexOf('function Dock('), TSX.indexOf('// ---- desktop icons'))
	assert.match(dockFn, /!focusWithin/, 'auto-hidden dock must reveal while focus is inside it')
	assert.match(dockFn, /instanceof globalThis\.Node/, 'blur check must use DOM Node (not hyprland layout Node)')
	assert.match(dockFn, /startDrag\(k\)\(e\)/, 'dock item pointerdown must compose tip.hide with startDrag without overwriting it')
	assert.doesNotMatch(dockFn.slice(dockFn.indexOf('const tipProps'), dockFn.indexOf('const frame')), /onPointerDown/, 'tipProps must not overwrite onPointerDown on dock items')
	assert.match(tipFn, /node\.style\.maxWidth/, 'side-dock tooltip must constrain maxWidth to available space before clamping')
	assert.match(dockFn, /!e\.currentTarget\.matches\(':focus-visible'\)/, 'pointer leave must not hide tooltip while keyboard focus remains')
	assert.match(dockFn, /pointerType === 'mouse'/, 'touch taps must not leave sticky hover tooltips')
	assert.match(dockFn, /matches\(':focus-visible'\)/, 'dock items must show tooltips on keyboard focus')
	assert.match(dockFn, /Math\.max\(d\.right,\s*art\.right\)/, 'tooltip must measure rendered artwork instead of assuming full magnification')
	assert.match(CSS, /\.dock-tip \{[^}]*max-width:\s*min\(320px,\s*calc\(100vw - 16px\)\);/)
	assert.match(CSS, /\.dock-tip \{[^}]*text-overflow:\s*ellipsis;/)
})
