// Compact app-store index: the browse list is light, a single-app query has the rest, and
// updates() reads the registry once for every installed app.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', gitArgv(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]), {cwd, stdio: 'pipe'}).toString()

async function addApp(work, id, {version = '1.0', extraYml = '', compose = 'services:\n  web:\n    image: nginx\n    volumes:\n      - ${APP_DATA_DIR}/data:/data\n'} = {}) {
	await mkdir(join(work, id), {recursive: true})
	await writeFile(
		join(work, id, 'omarchy-app.yml'),
		`manifestVersion: 1
id: ${id}
name: ${id}
tagline: a ${id} tagline
category: files
version: "${version}"
developer: Demo
website: https://example.com/${id}
description: |
  Long description of ${id} that should not be in the browse list.
releaseNotes: |
  Notes for ${id}.
gallery:
  - https://example.com/${id}/1.png
  - https://example.com/${id}/2.png
port: 9${String(id.length).padStart(3, '0')}
web:
  service: web
  port: 80
${extraYml}`,
	)
	await writeFile(join(work, id, 'docker-compose.yml'), compose)
}

function mockRun(root) {
	const up = new Set()
	return async (cmd, args, opts = {}) => {
		if (cmd === 'git') return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(args[1]) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			if (args[0] === 'network' && args[1] === 'exists') throw new Error('no such network')
			return ''
		}
		if (cmd === 'setfacl') return ''
		if (cmd === 'bwrap') return ''
		throw new Error(`${cmd} not simulated`)
	}
}

const until = async (fn, ms = 8000) => {
	const end = Date.now() + ms
	for (;;) {
		const v = await fn()
		if (v) return v
		if (Date.now() > end) throw new Error('timed out')
		await new Promise((r) => setTimeout(r, 40))
	}
}

const root = await mkdtemp(join(os.tmpdir(), 'store-index-'))
after(() => rm(root, {recursive: true, force: true}))

