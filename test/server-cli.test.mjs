// `server/cli.mjs` option parsing, validation, error handling, and help output.
import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {normalizeAppHosts} from '../server/app.mjs'

const CLI = fileURLToPath(new URL('../server/cli.mjs', import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), 'server-cli-'))
after(() => rm(root, {recursive: true, force: true}))

const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const {port} = s.address()
			s.close(() => resolve(port))
		})
	})

function runSync(args, extraEnv = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: {...process.env, HOME: root, OMARCHY_TLS_DIR: join(root, 'tls'), ...extraEnv},
		encoding: 'utf8',
		timeout: 15_000,
	})
}

async function startAndWaitForBanner(args, extraEnv = {}) {
	const child = spawn(process.execPath, [CLI, ...args], {
		env: {...process.env, HOME: root, OMARCHY_TLS_DIR: join(root, 'tls'), ...extraEnv},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (d) => (stdout += d))
	child.stderr.on('data', (d) => (stderr += d))
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out\nstdout=${stdout}\nstderr=${stderr}`)), 10_000)
			const check = () => {
				if (stdout.includes('Open')) {
					clearTimeout(timer)
					resolve()
				}
			}
			child.stdout.on('data', check)
			child.on('exit', (code) => {
				clearTimeout(timer)
				reject(new Error(`exited early (${code})\nstdout=${stdout}\nstderr=${stderr}`))
			})
		})
		return {stdout, stderr, child}
	} catch (error) {
		child.kill('SIGKILL')
		throw error
	}
}

async function stopChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return
	child.kill('SIGTERM')
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			resolve()
		}, 5000)
		child.once('exit', () => {
			clearTimeout(timer)
			resolve()
		})
	})
}

test('#609: rejects unknown, mistyped, missing-value, and positional options with exit 2 and no stack trace', () => {
	const cases = [
		['--bogus'],
		['--prot', '7790'],
		['--host'],
		['--port', '--host', '127.0.0.1'],
		['extra'],
	]
	for (const args of cases) {
		const r = runSync(args)
		assert.equal(r.status, 2, `${args.join(' ')} expected exit 2, got ${r.status} (stderr=${r.stderr})`)
		assert.match(r.stderr, /\[omarchy-server\]/)
		assert.doesNotMatch(r.stderr, /^\s+at /m)
	}
})

test('#609: accepts --name=value and uses the last value for repeated options', async () => {
	const port1 = await freePort()
	const port2 = await freePort()
	const data = await mkdtemp(join(root, 'eq-'))
	const res = await startAndWaitForBanner([`--port=${port1}`, `--port=${port2}`, '--host=127.0.0.1', `--data=${data}`])
	try {
		assert.match(res.stdout, new RegExp(`:${port2}\\b`))
		const health = await fetch(`http://127.0.0.1:${port2}/api/health`)
		assert.equal(health.status, 200)
	} finally {
		await stopChild(res.child)
	}
})

test('#448: --help and -h document --app-hosts and all server environment variables', () => {
	for (const flag of ['--help', '-h']) {
		const r = runSync([flag])
		assert.equal(r.status, 0, `${flag}: ${r.stderr}`)
		assert.equal(r.stderr, '')
		for (const expected of [
			'--backend',
			'--port',
			'--host',
			'--data',
			'--app-hosts',
			'PORT',
			'HOST',
			'OMARCHY_BACKEND_URL',
			'OMARCHY_SERVER_DATA',
			'TOUCH_APP_HOSTS',
			'OMARCHY_SERVER_SECURE_COOKIES',
		]) {
			assert.ok(r.stdout.includes(expected), `${flag} output missing ${expected}`)
		}
	}
})

test('#439: rejects invalid --port and PORT with exit 1 and no stack trace', () => {
	const data = join(root, 'bad-port-data')
	const flagCases = [
		['--port', '70000'],
		['--port', 'abc'],
		['--port', '0'],
		['--port', ''],
		['--port=-1'],
		['--port', '1.5'],
		['--port', '65536'],
	]
	for (const args of flagCases) {
		const r = runSync([...args, '--data', data])
		assert.equal(r.status, 1, `${args.join(' ')} expected exit 1, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /--port must be a number from 1 to 65535/)
		assert.doesNotMatch(r.stderr, /ERR_SOCKET_BAD_PORT|^\s+at /m)
	}
	for (const val of ['abc', '70000', '-1']) {
		const r = runSync(['--data', data], {PORT: val})
		assert.equal(r.status, 1, `PORT=${val} expected exit 1, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /PORT must be a number from 1 to 65535/)
		assert.doesNotMatch(r.stderr, /ERR_SOCKET_BAD_PORT|^\s+at /m)
	}
})

