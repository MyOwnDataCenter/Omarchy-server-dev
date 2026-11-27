import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {buildWolPacket, cleanMetrics, createConnector} from '../omarchyd/connector.mjs'
import {ensureTls} from '../omarchyd/tls.mjs'
import {swarmGaugeItems} from '../web/src/swarm/gauges.ts'

describe('swarm telemetry, history, alerts, power and resumable terminals', () => {
	let root, dataDir, tlsDir, c, server, port, clock, wolCalls

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'swarm-tel-'))
		dataDir = join(root, 'data')
		tlsDir = join(root, 'tls')
		await mkdir(dataDir, {recursive: true})
		await ensureTls({dir: tlsDir})
		clock = 1_700_000_000_000
		wolCalls = []
		c = createConnector({
			dataDir,
			tlsDir,
			now: () => clock,
			sendWol: async (mac) => {
				wolCalls.push(mac)
			},
		})
		server = http.createServer((_req, res) => {
			res.writeHead(404)
			res.end()
		})
		server.on('upgrade', (req, socket, head) => c.upgradeAgent(req, socket, head))
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		port = server.address().port
	})

	after(async () => {
		c?.close()
		await new Promise((r) => server?.close(r))
		await rm(root, {recursive: true, force: true})
	})

	test('buildWolPacket creates a valid 102-byte Wake-on-LAN magic packet', () => {
		const pkt = buildWolPacket('aa:bb:cc:dd:ee:ff')
		assert.equal(pkt.length, 102)
		assert.deepEqual(pkt.subarray(0, 6), Buffer.alloc(6, 0xff))
		for (let i = 0; i < 16; i++) {
			assert.deepEqual(pkt.subarray(6 + i * 6, 6 + (i + 1) * 6), Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))
		}
		assert.throws(() => buildWolPacket('not-a-mac'), /Invalid MAC/)
	})

	test('cleanMetrics and swarmGaugeItems preserve GPU VRAM, temp, power and net rates', () => {
		const m = cleanMetrics({
			cpu: 25,
			cores: 8,
			mem: {total: 16 * 1024 ** 3, used: 8 * 1024 ** 3},
			disks: [{mount: '/', total: 500e9, used: 100e9}],
			gpus: [{id: 'gpu-0', index: 0, name: 'NVIDIA GeForce RTX 4090', used: 65, vramUsed: 12 * 1024 ** 3, vramTotal: 24 * 1024 ** 3, temp: 68, power: 240.5}],
			net: {rx: 125_000, tx: 42_000},
		})
		assert.equal(m.gpus[0].vramUsed, 12 * 1024 ** 3)
		assert.equal(m.gpus[0].vramTotal, 24 * 1024 ** 3)
		assert.equal(m.gpus[0].temp, 68)
		assert.equal(m.gpus[0].power, 240.5)
		assert.deepEqual(m.net, {rx: 125_000, tx: 42_000})

		const items = swarmGaugeItems(m)
		const gpu = items.find((g) => g.k === 'GPU')
		assert.equal(gpu.sub, 'RTX 4090 · 12.0 GB/24 GB')
	})

	test('records metrics history, computes fleet alerts, dispatches power actions, and sends WoL', async () => {
		const p = await c.procedures['swarm.pair'].run({terminal: true, manage: true})
		const enrolled = await c.enroll({
			token: p.token,
			info: {hostname: 'gpu-box', os: 'Omarchy', macs: ['00:11:22:33:44:55']},
			abilities: {terminal: true, manage: true},
		})
		const {id, key} = enrolled.body

		const ws = new WebSocket(`ws://127.0.0.1:${port}/connector/ws`, {headers: {authorization: `Bearer ${id}:${key}`}})
		const calls = []
		await new Promise((resolve, reject) => {
			ws.once('open', resolve)
			ws.once('error', reject)
		})
		ws.on('message', (raw) => {
			const msg = JSON.parse(String(raw))
			if (msg.op === 'call') {
				calls.push(msg)
				ws.send(JSON.stringify({op: 'result', id: msg.id, ok: true, data: true}))
			}
		})

		ws.send(JSON.stringify({op: 'hello', info: {hostname: 'gpu-box', os: 'Omarchy', macs: ['00:11:22:33:44:55']}, abilities: {terminal: true, manage: true}}))
		ws.send(JSON.stringify({op: 'metrics', metrics: {cpu: 40, mem: {total: 1000, used: 500}, disks: [{mount: '/', total: 1000, used: 960}], temp: 91, updates: 4, net: {rx: 100, tx: 200}}}))
		clock += 65_000
		ws.send(JSON.stringify({op: 'metrics', metrics: {cpu: 60, mem: {total: 1000, used: 700}, disks: [{mount: '/', total: 1000, used: 960}], temp: 91, updates: 4, net: {rx: 300, tx: 400}}}))
		await new Promise((r) => setTimeout(r, 80))

		const h1 = await c.procedures['swarm.history'].run({id, range: '1h'})
		assert.equal(h1.points.length, 2)
		assert.equal(h1.points[0].cpu, 40)
		assert.equal(h1.points[1].cpu, 60)

		const h24 = await c.procedures['swarm.history'].run({id, range: '24h'})
		assert.equal(h24.points.length, 2)

		const alerts = await c.procedures['swarm.alerts'].run()
		assert.ok(alerts.some((a) => a.kind === 'disk' && a.severity === 'critical'))
		assert.ok(alerts.some((a) => a.kind === 'temp' && a.severity === 'warning'))
		assert.ok(alerts.some((a) => a.kind === 'updates'))

		// Power actions: suspend and shutdown.
		await c.procedures['swarm.action'].run({id, name: 'suspend'})
		await c.procedures['swarm.action'].run({id, name: 'shutdown'})
		assert.deepEqual(
			calls.map((x) => x.name),
			['suspend', 'shutdown'],
		)

		// Wake-on-LAN uses the agent's recorded MAC.
		const woken = await c.procedures['swarm.wake'].run({id})
		assert.equal(woken.mac, '00:11:22:33:44:55')
		assert.deepEqual(wolCalls, ['00:11:22:33:44:55'])

		// Disconnecting and advancing clock >2m triggers offline alert.
		ws.close()
		await new Promise((r) => setTimeout(r, 80))
		clock += 180_000
		const offlineAlerts = await c.procedures['swarm.alerts'].run()
		assert.ok(offlineAlerts.some((a) => a.kind === 'offline' && a.agentId === id))
	})
})
