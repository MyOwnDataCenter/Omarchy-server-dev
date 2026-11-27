// `install.sh` and `connector/install.sh` --help output and unknown-option usage messages.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const INSTALL = fileURLToPath(new URL('../install.sh', import.meta.url))
const CONNECTOR_INSTALL = fileURLToPath(new URL('../connector/install.sh', import.meta.url))

function runScript(script, args) {
	return spawnSync('bash', [script, ...args], {
		encoding: 'utf8',
		detached: true,
		timeout: 10_000,
	})
}

test('#620: install.sh --help and -h print options and environment variables on stdout and exit 0', () => {
	for (const args of [['--help'], ['-h'], ['--zfs', '--help']]) {
		const r = runScript(INSTALL, args)
		assert.equal(r.status, 0, `${args.join(' ')} status=${r.status} stderr=${r.stderr}`)
		assert.equal(r.stderr, '')
		for (const token of [
			'--zfs',
			'OMARCHY_SERVER_PORT',
			'OMARCHY_SERVER_REPO',
			'OMARCHY_SERVER_BRANCH',
			'OMARCHY_SERVER_SOURCE',
			'OMARCHY_SERVER_APP_STORE',
			'OMARCHY_SERVER_FROM_APP',
		]) {
			assert.ok(r.stdout.includes(token), `install.sh ${args.join(' ')} missing ${token}`)
		}
	}
})

test('#620: install.sh unknown option prints usage on stderr and exits 2', () => {
	const r = runScript(INSTALL, ['--bogus'])
	assert.equal(r.status, 2)
	assert.equal(r.stdout, '')
	assert.match(r.stderr, /Unknown option: --bogus/)
	assert.match(r.stderr, /--zfs/)
	assert.match(r.stderr, /OMARCHY_SERVER_PORT/)
})

test('#620: connector/install.sh --help and -h print valid options on stdout and exit 0', () => {
	for (const args of [['--help'], ['-h'], ['--uninstall', '--help']]) {
		const r = runScript(CONNECTOR_INSTALL, args)
		assert.equal(r.status, 0, `${args.join(' ')} status=${r.status} stderr=${r.stderr}`)
		assert.equal(r.stderr, '')
		for (const token of ['--server', '--ca', '--token', '--allow', '--source', '--uninstall']) {
			assert.ok(r.stdout.includes(token), `connector/install.sh ${args.join(' ')} missing ${token}`)
		}
	}
})

test('#620: connector/install.sh unknown option and missing value print usage on stderr and exit 2', () => {
	const bad = runScript(CONNECTOR_INSTALL, ['--bogus'])
	assert.equal(bad.status, 2)
	assert.equal(bad.stdout, '')
	assert.match(bad.stderr, /Unknown option: --bogus/)
	assert.match(bad.stderr, /--server/)
	assert.match(bad.stderr, /--uninstall/)

	const missing = runScript(CONNECTOR_INSTALL, ['--server'])
	assert.equal(missing.status, 2)
	assert.equal(missing.stdout, '')
	assert.match(missing.stderr, /Missing value for --server/)
	assert.match(missing.stderr, /--server/)
})
