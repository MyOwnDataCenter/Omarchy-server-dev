// Pool “last check” wording, including a scrub that did not finish and a ZFS pool never checked.
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createStorage, zfsScrub} from '../omarchyd/storage.mjs'
import {poolCheckText} from '../web/src/storageList.ts'

const root = await mkdtemp(join(os.tmpdir(), 'pool-check-'))
after(() => rm(root, {recursive: true, force: true}))

test('a finished scrub with no errors is the only clean result', () => {
	const started = 'Tue Nov 10 03:00:00 2026'
	assert.match(poolCheckText({errors: 0, kind: 'btrfs', scrub: {state: 'finished', errors: '', started}}), /^Last checked .+ no errors$/)
	assert.equal(poolCheckText({errors: 0, kind: 'btrfs', scrub: {state: 'aborted', errors: '', started}}), 'Last check did not finish')
	assert.equal(poolCheckText({errors: 0, kind: 'btrfs', scrub: {state: 'interrupted', errors: '', started}}), 'Last check did not finish')
	assert.equal(poolCheckText({errors: 0, kind: 'btrfs', scrub: {state: 'never', errors: '', started: null}}), 'Never checked for errors')
	assert.equal(poolCheckText({errors: 0, kind: 'zfs', scrub: {state: 'never', errors: '', started: null, summary: 'none requested'}}), 'Never checked for errors')
	assert.equal(poolCheckText({errors: 0, kind: 'zfs', scrub: {state: 'finished', errors: '', started: null, summary: 'scrub repaired 0B in 00:01:00 with 0 errors'}}), 'Last check: repaired 0B in 00:01:00 with 0 errors')
	assert.equal(poolCheckText({errors: 0, kind: 'btrfs', scrub: {state: 'running', errors: '', started}}), 'Checking for errors now…')
	const src = readFileSync(new URL('../web/src/screens/Storage.tsx', import.meta.url), 'utf8')
	assert.match(src, /poolCheckText\(p\)/)
	assert.doesNotMatch(src, /Last checked \$\{/)
})

test('a ZFS pool whose scan is “none requested” was never checked', async () => {
	assert.equal(zfsScrub('none requested').state, 'never')
	assert.equal(zfsScrub('').state, 'never')
	assert.equal(zfsScrub('scrub in progress').state, 'running')
	assert.equal(zfsScrub('scrub repaired 0B in 00:01:00 with 0 errors').state, 'finished')
	const data = join(root, 'data')
	await mkdir(data)
	const fstab = join(root, 'fstab')
	await import('node:fs/promises').then((fs) => fs.writeFile(fstab, ''))
	const pool = {name: 'tank', size: 10, used: 1, free: 9, health: 'ONLINE', mountpoint: '/tank', folder: null, state: 'ONLINE', scan: 'none requested', errors: 'No known data errors', layout: 'stripe', devices: []}
	const run = async (cmd, args) => {
		if (cmd === 'lsblk') return JSON.stringify({blockdevices: []})
		if (cmd === 'sudo' && args[2] === 'ping') return 'ok\n'
		if (cmd === 'sudo' && args[2] === 'zfs-available') return 'yes\n'
		if (cmd === 'sudo' && args[2] === 'zfs-pools') return `${JSON.stringify([pool])}\n`
		return ''
	}
	const s = createStorage({dataDir: data, home: '/home/chris', files: {resolve: async () => ({real: '', top: 'Home'})}, run, fstabPath: fstab})
	const [got] = await s.procedures['storage.pools'].run()
	assert.equal(got.kind, 'zfs')
	assert.equal(got.scrub.state, 'never')
	assert.equal(poolCheckText(got), 'Never checked for errors')
})
