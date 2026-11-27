// A restart (SIGTERM) used to wait the full 90 s for systemd's SIGKILL while a browser held a
// connection open (issue #87). It ends open connections and exits in a few seconds now.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

const free = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const {port} = s.address()
			s.close(() => resolve(port))
		})
	})

test('the web server stops in seconds on SIGTERM, even with a connection held open', {timeout: 30_000}, async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'web-stop-'))
	const port = await free()
	const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'server', 'cli.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', dir], {env: {...process.env, HOME: dir}, stdio: ['ignore', 'pipe', 'pipe']})
	try {
		await new Promise((resolve, reject) => {
			child.stdout.on('data', (d) => String(d).includes('Open') && resolve())
			child.on('exit', (code) => reject(new Error(`exited early (${code})`)))
		})
		// Like a browser: a connection that stays open (a request it never finishes sending).
		const held = net.connect(port, '127.0.0.1')
		await new Promise((r) => held.once('connect', r))
		held.write('GET / HTTP/1.1\r\nHost: x\r\n')
		held.on('error', () => {})
		await new Promise((r) => setTimeout(r, 300))
		const started = Date.now()
		child.kill('SIGTERM')
		const code = await new Promise((r) => child.once('exit', (c, sig) => r(c ?? sig)))
		const took = Date.now() - started
		assert.equal(code, 0)
		assert.ok(took < 4000, `took ${took} ms`)
		held.destroy()
	} finally {
		child.kill('SIGKILL')
		await rm(dir, {recursive: true, force: true})
	}
})