test('registry list is compact; appStore.app has the rest; installReview still has permissions', async () => {
	const origin = join(root, 'origin.git')
	const work = join(root, 'work')
	const data = join(root, 'data')
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`
	git(root, 'init', '-q', '--bare', '-b', 'main', origin)
	git(root, 'clone', '-q', origin, work)
	await addApp(work, 'photos', {
		compose: 'services:\n  web:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - ${APP_DATA_DIR}/data:/data\n',
	})
	git(work, 'add', '-A')
	git(work, 'commit', '-qm', 'photos')
	git(work, 'push', '-q', 'origin', 'HEAD:main')

	const apps = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run: mockRun(root)})
	try {
		const list = (await apps.procedures['appStore.registry'].run())[0].apps[0]
		assert.equal(list.id, 'photos')
		assert.equal(list.name, 'photos')
		assert.equal(list.tagline, 'a photos tagline')
		assert.equal(list.developer, 'Demo')
		assert.equal(list.category, 'files')
		assert.equal(list.version, '1.0')
		assert.equal(list.folder, undefined, 'server paths stay private')
		assert.equal(list.description, undefined)
		assert.equal(list.releaseNotes, undefined)
		assert.equal(Array.isArray(list.gallery), false)
		assert.equal(list.permissions, undefined)
		assert.ok(list.shots === 2 || list.gallery === true || list.hasGallery === true, 'browse list still knows it has screenshots')
		assert.ok(!JSON.stringify(list).includes(data), 'store folder is not sent')
		assert.ok(!JSON.stringify(list).includes('docker-compose'), 'compose text is not sent')

		const detail = await apps.procedures['appStore.app'].run({appId: 'photos'})
		assert.equal(detail.id, 'photos')
		assert.match(detail.description, /Long description of photos/)
		assert.match(detail.releaseNotes, /Notes for photos/)
		assert.deepEqual(detail.gallery, ['https://example.com/photos/1.png', 'https://example.com/photos/2.png'])
		assert.equal(detail.website, 'https://example.com/photos')
		assert.equal(detail.folder, undefined, 'detail also hides the store path')
		assert.ok(!JSON.stringify(detail).includes(join(data, 'apps', 'stores')), 'detail has no store folder')
		assert.ok(detail.permissions?.includes('containers'), 'detail can include permissions; the list must not')

		await assert.rejects(apps.procedures['appStore.app'].run({appId: 'no-such-app'}), (e) => e.code === 'NOT_FOUND')

		const review = await apps.procedures['apps.installReview'].run({appId: 'photos'})
		assert.ok(review.permissions.some((p) => p.id === 'containers'), 'installReview still reports permissions from compose on disk')

		await apps.procedures['apps.install'].run({appId: 'photos', grant: ['containers']})
		await until(async () => (await apps.procedures['apps.list'].run()).find((a) => a.id === 'photos' && a.state === 'running'))
		await readFile(join(data, 'apps', 'installed', 'photos', 'compose.omarchy.yml'), 'utf8')
	} finally {
		apps.close()
	}
})

test('apps.updates reports every installed app from one registry load', async () => {
	const origin = join(root, 'updates.git')
	const work = join(root, 'updates-work')
	const data = join(root, 'updates-data')
	const sock = join(root, 'updates.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`
	git(root, 'init', '-q', '--bare', '-b', 'main', origin)
	git(root, 'clone', '-q', origin, work)
	await addApp(work, 'alpha', {version: '1.0'})
	await addApp(work, 'beta', {version: '1.0'})
	git(work, 'add', '-A')
	git(work, 'commit', '-qm', 'v1')
	git(work, 'push', '-q', 'origin', 'HEAD:main')

	const run = mockRun(root)
	const apps = createApps({dataDir: data, home: join(root, 'updates-home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run})
	try {
		await apps.procedures['apps.install'].run({appId: 'alpha'})
		await apps.procedures['apps.install'].run({appId: 'beta'})
		await until(async () => (await apps.procedures['apps.list'].run()).filter((a) => ['alpha', 'beta'].includes(a.id) && a.state === 'running').length === 2)

		await addApp(work, 'alpha', {version: '2.0'})
		await addApp(work, 'beta', {version: '2.1'})
		git(work, 'add', '-A')
		git(work, 'commit', '-qm', 'v2')
		git(work, 'push', '-q', 'origin', 'HEAD:main')
		await apps.procedures['appStore.refresh'].run()

		const updates = await apps.procedures['apps.updates'].run()
		assert.deepEqual(
			updates.sort((a, b) => a.id.localeCompare(b.id)),
			[
				{id: 'alpha', version: '2.0'},
				{id: 'beta', version: '2.1'},
			],
		)
	} finally {
		apps.close()
	}
})

test('registry does not rewrite apps.json when store meta is unchanged', async () => {
	const origin = join(root, 'stable.git')
	const work = join(root, 'stable-work')
	const data = join(root, 'stable-data')
	git(root, 'init', '-q', '--bare', '-b', 'main', origin)
	git(root, 'clone', '-q', origin, work)
	await addApp(work, 'one', {version: '1.0'})
	git(work, 'add', '-A')
	git(work, 'commit', '-qm', 'one')
	git(work, 'push', '-q', 'origin', 'HEAD:main')

	const first = createApps({dataDir: data, home: join(root, 'stable-home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run: mockRun(root)})
	await first.procedures['appStore.registry'].run()
	first.close()
	const stateFile = join(data, 'apps', 'apps.json')
	const before = await stat(stateFile)
	await new Promise((r) => setTimeout(r, 30))
	const again = createApps({dataDir: data, home: join(root, 'stable-home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run: mockRun(root)})
	try {
		await again.procedures['appStore.registry'].run()
		const after = await stat(stateFile)
		assert.equal(after.mtimeMs, before.mtimeMs, 'unchanged store meta does not rewrite apps.json')
	} finally {
		again.close()
	}
})
