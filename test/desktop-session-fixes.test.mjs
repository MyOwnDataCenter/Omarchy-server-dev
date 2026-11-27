import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {reopenOnMount} from '../web/src/assistant.ts'
import {iconsInView} from '../web/src/desktop/iconsInView.ts'
import {startAlreadyPending} from '../web/src/desktop/startPending.ts'
import {wallpaperBlocked} from '../web/src/desktop/wallpaperGate.ts'

test('a signed-out wallpaper failure does not block the same url after sign-in', () => {
	const url = '/api/wallpaper/abc'
	assert.equal(wallpaperBlocked(null, false, url, false), false)
	assert.equal(wallpaperBlocked(null, true, null, true), false)
	// The sign-in page gets 401 for this url. That failure blocks only while still signed out.
	assert.equal(wallpaperBlocked(url, false, url, false), true)
	assert.equal(wallpaperBlocked(url, false, url, true), false)
	// A different picture is not blocked by the old failure.
	assert.equal(wallpaperBlocked(url, false, '/api/wallpaper/other', false), false)
	assert.equal(wallpaperBlocked(url, true, '/api/wallpaper/other', true), false)
	// A failure while signed in keeps blocking that url until the url or the session changes.
	assert.equal(wallpaperBlocked(url, true, url, true), true)
	assert.equal(wallpaperBlocked(url, true, url, false), false)
})

test('icons stored outside the visible grid move to free cells and icons already in view stay put', () => {
	const icons = [
		{key: 'a', col: 0, row: 0},
		{key: 'b', col: 1, row: 0},
		{key: 'c', col: 5, row: 0},
		{key: 'd', col: 0, row: 9},
	]
	const view = iconsInView(icons, 2, 2)
	assert.equal(view[0], icons[0])
	assert.equal(view[1], icons[1])
	assert.deepEqual(view[2], {key: 'c', col: 0, row: 1})
	assert.deepEqual(view[3], {key: 'd', col: 1, row: 1})
	assert.equal(icons[2].col, 5)
	assert.equal(icons[3].row, 9)
	assert.notEqual(view[2], icons[2])

	const negative = iconsInView([{key: 'n', col: -1, row: 0}], 2, 1)
	assert.deepEqual(negative[0], {key: 'n', col: 0, row: 0})

	// A full grid still must not stack two off-screen icons on one cell.
	const tight = iconsInView(
		[
			{key: 'in', col: 0, row: 0},
			{key: 'out1', col: 4, row: 4},
			{key: 'out2', col: 5, row: 5},
		],
		1,
		1,
	)
	assert.deepEqual(tight[0], {key: 'in', col: 0, row: 0})
	const cells = tight.map((i) => `${i.col},${i.row}`)
	assert.equal(new Set(cells).size, cells.length)
	assert.ok(tight[1].col !== 0 || tight[1].row !== 0)
	assert.ok(tight[2].col !== 0 || tight[2].row !== 0)
})

test('a second start is ignored while that machine is in flight or already watched', () => {
	const watches = [{id: 'vm', listUpdatedAt: 100}]
	assert.equal(startAlreadyPending(new Set(), [], 'vm'), false)
	assert.equal(startAlreadyPending(new Set(['vm']), [], 'vm'), true)
	assert.equal(startAlreadyPending(new Set(['other']), [], 'vm'), false)
	assert.equal(startAlreadyPending(new Set(), watches, 'vm'), true)
	assert.equal(startAlreadyPending(new Set(['vm']), watches, 'vm'), true)
	assert.equal(startAlreadyPending(new Set(), watches, 'other'), false)
	assert.equal(startAlreadyPending(['vm'], [], 'vm'), true)
	assert.equal(startAlreadyPending(['other'], [{id: 'vm', listUpdatedAt: 1}], 'nope'), false)
})

test('the assistant reopen flag opens the first mount only', () => {
	assert.equal(reopenOnMount(true, false), true)
	assert.equal(reopenOnMount(true, true), false)
	assert.equal(reopenOnMount(false, false), false)
	assert.equal(reopenOnMount(false, true), false)
})

test('backdrop, icons, machine start, and assistant reopen use the helpers', async () => {
	const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')
	const ui = await read('../web/src/ui.tsx')
	const app = await read('../web/src/App.tsx')
	const desktop = await read('../web/src/desktop/Desktop.tsx')
	assert.match(ui, /wallpaperBlocked\(/)
	assert.match(app, /<Backdrop wallpaper=\{wallpaper\} prefs=\{prefs\} signedIn=\{!!boot\.data\?\.session\}/)
	assert.match(app, /reopenOnMount\(/)
	assert.match(desktop, /iconsInView\(/)
	assert.match(desktop, /startAlreadyPending\(/)
	const start = desktop.slice(desktop.indexOf("if (action === 'start')"))
	const startBlock = start.slice(0, start.indexOf('toast(`${m.name} is ${m.state}'))
	const pendingAt = startBlock.indexOf('startAlreadyPending(')
	const addAt = startBlock.indexOf('startingFlightRef.current.add(id)')
	const mutateAt = startBlock.indexOf("mutate('machines.start'")
	const thenAt = startBlock.indexOf('.then(')
	const setAt = startBlock.indexOf('setStarting(')
	assert.ok(pendingAt >= 0 && addAt > pendingAt && mutateAt > addAt && thenAt > mutateAt && setAt > thenAt)
	assert.match(desktop, /iconsInView\(storedIcons, cols, rows\)/)
})
