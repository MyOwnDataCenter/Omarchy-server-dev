#!/usr/bin/env node
// Install the npm packages only when they changed. `npm ci` deletes and reinstalls everything,
// which needs a lot of memory; most updates change no packages at all (a version bump touches
// package-lock.json, so the stamp is a hash of the packages alone, not of the whole file).
import {createHash} from 'node:crypto'
import {cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const live = join(root, 'node_modules')
const previous = join(root, 'node_modules.previous')
// A swap killed after the live folder was moved aside, and before the new one landed.
// That previous folder is the only copy, so it is renamed back, not deleted.
if (!existsSync(live) && existsSync(previous)) renameSync(previous, live)
// A killed run never reaches finally, so its stage (and a previous copy beside a live one) stays.
for (const name of readdirSync(root)) {
	if (name.startsWith('.deps-stage-')) rmSync(join(root, name), {recursive: true, force: true})
}
if (existsSync(live) && existsSync(previous)) rmSync(previous, {recursive: true, force: true})
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const packages = {...lock.packages}
if (packages['']) packages[''] = {...packages[''], version: undefined, name: undefined}
const hash = createHash('sha256').update(JSON.stringify(packages)).digest('hex')
const stamp = join(live, '.omarchy-packages')

if (process.argv.includes('--check')) process.exit(existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash ? 0 : 1)
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) {
	console.log('Packages unchanged')
	process.exit(0)
}
// npm ci deletes node_modules before it installs. Run it beside the live folder and swap only
// when it finishes, so a failed or killed install leaves the running server able to start.
const stage = mkdtempSync(join(root, '.deps-stage-'))
try {
	cpSync(join(root, 'package.json'), join(stage, 'package.json'))
	cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'))
	// Fewer parallel downloads keeps memory down on small machines.
	const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error', '--maxsockets=4'], {cwd: stage, stdio: 'inherit'})
	if (r.status !== 0) {
		rmSync(stage, {recursive: true, force: true})
		if (r.error?.message) console.error(r.error.message)
		if (r.signal) console.error(`npm was stopped by signal ${r.signal}.`)
		if (r.signal === 'SIGKILL' || r.status === 137) console.error('npm was stopped because the computer ran out of memory.')
		process.exit(r.status || 1)
	}
	rmSync(previous, {recursive: true, force: true})
	if (existsSync(live)) renameSync(live, previous)
	try {
		renameSync(join(stage, 'node_modules'), live)
	} catch (error) {
		if (!existsSync(live) && existsSync(previous)) renameSync(previous, live)
		throw error
	}
	rmSync(previous, {recursive: true, force: true})
	writeFileSync(stamp, hash + '\n')
} finally {
	rmSync(stage, {recursive: true, force: true})
}
