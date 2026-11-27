import assert from 'node:assert/strict'
import {test} from 'node:test'

import {locateTransferPath} from '../omarchyd/file-transfer.mjs'

test('locateTransferPath accepts server paths and readable computer paths', () => {
	assert.deepEqual(locateTransferPath('/Home/Notes'), {kind: 'server', path: '/Home/Notes'})
	assert.equal(locateTransferPath('/Home/../etc'), null)
	assert.deepEqual(locateTransferPath('::computer/kitchen/Docs/a.txt'), {
		kind: 'computer',
		id: 'kitchen',
		rel: 'Docs/a.txt',
		path: '::computer/kitchen/Docs/a.txt',
	})
	assert.deepEqual(locateTransferPath('::computer/abc123'), {kind: 'computer', id: 'abc123', rel: '', path: '::computer/abc123'})
	assert.equal(locateTransferPath('::computer/../secret'), null)
	assert.equal(locateTransferPath('::guest/abc'), null)
	assert.equal(locateTransferPath(''), null)
})
