// A failed package install must leave the copy that is already installed. npm ci deletes
// node_modules before it fills it, so a failure in the live folder empties it.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/deps.mjs', import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), 'deps-keep-'))
after(() => rm(root, {recursive: true, force: true}))

const lock = JSON.stringify({packages: {'': {name: 'app', version: '1.0.0'}, 'node_modules/left': {version: '1.0.0'}}})

async function place(name) {
	const dir = join(root, name)
	const scripts = join(dir, 'scripts')
	await mkdir(scripts, {recursive: true})
	await writeFile(join(scripts, 'deps.mjs'), await readFile(SCRIPT))
	await writeFile(join(dir, 'package.json'), '{"name":"app","version":"1.0.0"}\n')
	await writeFile(join(dir, 'package-lock.json'), lock)
	await mkdir(join(dir, 'node_modules'))
	await writeFile(join(dir, 'node_modules/keep.txt'), 'installed')
	return dir
}

async function fakeNpm(body) {
	const dir = join(root, `npm-${Math.random().toString(16).slice(2)}`)
	await mkdir(dir)
	await writeFile(join(dir, 'npm'), `#!/bin/sh\necho "$PWD" >>"$FAKE_LOG"\n${body}\n`)
	await chmod(join(dir, 'npm'), 0o755)
	return dir
}

function run(dir, npmBin) {
	const log = join(dir, 'npm.log')
	const r = spawnSync(process.execPath, [join(dir, 'scripts/deps.mjs')], {
		env: {PATH: `${npmBin}:/usr/bin:/bin`, FAKE_LOG: log, HOME: dir},
		encoding: 'utf8',
		timeout: 20000,
	})
	return {status: r.status, out: `${r.stdout}${r.stderr}`, log}
}

test('a failed npm ci leaves the installed node_modules in place', async () => {
	const dir = await place('fail')
	// What npm ci does first: delete node_modules, then fail.
	const npmBin = await fakeNpm('rm -rf node_modules\nexit 1')
	const r = run(dir, npmBin)
	assert.notEqual(r.status, 0)
	assert.equal(await readFile(join(dir, 'node_modules/keep.txt'), 'utf8'), 'installed')
	const cwd = await readFile(r.log, 'utf8')
	assert.equal(cwd.trim() === dir, false, 'npm ci does not run in the live app folder')
})

test('a successful npm ci replaces node_modules only after it finishes', async () => {
	const dir = await place('ok')
	const npmBin = await fakeNpm('rm -rf node_modules\nmkdir -p node_modules\necho new > node_modules/marker\nexit 0')
	const r = run(dir, npmBin)
	assert.equal(r.status, 0, r.out)
	assert.equal(await readFile(join(dir, 'node_modules/marker'), 'utf8'), 'new\n')
	await assert.rejects(readFile(join(dir, 'node_modules/keep.txt')))
	assert.match(await readFile(join(dir, 'node_modules/.omarchy-packages'), 'utf8'), /^[0-9a-f]{64}\n$/)
})

test('npm that cannot be started names the spawn error and exits non-zero', async () => {
	const dir = await place('no-npm')
	const empty = join(root, 'empty-bin')
	await mkdir(empty, {recursive: true})
	const r = spawnSync(process.execPath, [join(dir, 'scripts/deps.mjs')], {
		env: {PATH: empty, HOME: dir},
		encoding: 'utf8',
		timeout: 20000,
	})
	assert.notEqual(r.status, 0)
	assert.match(`${r.stderr}`, /spawnSync npm ENOENT/)
})

test('a later run removes a stage folder and node_modules.previous left beside a live install', async () => {
	const dir = await place('killed')
	await mkdir(join(dir, '.deps-stage-old'))
	await writeFile(join(dir, '.deps-stage-old/marker.txt'), 'left')
	await mkdir(join(dir, 'node_modules.previous'))
	await writeFile(join(dir, 'node_modules.previous/old.txt'), 'left')
	const npmBin = await fakeNpm('exit 1')
	const r = run(dir, npmBin)
	assert.notEqual(r.status, 0)
	await assert.rejects(readFile(join(dir, '.deps-stage-old/marker.txt')))
	await assert.rejects(readFile(join(dir, 'node_modules.previous/old.txt')))
	assert.equal(await readFile(join(dir, 'node_modules/keep.txt'), 'utf8'), 'installed')
})

test('node_modules.previous is kept when it is the only copy', async () => {
	const dir = await place('only-prev')
	await rm(join(dir, 'node_modules'), {recursive: true, force: true})
	await mkdir(join(dir, 'node_modules.previous'))
	await writeFile(join(dir, 'node_modules.previous/keep.txt'), 'only')
	const npmBin = await fakeNpm('exit 1')
	const r = run(dir, npmBin)
	assert.notEqual(r.status, 0)
	const live = await readFile(join(dir, 'node_modules/keep.txt'), 'utf8').catch(() => null)
	const prev = await readFile(join(dir, 'node_modules.previous/keep.txt'), 'utf8').catch(() => null)
	assert.equal(live ?? prev, 'only')
})

test('git ignores deps stage folders and the previous node_modules', async () => {
	const text = await readFile(new URL('../.gitignore', import.meta.url), 'utf8')
	assert.match(text, /\.deps-stage-\*/)
	assert.match(text, /node_modules\.previous/)
})
