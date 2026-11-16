// omarchyd terminal: a single-use ticket opens your shell in a real pty over a WebSocket.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, test} from 'node:test'
import {EventEmitter} from 'node:events'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {createTerminalSessions} from '../omarchyd/terminal.mjs'

let root, d, auth, vnc
before(async () => {
	root = await mkdtemp(join(os.tmpdir(), 'omarchyd-t-'))
	const accounts = await openAccounts(join(root, 'data'))
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	// Stand-in for wayvnc on 127.0.0.1.
	vnc = net.createServer((sock) => sock.end('RFB 003.008\n'))
	await new Promise((r) => vnc.listen(0, '127.0.0.1', r))
	d = await startOmarchyd({port: 0, dataDir: join(root, 'data'), home: root, desktopVncPort: vnc.address().port})
	const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
	auth = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
})
after(async () => {
	vnc.close()
	await d.close()
	await rm(root, {recursive: true, force: true})
})
const ticket = async (target) => (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: auth, body: JSON.stringify({target})})).json()).result.data
const refused = (url) => new Promise((resolve) => new WebSocket(url).once('error', () => resolve(true)).once('open', () => resolve(false)))

test('a terminal ticket opens a sized shell in a pty; it works once', async () => {
	const t = await ticket('terminal')
	const url = `${d.url.replace('http', 'ws')}/terminal?cols=91&rows=27&ticket=${t}`
	const ws = new WebSocket(url)
	let out = ''
	ws.on('message', (m) => (out += m.toString()))
	await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
	ws.send('echo sum-$((40+2)) $(tput cols)x$(tput lines)\n')
	const deadline = Date.now() + 5000
	while (!/sum-42 91x27/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
	assert.match(out, /sum-42 91x27/)
	ws.send('exit\n')
	await new Promise((r) => ws.once('close', r))
	assert.equal(await refused(url), true, 'tickets are single-use')
})

// Open the terminal and collect what it shows; control messages (text frames) separately.
async function open(params) {
	const ws = new WebSocket(`${d.url.replace('http', 'ws')}/terminal?${new URLSearchParams({...params, ticket: await ticket('terminal')})}`)
	const term = {ws, out: '', control: []}
	ws.on('message', (m, binary) => (binary ? (term.out += m.toString()) : term.control.push(JSON.parse(m.toString()))))
	await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
	term.until = async (re, ms = 5000) => {
		const end = Date.now() + ms
		while (!re.test(term.out) && Date.now() < end) await new Promise((r) => setTimeout(r, 30))
		assert.match(term.out, re)
	}
	term.close = () => new Promise((r) => (ws.once('close', r), ws.close()))
	return term
}

test('closing the terminal leaves the shell running; opening it again resumes it, at this device’s size', async () => {
	const a = await open({cols: '91', rows: '27'})
	assert.deepEqual(a.control[0], {type: 'session', resumed: false, cols: 91, rows: 27})
	a.ws.send('export MARK=kept-7; echo ready-$MARK\n')
	await a.until(/ready-kept-7/)
	// Something still running when you close it keeps going.
	a.ws.send('for i in 1 2 3; do sleep 0.3; echo tick-$i; done\n')
	await a.close()
	await new Promise((r) => setTimeout(r, 1500))
	// Another device, another size: the same shell, with what was on screen.
	const b = await open({cols: '100', rows: '30'})
	assert.deepEqual(b.control[0], {type: 'session', resumed: true, cols: 91, rows: 27})
	await b.until(/ready-kept-7[\s\S]*tick-3/)
	await new Promise((r) => setTimeout(r, 300))
	assert.deepEqual(b.control[1], {type: 'size', cols: 100, rows: 30})
	b.ws.send('echo still-$MARK $(tput cols)x$(tput lines)\n')
	await b.until(/still-kept-7 100x30/)
	assert.equal(d.terminals.list().length, 1)
	await b.close()
})

test('two open at once both see it; “new session” ends the old shell; exit ends it', async () => {
	const a = await open({cols: '80', rows: '24'})
	const b = await open({cols: '80', rows: '24'})
	assert.equal(b.control[0].resumed, true)
	a.ws.send('echo both-$((6*7))\n')
	await a.until(/both-42/)
	await b.until(/both-42/)
	const c = await open({cols: '80', rows: '24', fresh: '1'})
	assert.equal(c.control[0].resumed, false)
	await new Promise((r) => (a.ws.readyState === a.ws.CLOSED ? r() : a.ws.once('close', r)))
	c.ws.send('echo mark-[$MARK]\n')
	await c.until(/mark-\[\]/)
	c.ws.send('exit\n')
	await new Promise((r) => c.ws.once('close', r))
	assert.equal(d.terminals.list().length, 0)
	const e = await open({cols: '80', rows: '24'})
	assert.equal(e.control[0].resumed, false, 'after exit, the next one starts fresh')
	e.ws.send('exit\n')
	await new Promise((r) => e.ws.once('close', r))
})

test('each person, and each app, has their own shell', async () => {
	const sessions = createTerminalSessions()
	const fake = () => Object.assign(new EventEmitter(), {OPEN: 1, readyState: 1, sent: [], send(m) {this.sent.push(m)}, close() {this.readyState = 3}})
	try {
		const shell = {home: root, cwd: root}
		assert.equal((await sessions.attach(fake(), {userId: 'owner', cols: 80, rows: 24, shell})).resumed, false)
		assert.equal((await sessions.attach(fake(), {userId: 'sam', cols: 80, rows: 24, shell})).resumed, false)
		assert.equal((await sessions.attach(fake(), {userId: 'owner', appId: 'immich', cols: 80, rows: 24, shell})).resumed, false)
		assert.equal((await sessions.attach(fake(), {userId: 'owner', cols: 80, rows: 24, shell})).resumed, true)
		assert.equal(sessions.list().length, 3)
	} finally {
		sessions.close()
	}
})

test('a machines ticket can’t open a shell; bad sizes are refused', async () => {
	assert.equal(await refused(`${d.url.replace('http', 'ws')}/terminal?cols=80&rows=24&ticket=${await ticket('machines')}`), true)
	assert.equal(await refused(`${d.url.replace('http', 'ws')}/terminal?cols=2&rows=24&ticket=${await ticket('terminal')}`), true)
})

test('the Omarchy desktop opens through the screen viewer with a ticket, never without', async () => {
	const base = `${d.url.replace('http', 'ws')}/machines/console?machineId=desktop`
	assert.equal(await refused(`${base}&ticket=forged`), true)
	const ws = new WebSocket(`${base}&ticket=${await ticket('machines')}`, ['binary'])
	const first = await new Promise((r, j) => (ws.once('message', (m) => r(m.toString())), ws.once('error', j)))
	assert.equal(first, 'RFB 003.008\n')
	ws.close()
})

test('the desktop is shared on a private socket when there is one (not on a port other programs can reach)', async () => {
	const sock = join(root, 'run', 'desktop-vnc.sock')
	const {mkdir} = await import('node:fs/promises')
	await mkdir(join(root, 'run'), {mode: 0o700})
	const unix = net.createServer((s) => s.end('RFB 003.008 via socket\n'))
	await new Promise((r) => unix.listen(sock, r))
	const d2 = await startOmarchyd({port: 0, dataDir: join(root, 'data'), home: root, desktopVncPort: vnc.address().port, desktopVncSocket: sock})
	try {
		const login = await (await fetch(`${d2.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't2'}})})).json()
		const t = (await (await fetch(`${d2.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}, body: JSON.stringify({target: 'machines'})})).json()).result.data
		const ws = new WebSocket(`${d2.url.replace('http', 'ws')}/machines/console?machineId=desktop&ticket=${t}`, ['binary'])
		const first = await new Promise((r, j) => (ws.once('message', (m) => r(m.toString())), ws.once('error', j)))
		assert.equal(first, 'RFB 003.008 via socket\n')
		ws.close()
	} finally {
		unix.close()
		await d2.close()
	}
})
