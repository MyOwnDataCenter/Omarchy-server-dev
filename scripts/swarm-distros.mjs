// Local swarm on many Linux distributions (CI: .github/workflows/connector.yml).
// Starts the real omarchyd and web server here, then for each distribution runs the real connector
// in a container of it: joins with a one-time code, reports, opens a terminal (and reads that
// computer's /etc/os-release through it), and is removed again. Needs docker.
//   node scripts/swarm-distros.mjs debian:12 fedora:41 ...
import assert from 'node:assert/strict'
import {execFile, spawn} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {dualProtocolServer, ensureTls, tlsContext} from '../omarchyd/tls.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
// How each distribution gets Python 3 (what the installer does, minus sudo: containers run as root).
const PY = {
	debian: 'apt-get update -qq && apt-get install -y -qq python3 >/dev/null',
	ubuntu: 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 >/dev/null',
	fedora: 'dnf install -y -q python3 >/dev/null',
	archlinux: 'pacman -Sy --noconfirm --needed python >/dev/null',
	opensuse: 'zypper -q --non-interactive install python3 >/dev/null',
}
const images = process.argv.slice(2)
if (!images.length) throw new Error('Name the images to try, e.g. debian:12 fedora:41')

const until = async (fn, ms = 60_000, what = 'it') => {
	const end = Date.now() + ms
	for (;;) {
		const v = await fn().catch(() => null)
		if (v) return v
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
		await new Promise((r) => setTimeout(r, 250))
	}
}

const root = await mkdtemp(join(os.tmpdir(), 'swarm-ci-'))
const tlsDir = join(root, 'tls')
const data = join(root, 'data')
await ensureTls({dir: tlsDir})
const secure = tlsContext({dir: tlsDir})
await until(async () => secure.get(), 10_000, 'the certificate')
const store = await createStore(join(root, 'web'))
const app = createApp({store, tls: secure, relayPortBase: 0, relayHost: '127.0.0.1'})
const httpServer = http.createServer(app)
const web = dualProtocolServer(httpServer, secure.get)
await new Promise((r) => web.listen(0, '0.0.0.0', r))
app.attachConsole(httpServer)
const webPort = web.address().port
await mkdir(data, {recursive: true})
// omarchyd's app store gets a dummy container socket; docker here keeps the real one.
const dockerEnv = {...process.env}
const sock = join(root, 'podman.sock')
await writeFile(sock, '')
process.env.DOCKER_HOST = `unix://${sock}`
const accounts = await openAccounts(data)
await accounts.createOwner({name: 'CI', password: 'correct horse'})
const d = await startOmarchyd({port: 0, dataDir: data, tlsDir, home: root, webPort, appOptions: {run: async () => '', allowFileStores: true, defaultStores: [], systemApps: null}, updaterOptions: {autoCheck: false}})
await store.setConfig({backendUrl: d.url})
const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 'ci'}})})).json()
const auth = {authorization: `Bearer ${login.result.data.accessToken}`}
const call = async (path, input, kind = 'mutation') => {
	const url = new URL(`${d.url}/trpc/${path}`)
	const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
	if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
	else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
	const body = await (await fetch(url, init)).json()
	if (body.error) throw new Error(body.error.message)
	return body.result.data
}
const caPem = await (await fetch(`http://127.0.0.1:${webPort}/api/tls/ca.crt`)).text()

let failed = 0
for (const image of images) {
	const family = Object.keys(PY).find((k) => image.startsWith(k) || image.includes(`/${k}`))
	const dir = await mkdtemp(join(root, 'agent-'))
	await mkdir(join(dir, '.config/omarchy-connector'), {recursive: true})
	await writeFile(join(dir, '.config/omarchy-connector/server-ca.crt'), caPem)
	const p = await call('swarm.pair', {terminal: true, desktop: false, manage: true})
	const script = [
		PY[family],
		'python3 --version',
		`python3 /agent.py enroll https://127.0.0.1:${webPort} ${p.token} terminal,manage`,
		'exec python3 /agent.py',
	].join(' && ')
	const name = `swarm-${image.replace(/[^a-z0-9]+/g, '-')}`
	const proc = spawn('docker', ['run', '--rm', '--name', name, '--network', 'host', '-e', 'HOME=/root', '-v', `${AGENT}:/agent.py:ro`, '-v', `${dir}/.config:/root/.config`, image, 'sh', '-c', script], {stdio: ['ignore', 'inherit', 'inherit'], env: dockerEnv})
	try {
		const a = await until(async () => (await call('swarm.list', undefined, 'query')).find((x) => x.online && x.metrics?.mem?.total), 300_000, `${image} to join`)
		const ticket = await call('user.createWebSocketTicket', {target: 'terminal'})
		const url = new URL(`${d.url.replace('http', 'ws')}/terminal`)
		url.search = new URLSearchParams({agentId: a.id, cols: '120', rows: '40', ticket: typeof ticket === 'string' ? ticket : ticket.ticket}).toString()
		const ws = new WebSocket(url)
		let out = ''
		ws.on('message', (m) => (out += String(m)))
		await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
		ws.send('. /etc/os-release; echo "it-is-$ID"\n')
		await until(async () => /it-is-[a-z]/.test(out), 30_000, `${image}'s terminal`)
		const seen = /it-is-([a-z-]+)/.exec(out)[1]
		ws.close()
		assert.equal(a.info.osId, seen, 'the connector reports the same distribution the shell sees')
		assert.ok(a.info.pkg, 'it found the package manager')
		assert.ok(a.info.updateCommand, 'and the update command')
		await call('swarm.remove', {id: a.id})
		await until(async () => proc.exitCode !== null, 30_000, `${image}'s connector to stop`)
		console.log(`ok - ${image}: ${a.info.os} · ${a.info.pkg} · "${a.info.updateCommand}" · ${a.metrics.disks.length} disk(s) · terminal works · removed`)
	} catch (error) {
		failed++
		console.log(`not ok - ${image}: ${error.message}`)
		await promisify(execFile)('docker', ['rm', '-f', name], {env: dockerEnv}).catch(() => {})
		for (const x of await call('swarm.list', undefined, 'query')) await call('swarm.remove', {id: x.id})
	}
}
await d.close()
web.close()
secure.close?.()
await rm(root, {recursive: true, force: true})
process.exit(failed ? 1 : 0)
