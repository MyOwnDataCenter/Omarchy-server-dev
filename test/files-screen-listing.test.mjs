// Pure Files screen rules for listing, search, viewer, copy, and grid keyboard movement.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

const {nice, readStoredFilesPath, filesPathToStore, PHONE_FILES_PATH_KEY, filesListMoreLeft, FILES_LIST_PAGE, asFileSearch, searchMatchNote, viewerAfterPathChange, copyTextOrToast} = await import('../web/src/screens/filesRules.ts')
const {nextGridCell} = await import('../web/src/screens/viewer/helpers.ts')

const filesSrc = await readFile(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')
const viewerSrc = await readFile(new URL('../web/src/screens/viewer/FileViewer.tsx', import.meta.url), 'utf8')
const deskSrc = await readFile(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')

describe('files screen listing helpers', () => {
	test('nice() uses the codes the files daemon sends', () => {
		assert.equal(nice('[already-exists]'), 'Something with that name is already there')
		assert.equal(nice('[destination-already-exists]'), 'Something with that name is already there')
		assert.equal(nice('[invalid-name]'), 'That name isn’t allowed')
		assert.equal(nice('[hidden-name]'), 'Names starting with a dot are hidden')
		assert.equal(nice('[cannot-trash]'), 'That can’t be moved to Trash')
		assert.equal(nice('[not-in-trash]'), 'That isn’t in Trash')
		assert.equal(nice('[only-from-trash]'), 'Only items in Trash can be deleted')
		assert.equal(nice('[outside-home]'), 'That isn’t inside Home')
		assert.equal(nice('[not-a-directory]'), 'That isn’t a folder')
		assert.equal(nice('[is-a-directory]'), 'That’s a folder, not a file')
		assert.equal(nice('[does-not-exist]'), 'That item no longer exists')
		assert.equal(nice('[subdir-of-self]'), 'A folder can’t go inside itself')
		assert.equal(nice('[not-a-directory:notes.txt]'), 'notes.txt is a file, not a folder')
		assert.equal(nice('[permission]'), 'You don’t have permission to change that folder')
		assert.notEqual(nice('[already-exists]'), 'already exists')
	})

	test('each desktop window remembers its own folder and the phone keeps the shared key', () => {
		const store = new Map()
		const read = (key) => (store.has(key) ? store.get(key) : null)
		assert.equal(readStoredFilesPath(undefined, undefined, read), null)
		assert.equal(readStoredFilesPath(undefined, '/Home/Photos', read), '/Home/Photos')
		const phone = filesPathToStore(undefined, '/Home/Documents')
		assert.equal(phone.key, PHONE_FILES_PATH_KEY)
		store.set(phone.key, phone.value)
		assert.equal(readStoredFilesPath('win-a', undefined, read), null)
		assert.equal(readStoredFilesPath('win-b', '/Home/Photos', read), '/Home/Photos')
		store.set(filesPathToStore('win-a', '/Home/Documents').key, '/Home/Documents')
		store.set(filesPathToStore('win-b', '/Home/Photos').key, '/Home/Photos')
		assert.equal(readStoredFilesPath('win-a', undefined, read), '/Home/Documents')
		assert.equal(readStoredFilesPath('win-b', undefined, read), '/Home/Photos')
		assert.equal(readStoredFilesPath(undefined, undefined, read), '/Home/Documents')
		const cleared = filesPathToStore('win-a', null)
		assert.equal(cleared.key, `${PHONE_FILES_PATH_KEY}:win-a`)
		assert.equal(cleared.value, '')
		store.set(cleared.key, cleared.value)
		assert.equal(readStoredFilesPath('win-a', '/Home/Documents', read), null)
		assert.match(deskSrc, /<Files windowId=\{win\.id\} initialPath=\{win\.payload\?\.path\} \/>/)
		assert.match(filesSrc, /const storageId = windowId \?\?/)
		assert.match(filesSrc, /readStoredFilesPath\(storageId/)
		assert.equal(filesSrc.includes('sessionStorage.getItem("omarchy-server:files-path")'), false)
	})

	test('a long folder page asks for another 300 and search says when it is cut', () => {
		assert.equal(FILES_LIST_PAGE, 300)
		assert.equal(filesListMoreLeft(5000, 300), 4700)
		assert.equal(filesListMoreLeft(300, 300), 0)
		assert.equal(asFileSearch([{path: '/Home/a'}]).truncated, false)
		const page = asFileSearch({files: [{path: '/Home/a'}], truncated: true})
		assert.equal(page.files.length, 1)
		assert.equal(page.truncated, true)
		assert.equal(searchMatchNote(10, true), 'Showing the first 10 matches')
		assert.equal(searchMatchNote(10, false), null)
		assert.match(filesSrc, /useListing\(path, sort, listLimit\)/)
		assert.match(filesSrc, /Show more \(/)
		assert.match(filesSrc, /No recent files yet/)
		assert.match(filesSrc, /queryKey: \["files\.search"\]/)
	})

	test('trash, rename, and move update the open viewer', () => {
		const viewing = {
			files: [
				{path: '/Home/a.jpg', name: 'a.jpg'},
				{path: '/Home/b.jpg', name: 'b.jpg'},
				{path: '/Home/c.jpg', name: 'c.jpg'},
			],
			index: 1,
		}
		const trashed = viewerAfterPathChange(viewing, '/Home/b.jpg', null)
		assert.deepEqual(trashed.files.map((f) => f.path), ['/Home/a.jpg', '/Home/c.jpg'])
		assert.equal(trashed.index, 1)
		const renamed = viewerAfterPathChange(viewing, '/Home/b.jpg', '/Home/b2.jpg')
		assert.equal(renamed.files[1].path, '/Home/b2.jpg')
		assert.equal(renamed.files[1].name, 'b2.jpg')
		assert.equal(renamed.index, 1)
		const moved = viewerAfterPathChange(viewing, '/Home/a.jpg', '/Home/Away/a.jpg')
		assert.equal(moved.files[0].path, '/Home/Away/a.jpg')
		assert.equal(moved.index, 1)
		assert.equal(viewerAfterPathChange({files: [{path: '/Home/a.jpg', name: 'a.jpg'}], index: 0}, '/Home/a.jpg', null), null)
		assert.match(filesSrc, /viewerAfterPathChange/)
	})

	test('copy falls back to a toast when clipboard.writeText is missing', async () => {
		const seen = []
		copyTextOrToast(undefined, 'smb://host/share', () => seen.push('copied'), (v) => seen.push(v))
		assert.deepEqual(seen, ['smb://host/share'])
		let wrote = null
		copyTextOrToast(
			async (v) => {
				wrote = v
			},
			'secret',
			() => seen.push('ok'),
			() => seen.push('no'),
		)
		await new Promise((r) => setTimeout(r, 0))
		assert.equal(wrote, 'secret')
		assert.equal(seen.includes('ok'), true)
		copyTextOrToast(
			() => Promise.reject(new Error('denied')),
			'plain',
			() => seen.push('copied'),
			(v) => seen.push(`fallback:${v}`),
		)
		await new Promise((r) => setTimeout(r, 0))
		assert.equal(seen.includes('fallback:plain'), true)
		assert.match(filesSrc, /copyTextOrToast/)
		assert.equal(filesSrc.includes('navigator.clipboard?.writeText(v)'), false)
	})

	test('photo wheel is not passive and zoom buttons see the current pan', () => {
		assert.match(viewerSrc, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/)
		assert.match(viewerSrc, /\}, \[z\.s, z\.x, z\.y\]\)/)
		assert.equal(viewerSrc.includes('onWheel={(e) =>'), false)
	})

	test('grid cells move left on Shift+Tab and wrap at the end of a row', () => {
		assert.deepEqual(nextGridCell(0, 2, 3, 2, 'Tab', true), [0, 1])
		assert.deepEqual(nextGridCell(1, 0, 3, 2, 'Tab', true), [0, 2])
		assert.deepEqual(nextGridCell(0, 2, 3, 2, 'Tab', false), [1, 0])
		assert.deepEqual(nextGridCell(1, 2, 3, 2, 'Tab', false), [1, 2])
		assert.deepEqual(nextGridCell(0, 1, 3, 2, 'Enter', false), [1, 1])
		assert.equal(nextGridCell(0, 0, 3, 2, 'F2', false), null)
		assert.match(viewerSrc, /tabIndex=\{editable \? 0 : undefined\}/)
		assert.match(viewerSrc, /e\.key === "Enter" \|\| e\.key === "F2"/)
		assert.match(viewerSrc, /nextGridCell/)
	})
})