test('#439: empty PORT falls back to 7780 instead of listening on port 0', async () => {
	const data = await mkdtemp(join(root, 'empty-port-'))
	const child = spawn(process.execPath, [CLI, '--host', '127.0.0.1', '--data', data], {
		env: {...process.env, HOME: root, OMARCHY_TLS_DIR: join(root, 'tls'), PORT: ''},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (d) => (stdout += d))
	child.stderr.on('data', (d) => (stderr += d))
	try {
		const outcome = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out\nstdout=${stdout}\nstderr=${stderr}`)), 10_000)
			child.stdout.on('data', () => {
				if (stdout.includes('Open')) {
					clearTimeout(timer)
					resolve('started')
				}
			})
			child.on('exit', (code) => {
				clearTimeout(timer)
				resolve(`exited:${code}`)
			})
		})
		if (outcome === 'started') {
			assert.match(stdout, /:7780\b/)
			assert.doesNotMatch(stdout, /:0\b/)
		} else {
			assert.match(stderr, /7780|EADDRINUSE|EACCES/)
			assert.doesNotMatch(stdout, /:0\b/)
		}
	} finally {
		await stopChild(child)
	}
})

test('#447: unusable --backend or OMARCHY_BACKEND_URL exits 1 with a clean message and no stack trace', () => {
	const data = join(root, 'bad-backend-data-does-not-exist')
	for (const val of ['http://a b', 'http://user:pw@host', '']) {
		const r = runSync(['--backend', val, '--data', data])
		assert.equal(r.status, 1, `--backend ${JSON.stringify(val)} expected exit 1, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /^\[omarchy-server\] --backend: /m)
		assert.doesNotMatch(r.stderr, /TypeError|ERR_INVALID_URL|^\s+at /m)
	}
	const rEnv = runSync(['--data', data], {OMARCHY_BACKEND_URL: 'x y'})
	assert.equal(rEnv.status, 1)
	assert.match(rEnv.stderr, /^\[omarchy-server\] OMARCHY_BACKEND_URL: /m)
	assert.doesNotMatch(rEnv.stderr, /TypeError|ERR_INVALID_URL|^\s+at /m)
	assert.equal(existsSync(data), false)
})

test('#617: invalid --app-hosts or TOUCH_APP_HOSTS is refused without saving, and empty clears saved value', async () => {
	const badDir = join(root, 'bad-app-hosts-does-not-exist')
	for (const val of ['touch.example.com', '{app}_touch.example.com', 'https://{app}.example.com']) {
		const r = runSync(['--app-hosts', val, '--data', badDir])
		assert.equal(r.status, 2, `--app-hosts ${val} expected exit 2, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /--app-hosts must look like/)
	}
	const rBadEnv = runSync(['--data', badDir], {TOUCH_APP_HOSTS: 'touch.example.com'})
	assert.equal(rBadEnv.status, 2)
	assert.match(rBadEnv.stderr, /TOUCH_APP_HOSTS must look like/)
	assert.equal(existsSync(badDir), false)

	const data = await mkdtemp(join(root, 'app-hosts-'))
	const cfgPath = join(data, 'config.json')
	const readCfg = async () => JSON.parse(await readFile(cfgPath, 'utf8'))

	// Save valid value
	const s1 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data, '--app-hosts', '{app}-touch.example.com'])
	await stopChild(s1.child)
	assert.equal((await readCfg()).appHosts, '{app}-touch.example.com')

	// Preserved when unset
	const s2 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data])
	await stopChild(s2.child)
	assert.equal((await readCfg()).appHosts, '{app}-touch.example.com')

	// Cleared with empty --app-hosts ""
	const s3 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data, '--app-hosts', ''])
	await stopChild(s3.child)
	assert.equal((await readCfg()).appHosts, null)

	// Re-save, then clear with empty TOUCH_APP_HOSTS=""
	const s4 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data, '--app-hosts', '{app}-touch.example.com'])
	await stopChild(s4.child)
	assert.equal((await readCfg()).appHosts, '{app}-touch.example.com')

	const s5 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data], {TOUCH_APP_HOSTS: ''})
	await stopChild(s5.child)
	assert.equal((await readCfg()).appHosts, null)

	// Re-save, then clear with --app-hosts off
	const s6 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data, '--app-hosts', '{app}-touch.example.com'])
	await stopChild(s6.child)
	assert.equal((await readCfg()).appHosts, '{app}-touch.example.com')

	const s7 = await startAndWaitForBanner(['--port', String(await freePort()), '--host', '127.0.0.1', '--data', data, '--app-hosts', 'off'])
	await stopChild(s7.child)
	assert.equal((await readCfg()).appHosts, null)
})

test('#617: normalizeAppHosts accepts valid patterns, clears on empty/off, and rejects invalid inputs', () => {
	assert.equal(normalizeAppHosts('{app}-touch.example.com'), '{app}-touch.example.com')
	assert.equal(normalizeAppHosts('  {APP}.Home.Example.Com  '), '{app}.home.example.com')
	assert.equal(normalizeAppHosts('off'), null)
	assert.equal(normalizeAppHosts('OFF'), null)
	assert.equal(normalizeAppHosts(''), null)
	assert.equal(normalizeAppHosts('   '), null)
	for (const bad of ['touch.example.com', '{app}_touch.example.com', 'https://{app}.example.com', '{app}', '{app}-{app}.example.com', '{app}.', '.{app}.com', '{app}..com']) {
		assert.throws(() => normalizeAppHosts(bad), /must look like/)
	}
})

test('#614: unusable --data prints a clean one-line error and exits 1 with no stack trace', async () => {
	const filePath = join(root, 'server-not-a-dir')
	await writeFile(filePath, 'x')

	const rFile = runSync(['--data', filePath])
	assert.equal(rFile.status, 1)
	assert.match(rFile.stderr, /^\[omarchy-server\] .*not a directory/m)
	assert.doesNotMatch(rFile.stderr, /^\s+at /m)

	const rEmpty = runSync(['--data', ''])
	assert.equal(rEmpty.status, 1)
	assert.match(rEmpty.stderr, /^\[omarchy-server\] --data cannot be empty/m)
	assert.doesNotMatch(rEmpty.stderr, /^\s+at /m)

	if (process.getuid?.() !== 0) {
		const locked = await mkdtemp(join(root, 'server-locked-'))
		await chmod(locked, 0o000)
		try {
			const rLocked = runSync(['--data', join(locked, 'sub')])
			assert.equal(rLocked.status, 1)
			assert.match(rLocked.stderr, /^\[omarchy-server\] .*permission denied/m)
			assert.doesNotMatch(rLocked.stderr, /^\s+at /m)
		} finally {
			await chmod(locked, 0o700)
		}
	}
})
