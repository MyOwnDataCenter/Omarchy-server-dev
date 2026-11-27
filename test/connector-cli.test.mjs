// `connector/agent.py` CLI argument handling, --help, and enroll error paths.
import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {ensureTls} from '../omarchyd/tls.mjs'

const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
const PY_TEST = fileURLToPath(new URL('../connector/test_agent.py', import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), 'connector-cli-'))
after(() => rm(root, {recursive: true, force: true}))

function runAgent(args, {home, timeout = 5000} = {}) {
	return spawnSync('python3', ['-I', AGENT, ...args], {
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, '.config'),
			XDG_DATA_HOME: join(home, '.local/share'),
			XDG_RUNTIME_DIR: join(home, 'run'),
		},
		encoding: 'utf8',
		timeout,
	})
}

const closedPort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const {port} = s.address()
			s.close(() => resolve(port))
		})
	})

test('#612: python connector unit tests pass', () => {
	execFileSync('python3', ['-m', 'unittest', PY_TEST], {encoding: 'utf8', stdio: 'pipe'})
	assert.ok(true)
})

test('#612: --help, -h, help, enroll --help, and info --help exit 0 with or without config.json', async () => {
	const unconfigured = await mkdtemp(join(root, 'unconf-'))
	const configured = await mkdtemp(join(root, 'conf-'))
	await mkdir(join(configured, '.config/omarchy-connector'), {recursive: true})
	await writeFile(join(configured, '.config/omarchy-connector/config.json'), JSON.stringify({server: 'https://127.0.0.1:7780', id: '1', key: 'k'}))

	for (const home of [unconfigured, configured]) {
		for (const args of [['--help'], ['-h'], ['help'], ['help', 'enroll'], ['enroll', '--help'], ['info', '--help']]) {
			const r = runAgent(args, {home, timeout: 2500})
			assert.equal(r.signal, null, `${args.join(' ')} timed out / signaled`)
			assert.equal(r.status, 0, `${args.join(' ')} status=${r.status} stderr=${r.stderr}`)
			assert.equal(r.stderr, '')
			assert.match(r.stdout, /enroll/)
		}
	}
})

test('#612: unknown options and malformed enroll/info invocations exit 2 without traceback', async () => {
	const home = await mkdtemp(join(root, 'badargs-'))
	const cases = [
		['--version'],
		['--bogus'],
		['status'],
		['info', 'extra'],
		['enroll'],
		['enroll', 'https://127.0.0.1:7780'],
		['enroll', 'https://127.0.0.1:7780', 'tok', 'terminal', 'extra'],
		['enroll', '--bad', 'tok'],
	]
	for (const args of cases) {
		const r = runAgent(args, {home})
		assert.equal(r.status, 2, `${args.join(' ')} expected exit 2, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /Use:/)
		assert.doesNotMatch(r.stderr, /Traceback|IndexError/)
	}
})

test('#612: enroll prints friendly messages on missing CA file and unreachable server', async () => {
	const homeNoCa = await mkdtemp(join(root, 'noca-'))
	const rNoCa = runAgent(['enroll', 'https://127.0.0.1:1', 'tok'], {home: homeNoCa})
	assert.equal(rNoCa.status, 1)
	assert.match(rNoCa.stderr, /Server certificate not found/)
	assert.doesNotMatch(rNoCa.stderr, /Traceback|FileNotFoundError/)

	const homeWithCa = await mkdtemp(join(root, 'withca-'))
	const tlsDir = join(homeWithCa, 'tls')
	await ensureTls({dir: tlsDir})
	await mkdir(join(homeWithCa, '.config/omarchy-connector'), {recursive: true})
	await copyFile(join(tlsDir, 'ca.crt'), join(homeWithCa, '.config/omarchy-connector/server-ca.crt'))

	const port = await closedPort()
	const rDown = runAgent(['enroll', `https://127.0.0.1:${port}`, 'tok'], {home: homeWithCa})
	assert.equal(rDown.status, 1)
	assert.match(rDown.stderr, /Couldn't reach/)
	assert.doesNotMatch(rDown.stderr, /Traceback|URLError/)
})
