// Overlapping settings saves must keep every change and count revisions in order.
import assert from 'node:assert/strict'
import {chmod, mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

async function setupApp(t) {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-store-conc-'))
	const store = await createStore(dir)
	const now = Date.now()
	await store.putSession('sid-owner', {mode: 'legacy', accountId: 'owner', accessToken: 'tok-owner', createdAt: now, lastSeenAt: now})
	await store.putSession('sid-member', {mode: 'legacy', accountId: 'member', accessToken: 'tok-member', createdAt: now, lastSeenAt: now})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	t.after(async () => {
		app.closeRelays()
		server.closeAllConnections?.()
		await new Promise((r) => server.close(r))
		await chmod(dir, 0o700).catch(() => {})
		await rm(dir, {recursive: true, force: true})
	})
	const base = `http://127.0.0.1:${server.address().port}`
	const req = async (sid, method, path, body) => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: {
				cookie: `omarchy_server_sid=${sid}`,
				...(body !== undefined ? {'content-type': 'application/json'} : {}),
				...(method !== 'GET' ? {'x-omarchy-server': '1'} : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		})
		return {status: res.status, body: await res.json()}
	}
	return {dir, store, req}
}

test('setConfig updater functions run against the latest queued state and roll back cleanly on failure', async (t) => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-store-fn-'))
	t.after(async () => {
		await chmod(dir, 0o700).catch(() => {})
		await rm(dir, {recursive: true, force: true})
	})
	const store = await createStore(dir)
	const seen = []
	const [a, b] = await Promise.all([
		store.setConfig((current) => {
			seen.push(['a', {...current}])
			return {prefs: {...(current.prefs ?? {}), owner: {theme: 'tokyo'}}}
		}),
		store.setConfig((current) => {
			seen.push(['b', {...current}])
			return {prefs: {...(current.prefs ?? {}), owner: {...current.prefs?.owner, accent: 'teal'}}}
		}),
	])
	assert.deepEqual(seen[0], ['a', {}])
	assert.deepEqual(seen[1], ['b', {prefs: {owner: {theme: 'tokyo'}}}])
	assert.deepEqual(a.prefs.owner, {theme: 'tokyo'})
	assert.deepEqual(b.prefs.owner, {theme: 'tokyo', accent: 'teal'})
	assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')), b)

	await chmod(dir, 0o555)
	await assert.rejects(store.setConfig((current) => ({...current, broken: true})))
	assert.equal(store.getConfig().broken, undefined)
	assert.deepEqual(store.getConfig().prefs.owner, {theme: 'tokyo', accent: 'teal'})

	await chmod(dir, 0o700)
	const after = await store.setConfig((current) => ({prefs: {...current.prefs, owner: {...current.prefs.owner, solidColor: '#112233'}}}))
	assert.deepEqual(after.prefs.owner, {theme: 'tokyo', accent: 'teal', solidColor: '#112233'})
})

test('overlapping /api/prefs saves for one account and across accounts keep every change', async (t) => {
	const {req} = await setupApp(t)
	const [a, b] = await Promise.all([
		req('sid-owner', 'POST', '/api/prefs', {theme: 'tokyo'}),
		req('sid-owner', 'POST', '/api/prefs', {accent: 'teal'}),
	])
	assert.equal(a.status, 200)
	assert.equal(b.status, 200)
	assert.deepEqual([a.body.prefs.rev, b.body.prefs.rev].sort((x, y) => x - y), [1, 2])
	const owner = await req('sid-owner', 'GET', '/api/prefs')
	assert.deepEqual(owner.body.prefs, {theme: 'tokyo', accent: 'teal', rev: 2})

	const [o2, m1] = await Promise.all([
		req('sid-owner', 'POST', '/api/prefs', {solidColor: '#1a1b26'}),
		req('sid-member', 'POST', '/api/prefs', {theme: 'mocha'}),
	])
	assert.equal(o2.status, 200)
	assert.equal(m1.status, 200)
	assert.deepEqual((await req('sid-owner', 'GET', '/api/prefs')).body.prefs, {theme: 'tokyo', accent: 'teal', solidColor: '#1a1b26', rev: 3})
	assert.deepEqual((await req('sid-member', 'GET', '/api/prefs')).body.prefs, {theme: 'mocha', rev: 1})
})

test('overlapping /api/desktop saves count sequential revisions and keep distinct accounts', async (t) => {
	const {req} = await setupApp(t)
	const [d1, d2] = await Promise.all([
		req('sid-owner', 'POST', '/api/desktop', {config: {wallpaper: 'valley'}}),
		req('sid-owner', 'POST', '/api/desktop', {config: {wallpaper: 'surf'}}),
	])
	assert.equal(d1.status, 200)
	assert.equal(d2.status, 200)
	assert.deepEqual([d1.body.desktop.rev, d2.body.desktop.rev].sort((x, y) => x - y), [1, 2])
	const ownerDesk = await req('sid-owner', 'GET', '/api/desktop')
	assert.equal(ownerDesk.body.desktop.rev, 2)

	const [o3, m1] = await Promise.all([
		req('sid-owner', 'POST', '/api/desktop', {config: {wallpaper: 'dunes'}}),
		req('sid-member', 'POST', '/api/desktop', {config: {wallpaper: 'pier'}}),
	])
	assert.equal(o3.status, 200)
	assert.equal(m1.status, 200)
	assert.equal((await req('sid-owner', 'GET', '/api/desktop')).body.desktop.config.wallpaper, 'dunes')
	assert.equal((await req('sid-owner', 'GET', '/api/desktop')).body.desktop.rev, 3)
	assert.equal((await req('sid-member', 'GET', '/api/desktop')).body.desktop.config.wallpaper, 'pier')
	assert.equal((await req('sid-member', 'GET', '/api/desktop')).body.desktop.rev, 1)
})
