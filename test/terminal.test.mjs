// omarchyd terminal: a single-use ticket opens your shell in a real pty over a WebSocket.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, test} from 'node:test'
import {EventEmitter} from 'node:events'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {createTerminalSessions} from '../omarchyd/terminal.mjs'

let root, d, auth, memberAuth, vnc
before(async () => {
	root = await mkdtemp(join(os.tmpdir(), 'omarchyd-t-'))
	const data = join(root, 'data')
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const file = join(data, 'accounts.json')
	const state = JSON.parse(await readFile(file, 'utf8'))
	const owner = state.users[0]
	state.users.push({userId: 'sam', name: 'Sam', role: 'member', language: 'en', salt: owner.salt, hash: owner.hash, createdAt: Date.now()})
	await writeFile(file, JSON.stringify(state, null, '\t'))
	// Stand-in for wayvnc on 127.0.0.1.
	vnc = net.createServer((sock) => sock.end('RFB 003.008\n'))
	await new Promise((r) => vnc.listen(0, '127.0.0.1', r))
	d = await startOmarchyd({port: 0, dataDir: data, home: root, desktopVncPort: vnc.address().port, desktopVncSocket: join(root, 'no-such.sock')})
	const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
	auth = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
	const memberLogin = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'sam', password: 'correct horse', client: {id: 'm'}})})).json()
	memberAuth = {authorization: `Bearer ${memberLogin.result.data.accessToken}`, 'content-type': 'application/json'}
})
after(async () => {
	vnc.close()
	await d.close()
	await rm(root, {recursive: true, force: true})
})
const ticket = async (target, headers = auth) => (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers, body: JSON.stringify({target})})).json()).result.data
const refused = (url) => new Promise((resolve) => new WebSocket(url).once('error', () => resolve(true)).once('open', () => resolve(false)))
const handshake = (url, protocols) =>
	new Promise((resolve) => {
		const ws = new WebSocket(url, protocols)
		ws.once('unexpected-response', (_req, res) => {
			res.resume()
			resolve(res.statusCode)
		})
		ws.once('open', () => {
			ws.close()
			resolve(101)
		})
	})

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

test('the window changes size: the shell takes it at once (and a resumed shell does too)', async () => {
	const resize = (t, cols, rows) => t.ws.send(Buffer.from(JSON.stringify({type: 'resize', cols, rows})), {binary: true})
	const a = await open({cols: '80', rows: '24'})
	resize(a, 132, 41)
	await new Promise((r) => setTimeout(r, 300))
	a.ws.send('echo got-$(tput cols)x$(tput lines)\n')
	await a.until(/got-132x41/)
	// Resize and type at once: the command runs at the new size (typing waits for the resize).
	a.ws.send(Buffer.from(JSON.stringify({type: 'resize', cols: 99, rows: 33})), {binary: true})
	a.ws.send('echo at-once-$(tput cols)x$(tput lines)\n')
	await a.until(/at-once-99x33/)
	resize(a, 132, 41)
	await new Promise((r) => setTimeout(r, 300))
	// What's typed is text, so a typed '{"type":"resize"…}' is just typing, never a resize.
	a.ws.send('echo \'{"type":"resize","cols":20,"rows":5}\' >/dev/null; echo still-$(tput cols)\n')
	await a.until(/still-132/)
	// Asking for the size it already is changes nothing, and later resizes still work.
	resize(a, 132, 41)
	await new Promise((r) => setTimeout(r, 200))
	resize(a, 120, 40)
	await new Promise((r) => setTimeout(r, 300))
	a.ws.send('echo same-then-$(tput cols)x$(tput lines)\n')
	await a.until(/same-then-120x40/)
	resize(a, 132, 41)
	await new Promise((r) => setTimeout(r, 300))
	// Nonsense sizes are ignored.
	resize(a, 3, 2)
	a.ws.send(Buffer.from('not json'), {binary: true})
	await new Promise((r) => setTimeout(r, 200))
	a.ws.send('echo kept-$(tput cols)x$(tput lines)\n')
	await a.until(/kept-132x41/)
	await a.close()
	// Opened again (resumed), then resized straight away: nothing is lost.
	const b = await open({cols: '100', rows: '30'})
	resize(b, 150, 45)
	await new Promise((r) => setTimeout(r, 400))
	b.ws.send('echo now-$(tput cols)x$(tput lines)\n')
	await b.until(/now-150x45/)
	b.ws.send('exit\n')
	await new Promise((r) => b.ws.once('close', r))
})

