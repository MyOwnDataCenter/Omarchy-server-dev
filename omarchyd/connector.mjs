// Local swarm: other Linux computers joined to this server through the Omarchy Server connector
// (connector/agent.py). The connector dials *out* to this server over wss:// (pinned to this
// server's own certificate authority), so the other computer opens no ports.
//
// Joining: the owner makes a one-time pairing code (15 minutes, used once) with the abilities they
// allow (watching is always on; terminal, desktop and manage are optional). The connector trades
// it for its own id and key; only a hash of the key is kept here.
//
// Two limits on what a computer does: the abilities chosen when pairing, which the connector also
// keeps itself and enforces on its own side (so even this server can't widen them), and the
// owner's switches here, which can only narrow those.
//
// Wire format on the connector's WebSocket: JSON text messages for control, and binary frames
// starting with a 4-byte channel number for terminal and desktop bytes.
import {X509Certificate, createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {WebSocketServer} from 'ws'

import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

const ABILITIES = ['terminal', 'desktop', 'manage']
const PAIR_TTL = 15 * 60_000
const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const clip = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

// Only the facts the page shows, checked and trimmed (a connector is another computer: don't
// trust its numbers to be well-formed).
function cleanMetrics(m = {}) {
	const disks = Array.isArray(m.disks)
		? m.disks.slice(0, 12).map((d) => ({mount: clip(d?.mount, 200), total: num(d?.total), used: num(d?.used)})).filter((d) => d.total > 0)
		: []
	return {
		at: Date.now(),
		cpu: num(m.cpu),
		cores: num(m.cores),
		load: Array.isArray(m.load) ? m.load.slice(0, 3).map(num) : [],
		mem: {total: num(m.mem?.total), used: num(m.mem?.used)},
		swap: {total: num(m.swap?.total), used: num(m.swap?.used)},
		disks,
		temp: num(m.temp),
		uptime: num(m.uptime),
		updates: num(m.updates),
	}
}
function cleanInfo(i = {}) {
	return {
		hostname: clip(i.hostname, 64),
		os: clip(i.os, 80),
		osId: clip(i.osId, 32).toLowerCase(),
		kernel: clip(i.kernel, 64),
		arch: clip(i.arch, 16),
		user: clip(i.user, 32),
		version: clip(i.version, 16),
		pkg: clip(i.pkg, 16),
		updateCommand: clip(i.updateCommand, 160),
		omarchy: !!i.omarchy,
		plugins: Array.isArray(i.plugins) ? i.plugins.slice(0, 200).map((p) => clip(p, 80)) : [],
		themes: Array.isArray(i.themes) ? i.themes.slice(0, 200).map((t) => clip(t, 80)) : [],
		theme: clip(i.theme, 80),
		desktop: {kind: clip(i.desktop?.kind, 32), ok: !!i.desktop?.ok, why: clip(i.desktop?.why, 200)},
	}
}

// This server's addresses other computers can reach: its network addresses (Tailscale's too).
function serverAddresses() {
	const out = []
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		for (const i of list ?? []) {
			if (i.internal || i.family !== 'IPv4' || /^(docker|podman|veth|virbr|br-|cni)/.test(name)) continue
			out.push({address: i.address, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address) || name.startsWith('tailscale')})
		}
	}
	return out
}

