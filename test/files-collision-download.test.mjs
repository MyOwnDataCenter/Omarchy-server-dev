// Replace must not delete a parent, and share follow must see the normalized path.
import assert from 'node:assert/strict'
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

async function scratch() {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-files-collision-')))
	const home = join(root, 'home')
	await mkdir(join(root, 'data'))
	const files = createFiles({home, dataDir: join(root, 'data')})
	const call = (name, input) => files.procedures[name].run(input)
	return {root, home, files, call}
}

describe('files: replace onto a parent', () => {
	test('replace onto docs itself leaves Home/docs/file in place', async () => {
		const {root, home, call} = await scratch()
		try {
			// Home/docs/file, plus a nested folder named docs so the replacement target is docs.
			await mkdir(join(home, 'docs', 'file', 'docs'), {recursive: true})
			await writeFile(join(home, 'docs', 'file', 'note.txt'), 'keep')
			await writeFile(join(home, 'docs', 'file', 'docs', 'inner.txt'), 'inner')
			for (const name of ['files.copy', 'files.move']) {
				await assert.rejects(
					call(name, {path: '/Home/docs/file/docs', toDirectory: '/Home', collision: 'replace'}),
					(e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && e.message === '[subdir-of-self]',
				)
			}
			assert.equal(await readFile(join(home, 'docs', 'file', 'note.txt'), 'utf8'), 'keep')
			assert.equal(await readFile(join(home, 'docs', 'file', 'docs', 'inner.txt'), 'utf8'), 'inner')

			// A path whose real target is the parent of the file: box/note.txt -> Home/docs/file.
			await mkdir(join(home, 'box'))
			await symlink(join(home, 'docs', 'file'), join(home, 'box', 'note.txt'))
			for (const name of ['files.copy', 'files.move']) {
				await assert.rejects(
					call(name, {path: '/Home/docs/file/note.txt', toDirectory: '/Home/box', collision: 'replace'}),
					(e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && e.message === '[subdir-of-self]',
				)
			}
			assert.equal(await readFile(join(home, 'docs', 'file', 'note.txt'), 'utf8'), 'keep')
			assert.equal((await lstat(join(home, 'box', 'note.txt'))).isSymbolicLink(), true)
		} finally {
			await rm(root, {recursive: true, force: true})
		}
	})

	test('copy or move into a symlink that points inside the source is rejected', async () => {
		const {root, home, call} = await scratch()
		try {
			await mkdir(join(home, 'proj', 'inner'), {recursive: true})
			await writeFile(join(home, 'proj', 'a.txt'), 'keep')
			await symlink(join(home, 'proj', 'inner'), join(home, 'into'))
			for (const name of ['files.copy', 'files.move']) {
				await assert.rejects(
					call(name, {path: '/Home/proj', toDirectory: '/Home/into'}),
					(e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && e.message === '[subdir-of-self]',
					name,
				)
			}
			assert.equal(await readFile(join(home, 'proj', 'a.txt'), 'utf8'), 'keep')
			assert.deepEqual(await readdir(join(home, 'proj', 'inner')), [])
			assert.equal((await lstat(join(home, 'into'))).isSymbolicLink(), true)
			assert.equal(await realpath(join(home, 'into')), await realpath(join(home, 'proj', 'inner')))
		} finally {
			await rm(root, {recursive: true, force: true})
		}
	})
})

describe('files: share follow path', () => {
	test('rename, move, and trash follow the normalized virtual path; copy does not', async () => {
		const {root, home, files, call} = await scratch()
		const seen = []
		files.followShares((from, to) => {
			seen.push([from, to])
		})
		try {
			await mkdir(join(home, 'docs'), {recursive: true})
			await writeFile(join(home, 'docs', 'a.txt'), 'a')
			await call('files.rename', {path: '/Home/docs/', newName: 'notes'})
			assert.deepEqual(seen, [['/Home/docs', '/Home/notes']])
			seen.length = 0
			await call('files.rename', {path: '/Home//notes', newName: 'docs'})
			assert.deepEqual(seen, [['/Home/notes', '/Home/docs']])
			seen.length = 0
			await mkdir(join(home, 'Other'))
			await call('files.move', {path: '/Home//docs', toDirectory: '/Home/Other'})
			assert.deepEqual(seen, [['/Home/docs', '/Home/Other/docs']])
			seen.length = 0
			await call('files.trash', {path: '/Home/Other/docs/'})
			assert.deepEqual(seen, [['/Home/Other/docs', null]])
			seen.length = 0
			await call('files.createDirectory', {path: '/Home/keep'})
			await call('files.copy', {path: '/Home/keep/', toDirectory: '/Home/Other'})
			assert.deepEqual(seen, [])
			assert.equal((await lstat(join(home, 'Other', 'keep'))).isDirectory(), true)
		} finally {
			await rm(root, {recursive: true, force: true})
		}
	})
})

describe('files screen rules', () => {
	test('a new search query clears the selection; the same query does not', async () => {
		const {selectionAfterQuery} = await import('../web/src/screens/filesRules.ts')
		const selected = new Set(['/Home/docs/file', '/Home/docs/other'])
		assert.equal(selectionAfterQuery(selected, 'do', 'doc').size, 0)
		assert.equal(selectionAfterQuery(selected, 'doc', 'doc'), selected)
	})

	test('batch toast counts successes and stays quiet when every call failed', async () => {
		const {batchToast} = await import('../web/src/screens/filesRules.ts')
		assert.equal(batchToast(0, 2, 'trash'), null)
		assert.equal(batchToast(0, 1, 'delete'), null)
		assert.equal(batchToast(0, 3, 'restore'), null)
		assert.equal(batchToast(1, 0, 'trash'), 'Moved to Trash')
		assert.equal(batchToast(2, 0, 'trash'), '2 items moved to Trash')
		assert.equal(batchToast(1, 2, 'trash'), '1 of 3 moved to Trash')
		assert.equal(batchToast(4, 0, 'delete'), 'Deleted')
		assert.equal(batchToast(2, 1, 'delete'), 'Deleted 2 of 3')
		assert.equal(batchToast(1, 0, 'restore'), 'Restored')
		assert.equal(batchToast(3, 0, 'restore'), '3 items restored')
		assert.equal(batchToast(2, 2, 'restore'), 'Restored 2 of 4')
	})

	test('download is offered for one file, not a folder or a multi-selection', async () => {
		const {actionsForItems, offersDownload} = await import('../web/src/screens/filesRules.ts')
		const actions = [
			{id: 'download-zip', label: 'Download zip'},
			{id: 'download', label: 'Download'},
			{id: 'share-out', label: 'Share'},
			{id: 'trash', label: 'Trash'},
		]
		const ids = (items) => actionsForItems(actions, items).map((a) => a.id)
		assert.deepEqual(ids([{directory: true}]), ['share-out', 'trash'])
		assert.deepEqual(ids([{directory: false}, {directory: false}]), ['share-out', 'trash'])
		assert.deepEqual(ids([{directory: false}, {directory: true}]), ['share-out', 'trash'])
		assert.ok(ids([{directory: false}]).includes('download'))
		assert.equal(offersDownload([{directory: true}]), false)
		assert.equal(offersDownload([{directory: false}, {directory: false}]), false)
		assert.equal(offersDownload([{directory: false}]), true)
	})
})