test('two devices on one shell: whoever resizes, the other is told the size', async () => {
	const a = await open({cols: '120', rows: '40'})
	const b = await open({cols: '60', rows: '30'})
	await new Promise((r) => setTimeout(r, 400))
	// b joining resized the shell to b's window: a hears about it.
	assert.deepEqual(a.control.at(-1), {type: 'size', cols: 60, rows: 30})
	a.ws.send(Buffer.from(JSON.stringify({type: 'resize', cols: 120, rows: 40})), {binary: true})
	await new Promise((r) => setTimeout(r, 400))
	assert.deepEqual(b.control.at(-1), {type: 'size', cols: 120, rows: 40})
	a.ws.send('exit\n')
	await Promise.all([new Promise((r) => a.ws.once('close', r)), new Promise((r) => b.ws.once('close', r))])
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
	const sockDir = await mkdtemp('/tmp/om-term-')
	const sock = join(sockDir, 'desktop-vnc.sock')
	const unix = net.createServer((s) => s.end('RFB 003.008 via socket\n'))
	let d2
	try {
		await new Promise((resolve, reject) => {
			unix.once('error', reject)
			unix.listen(sock, () => {
				unix.off('error', reject)
				resolve()
			})
		})
		d2 = await startOmarchyd({port: 0, dataDir: join(root, 'data'), home: root, desktopVncPort: vnc.address().port, desktopVncSocket: sock})
		const login = await (await fetch(`${d2.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't2'}})})).json()
		const t = (await (await fetch(`${d2.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}, body: JSON.stringify({target: 'machines'})})).json()).result.data
		const ws = new WebSocket(`${d2.url.replace('http', 'ws')}/machines/console?machineId=desktop&ticket=${t}`, ['binary'])
		const first = await new Promise((r, j) => (ws.once('message', (m) => r(m.toString())), ws.once('error', j)))
		assert.equal(first, 'RFB 003.008 via socket\n')
		ws.close()
	} finally {
		unix.close()
		await d2?.close()
		await rm(sockDir, {recursive: true, force: true})
	}
})

test('a member’s ticket cannot open this server’s shell or a swarm computer’s', async () => {
	const ws = d.url.replace('http', 'ws')
	const term = await ticket('terminal', memberAuth)
	assert.equal(typeof term, 'string')
	assert.equal(await handshake(`${ws}/terminal?cols=80&rows=24&ticket=${term}`), 403, 'host shell runs as the owner’s user')
	const agentTerm = await ticket('terminal', memberAuth)
	assert.equal(await handshake(`${ws}/terminal?agentId=0123456789ab&cols=80&rows=24&ticket=${agentTerm}`), 403, 'swarm shells are owner-only, same as swarm.*')
	const agentScreen = await ticket('machines', memberAuth)
	assert.equal(await handshake(`${ws}/machines/console?machineId=agent-0123456789ab&ticket=${agentScreen}`, ['binary']), 403)
	assert.equal(await handshake(`${ws}/machines/console?machineId=desktop&ticket=${await ticket('machines', memberAuth)}`, ['binary']), 403, 'this server’s desktop is the owner’s session')
	assert.equal(await handshake(`${ws}/machines/console?machineId=desktop&ticket=${await ticket('machines')}`, ['binary']), 101, 'the owner can still open it')
	assert.equal(await handshake(`${ws}/terminal?cols=80&rows=24&ticket=${await ticket('terminal')}`), 101, 'the owner can still open a shell')
})
