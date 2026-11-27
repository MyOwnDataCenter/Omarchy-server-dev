// The project's GitHub account moved (TouchWorkStation → MyOwnDataCenter, omarchy-server → server).
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps, isGithubAppStore} from '../omarchyd/apps.mjs'
import {movedGithubUrl} from '../omarchyd/moved.mjs'
import {INSTALL_COMMAND, REPO_RAW} from '../omarchyd/updater.mjs'

test('old addresses map to the new account; the server repo is now "server", the rest keep their names', () => {
	assert.equal(movedGithubUrl('https://github.com/TouchWorkStation/omarchy-server.git'), 'https://github.com/MyOwnDataCenter/server.git')
	assert.equal(movedGithubUrl('https://github.com/touchworkstation/omarchy-server'), 'https://github.com/MyOwnDataCenter/server')
	assert.equal(movedGithubUrl('git@github.com:TouchWorkStation/omarchy-server.git'), 'git@github.com:MyOwnDataCenter/server.git')
	assert.equal(movedGithubUrl('https://github.com/TouchWorkStation/app-store'), 'https://github.com/MyOwnDataCenter/app-store')
	assert.equal(movedGithubUrl('https://github.com/TouchWorkStation/Modc-app-store/'), 'https://github.com/MyOwnDataCenter/Modc-app-store/')
	assert.equal(movedGithubUrl('https://github.com/TouchWorkStation/omarchy-server-dev.git'), 'https://github.com/MyOwnDataCenter/omarchy-server-dev.git')
	assert.equal(movedGithubUrl('https://github.com/MyOwnDataCenter/server'), null)
	assert.equal(movedGithubUrl('https://github.com/someone/omarchy-server'), null)
	assert.equal(movedGithubUrl('https://gitlab.com/TouchWorkStation/omarchy-server'), null)
	assert.equal(REPO_RAW, 'https://raw.githubusercontent.com/MyOwnDataCenter/server')
	assert.match(INSTALL_COMMAND, /MyOwnDataCenter\/server\/main\/install\.sh/)
	assert.ok(isGithubAppStore('https://github.com/MyOwnDataCenter/app-store') && isGithubAppStore('https://github.com/TouchWorkStation/app-store'))
})

test('a server’s saved stores and their apps move to the new address, once', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'moved-stores-'))
	try {
		const data = join(root, 'data')
		await mkdir(join(data, 'apps'), {recursive: true})
		await writeFile(
			join(data, 'apps', 'apps.json'),
			JSON.stringify({
				defaultsAdded: true,
				umbrelStoreRemoved: true,
				permissionsVersion: 2,
				stores: [
					{url: 'https://github.com/TouchWorkStation/app-store', syncedAt: 5},
					{url: 'https://github.com/TouchWorkStation/Modc-app-store', syncedAt: 5},
					{url: 'https://github.com/someone/apps', syncedAt: 5},
				],
				apps: [{id: 'chrome', name: 'Chrome', state: 'running', store: 'https://github.com/TouchWorkStation/app-store'}],
				recent: [],
			}),
		)
		const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: []})
		try {
			await apps.ready
			const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
			assert.deepEqual(saved.stores.map((s) => s.url), ['https://github.com/MyOwnDataCenter/app-store', 'https://github.com/MyOwnDataCenter/Modc-app-store', 'https://github.com/someone/apps'])
			assert.equal(saved.stores[0].syncedAt, 0)
			assert.equal(saved.stores[2].syncedAt, 5)
			assert.equal(saved.apps[0].store, 'https://github.com/MyOwnDataCenter/app-store')
			assert.equal(saved.storesMoved, true)
		} finally {
			await apps.close?.()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a copy installed from the old address moves its git origin and updates from the new one', async () => {
	const {createUpdater} = await import('../omarchyd/updater.mjs')
	const dir = await mkdtemp(join(os.tmpdir(), 'moved-origin-'))
	const calls = []
	const run = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '))
		if (args.includes('get-url')) return 'https://github.com/TouchWorkStation/omarchy-server.git\n'
		return ''
	}
	try {
		const u = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '0.9.0', run, fetchImpl: async () => new Response('', {status: 503})})
		assert.equal(await u.source(), 'https://raw.githubusercontent.com/MyOwnDataCenter/server')
		assert.ok(calls.some((c) => c === `git -C ${dir} remote set-url origin https://github.com/MyOwnDataCenter/server.git`))
		u.stop()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