export function createConnector({dataDir, tlsDir, plugins = null, source = async () => 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server-dev', webPort = 7780, now = () => Date.now()}) {
	const file = join(dataDir, 'swarm.json')
	let state = {agents: []}
	const loaded = readFile(file, 'utf8').then(
		(t) => {
			const s = JSON.parse(t)
			if (Array.isArray(s?.agents)) state = s
		},
		() => {},
	)
	const save = () => writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600})
	const pairings = new Map() // sha(token) -> {abilities, expires}
	const live = new Map() // agentId -> {ws, metrics, info, channels: Map, nextCh, calls: Map, nextCall}
	const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024})

	const find = (id) => state.agents.find((a) => a.id === id)
	const view = (a) => {
		const l = live.get(a.id)
		return {
			id: a.id,
			name: a.name,
			online: !!l,
			lastSeen: l ? now() : (a.lastSeen ?? null),
			enrolledAt: a.enrolledAt,
			// What it may do: allowed at pairing (and by the connector itself) and still switched on here.
			allowed: a.allowed,
			on: a.on,
			info: a.info ?? null,
			metrics: l?.metrics ?? a.metrics ?? null,
		}
	}

	async function caFingerprint() {
		const pem = await readFile(join(tlsDir, 'ca.crt'), 'utf8').catch(() => null)
		if (!pem) throw new RpcError('PRECONDITION_FAILED', 'This server’s secure address (https) isn’t set up yet, and the connector needs it.')
		return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase()
	}

	// ---- owner actions (tRPC) ------------------------------------------------------------------
	async function pair(input = {}) {
		await loaded
		const abilities = Object.fromEntries(ABILITIES.map((k) => [k, input?.[k] === true]))
		const token = randomBytes(24).toString('base64url')
		for (const [k, p] of pairings) if (p.expires < now()) pairings.delete(k)
		pairings.set(sha(token), {abilities, expires: now() + PAIR_TTL})
		return {token, ca: await caFingerprint(), expiresAt: now() + PAIR_TTL, abilities, source: await source(), port: webPort, addresses: serverAddresses()}
	}
	async function list() {
		await loaded
		return state.agents.map(view)
	}
	async function remove(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		state.agents = state.agents.filter((x) => x !== a)
		await save()
		const l = live.get(a.id)
		// Tell it to forget this server and stop; then cut it off either way.
		if (l) {
			try {
				l.ws.send(JSON.stringify({op: 'removed'}))
			} catch {}
			setTimeout(() => l.ws.terminate(), 500).unref?.()
		}
		return true
	}
	async function rename(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const name = clip(input?.name, 48).trim()
		if (!name) throw new RpcError('BAD_REQUEST', 'Give it a name')
		a.name = name
		await save()
		return true
	}
	// Switch abilities on or off here. Never more than it was allowed when it joined.
	async function setAbilities(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		for (const k of ABILITIES) {
			if (input?.[k] === undefined) continue
			if (input[k] === true && !a.allowed[k]) throw new RpcError('FORBIDDEN', `${a.name} wasn’t allowed ${k} when it joined. Pair it again with ${k} switched on to allow it.`)
			a.on[k] = input[k] === true && a.allowed[k]
		}
		await save()
		return true
	}
	const may = (a, ability) => a.allowed[ability] && a.on[ability]

	function call(id, name, args = {}, timeout = 10 * 60_000) {
		const l = live.get(id)
		if (!l) return Promise.reject(new RpcError('PRECONDITION_FAILED', 'That computer is offline right now'))
		const n = ++l.nextCall
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => (l.calls.delete(n), reject(new RpcError('BAD_GATEWAY', 'That computer didn’t answer in time'))), timeout)
			l.calls.set(n, {resolve, reject, timer})
			l.ws.send(JSON.stringify({op: 'call', id: n, name, args}))
		})
	}
	// Manage: a short list of things the connector knows how to do itself (it has no "run this").
	async function action(input) {
		await loaded
		const a = find(String(input?.id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		if (!may(a, 'manage')) throw new RpcError('FORBIDDEN', `Managing ${a.name} isn’t switched on`)
		const name = String(input?.name ?? '')
		if (name === 'plugin-install') {
			// Same rule as the App Store: only verified plugins, at the verified commit.
			const p = await plugins?.find(String(input?.pluginId ?? ''))
			if (!p) throw new RpcError('NOT_FOUND', 'That plugin isn’t in the verified list')
			return call(a.id, 'plugin-install', {id: p.id, repo: p.repo, commit: p.commit})
		}
		if (name === 'plugin-remove') return call(a.id, 'plugin-remove', {id: clip(input?.pluginId, 80)})
		if (name === 'theme-set') return call(a.id, 'theme-set', {name: clip(input?.theme, 80)})
		if (name === 'reboot') return call(a.id, 'reboot', {}, 30_000)
		throw new RpcError('BAD_REQUEST', 'Unknown action')
	}

	// ---- connector side (HTTP enroll + WebSocket) ----------------------------------------------
	const enrollTries = []
	async function enroll(body) {
		await loaded
		// A handful of tries a minute is plenty for people; it stops guessing.
		const t = now()
		while (enrollTries.length && enrollTries[0] < t - 60_000) enrollTries.shift()
		if (enrollTries.length >= 20) return {status: 429, body: {error: 'Too many tries. Wait a minute.'}}
		enrollTries.push(t)
		const p = pairings.get(sha(body?.token ?? ''))
		pairings.delete(sha(body?.token ?? ''))
		if (!p || p.expires < t) return {status: 401, body: {error: 'That pairing code isn’t valid any more. Make a new one in Machines → Local swarm → Add a computer.'}}
		const info = cleanInfo(body?.info)
		// The connector's own limits (what its installer was told) and the pairing's, together.
		const local = body?.abilities ?? {}
		const allowed = Object.fromEntries(ABILITIES.map((k) => [k, p.abilities[k] === true && local[k] === true]))
		const id = randomBytes(6).toString('hex')
		const key = randomBytes(32).toString('base64url')
		let name = info.hostname || 'computer'
		for (let n = 2; state.agents.some((a) => a.name === name); n++) name = `${info.hostname || 'computer'} ${n}`
		state.agents.push({id, name, keyHash: sha(key), allowed, on: {...allowed}, enrolledAt: t, lastSeen: null, info})
		await save()
		return {status: 200, body: {id, key, name, abilities: allowed}}
	}

	function authAgent(req) {
		const m = /^Bearer ([0-9a-f]{12}):([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))
		if (!m) return null
		const a = find(m[1])
		return a && sameHash(a.keyHash, sha(m[2])) ? a : null
	}

	async function upgradeAgent(req, socket, head) {
		await loaded
		const a = authAgent(req)
		if (!a) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
			return socket.destroy()
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			// One connection per computer: a new one replaces the old.
			live.get(a.id)?.ws.terminate()
			const l = {ws, metrics: a.metrics ?? null, channels: new Map(), nextCh: 0, calls: new Map(), nextCall: 0}
			live.set(a.id, l)
			const alive = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000)
			ws.on('message', async (data, isBinary) => {
				if (isBinary) {
					const buf = Buffer.from(data)
					if (buf.length < 4) return
					const ch = l.channels.get(buf.readUInt32BE(0))
					if (ch?.ws.readyState === ch?.ws.OPEN) ch.ws.send(buf.subarray(4), {binary: true})
					return
				}
				let msg
				try {
					msg = JSON.parse(String(data))
				} catch {
					return
				}
				if (msg.op === 'hello') {
					a.info = cleanInfo(msg.info)
					// The connector's own limits win if they're narrower than what was stored.
					for (const k of ABILITIES) if (msg.abilities?.[k] !== true) a.allowed[k] = a.on[k] = false
					a.lastSeen = now()
					await save()
				} else if (msg.op === 'metrics') {
					l.metrics = cleanMetrics(msg.metrics)
					a.metrics = l.metrics
				} else if (msg.op === 'closed') {
					const ch = l.channels.get(Number(msg.ch))
					if (ch) (l.channels.delete(Number(msg.ch)), ch.ws.close(msg.code === 1011 ? 1011 : 1000, clip(msg.reason, 120)))
				} else if (msg.op === 'result') {
					const c = l.calls.get(Number(msg.id))
					if (!c) return
					l.calls.delete(Number(msg.id))
					clearTimeout(c.timer)
					if (msg.ok) c.resolve(msg.data ?? true)
					else c.reject(new RpcError('BAD_GATEWAY', clip(msg.error, 400) || 'That didn’t work'))
				}
			})
			const gone = async () => {
				clearInterval(alive)
				if (live.get(a.id)?.ws !== ws) return
				live.delete(a.id)
				for (const ch of l.channels.values()) ch.ws.close(1000, 'The computer went offline')
				for (const c of l.calls.values()) (clearTimeout(c.timer), c.reject(new RpcError('BAD_GATEWAY', 'The computer went offline')))
				a.lastSeen = now()
				await save().catch(() => {})
			}
			ws.on('close', gone)
			ws.on('error', gone)
		})
	}

	// A browser's terminal or desktop viewer, joined to a channel on the computer's connector.
	function openChannel(agentId, kind, browserWs, opts = {}) {
		const a = find(agentId)
		const l = live.get(agentId)
		const ability = kind === 'pty' ? 'terminal' : 'desktop'
		if (!a || !l || !may(a, ability)) return browserWs.close(1011, !a ? 'Unknown computer' : !l ? 'That computer is offline' : `${ability === 'terminal' ? 'The terminal' : 'The desktop'} isn’t switched on for ${a.name}`)
		const ch = ++l.nextCh
		l.channels.set(ch, {ws: browserWs})
		l.ws.send(JSON.stringify({op: 'open', ch, kind, cols: opts.cols, rows: opts.rows}))
		const head = Buffer.alloc(4)
		head.writeUInt32BE(ch)
		browserWs.on('message', (d) => l.ws.readyState === l.ws.OPEN && l.ws.send(Buffer.concat([head, Buffer.from(d)]), {binary: true}))
		const end = () => {
			if (!l.channels.delete(ch)) return
			if (l.ws.readyState === l.ws.OPEN) l.ws.send(JSON.stringify({op: 'close', ch}))
		}
		browserWs.on('close', end)
		browserWs.on('error', end)
	}

	return {
		procedures: {
			'swarm.list': {kind: 'query', run: list},
			'swarm.pair': {kind: 'mutation', run: pair},
			'swarm.remove': {kind: 'mutation', run: remove},
			'swarm.rename': {kind: 'mutation', run: rename},
			'swarm.setAbilities': {kind: 'mutation', run: setAbilities},
			'swarm.action': {kind: 'mutation', run: action},
			// Before showing a computer's screen: can it, and if not, why (in words, not a socket code).
			'swarm.desktopCheck': {
				kind: 'query',
				run: async (input) => {
					await loaded
					const a = find(String(input?.id ?? ''))
					if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
					if (!may(a, 'desktop')) throw new RpcError('FORBIDDEN', `Seeing ${a.name}’s desktop isn’t switched on`)
					if (!live.has(a.id)) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
					const d = a.info?.desktop
					if (d && !d.ok) throw new RpcError('PRECONDITION_FAILED', d.why || 'Its desktop can’t be shown')
					return true
				},
			},
		},
		enroll,
		upgradeAgent,
		openChannel,
		isAgentMachine: (machineId) => /^agent-[0-9a-f]{12}$/.test(machineId),
		close: () => {
			for (const l of live.values()) l.ws.terminate()
		},
	}
}
