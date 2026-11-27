import {test} from 'node:test'
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', gitArgv(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]), {cwd, stdio: 'pipe'}).toString()
async function addApp(work, id) {
	await mkdir(join(work, id), {recursive: true})
	await writeFile(join(work, id, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\ntagline: t\ncategory: files\nport: 9${id.length}00\nweb:\n  service: web\n  port: 80\n`)
	await writeFile(join(work, id, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
}

test('a store that gained apps since it was first downloaded shows them (shallow clones can’t fast-forward)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-sync-'))
	try {
		const origin = join(root, 'origin.git'), work = join(root, 'work')
		git(root, 'init', '-q', '--bare', '-b', 'main', origin)
		git(root, 'clone', '-q', origin, work)
		await addApp(work, 'one')
		git(work, 'add', '-A'); git(work, 'commit', '-qm', 'one'); git(work, 'push', '-q', 'origin', 'HEAD:main')
		const run = async (cmd, args, o = {}) => (cmd === 'git' ? execFileSync('git', args, {cwd: o.cwd, stdio: 'pipe'}).toString() : '')
		const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run})
		const ids = async () => (await apps.procedures['appStore.registry'].run())[0].apps.map((a) => a.id).sort()
		assert.deepEqual(await ids(), ['one'])
		for (const id of ['two', 'three']) {
			await addApp(work, id)
			git(work, 'add', '-A'); git(work, 'commit', '-qm', id); git(work, 'push', '-q', 'origin', 'HEAD:main')
		}
		apps.close()
		// The next process, after the hourly window, takes the store's latest commit.
		const stateFile = join(root, 'data', 'apps', 'apps.json')
		const {readFile} = await import('node:fs/promises')
		const st = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'))
		for (const s of st.stores ?? []) s.syncedAt = 0
		if (st.stores) await writeFile(stateFile, JSON.stringify(st))
		const again = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run})
		try {
			assert.deepEqual((await again.procedures['appStore.registry'].run())[0].apps.map((a) => a.id).sort(), ['one', 'three', 'two'])
		} finally {
			again.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

async function seedStore(dir) {
	await mkdir(join(dir, 'one'), {recursive: true})
	await writeFile(join(dir, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	await writeFile(join(dir, 'one', 'omarchy-app.yml'), 'manifestVersion: 1\nid: one\nname: One\ntagline: t\ncategory: files\nport: 9100\nweb:\n  service: web\n  port: 80\n')
	await writeFile(join(dir, 'one', 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
}

test('overlapping registry reads share one download and a failed download rejects both', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-flight-'))
	const origin = join(root, 'origin')
	await seedStore(origin)
	let clones = 0
	let release
	const gate = new Promise((r) => (release = r))
	const run = async (cmd, args) => {
		if (cmd !== 'git') return ''
		if (args[0] !== 'clone') return ''
		clones++
		const dest = args.at(-1)
		await gate
		await seedStore(dest)
		return ''
	}
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run, systemApps: null})
	try {
		const first = apps.procedures['appStore.registry'].run()
		const second = apps.procedures['appStore.registry'].run()
		await new Promise((r) => setTimeout(r, 100))
		assert.equal(clones, 1, 'the second read must not start another download')
		release()
		const [a, b] = await Promise.all([first, second])
		assert.deepEqual(a[0].apps.map((app) => app.id), ['one'])
		assert.deepEqual(b[0].apps.map((app) => app.id), ['one'])
	} finally {
		apps.close()
	}

	let failed = 0
	const failRun = async (cmd, args) => {
		if (cmd === 'git' && args[0] === 'clone') {
			failed++
			throw new Error('clone failed')
		}
		return ''
	}
	const again = createApps({dataDir: join(root, 'data-fail'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run: failRun, systemApps: null})
	try {
		const one = again.procedures['appStore.registry'].run()
		const two = again.procedures['appStore.registry'].run()
		await assert.rejects(one, /clone failed/)
		await assert.rejects(two, /clone failed/)
		assert.equal(failed, 1, 'both callers share the failed download')
		await assert.rejects(again.procedures['appStore.registry'].run(), /clone failed/)
		assert.equal(failed, 2, 'a settled failure is not reused')
	} finally {
		again.close()
		await rm(root, {recursive: true, force: true})
	}
})
