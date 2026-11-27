// Folders an app lets you place yourself (its listing's `folders:`), and the proof header its
// sign-in gateway adds (x-omarchy-gateway) for apps that leave sign-in to Omarchy Server.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {folderAllowed, folderChoices, missingVars} from '../omarchyd/apps.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

test('folder declarations: only sensible ids and names; FOLDER_ variables count as provided', () => {
	assert.deepEqual(folderChoices([{id: 'projects', label: 'Your projects', suggest: 'Projects'}, {id: '../x'}, {id: 'Bad'}, {id: 'ok', suggest: '../etc'}]), [
		{id: 'projects', label: 'Your projects', detail: '', suggest: 'Projects'},
		{id: 'ok', label: 'ok', detail: '', suggest: null},
	])
	assert.deepEqual(missingVars('x: ${FOLDER_PROJECTS}\ny: ${NOPE}'), ['NOPE'])
	const home = '/home/chris'
	assert.ok(folderAllowed('/home/chris/Projects', home))
	assert.ok(folderAllowed('/home/chris/Code/work', home))
	for (const bad of ['/home/chris', '/home/chris/.ssh', '/home/chris/a/.git', '/home/chris/../eve', '/etc', 'Projects', '/home/other/x', '/home/chris/a/../../x']) assert.ok(!folderAllowed(bad, home), bad)
})

