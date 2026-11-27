import assert from 'node:assert/strict'
import {gitArgv} from './git-nosign.mjs'
import {execFile} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {promisify} from 'node:util'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', gitArgv(['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]))

// The installer's GitHub in-place update (not the local-clone HEAD path).
async function updateLines() {
	const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
	const lines = script.split('\n').map((l) => l.trim()).filter((l) => /^git -C "\$APP" (fetch|reset --hard) /.test(l) && /\borigin\b/.test(l))
	assert.equal(lines.length, 2, 'install.sh fetches, then resets')
	return lines.join('\n')
}

test('updating an install to another branch works from a shallow clone of main', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'inst-branch-'))
	try {
		const origin = join(dir, 'origin')
		await run('git', ['init', '-q', '-b', 'main', origin])
		await writeFile(join(origin, 'which'), 'main\n')
		await git(origin, 'add', '.')
		await git(origin, 'commit', '-q', '-m', 'main')
		await git(origin, 'checkout', '-q', '-b', 'feature')
		await writeFile(join(origin, 'which'), 'feature\n')
		await git(origin, 'commit', '-q', '-am', 'feature')
		await git(origin, 'checkout', '-q', 'main')
		// What the installer's first run leaves: a depth-1 clone that only tracks main.
		const app = join(dir, 'app')
		await run('git', ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${origin}`, app])
		const lines = await updateLines()
		const update = (branch) => run('bash', ['-euc', lines], {env: {...process.env, APP: app, BRANCH: branch}})
		await update('feature')
		assert.equal(await readFile(join(app, 'which'), 'utf8'), 'feature\n')
		// And back again, as the in-app updater does.
		await update('main')
		assert.equal(await readFile(join(app, 'which'), 'utf8'), 'main\n')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
