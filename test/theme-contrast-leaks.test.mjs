// Theme contrast and light-theme leak regressions (Latte & light Omarchy palettes).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {contrastRatio, darkenHslForWhite, hslToRgb, parseRgbColor, pickOnAccent} from '../web/src/theme/contrast.ts'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
const UI = readFileSync(new URL('../web/src/ui.tsx', import.meta.url), 'utf8')

test('Omarchy theme does not force a dark window background and keeps active and inactive title bars opaque', () => {
	assert.doesNotMatch(CSS, /\[data-theme='omarchy'\] \.win \{ background: #1a1b26/)
	assert.match(CSS, /\[data-theme='omarchy'\] \.desk \.win-bar \{ background: color-mix\(in srgb, var\(--bg-solid\) 96%, var\(--fg\) 4%\); \}/)
	assert.match(CSS, /\[data-theme='omarchy'\] \.desk \.win:not\(\.active\) \.win-bar \{ background: var\(--bg-solid\); \}/)
})

test('pickOnAccent selects >= 4.5:1 foreground for Omarchy-light blue, Omarchy-dark blue, and Latte green/blue', () => {
	// Omarchy-light blue (#286983): white is 6.11:1 vs #111 3.09:1
	const omLightBlue = pickOnAccent('#286983', '#111')
	assert.equal(omLightBlue, '#fff')
	assert.ok(contrastRatio(parseRgbColor('#286983'), parseRgbColor(omLightBlue)) >= 4.5)

	// Latte green (#40a02b): #111 is 5.65:1 vs white 3.34:1
	const latteGreen = pickOnAccent('#40a02b', '#fff')
	assert.equal(latteGreen, '#111')
	assert.ok(contrastRatio(parseRgbColor('#40a02b'), parseRgbColor(latteGreen)) >= 4.5)

	// Latte blue (#1e66f5): white is 4.68:1
	assert.equal(pickOnAccent('#1e66f5', '#111'), '#fff')

	// Omarchy-dark accent (#7aa2f7) prefers palette background (#1a1b26) when >= 4.5:1
	assert.equal(pickOnAccent('#7aa2f7', '#111', '#1a1b26'), '#1a1b26')

	// Handles #777777 where both #fff (4.48:1) and #111 (4.22:1) miss 4.5:1 → falls back to #000 (4.69:1)
	const midGray = pickOnAccent('#777777', '#fff')
	assert.equal(midGray, '#000')
	assert.ok(contrastRatio(parseRgbColor('#777777'), parseRgbColor(midGray)) >= 4.5)

	// Default wallpaper orange (24 90% 50%) darkens enough for white ink to reach >= 4.5:1
	const orangeFill = darkenHslForWhite(24, 90, 50)
	const orangeMatch = orangeFill.match(/^hsl\(24 90% (\d+(?:\.\d+)?)%\)$/)
	assert.ok(orangeMatch, `unexpected orange fill: ${orangeFill}`)
	assert.ok(contrastRatio(hslToRgb(24, 90, Number(orangeMatch[1])), [255, 255, 255]) >= 4.5)

	// Handles color(srgb ...) computed output without misreading color space names
	assert.equal(pickOnAccent('color(srgb 0.157 0.412 0.514)', '#111'), '#fff')

	// Wired in applyPrefs
	assert.match(UI, /darkenHslForWhite\(h, s, l\)/)
	assert.match(UI, /resolveCssColor\(root, token\)/)
	assert.match(UI, /pickOnAccent\(resolved, light \? '#fff' : '#111'\)/)
})

test('File viewer .fv pins dark surface tokens so Latte text stays readable', () => {
	const fv = CSS.match(/\n\.fv \{[^}]*\}/)?.[0]
	assert.ok(fv, '.fv rule not found')
	assert.match(fv, /--fg:\s*#fff;/)
	assert.match(fv, /color-scheme:\s*dark;/)
})

test('Dark-chrome overlays (.console-bar, .term-paste, .desk-hint-close) pin light ink', () => {
	const cb = CSS.match(/\n\.console-bar \{[^}]*\}/)?.[0]
	assert.ok(cb && /color:\s*#fff;/.test(cb), '.console-bar must set color: #fff')
	assert.match(CSS, /\.term-paste-actions \.btn:not\(\.primary\) \{[^}]*color:\s*#fff;/)
	const dhc = CSS.match(/\n\.desk-hint-close \{[^}]*\}/)?.[0]
	assert.ok(dhc && /color:\s*#fff;/.test(dhc), '.desk-hint-close must set color: #fff')
})

test('accent fills use --on-accent instead of hard-coded #fff', () => {
	const today = CSS.match(/\n\.cal-day\.today \{[^}]*\}/)?.[0]
	assert.ok(today && /color:\s*var\(--on-accent/.test(today))
	const chip = CSS.match(/\n\.swarm-steps \.chip\.on \{[^}]*\}/)?.[0]
	assert.ok(chip && /color:\s*var\(--on-accent/.test(chip))
})
