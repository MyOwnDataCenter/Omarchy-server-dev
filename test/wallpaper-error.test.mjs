// A wallpaper change must wait for omarchy-theme-bg-set and surface its failure.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createOmarchyTheme as realCreate} from '../omarchyd/omarchy-theme.mjs'

const createOmarchyTheme = (opts) => realCreate({systemShare: null, systemBin: [], env: {}, ...opts})

const root = await mkdtemp(join(os.tmpdir(), 'omarchy-wallpaper-error-'))
after(() => rm(root, {recursive: true, force: true}))

test('setBackground rejects with the wallpaper command error and does not resolve before it finishes', async () => {
	const home = join(root, 'home')
	const omarchy = join(root, 'omarchy')
	const file = join(omarchy, 'themes/nord/backgrounds/fjord.webp')
	await mkdir(join(omarchy, 'themes/nord/backgrounds'), {recursive: true})
	await writeFile(file, 'img-nord')
	await mkdir(join(omarchy, 'bin'), {recursive: true})
	await writeFile(join(omarchy, 'bin', 'omarchy-theme-bg-set'), '#!/bin/sh\n', {mode: 0o755})
	const state = join(home, '.local/state/omarchy/current')
	await mkdir(state, {recursive: true})
	await symlink(join(omarchy, 'themes/nord'), join(state, 'theme'))
	await writeFile(join(state, 'theme.name'), 'nord\n')
	await symlink(file, join(state, 'background'))

	let started
	const startedP = new Promise((resolve) => {
		started = resolve
	})
	let release
	const gate = new Promise((resolve) => {
		release = resolve
	})
	const t = createOmarchyTheme({
		home,
		env: {OMARCHY_PATH: omarchy, PATH: '/usr/bin'},
		run: async (cmd) => {
			if (cmd.split('/').pop() !== 'omarchy-theme-bg-set') return
			started()
			await gate
			throw new Error('could not set wallpaper')
		},
	})
	const id = (await t.list()).groups.find((g) => g.theme === 'nord').items[0].id
	let settled = null
	const pending = t.setBackground(id).then(
		(value) => {
			settled = value
		},
		(error) => {
			settled = error
		},
	)
	await startedP
	assert.equal(settled, null, 'setBackground resolved before the wallpaper command finished')
	release()
	await pending
	assert.ok(settled instanceof Error, 'setBackground resolved when the wallpaper command failed')
	assert.match(settled.message, /could not set wallpaper/)
})
