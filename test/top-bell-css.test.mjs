// Ensure the top bar notifications bell rule beats generic .desk-top button styles (including :hover and .on) in web/src/styles.css.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

function splitTopLevelCommas(text) {
	const out = []
	let depth = 0
	let start = 0
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === '(' || ch === '[') depth++
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
		else if (ch === ',' && depth === 0) {
			const s = text.slice(start, i).trim()
			if (s) out.push(s)
			start = i + 1
		}
	}
	const tail = text.slice(start).trim()
	if (tail) out.push(tail)
	return out
}

function parseRules(css) {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
	const rules = []
	let i = 0
	let order = 0
	while (i < clean.length) {
		while (i < clean.length && /\s/.test(clean[i])) i++
		if (i >= clean.length) break
		const semi = clean.indexOf(';', i)
		const brace = clean.indexOf('{', i)
		if (brace === -1) break
		if (semi !== -1 && semi < brace) {
			i = semi + 1
			continue
		}
		const header = clean.slice(i, brace).trim()
		let depth = 1
		let j = brace + 1
		while (j < clean.length && depth > 0) {
			if (clean[j] === '{') depth++
			else if (clean[j] === '}') depth--
			j++
		}
		const body = clean.slice(brace + 1, j - 1)
		i = j
		if (header.startsWith('@')) continue
		const decls = {}
		for (const part of body.split(';')) {
			const colon = part.indexOf(':')
			if (colon === -1) continue
			const prop = part.slice(0, colon).trim().toLowerCase()
			const val = part.slice(colon + 1).trim()
			if (prop) decls[prop] = val
		}
		for (const sel of splitTopLevelCommas(header)) {
			rules.push({selector: sel, decls, order: order++})
		}
	}
	return rules
}

// Matches a selector against <div class="desk ..."><header class="desk-top"><div class="top-right"><button class="...">
// Supports :where(...) (0 specificity), > combinators, and :hover pseudo-class so hover-only mutations are caught too.
function matchPart(part, node, pseudoStates) {
	const m = part.match(/^(?:([a-zA-Z0-9_-]+))?((?:\.[a-zA-Z0-9_-]+)*)((?::[a-zA-Z0-9_-]+)*)$/)
	if (!m) return null
	const [, elTag, clsStr, pseudoStr] = m
	if (elTag && elTag !== node.tag) return null
	const cls = clsStr ? clsStr.slice(1).split('.') : []
	if (!cls.every((c) => node.classes.has(c))) return null
	const pseudos = pseudoStr ? pseudoStr.slice(1).split(':') : []
	if (!pseudos.every((p) => pseudoStates.has(p))) return null
	return [0, cls.length + pseudos.length, elTag ? 1 : 0]
}

function matchChain(selector, chain, pseudoStates) {
	if (/[\[\+~]/.test(selector)) return null
	const tokens = selector
		.trim()
		.replace(/\s*>\s*/g, ' > ')
		.split(/\s+/)
		.filter(Boolean)
	const items = []
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === '>') {
			if (items.length) items[items.length - 1].child = true
		} else {
			items.push({part: tokens[i], child: false})
		}
	}
	if (!items.length) return null
	const lastSpec = matchPart(items[items.length - 1].part, chain[chain.length - 1], pseudoStates)
	if (!lastSpec) return null
	let spec = [...lastSpec]
	let nodeIdx = chain.length - 1
	for (let k = items.length - 2; k >= 0; k--) {
		const {part, child} = items[k]
		if (child) {
			nodeIdx -= 1
			if (nodeIdx < 0) return null
			const s = matchPart(part, chain[nodeIdx], new Set())
			if (!s) return null
			spec = [spec[0] + s[0], spec[1] + s[1], spec[2] + s[2]]
		} else {
			let found = -1
			let foundSpec = null
			for (let n = nodeIdx - 1; n >= 0; n--) {
				const s = matchPart(part, chain[n], new Set())
				if (s) {
					found = n
					foundSpec = s
					break
				}
			}
			if (found < 0) return null
			nodeIdx = found
			spec = [spec[0] + foundSpec[0], spec[1] + foundSpec[1], spec[2] + foundSpec[2]]
		}
	}
	return spec
}

function matchBellSelector(selector, buttonClasses, rootClasses = new Set(), pseudoStates = new Set()) {
	const chain = [
		{tag: 'div', classes: rootClasses},
		{tag: 'header', classes: new Set(['desk-top'])},
		{tag: 'div', classes: new Set(['top-right'])},
		{tag: 'button', classes: buttonClasses},
	]
	const wm = selector.match(/^(.*?):where\(([^()]+)\)(.*)$/)
	if (wm) {
		const [, pre, inner, post] = wm
		const prefixSpec = pre.trim() ? matchChain(pre.trim(), chain.slice(0, 1), new Set()) : [0, 0, 0]
		if (pre.trim() && !prefixSpec) return null
		const postSpec = post.trim() ? matchPart(post.trim(), chain[chain.length - 1], pseudoStates) : [0, 0, 0]
		if (post.trim() && !postSpec) return null
		for (const branch of splitTopLevelCommas(inner)) {
			if (matchChain(branch, chain, new Set())) {
				return [prefixSpec[0] + postSpec[0], prefixSpec[1] + postSpec[1], prefixSpec[2] + postSpec[2]]
			}
		}
		return null
	}
	return matchChain(selector, chain, pseudoStates)
}

function cmpSpec(a, b) {
	for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] - b[k]
	return 0
}

function computeBellStyles(buttonClasses, rootClasses = new Set(), pseudoStates = new Set()) {
	const rules = parseRules(CSS)
	const resolved = {}
	for (const r of rules) {
		const spec = matchBellSelector(r.selector, buttonClasses, rootClasses, pseudoStates)
		if (!spec) continue
		for (const [prop, value] of Object.entries(r.decls)) {
			const prev = resolved[prop]
			if (!prev || cmpSpec(spec, prev.spec) >= 0) {
				resolved[prop] = {value, spec, order: r.order}
			}
		}
	}
	return Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.value]))
}

describe('desktop top bar bell styles', () => {
	test('.desk-top .top-bell wins padding, display, width, and color over scoped bar button defaults', () => {
		const bell = computeBellStyles(new Set(['top-bell']))
		assert.equal(bell.padding, '0')
		assert.equal(bell.display, 'inline-grid')
		assert.equal(bell.width, '30px')
		assert.equal(bell.color, 'rgba(255, 255, 255, 0.82)')

		const lit = computeBellStyles(new Set(['top-bell', 'lit']))
		assert.equal(lit.color, 'var(--accent-text)')
	})

	test('.style-daylight .desk-top .top-bell uses dark ink, keeps 30px width, and gets dark hover/on tint', () => {
		const daylight = new Set(['style-daylight'])
		const bell = computeBellStyles(new Set(['top-bell']), daylight)
		assert.equal(bell.color, 'rgba(0, 0, 0, 0.62)')
		assert.equal(bell.width, '30px')

		const hovered = computeBellStyles(new Set(['top-bell']), daylight, new Set(['hover']))
		assert.equal(hovered.width, '30px')
		assert.equal(hovered.background, 'rgba(0, 0, 0, 0.08)')

		const lit = computeBellStyles(new Set(['top-bell', 'lit']), daylight)
		assert.equal(lit.color, 'var(--accent-text)')
	})
})
