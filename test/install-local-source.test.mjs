// install.sh isolation: validate SOURCE/APP_STORE, persist only when set, fetch local HEAD.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {after, before, test} from 'node:test'

const installPath = fileURLToPath(new URL('../install.sh', import.meta.url))
const script = await readFile(installPath, 'utf8')

let root
before(async () => (root = await mkdtemp(join(os.tmpdir(), 'omarchyd-install-'))))
after(() => rm(root, {recursive: true, force: true}))

function extract(name) {
	const re = new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, 'm')
	const m = script.match(re)
	assert.ok(m, `install.sh must define ${name}()`)
	return m[0]
}

function runBash(body, env = {}) {
	return new Promise((resolve) => {
		execFile('bash', ['-c', body], {env: {...process.env, ...env}}, (error, stdout, stderr) => {
			resolve({code: error?.code || 0, stdout: String(stdout), stderr: String(stderr)})
		})
	})
}

test('install.sh has no ~/code auto-detect', () => {
	assert.ok(!script.includes('$HOME/code/omarchy-server'))
	assert.ok(!script.includes('$HOME/code/app-store'))
})

test('require_local_git fails closed on a missing or relative path', async () => {
	const prelude = `die() { printf 'Error: %s\\n' "$*" >&2; exit 1; }\n${extract('require_local_git')}`
	const missing = await runBash(`${prelude}\nrequire_local_git OMARCHY_SERVER_SOURCE ${join(root, 'nope')}`)
	assert.equal(missing.code, 1)
	assert.match(missing.stderr, /OMARCHY_SERVER_SOURCE/)
	assert.match(missing.stderr, /not a git repository/)
	const relative = await runBash(`${prelude}\nrequire_local_git OMARCHY_SERVER_APP_STORE code/app-store`)
	assert.equal(relative.code, 1)
	assert.match(relative.stderr, /absolute path/)
	assert.match(relative.stderr, /GitHub app store/)
})

test('require_local_git accepts an absolute git directory', async () => {
	const dir = join(root, 'clone')
	await mkdir(dir)
	await writeFile(join(dir, '.git'), 'gitdir: /tmp/x.git\n')
	const prelude = `die() { printf 'Error: %s\\n' "$*" >&2; exit 1; }\n${extract('require_local_git')}`
	const ok = await runBash(`${prelude}\nrequire_local_git OMARCHY_SERVER_SOURCE ${dir}`)
	assert.equal(ok.code, 0, ok.stderr)
})

test('install.sh fetches a local clone HEAD, not origin/branch', () => {
	assert.match(script, /fetch --depth 1 "\$REPO" HEAD/)
	assert.match(script, /reset --hard FETCH_HEAD/)
})

test('install.sh writes Environment= only for SOURCE and APP_STORE that were set', () => {
	assert.match(script, /Environment=\\"OMARCHY_SERVER_SOURCE=/)
	assert.match(script, /Environment=\\"OMARCHY_SERVER_APP_STORE=/)
	assert.match(script, /OMARCHY_SERVER_SOURCE/)
	assert.ok(!/\$HOME\/code/.test(script))
})

test('#421: source paths are quoted so a space stays one Environment assignment', () => {
	assert.match(script, /Environment=\\"OMARCHY_SERVER_SOURCE=\$SOURCE\\"/)
	assert.match(script, /Environment=\\"OMARCHY_SERVER_APP_STORE=\$APP_STORE\\"/)
})

test('install.sh uses SOURCE as REPO when REPO is unset', () => {
	assert.match(script, /OMARCHY_SERVER_REPO/)
	assert.match(script, /REPO="\$SOURCE"/)
})
