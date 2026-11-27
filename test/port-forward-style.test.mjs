// The port-forward form’s pf-* classes have layout rules.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

test('styles.css lays out the forward-a-port form', () => {
	const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
	for (const sel of ['.pf-add', '.pf-fields', '.pf-presets', '.pf-actions']) assert.match(css, new RegExp(`${sel.replace('.', '\\.')}\\s*[,{]`))
	assert.match(css, /\.pf-add\s*\{[^}]*padding:[^}]*gap:/s)
	assert.match(css, /\.pf-fields\s*\{[^}]*(?:grid|flex)/s)
	assert.match(css, /\.pf-presets\s*,\s*\.pf-actions\s*\{[^}]*flex[^}]*gap:/s)
})
