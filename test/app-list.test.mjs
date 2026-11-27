// The app list stays quick and current while apps install: one podman check for all apps,
// shared between polls, and never held up while podman is busy downloading an image.
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

describe('the app list while apps install', () => {
	let root, home, data, d, auth, appPort, calls, upstream, store
	let psCalls = 0, composePs = 0, psHang = null
	const running = new Set()
	const git = (args, cwd) => execFileSync('git', gitArgv(args), {cwd, stdio: 'pipe'}).toString()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return git(args, opts.cwd)
		if (cmd === 'docker-compose') {
			calls.push({args, env: opts.env})
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			if (args[4] === 'ps') (composePs++, await psHang)
			if (args[4] === 'ps') return JSON.stringify([{Service: 'web', State: 'running'}])
			// The download for an install is what keeps podman busy.
			if (args[4] === 'pull' || args[4] === 'up') await psHang
			if (args[4] === 'up') running.add(args[1].replace('omarchy-', ''))
			if (args[4] === 'stop') running.delete(args[1].replace('omarchy-', ''))
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'ps') {
				psCalls++
				// Podman busy (a big image downloading): ps waits until it's done.
				if (psHang) await psHang
				return JSON.stringify([...running].map((id) => ({Names: [`omarchy-${id}_web_1`], State: 'running', Labels: {'com.docker.compose.project': `omarchy-${id}`}})))
			}
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
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-list-'))
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
		for (const id of ['alpha', 'beta']) {
			await mkdir(join(store, id), {recursive: true})
			await writeFile(join(store, `${id}/omarchy-app.yml`), `manifestVersion: 1\nid: ${id}\nname: ${id}\nversion: "1"\nport: ${appPort + (id === 'alpha' ? 1 : 2)}\n`)
			await writeFile(join(store, `${id}/docker-compose.yml`), 'services:\n  web:\n    image: example/x:1\n')
		}
		git(['init', '-q', '-b', 'main'], store)
		git(['add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, home, webPort: 7797, appOptions: {run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null}})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
		await call('appStore.addRepository', {url: `file://${store}`})
	})
	after(async () => {
		await d?.close()
		upstream?.close()
		await rm(root, {recursive: true, force: true})
	})

	const listed = async () => Object.fromEntries((await q('apps.list')).map((a) => [a.id, a.state]))
	const waitRunning = (id) => until(async () => (await listed())[id] === 'running')

	test('one podman check for all apps, not one docker-compose per app', async () => {
		for (const id of ['devbox', 'alpha']) {
			await call('apps.install', {appId: id})
			await waitRunning(id)
		}
		await new Promise((r) => setTimeout(r, 1600))
		psCalls = composePs = 0
		await Promise.all([q('apps.list'), q('apps.list'), q('apps.list')])
		assert.equal(psCalls, 1, 'polls that arrive together share one check')
		assert.equal(composePs, 0)
		await call('apps.stop', {appId: 'alpha'})
		assert.equal((await listed()).alpha, 'stopped', 'looks again after a change')
		await call('apps.start', {appId: 'alpha'})
		assert.equal((await listed()).alpha, 'running')
	})

	test('while podman is busy, the list still answers quickly and a new install shows up at once', async () => {
		await new Promise((r) => setTimeout(r, 1600))
		let release
		psHang = new Promise((r) => (release = r))
		const t0 = Date.now()
		const during = await listed()
		assert.ok(Date.now() - t0 < 4500, `answered in ${Date.now() - t0} ms`)
		assert.equal(during.devbox, 'running', 'last known state')
		await call('apps.install', {appId: 'beta'})
		const t1 = Date.now()
		const b = (await q('apps.list')).find((a) => a.id === 'beta')
		assert.equal(b.state, 'installing', b.error)
		assert.ok(Date.now() - t1 < 4500)
		release()
		psHang = null
		await waitRunning('beta')
	})
})
