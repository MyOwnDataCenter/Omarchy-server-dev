// The share-a-key sheet lists accounts as buttons; each must report whether the key is shared with it.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

test('share key account rows are checkboxes with aria-checked', () => {
	const s = readFileSync(new URL('../web/src/screens/Settings.tsx', import.meta.url), 'utf8')
	assert.match(s, /key=\{a\.userId\} className="row"[^>]*role="checkbox" aria-checked=\{picked\.includes\(a\.userId\)\}/)
})
