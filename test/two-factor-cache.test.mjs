// The two-factor sheet keeps one setup key while it is open, then drops it on close or success
// so the next open asks the server for a new key.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {QueryClient} from '@tanstack/react-query'

import {clearTotpSetupQuery} from '../web/src/screens/twoFactorQuery.ts'

test('close and success drop the cached setup key and leave other queries', () => {
	const qc = new QueryClient()
	qc.setQueryData(['user.generateTotpUri', undefined], 'otpauth://old')
	qc.setQueryData(['user.is2faEnabled', undefined], false)
	clearTotpSetupQuery(qc, 'close')
	assert.equal(qc.getQueryData(['user.generateTotpUri', undefined]), undefined)
	assert.equal(qc.getQueryData(['user.is2faEnabled', undefined]), false)
	qc.setQueryData(['user.generateTotpUri', undefined], 'otpauth://again')
	clearTotpSetupQuery(qc, 'success')
	assert.equal(qc.getQueryData(['user.generateTotpUri', undefined]), undefined)
	assert.equal(qc.getQueryData(['user.is2faEnabled', undefined]), false)
})

test('a reason other than close or success keeps the cached setup key', () => {
	const qc = new QueryClient()
	qc.setQueryData(['user.generateTotpUri', undefined], 'otpauth://keep')
	clearTotpSetupQuery(qc, 'render')
	assert.equal(qc.getQueryData(['user.generateTotpUri', undefined]), 'otpauth://keep')
})

test('the two-factor sheet clears the setup key on close and on success, not on render', async () => {
	const src = await readFile(new URL('../web/src/screens/Settings.tsx', import.meta.url), 'utf8')
	const sheet = src.slice(src.indexOf('function TwoFactorSheet'))
	assert.match(sheet, /clearTotpSetupQuery\(qc, 'close'\)/)
	assert.match(sheet, /clearTotpSetupQuery\(qc, 'success'\)/)
	assert.doesNotMatch(sheet, /useEffect\(\(\) => \{\s*clearTotpSetupQuery/)
	assert.match(sheet, /staleTime: Infinity/)
})
