import assert from 'node:assert/strict'
import {test} from 'node:test'

import {PREFS_DIRTY_KEY, PREFS_REV_KEY, createPrefsSync, diffPrefsPatch} from '../web/src/prefsSync.ts'

function memoryStorage() {
	const map = new Map()
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => void map.set(k, String(v)),
		removeItem: (k) => void map.delete(k),
	}
}

const clean = (raw) => {
	const p = raw && typeof raw === 'object' ? raw : {}
	return {
		theme: p.theme ?? 'horizon',
		accent: p.accent ?? 'wallpaper',
		customBrandHsl: p.customBrandHsl ?? null,
		omarchyBackground: p.omarchyBackground ?? null,
		solidColor: p.solidColor ?? null,
		assistantLook: p.assistantLook ?? null,
	}
}

test('diffPrefsPatch computes changed synced keys', () => {
	const a = clean({theme: 'horizon', accent: 'wallpaper'})
	const b = clean({theme: 'horizon', accent: 'pink', solidColor: '#112233'})
	assert.deepEqual(diffPrefsPatch(a, b), {accent: 'pink', solidColor: '#112233'})
	assert.deepEqual(diffPrefsPatch(a, a), {})
})

test('failed save preserves local prefs across polls and retries when server returns', async () => {
	const storage = memoryStorage()
	let clock = 10_000
	let serverOnline = false
	let serverPrefs = {...clean({theme: 'horizon', accent: 'wallpaper'}), rev: 1}
	let current = clean(serverPrefs)
	let loadCount = 0
	const savedPatches = []

	const sync = createPrefsSync({
		storage,
		now: () => clock,
		clean,
		getCurrent: () => current,
		onApply: (p) => {
			current = p
		},
		load: async () => {
			loadCount++
			return serverOnline ? {prefs: serverPrefs} : null
		},
		save: async (patch) => {
			savedPatches.push(patch)
			if (!serverOnline) return null
			serverPrefs = {...serverPrefs, ...patch, rev: serverPrefs.rev + 1}
			return serverPrefs
		},
	})

	// Initial pull while online sets rev=1.
	serverOnline = true
	await sync.pull()
	assert.equal(storage.getItem(PREFS_REV_KEY), '1')

	// Server goes down; user taps pink accent.
	serverOnline = false
	const before = current
	current = {...before, accent: 'pink'}
	assert.equal(await sync.update(before, current), false)
	assert.equal(sync.hasPending(), true)
	assert.deepEqual(JSON.parse(storage.getItem(PREFS_DIRTY_KEY)), {accent: 'pink'})

	// Server returns with old accent='wallpaper'; pull must retry saving pink instead of reverting.
	serverOnline = true
	const loadsBeforeRetry = loadCount
	clock += 20_000
	await sync.pull()
	assert.equal(loadCount, loadsBeforeRetry, 'must flush dirty patch instead of overwriting via GET')
	assert.equal(current.accent, 'pink')
	assert.equal(serverPrefs.accent, 'pink')
	assert.equal(sync.hasPending(), false)
	assert.equal(storage.getItem(PREFS_DIRTY_KEY), null)
	assert.equal(storage.getItem(PREFS_REV_KEY), '2')
	assert.deepEqual(savedPatches, [{accent: 'pink'}, {accent: 'pink'}])
})

