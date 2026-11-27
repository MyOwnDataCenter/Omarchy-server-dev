import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {gitArgv} from './git-nosign.mjs'

const STORE_TESTS = [
	'app-data-ownership.test.mjs',
	'app-folders.test.mjs',
	'app-launch.test.mjs',
	'app-list.test.mjs',
	'apps.test.mjs',
	'assistant-mcp.test.mjs',
	'local-source.test.mjs',
	'low-ports-place.test.mjs',
	'store-index.test.mjs',
	'store-sync.test.mjs',
	'usb.test.mjs',
	'app-permissions.test.mjs',
	'install-branch.test.mjs',
	'app-compose-numbers.test.mjs',
	'app-install-failures.test.mjs',
	'app-lifecycle.test.mjs',
	'app-store-failures.test.mjs',
	'apps-concurrent.test.mjs',
	'appstore-listings.test.mjs',
	'appstore-sync.test.mjs',
	'publish.test.mjs',
	'tailscale.test.mjs',
]

test('gitArgv disables commit signing and hooks before the git subcommand', () => {
	const argv = gitArgv(['commit', '-qm', 'x'])
	assert.deepEqual(argv.slice(0, 6), ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null'])
	assert.ok(argv.indexOf('commit') > argv.indexOf('core.hooksPath=/dev/null'))
})

test('a commit succeeds when the repo config would sign and a hook would fail', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-nosign-'))
	try {
		execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: dir})
		execFileSync('git', ['config', 'user.name', 't'], {cwd: dir})
		execFileSync('git', ['config', 'user.email', 't@t'], {cwd: dir})
		execFileSync('git', ['config', 'commit.gpgsign', 'true'], {cwd: dir})
		execFileSync('git', ['config', 'tag.gpgsign', 'true'], {cwd: dir})
		execFileSync('git', ['config', 'gpg.program', 'false'], {cwd: dir})
		const hook = join(dir, '.git', 'hooks', 'pre-commit')
		await mkdir(join(dir, '.git', 'hooks'), {recursive: true})
		await writeFile(hook, '#!/bin/sh\nexit 1\n')
		await chmod(hook, 0o755)
		execFileSync('git', gitArgv(['commit', '--allow-empty', '-qm', 'ok']), {cwd: dir})
		assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], {cwd: dir, encoding: 'utf8'}).trim(), 'ok')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('store-building tests commit through gitArgv', async () => {
	for (const name of STORE_TESTS) {
		const text = await readFile(new URL(`./${name}`, import.meta.url), 'utf8')
		assert.match(text, /gitArgv\(/, name)
	}
})