describe('placing an app’s folders', () => {
	let root, home, data, d, auth, appPort, calls, upstream, store
	const git = (args, cwd) => execFileSync('git', gitArgv(args), {cwd, stdio: 'pipe'}).toString()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return git(args, opts.cwd)
		if (cmd === 'docker-compose') {
			calls.push({args, env: opts.env})
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			if (args[4] === 'ps') return JSON.stringify([{Service: 'web', State: 'running'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			return ''
		}
		if (cmd === 'setfacl') return ''
		throw new Error(`${cmd} not simulated`)
	}
	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const body = await (await fetch(url, init)).json()
		if (body.error) throw new Error(body.error.message)
		return body.result.data
	}
	const q = (p, i) => call(p, i, 'query')
	const until = async (fn, ms = 5000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn().catch(() => null)
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 40))
		}
	}
	const lastEnv = () => calls.filter((c) => c.env).at(-1).env
	const installed = () => until(async () => (await q('apps.list')).find((a) => a.id === 'devbox' && a.state === 'running'))
	const uninstall = async () => {
		await call('apps.uninstall', {appId: 'devbox'})
		await until(async () => !(await q('apps.list')).some((a) => a.id === 'devbox'))
	}

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-folders-'))
		home = join(root, 'home')
		data = join(root, 'data')
		calls = []
		await mkdir(home, {recursive: true})
		const sock = join(root, 'podman.sock')
		await writeFile(sock, '')
		process.env.DOCKER_HOST = `unix://${sock}`
		appPort = 30000 + Math.floor(Math.random() * 2700)
		store = join(root, 'store')
		await mkdir(join(store, 'devbox'), {recursive: true})
		await writeFile(join(store, 'devbox/omarchy-app.yml'), `manifestVersion: 1\nid: devbox\nname: Devbox\nversion: "1"\nport: ${appPort}\nweb:\n  service: web\n  port: 8787\nfolders:\n  - id: projects\n    label: Your projects\n    detail: Where it keeps your projects.\n    suggest: Projects\n`)
		await writeFile(join(store, 'devbox/docker-compose.yml'), 'services:\n  web:\n    image: example/devbox:1\n    environment:\n      GATEWAY_KEY: ${APP_GATEWAY_KEY}\n    volumes:\n      - ${APP_DATA_DIR:-.}/data/home:/data/home\n      - ${FOLDER_PROJECTS:-./data/projects}:/data/home/Projects\n    ports:\n      - "8787:8787"\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, home, webPort: 7798, appOptions: {run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null}})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
		await call('appStore.addRepository', {url: `file://${store}`})
	})
	after(async () => {
		await d?.close()
		upstream?.close()
		await rm(root, {recursive: true, force: true})
	})

	test('the store and the install review show the choice, suggested under your home', async () => {
		const listing = (await q('appStore.registry'))[0].apps[0]
		assert.deepEqual(listing.folders, [{id: 'projects', label: 'Your projects', detail: 'Where it keeps your projects.', suggest: 'Projects'}])
		assert.equal(listing.caution, undefined, 'FOLDER_PROJECTS isn’t an unknown setting')
		assert.equal(listing.permissions, undefined, 'permissions are computed at install review, not at index')
		const review = await q('apps.installReview', {appId: 'devbox'})
		assert.equal(review.home, home)
		assert.deepEqual(review.permissions, [], 'kept inside the app, it asks for nothing extra')
		assert.deepEqual(review.folders, [{id: 'projects', label: 'Your projects', detail: 'Where it keeps your projects.', suggest: join(home, 'Projects'), appId: 'devbox', appName: 'Devbox'}])
	})

	test('by default the folder stays inside the app', async () => {
		await call('apps.install', {appId: 'devbox'})
		await installed()
		assert.match(lastEnv().FOLDER_PROJECTS, /\/devbox\/folders\/projects$/)
		await uninstall()
	})

	test('climbing out of a folder you placed cannot bind a hidden folder', async () => {
		const store2 = join(root, 'climb-store')
		await mkdir(join(store2, 'climber'), {recursive: true})
		await writeFile(join(store2, 'climber/omarchy-app.yml'), `manifestVersion: 1\nid: climber\nname: Climber\nversion: "1"\nport: ${appPort + 1}\nweb:\n  service: web\n  port: 8787\nfolders:\n  - id: projects\n    label: Your projects\n    suggest: Projects\n`)
		await writeFile(join(store2, 'climber/docker-compose.yml'), 'services:\n  web:\n    image: x\n    volumes:\n      - ${FOLDER_PROJECTS}/../.ssh:/keys\n')
		git(['init', '-q', '-b', 'main'], store2)
		git(['add', '.'], store2)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store2)
		await call('appStore.addRepository', {url: `file://${store2}`})
		const mine = join(home, 'Projects')
		const review = await q('apps.installReview', {appId: 'climber'})
		assert.ok(review.permissions.some((p) => p.id === 'refused'), 'review uses the suggested folder, not the in-app default')
		await assert.rejects(call('apps.install', {appId: 'climber', folders: [{appId: 'climber', id: 'projects', path: mine}]}), /never gives an app/)
		assert.equal((await q('apps.list')).find((a) => a.id === 'climber'), undefined)
		await call('appStore.removeRepository', {url: `file://${store2}`})
	})

	test('folders Omarchy Server won’t give an app are refused, and nothing installs', async () => {
		await mkdir(join(home, 'Links'), {recursive: true})
		await symlink('/etc', join(home, 'Links', 'etc'))
		for (const path of [home, join(home, '.ssh'), '/etc', join(home, '..', 'x'), join(home, 'Links', 'etc', 'cron.d'), 'Projects']) {
			await assert.rejects(call('apps.install', {appId: 'devbox', folders: [{appId: 'devbox', id: 'projects', path}]}), /can’t use|leads outside/, path)
		}
		assert.equal((await q('apps.list')).find((a) => a.id === 'devbox'), undefined)
	})

	test('a folder of yours: made if needed, used by the app, kept across a restart, and left alone on uninstall', async () => {
		const mine = join(home, 'Code', 'Projects')
		await call('apps.install', {appId: 'devbox', folders: [{appId: 'devbox', id: 'projects', path: mine}]})
		const app = await installed()
		assert.ok((await stat(mine)).isDirectory())
		assert.equal(lastEnv().FOLDER_PROJECTS, mine)
		await call('apps.restart', {appId: 'devbox'})
		assert.equal(lastEnv().FOLDER_PROJECTS, mine)
		await writeFile(join(mine, 'keep.txt'), 'mine')

		// Its gateway proves to the app that a request came through Omarchy Server's sign-in.
		let seen = null
		upstream = http.createServer((req, res) => ((seen = req.headers['x-omarchy-gateway']), res.end('ok')))
		await new Promise((r) => upstream.listen(app.internalPort, '127.0.0.1', r))
		const {ticket} = await call('apps.accessTicket', {appId: 'devbox'})
		const enter = await fetch(`http://127.0.0.1:${appPort}/__omarchy/enter?t=${ticket}`, {redirect: 'manual'})
		const cookie = enter.headers.get('set-cookie').split(';')[0]
		await fetch(`http://127.0.0.1:${appPort}/`, {headers: {cookie, 'x-omarchy-gateway': 'typed-by-someone'}})
		assert.equal(seen, lastEnv().APP_GATEWAY_KEY)
		assert.match(seen, /^[0-9a-f]{64}$/)
		// Strangers never reach the app at all.
		assert.equal((await fetch(`http://127.0.0.1:${appPort}/`, {redirect: 'manual', headers: {'x-omarchy-gateway': seen}})).status, 302)
		upstream.close()

		await uninstall()
		assert.ok((await stat(join(mine, 'keep.txt'))).isFile(), 'your folder and its files stay')
	})

	test('“Check for new apps” picks up a listing added to a store just now', async () => {
		await mkdir(join(store, 'newbie'), {recursive: true})
		await writeFile(join(store, 'newbie/omarchy-app.yml'), 'manifestVersion: 1\nid: newbie\nname: Newbie\nport: 31999\n')
		await writeFile(join(store, 'newbie/docker-compose.yml'), 'services:\n  web:\n    image: x\n')
		git(['add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'newbie'], store)
		const ids = async () => (await q('appStore.registry'))[0].apps.map((a) => a.id)
		assert.ok(!(await ids()).includes('newbie'), 'the hourly check hasn’t run yet')
		assert.equal(await call('appStore.refresh'), 2)
		assert.deepEqual((await ids()).sort(), ['devbox', 'newbie'])
	})
})
