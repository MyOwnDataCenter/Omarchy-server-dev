// Local swarm, end to end: the real omarchyd and web server (https on the same port), and the real
// connector (connector/agent.py, Python) joining with a one-time code, reporting, opening a
// terminal, and leaving again when removed.
import assert from 'node:assert/strict'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {dualProtocolServer, ensureTls, tlsContext} from '../omarchyd/tls.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
const hasPython = (() => {
	try {
		execFileSync('python3', ['--version'])
		return true
	} catch {
		return false
	}
})()

describe('local swarm', {skip: !hasPython && 'python3 is needed'}, () => {
	let root, data, tlsDir, d, web, webPort, auth, secure, agentHome, agentProc, agentLog
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
	const until = async (fn, ms = 15_000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn().catch(() => null)
			if (v) return v
			if (Date.now() > end) throw new Error(`timed out\n${agentLog?.join('') ?? ''}`)
			await new Promise((r) => setTimeout(r, 100))
		}
	}
	const agentEnv = () => ({...process.env, HOME: agentHome, XDG_CONFIG_HOME: join(agentHome, '.config'), XDG_DATA_HOME: join(agentHome, '.local/share'), XDG_RUNTIME_DIR: join(agentHome, 'run')})
	// Async: the servers under test run in this process, so a blocking call would stall them.
	const runAgent = async (args) => {
		try {
			return (await promisify(execFile)('python3', [AGENT, ...args], {env: agentEnv(), encoding: 'utf8'})).stdout
		} catch (e) {
			throw new Error(String(e.stderr || e.message))
		}
	}
	const startAgent = () => {
		agentLog = []
		agentProc = spawn('python3', [AGENT], {env: agentEnv()})
		agentProc.stderr.on('data', (c) => agentLog.push(String(c)))
	}
	const pair = (abilities) => call('swarm.pair', abilities)
	const server = () => `https://127.0.0.1:${webPort}`
	// What the installer does before joining: trust the server's CA, after checking its fingerprint.
	const trust = async (ca) => {
		const pem = await (await fetch(`http://127.0.0.1:${webPort}/api/tls/ca.crt`)).text()
		const got = execFileSync('python3', ['-c', 'import ssl,sys,hashlib; print(hashlib.sha256(ssl.PEM_cert_to_DER_cert(sys.stdin.read())).hexdigest())'], {input: pem, encoding: 'utf8'}).trim()
		assert.equal(got, ca, 'the fingerprint in the install command is the CA the server serves')
		await mkdir(join(agentHome, '.config/omarchy-connector'), {recursive: true})
		await writeFile(join(agentHome, '.config/omarchy-connector/server-ca.crt'), pem)
	}
	const browserWs = async (target, params) => {
		const {ticket} = {ticket: await call('user.createWebSocketTicket', {target})}
		const url = new URL(`${d.url.replace('http', 'ws')}/${target === 'terminal' ? 'terminal' : 'machines/console'}`)
		url.search = new URLSearchParams({...params, ticket: typeof ticket === 'string' ? ticket : ticket.ticket}).toString()
		return new WebSocket(url, target === 'machines' ? ['binary'] : [])
	}

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'swarm-'))
		data = join(root, 'data')
		tlsDir = join(root, 'tls')
		agentHome = join(root, 'agent')
		await mkdir(join(agentHome, 'run'), {recursive: true, mode: 0o700})
		await ensureTls({dir: tlsDir})
		const sock = join(root, 'podman.sock')
		await writeFile(sock, '')
		process.env.DOCKER_HOST = `unix://${sock}`
		// The web server first (omarchyd needs its port for nothing here; the connector uses it).
		secure = tlsContext({dir: tlsDir})
		await until(async () => secure.get())
		const store = await createStore(join(root, 'web'))
		const app = createApp({store, tls: secure, relayPortBase: 0, relayHost: '127.0.0.1'})
		const httpServer = http.createServer(app)
		web = dualProtocolServer(httpServer, secure.get)
		await new Promise((r) => web.listen(0, '127.0.0.1', r))
		app.attachConsole(httpServer)
		webPort = web.address().port
		await mkdir(data, {recursive: true})
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, tlsDir, home: root, webPort, appOptions: {run: async () => '', allowFileStores: true, defaultStores: [], systemApps: null}, updaterOptions: {autoCheck: false, raw: 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server-dev'}})
		await store.setConfig({backendUrl: d.url})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	})
	after(async () => {
		agentProc?.kill()
		await d?.close()
		web?.close()
		secure?.close?.()
		await rm(root, {recursive: true, force: true})
	})

	test('pairing gives a one-time code, the server’s fingerprint and how to install', async () => {
		const p = await pair({terminal: true, desktop: true, manage: true})
		assert.match(p.token, /^[A-Za-z0-9_-]{32}$/)
		assert.match(p.ca, /^[0-9a-f]{64}$/)
		assert.equal(p.source, 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server-dev')
		assert.equal(p.port, webPort)
		assert.ok(Array.isArray(p.addresses))
		assert.ok(p.expiresAt > Date.now() + 14 * 60_000)
	})

	test('a computer joins with the code (once), with what both sides allow', async () => {
		const p = await pair({terminal: true, desktop: true, manage: true})
		await trust(p.ca)
		// This computer's installer allowed terminal and manage, not the desktop.
		const name = (await runAgent(['enroll', server(), p.token, 'terminal,manage'])).trim()
		assert.equal(name, os.hostname())
		const cfg = JSON.parse(await readFile(join(agentHome, '.config/omarchy-connector/config.json'), 'utf8'))
		assert.equal((await stat(join(agentHome, '.config/omarchy-connector/config.json'))).mode & 0o777, 0o600)
		assert.deepEqual(cfg.abilities, {terminal: true, desktop: false, manage: true})
		// The same code again: refused.
		await assert.rejects(runAgent(['enroll', server(), p.token, 'terminal']), /isn’t valid any more|already used|expired/)
		const [a] = await q('swarm.list')
		assert.deepEqual(a.allowed, {terminal: true, desktop: false, manage: true})
		assert.equal(a.online, false)
	})

	test('it connects, says what it is, and reports every few seconds', async () => {
		startAgent()
		const a = await until(async () => {
			const [x] = await q('swarm.list')
			return x.online && x.metrics?.mem?.total > 0 && x.info?.os && x
		})
		assert.equal(a.info.hostname, os.hostname())
		assert.ok(a.metrics.disks.length >= 1)
		assert.ok(a.metrics.cores >= 1)
	})

	test('a terminal on that computer, through the server', async () => {
		const [a] = await q('swarm.list')
		const ws = await browserWs('terminal', {agentId: a.id, cols: '100', rows: '30'})
		let out = ''
		ws.on('message', (d) => (out += String(d)))
		await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
		ws.send('echo swarm-$((40+2)); stty size\n')
		await until(async () => out.includes('swarm-42') && /30 100/.test(out))
		ws.close()
	})

	test('what wasn’t allowed stays off: the desktop here, and the server can’t switch it on', async () => {
		const [a] = await q('swarm.list')
		const ws = await browserWs('machines', {machineId: `agent-${a.id}`})
		const closed = await new Promise((r) => ws.once('close', (code, reason) => r({code, reason: String(reason)})))
		assert.match(closed.reason, /isn’t switched on/)
		await assert.rejects(call('swarm.setAbilities', {id: a.id, desktop: true}), /wasn’t allowed desktop when it joined/)
		// Switching the terminal off here closes it off too.
		await call('swarm.setAbilities', {id: a.id, terminal: false})
		const t = await browserWs('terminal', {agentId: a.id, cols: '80', rows: '24'})
		const tc = await new Promise((r) => t.once('close', (code, reason) => r(String(reason))))
		assert.match(tc, /isn’t switched on/)
		await call('swarm.setAbilities', {id: a.id, terminal: true})
	})

	test('manage: only the fixed actions; unverified plugins refused before it’s asked', async () => {
		const [a] = await q('swarm.list')
		await assert.rejects(call('swarm.action', {id: a.id, name: 'run', args: 'rm -rf /'}), /Unknown action/)
		await assert.rejects(call('swarm.action', {id: a.id, name: 'theme-set', theme: 'Tokyo Night'}), /can’t be set here/)
		await call('swarm.rename', {id: a.id, name: 'Study PC'})
		assert.equal((await q('swarm.list'))[0].name, 'Study PC')
	})

	test('strangers get nowhere: a wrong key, or no key', async () => {
		const bad = new WebSocket(`wss://127.0.0.1:${webPort}/connector/ws`, {rejectUnauthorized: false, headers: {authorization: `Bearer 000000000000:${'x'.repeat(43)}`}})
		const status = await new Promise((r) => (bad.once('unexpected-response', (_q, res) => r(res.statusCode)), bad.once('open', () => r(101))))
		assert.equal(status, 401)
		const none = await fetch(`https://127.0.0.1:${webPort}/connector/enroll`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token: 'guess'})}).catch(() => null)
		// (fetch refuses the private CA; plain http reaches the same route)
		const r = none ?? (await fetch(`http://127.0.0.1:${webPort}/connector/enroll`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token: 'guess'})}))
		assert.equal(r.status, 401)
	})

	test('removed from the swarm: it’s cut off, forgets the server and stops', async () => {
		const [a] = await q('swarm.list')
		await call('swarm.remove', {id: a.id})
		await until(async () => agentProc.exitCode !== null || agentProc.signalCode !== null)
		await assert.rejects(stat(join(agentHome, '.config/omarchy-connector/config.json')))
		assert.deepEqual(await q('swarm.list'), [])
	})

	// Needs Xvfb and x11vnc (the CI job installs them).
	const hasX = (() => {
		try {
			execFileSync('sh', ['-c', 'command -v Xvfb && command -v x11vnc'])
			return true
		} catch {
			return false
		}
	})()
	test('desktop: its screen (X11, through x11vnc on a private socket) reaches the browser as VNC', {skip: !hasX && 'Xvfb and x11vnc are needed'}, async (t) => {
		const xvfb = spawn('Xvfb', [':93', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], {stdio: 'ignore'})
		t.after(() => xvfb.kill())
		await until(async () => stat('/tmp/.X11-unix/X93').then(() => true))
		const p = await pair({terminal: false, desktop: true, manage: false})
		await trust(p.ca)
		await runAgent(['enroll', server(), p.token, 'desktop'])
		startAgent()
		t.after(() => agentProc.kill())
		const a = await until(async () => {
			const [x] = await q('swarm.list')
			return x?.online && x.info?.desktop?.kind === 'x11' && x
		})
		assert.equal(a.info.desktop.ok, true)
		// The readable check says yes before the browser opens the screen.
		assert.equal(await q('swarm.desktopCheck', {id: a.id}), true)
		const ws = await browserWs('machines', {machineId: `agent-${a.id}`})
		const first = await new Promise((r, j) => (ws.once('message', (d) => r(Buffer.from(d))), ws.once('close', (c, why) => j(new Error(`closed ${c} ${why}`)))))
		assert.match(first.toString('latin1'), /^RFB 003\.00\d\n/)
		ws.close()
		// The VNC server listens only on a socket in the connector's private runtime folder, no port.
		const sockDir = join(agentHome, 'run/omarchy-connector')
		assert.equal((await stat(sockDir)).mode & 0o777, 0o700)
	})
})
