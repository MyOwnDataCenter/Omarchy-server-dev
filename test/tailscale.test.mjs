// Tailscale, installed on the server itself (omarchyd/system-apps.mjs) rather than in a container.
// Real omarchyd; stand-ins for the root helper, Tailscale's local API (a unix socket) and the
// `tailscale` program (its `web` page and `version`).
import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFileSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {createSystemApps} from '../omarchyd/system-apps.mjs'

const FAKE_TAILSCALE = `#!${process.execPath}
const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'version') { console.log('1.104.7\\n  tailscale commit: test'); process.exit(0) }
if (cmd === 'web') {
	const [host, port] = rest[rest.indexOf('--listen') + 1].split(':')
	require('fs').writeFileSync(process.env.FAKE_TS_PID, String(process.pid))
	require('http').createServer((req, res) => {
		if (req.url === '/api/data') return res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({Status: 'NeedsLogin', listen: host + ':' + port}))
		res.end('<!doctype html><title>Tailscale</title>')
	}).listen(Number(port), host, () => console.log('web server running on: http://' + host + ':' + port))
} else process.exit(2)
`

describe('Tailscale on the system', () => {
	let root, sockDir, data, d, auth, port, helperCalls, helperAnswer, operator, helperFile, prefs, apiRequests, socketPath, api, composeCalls, bin
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
	const wait = (ms) => new Promise((r) => setTimeout(r, ms))
	const until = async (fn, ms = 8000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn().catch(() => null)
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await wait(50)
		}
	}
	const tailscale = async () => (await q('apps.list')).find((a) => a.id === 'tailscale')
	const helper = async (verb) => {
		helperCalls.push(verb)
		if (helperAnswer[verb] instanceof Error) throw helperAnswer[verb]
		// What the real verbs leave behind: you as Tailscale's operator, or no Tailscale at all.
		if (verb === 'tailscale-setup') operator = true
		if (verb === 'tailscale-remove') operator = false
		return helperAnswer[verb] ?? 'ok'
	}
	const systemApps = () =>
		createSystemApps({
			helper,
			helperFile,
			socketPath,
			tailscaleBin: bin,
			restartDelayMs: 150,
			ports: {tailscale: port},
			run: async (cmd, args) => {
				if (cmd === bin && args[0] === 'version') return '1.104.7\n'
				if (cmd === 'journalctl') return 'tailscaled[1]: Program starting\n'
				throw new Error(`${cmd} not simulated`)
			},
		})
	const boot = async () => {
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home: join(root, 'home'),
			webPort: 7797,
			appOptions: {
				run: async (cmd, args) => {
					composeCalls.push([cmd, ...args].join(' '))
					if (cmd === 'git') return execFileSync('git', args, {stdio: 'pipe'}).toString()
					return ''
				},
				allowFileStores: true,
				gatewayHost: '127.0.0.1',
				defaultStores: [],
				systemApps: systemApps(),
			},
		})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	}

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchy-tailscale-'))
		data = join(root, 'data')
		port = 29300 + Math.floor(Math.random() * 600) // below the ephemeral range, clear of the other app tests
		helperCalls = []
		helperAnswer = {'tailscale-setup': JSON.stringify({installedPackage: true})}
		operator = false
		helperFile = join(root, 'helper.mjs')
		await writeFile(helperFile, "const verbs = {\n\t'tailscale-setup': async () => {},\n\t'tailscale-remove': async () => {},\n}\n")
		composeCalls = []
		bin = join(root, 'tailscale')
		await writeFile(bin, FAKE_TAILSCALE)
		await chmod(bin, 0o755)
		process.env.FAKE_TS_PID = join(root, 'web.pid')
		// Tailscale's local API: only accepts what the real one does (its Host, no Origin or Referer).
		prefs = {WantRunning: true}
		apiRequests = []
		sockDir = await mkdtemp('/tmp/om-ts-')
		socketPath = join(sockDir, 'tailscaled.sock')
		api = http.createServer((req, res) => {
			let body = ''
			req.on('data', (c) => (body += c))
			req.on('end', () => {
				apiRequests.push(`${req.method} ${req.url}`)
				if (req.headers.host !== 'local-tailscaled.sock' || req.headers.origin || req.headers.referer) return res.writeHead(403).end('invalid localapi request')
				if (req.method === 'PATCH' && req.url === '/localapi/v0/prefs') {
					// Like the real one: changing settings is for its operator (or root) only.
					if (!operator) return res.writeHead(403).end('Access denied: prefs write access denied')
					const p = JSON.parse(body)
					if (p.WantRunningSet) prefs.WantRunning = p.WantRunning
					return res.end(JSON.stringify(prefs))
				}
				if (req.method === 'GET' && req.url === '/localapi/v0/status?peers=false') return res.end(JSON.stringify({BackendState: prefs.WantRunning ? 'NeedsLogin' : 'Stopped'}))
				res.writeHead(404).end()
			})
		})
		await new Promise((resolve, reject) => {
			api.once('error', reject)
			api.listen(socketPath, () => {
				api.off('error', reject)
				resolve()
			})
		})
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		// A store that also lists an app called "tailscale" (as a container).
		const store = join(root, 'store')
		await mkdir(join(store, 'tailscale'), {recursive: true})
		await writeFile(join(store, 'tailscale', 'omarchy-app.yml'), 'manifestVersion: 1\nid: tailscale\nname: Container Tailscale\nport: 8241\nweb:\n  service: web\n  port: 8240\n')
		await writeFile(join(store, 'tailscale', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    network_mode: host\n')
		for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 's']]) execFileSync('git', gitArgv(args), {cwd: store, stdio: 'pipe'})
		await boot()
		await call('appStore.addRepository', {url: `file://${store}`})
	})
	after(async () => {
		await d?.close()
		api?.close()
		if (sockDir) await rm(sockDir, {recursive: true, force: true})
		if (root) await rm(root, {recursive: true, force: true})
	})

	test('listed first, as part of Omarchy Server; a store’s own “tailscale” can’t stand in for it', async () => {
		const reg = await q('appStore.registry')
		assert.equal(reg[0].meta.name, 'MODC')
		const listing = reg[0].apps.find((a) => a.id === 'tailscale')
		assert.equal(listing.system, true)
		assert.equal(listing.port, port)
		const review = await q('apps.installReview', {appId: 'tailscale'})
		assert.deepEqual(review.permissions.map((p) => p.id), ['system-software'], 'the built-in one, not the store’s container (which would ask for the host network)')
		assert.match(review.permissions[0].label, /Install software on the server itself/)
		assert.ok(review.permissions[0].what.some((w) => /tailscale/.test(w)))
	})

	test('installing needs your explicit permission', async () => {
		await assert.rejects(call('apps.install', {appId: 'tailscale'}), /needs your permission: install software on the server itself/)
		assert.deepEqual(helperCalls, [])
	})

	test('a helper older than Tailscale support: no installer needed, just a one-time command you run yourself', async () => {
		const current = await readFile(helperFile, 'utf8')
		await writeFile(helperFile, "const verbs = {\n\t'ping': async () => 'ok',\n}\n")
		const review = await q('apps.installReview', {appId: 'tailscale'})
		assert.equal(review.setup.length, 1)
		assert.match(review.setup[0].command, /^sudo pacman -S --needed tailscale && sudo systemctl enable --now tailscaled && sudo tailscale set --operator=/)
		helperCalls.length = 0
		await call('apps.install', {appId: 'tailscale', grant: ['system-software']})
		const app = await until(async () => {
			const a = await tailscale()
			return a?.state === 'unknown' && a
		})
		assert.match(app.error, /one-time setup/)
		assert.ok(app.error.includes(review.setup[0].command))
		assert.deepEqual(helperCalls, [], 'the old helper isn’t even asked')
		assert.doesNotMatch(app.error, /installer/)
		await call('apps.uninstall', {appId: 'tailscale'})
		// You ran the command: the review sees it at once, with nothing left to do.
		operator = true
		assert.deepEqual((await q('apps.installReview', {appId: 'tailscale'})).setup, [])
		operator = false
		await writeFile(helperFile, current)
		assert.deepEqual((await q('apps.installReview', {appId: 'tailscale'})).setup, [], 'a current helper does it for you')
	})

	test('install: through the helper, no containers; its page runs as you on a private port, behind the sign-in', async () => {
		helperCalls.length = 0
		composeCalls.length = 0
		await call('apps.install', {appId: 'tailscale', grant: ['system-software']})
		const app = await until(async () => {
			const a = await tailscale()
			return a?.state === 'running' && a
		})
		assert.deepEqual(helperCalls, ['tailscale-setup'])
		assert.ok(!composeCalls.some((c) => /^(docker-compose|podman)/.test(c)), `no container engine involved: ${composeCalls.join(' / ')}`)
		assert.equal(app.system, true)
		assert.equal(app.version, '1.104.7')
		assert.equal(app.port, port)
		assert.ok(app.internalPort >= 20000 && app.internalPort < 29000)
		// The page only on 127.0.0.1, at the private port.
		const page = await until(async () => (await fetch(`http://127.0.0.1:${app.internalPort}/api/data`)).json())
		assert.equal(page.listen, `127.0.0.1:${app.internalPort}`)
		const probe = await until(async () => {
			const p = await q('apps.probe', {appId: 'tailscale'})
			return p.readiness === 'ready' && p
		})
		assert.equal(probe.gateway, true)
		// Its port: sign in to Omarchy Server first.
		const stranger = await fetch(`http://127.0.0.1:${port}/`, {redirect: 'manual'})
		assert.equal(stranger.status, 302)
		const {ticket} = await call('apps.accessTicket', {appId: 'tailscale'})
		const enter = await fetch(`http://127.0.0.1:${port}/__omarchy/enter?t=${ticket}`, {redirect: 'manual'})
		const cookie = enter.headers.get('set-cookie').split(';')[0]
		assert.match(await (await fetch(`http://127.0.0.1:${port}/`, {headers: {cookie}})).text(), /<title>Tailscale<\/title>/)
	})

	test('stop and start disconnect and reconnect it, through Tailscale’s own local API', async () => {
		apiRequests.length = 0
		await call('apps.stop', {appId: 'tailscale'})
		assert.equal(prefs.WantRunning, false)
		assert.equal((await tailscale()).state, 'stopped')
		await call('apps.start', {appId: 'tailscale'})
		assert.equal(prefs.WantRunning, true)
		assert.equal((await tailscale()).state, 'running')
		assert.ok(apiRequests.includes('PATCH /localapi/v0/prefs'))
		assert.ok(!apiRequests.some((r) => /logout|reset/.test(r)), 'never signs you out')
	})

	test('its page comes back by itself if it stops', async () => {
		const pid = Number(await readFile(process.env.FAKE_TS_PID, 'utf8'))
		process.kill(pid, 'SIGKILL')
		const app = await tailscale()
		await until(async () => Number(await readFile(process.env.FAKE_TS_PID, 'utf8')) !== pid && (await fetch(`http://127.0.0.1:${app.internalPort}/`)).ok)
	})

	test('logs, updates and a shell', async () => {
		const logs = await q('apps.logs', {appId: 'tailscale'})
		assert.match(logs, /tailscaled\[1\]: Program starting/)
		assert.match(logs, /web server running on/)
		await assert.rejects(call('apps.update', {appId: 'tailscale'}), /updated with the rest of the system/)
		assert.ok(!(await q('apps.updates')).some((u) => u.id === 'tailscale'))
	})

	test('after omarchyd restarts, its page and port come back', async () => {
		await d.close()
		await boot()
		const app = await tailscale()
		await until(async () => (await q('apps.probe', {appId: 'tailscale'})).readiness === 'ready')
		assert.equal((await fetch(`http://127.0.0.1:${port}/`, {redirect: 'manual'})).status, 302)
		assert.ok((await fetch(`http://127.0.0.1:${app.internalPort}/`)).ok)
	})

	test('uninstall removes what Omarchy Server installed; a Tailscale you set up yourself stays', async () => {
		helperCalls.length = 0
		const internal = (await tailscale()).internalPort
		await call('apps.uninstall', {appId: 'tailscale'})
		assert.deepEqual(helperCalls, ['tailscale-remove'])
		assert.equal(await tailscale(), undefined)
		await until(async () => !(await fetch(`http://127.0.0.1:${internal}/`).then(() => true, () => false)))
		await assert.rejects(fetch(`http://127.0.0.1:${port}/`), 'its port is closed')

		// Already set up (from Omarchy's menu, or the one-time command): used as it is, without root,
		// and left in place on uninstall.
		operator = true
		helperCalls.length = 0
		await call('apps.install', {appId: 'tailscale', grant: ['system-software']})
		await until(async () => (await tailscale())?.state === 'running')
		await call('apps.uninstall', {appId: 'tailscale'})
		assert.deepEqual(helperCalls, [], 'no root needed, and nothing removed')
	})
})
