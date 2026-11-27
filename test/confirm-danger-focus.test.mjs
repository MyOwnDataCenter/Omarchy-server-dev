// A destructive confirm must open with focus on Cancel, not on the destructive button.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {getInitialFocusTarget} from '../web/src/focus.ts'

const UI = readFileSync(new URL('../web/src/ui.tsx', import.meta.url), 'utf8')

test('the Confirm sheet marks Cancel for autofocus only when the action is dangerous', () => {
	const cancel = UI.match(/<button className="btn block ghost"(.*)\n\s*Cancel\n/)
	assert.ok(cancel, 'Confirm Cancel button not found')
	assert.match(cancel[1], /data-autofocus=\{pending\.danger \|\| undefined\}/)
	const confirmBtn = UI.match(/<button className=\{`btn block \$\{pending\.danger.*\n/)
	assert.ok(confirmBtn, 'Confirm action button not found')
	assert.doesNotMatch(confirmBtn[0], /autofocus/i)
})

test('initial focus prefers the data-autofocus element over the first focusable one', () => {
	const el = (name, attrs = {}) => ({name, attrs, disabled: false, isConnected: true, getAttribute: (k) => attrs[k] ?? null, closest: () => null, focus() {}})
	const confirm = el('confirm')
	const cancel = el('cancel', {'data-autofocus': 'true'})
	const container = {
		contains: (x) => x === confirm || x === cancel,
		querySelector: (sel) => (sel.includes('data-autofocus') ? cancel : null),
		querySelectorAll: () => [confirm, cancel],
	}
	assert.equal(getInitialFocusTarget(container, null), cancel)
})

test('plugin removal confirms are marked danger: true so Cancel receives initial focus', () => {
	const plugins = readFileSync(new URL('../web/src/screens/Plugins.tsx', import.meta.url), 'utf8')
	const swarm = readFileSync(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	assert.match(plugins, /confirm\(\{title: `Remove \$\{p\.name\}\?`[^\n]*danger:\s*true/)
	assert.match(swarm, /confirm\(\{title: `Remove \$\{id\}\?`[^\n]*danger:\s*true/)
})
