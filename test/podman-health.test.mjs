// Apps used to fail with only "Cannot connect to the Docker daemon" when Podman itself couldn't start,
// most often because its storage belonged to another home folder (issue #88).
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {podmanHealth} from '../omarchyd/apps.mjs'

const fails = (message, extra = {}) => async () => {
	throw Object.assign(new Error(message), extra)
}

test('storage made for another home folder is named, with the fix', async () => {
	const h = await podmanHealth(fails('podman: Error: database static dir "/home/olduser/.local/share/containers/storage/libpod" does not match our static dir "/home/chris/.local/share/containers/storage/libpod": database configuration mismatch'), {}, '/home/chris')
	assert.equal(h.ok, false)
	assert.match(h.message, /belongs to \/home\/olduser, not to \/home\/chris/)
	assert.match(h.message, /Move ~\/\.local\/share\/containers aside/)
	// It runs, but its storage is still somewhere else.
	const moved = await podmanHealth(async () => JSON.stringify({store: {graphRoot: '/home/olduser/.local/share/containers/storage'}}), {}, '/home/chris')
	assert.match(moved.message, /belongs to \/home\/olduser/)
})

test('a working Podman is fine, and other failures show Podman’s own words', async () => {
	assert.deepEqual(await podmanHealth(async () => JSON.stringify({store: {graphRoot: '/home/chris/.local/share/containers/storage'}}), {}, '/home/chris'), {ok: true})
	assert.deepEqual(await podmanHealth(async () => '', {}, '/home/chris'), {ok: true})
	const other = await podmanHealth(fails('podman: Error: could not find a working conmon binary'), {}, '/home/chris')
	assert.equal(other.message, 'Podman didn’t start: could not find a working conmon binary')
	const missing = await podmanHealth(fails('spawn podman ENOENT', {code: 'ENOENT'}), {}, '/home/chris')
	assert.match(missing.message, /Apps need Podman/)
})