test('multiple offline edits coalesce and survive page reload', async () => {
	const storage = memoryStorage()
	let serverOnline = false
	let serverPrefs = {...clean({theme: 'horizon', accent: 'wallpaper'}), rev: 1}
	let current = clean(serverPrefs)

	const sync1 = createPrefsSync({
		storage,
		clean,
		getCurrent: () => current,
		onApply: (p) => {
			current = p
		},
		load: async () => (serverOnline ? {prefs: serverPrefs} : null),
		save: async () => null,
	})

	const p1 = {...current, accent: 'pink'}
	await sync1.update(current, p1)
	current = p1
	const p2 = {...current, theme: 'tokyo'}
	await sync1.update(current, p2)
	current = p2
	assert.deepEqual(JSON.parse(storage.getItem(PREFS_DIRTY_KEY)), {accent: 'pink', theme: 'tokyo'})

	// Simulate page reload with a brand new sync instance reading the same storage.
	serverOnline = true
	let currentAfterReload = clean(current)
	const sync2 = createPrefsSync({
		storage,
		clean,
		getCurrent: () => currentAfterReload,
		onApply: (p) => {
			currentAfterReload = p
		},
		load: async () => ({prefs: serverPrefs}),
		save: async (patch) => {
			serverPrefs = {...serverPrefs, ...patch, rev: serverPrefs.rev + 1}
			return serverPrefs
		},
	})
	assert.equal(sync2.hasPending(), true)
	await sync2.pull()
	assert.equal(sync2.hasPending(), false)
	assert.equal(serverPrefs.accent, 'pink')
	assert.equal(serverPrefs.theme, 'tokyo')
	assert.equal(currentAfterReload.accent, 'pink')
	assert.equal(currentAfterReload.theme, 'tokyo')
})

test('concurrent edit made while a save is in flight stays dirty and flushes next', async () => {
	const storage = memoryStorage()
	let current = clean({theme: 'horizon', accent: 'wallpaper'})
	let releaseFirstSave
	let calls = 0
	let serverPrefs = {...current, rev: 1}

	const sync = createPrefsSync({
		storage,
		clean,
		getCurrent: () => current,
		onApply: (p) => {
			current = p
		},
		load: async () => ({prefs: serverPrefs}),
		save: async (patch) => {
			calls++
			if (calls === 1) {
				await new Promise((r) => {
					releaseFirstSave = r
				})
			}
			serverPrefs = {...serverPrefs, ...patch, rev: serverPrefs.rev + 1}
			return serverPrefs
		},
	})

	const firstNext = {...current, accent: 'pink'}
	current = firstNext
	const firstSave = sync.update(clean({theme: 'horizon', accent: 'wallpaper'}), firstNext)

	// Edit accent again while first POST is still in flight.
	const secondNext = {...current, accent: 'teal'}
	current = secondNext
	const secondSave = sync.update(firstNext, secondNext)

	releaseFirstSave()
	await Promise.all([firstSave, secondSave])
	// Wait a microtask in case follow-up flush triggered.
	await new Promise((r) => setTimeout(r, 10))
	assert.equal(sync.hasPending(), false)
	assert.equal(current.accent, 'teal')
	assert.equal(serverPrefs.accent, 'teal')
})

test('clean steady-state pull applies newer remote rev, but ignores stale GET if edited mid-flight', async () => {
	const storage = memoryStorage()
	let clock = 10_000
	let serverPrefs = {...clean({theme: 'horizon', accent: 'wallpaper'}), rev: 1}
	let current = clean(serverPrefs)
	let releaseGet

	const sync = createPrefsSync({
		storage,
		now: () => clock,
		clean,
		getCurrent: () => current,
		onApply: (p) => {
			current = p
		},
		load: async () => {
			if (releaseGet === 'wait') {
				return new Promise((r) => {
					releaseGet = () => r({prefs: serverPrefs})
				})
			}
			return {prefs: serverPrefs}
		},
		save: async (patch) => {
			serverPrefs = {...serverPrefs, ...patch, rev: serverPrefs.rev + 1}
			return serverPrefs
		},
	})

	// Clean remote update rev=2 applies locally.
	serverPrefs = {...serverPrefs, theme: 'latte', rev: 2}
	await sync.pull()
	assert.equal(current.theme, 'latte')
	assert.equal(storage.getItem(PREFS_REV_KEY), '2')

	// Now start a GET, edit locally while GET is in flight, then resolve GET with old rev=2.
	clock += 10_000
	releaseGet = 'wait'
	const pullPromise = sync.pull()
	const beforeEdit = current
	current = {...beforeEdit, accent: 'mauve'}
	await sync.update(beforeEdit, current)
	releaseGet()
	await pullPromise
	assert.equal(current.accent, 'mauve')
})
