// A store can be a repository, one branch, or one pull request (to try a submission before approving it).
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {storeSource} from '../omarchyd/apps.mjs'

test('a plain repository uses its default branch', () => {
	assert.deepEqual(storeSource('https://github.com/MyOwnDataCenter/Modc-app-store'), {remote: 'https://github.com/MyOwnDataCenter/Modc-app-store', ref: 'HEAD'})
	assert.deepEqual(storeSource('https://git.example.com/me/store'), {remote: 'https://git.example.com/me/store', ref: 'HEAD'})
})

test('a GitHub pull request link fetches that pull request', () => {
	const s = storeSource('https://github.com/MyOwnDataCenter/Modc-app-store/pull/12')
	assert.equal(s.remote, 'https://github.com/MyOwnDataCenter/Modc-app-store')
	assert.equal(s.ref, 'pull/12/head')
	assert.equal(s.label, 'pull request #12')
})

test('a GitHub branch link fetches that branch, and odd branch names are not used as one', () => {
	const s = storeSource('https://github.com/someone/Modc-app-store/tree/add-notes')
	assert.equal(s.remote, 'https://github.com/someone/Modc-app-store')
	assert.equal(s.ref, 'refs/heads/add-notes')
	assert.equal(storeSource('https://github.com/someone/Modc-app-store/tree/feat/notes').ref, 'refs/heads/feat/notes')
	for (const bad of ['-upload-pack=x', 'a..b', 'x.lock']) assert.equal(storeSource(`https://github.com/someone/store/tree/${bad}`).ref, 'HEAD', bad)
})
