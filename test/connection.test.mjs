import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {QueryClient, QueryObserver} from '@tanstack/react-query'

import {OFFLINE_MESSAGE, UNREACHABLE_MESSAGE, deriveConnectionState, isBrowserOnline, queryProblem, snapshotCacheStatus} from '../web/src/connection.ts'
import {applyOptimisticAppState, rollbackOptimisticAppState} from '../web/src/optimisticApps.ts'

test('isBrowserOnline defaults true unless onLine is explicitly false', () => {
	assert.equal(isBrowserOnline(undefined), true)
	assert.equal(isBrowserOnline({}), true)
	assert.equal(isBrowserOnline({onLine: true}), true)
	assert.equal(isBrowserOnline({onLine: false}), false)
})

test('deriveConnectionState handles online, offline, paused, unreachable, and recovery', () => {
	const healthy = {status: 'success', fetchStatus: 'idle', error: null, dataUpdatedAt: 1000, errorUpdatedAt: 0}
	assert.deepEqual(deriveConnectionState(true, [healthy]), {
		reachable: true,
		browserOnline: true,
		status: 'online',
		message: null,
	})

	assert.deepEqual(deriveConnectionState(false, [healthy]), {
		reachable: false,
		browserOnline: false,
		status: 'offline',
		message: OFFLINE_MESSAGE,
	})

	assert.deepEqual(
		deriveConnectionState(true, [{status: 'pending', fetchStatus: 'paused', error: null}]),
		{
			reachable: false,
			browserOnline: true,
			status: 'offline',
			message: OFFLINE_MESSAGE,
		},
	)

	assert.deepEqual(
		deriveConnectionState(true, [
			healthy,
			{status: 'error', fetchStatus: 'idle', error: new Error('502'), dataUpdatedAt: 1000, errorUpdatedAt: 2000},
		]),
		{
			reachable: false,
			browserOnline: true,
			status: 'unreachable',
			message: UNREACHABLE_MESSAGE,
		},
	)

	assert.deepEqual(
		deriveConnectionState(true, [
			{status: 'success', fetchStatus: 'idle', error: null, dataUpdatedAt: 3000, errorUpdatedAt: 0},
			{status: 'error', fetchStatus: 'idle', error: new Error('502'), dataUpdatedAt: 1000, errorUpdatedAt: 2000},
		]),
		{
			reachable: true,
			browserOnline: true,
			status: 'online',
			message: null,
		},
	)

	assert.equal(deriveConnectionState(true, [{status: 'pending', fetchStatus: 'fetching', error: null}]).reachable, true)
})

test('snapshotCacheStatus tracks active core queries and ignores inactive stale errors', () => {
	const qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
	const appsObs = new QueryObserver(qc, {queryKey: ['apps.list'], enabled: false})
	const statsObs = new QueryObserver(qc, {queryKey: ['system.stats'], enabled: false})
	const unsubApps = appsObs.subscribe(() => {})
	let unsubStats = statsObs.subscribe(() => {})
	try {
		qc.setQueryData(['apps.list'], [{id: 'immich'}])
		qc.setQueryData(['system.stats'], {cpu: {totalUsed: 10}})
		assert.equal(snapshotCacheStatus(qc, true), 'online')
		assert.equal(snapshotCacheStatus(qc, false), 'offline')

		// Detach system.stats observer and mark it errored; inactive error must not poison active apps.list.
		unsubStats()
		unsubStats = () => {}
		qc.getQueryCache().find({queryKey: ['system.stats']})?.setState({
			status: 'error',
			error: new Error('502'),
			errorUpdatedAt: Date.now() + 1000,
		})
		assert.equal(snapshotCacheStatus(qc, true), 'online')

		// Reattach system.stats observer; active failure now flips status to unreachable.
		unsubStats = statsObs.subscribe(() => {})
		assert.equal(snapshotCacheStatus(qc, true), 'unreachable')

		// Paused query flips status to offline even if navigator.onLine looks true.
		qc.getQueryCache().find({queryKey: ['apps.list']})?.setState({fetchStatus: 'paused'})
		assert.equal(snapshotCacheStatus(qc, true), 'offline')
	} finally {
		unsubApps()
		unsubStats()
		qc.clear()
	}
})

test('queryProblem catches missing data offline/paused and explicit errors', () => {
	assert.equal(queryProblem({data: undefined, error: null, fetchStatus: 'paused'}, true), OFFLINE_MESSAGE)
	assert.equal(queryProblem({data: undefined, error: null, fetchStatus: 'idle'}, false), OFFLINE_MESSAGE)
	assert.equal(queryProblem({data: [{id: 'vm-1'}], error: null, fetchStatus: 'paused'}, false), null)
	assert.equal(queryProblem({data: undefined, error: new Error('Server unreachable'), fetchStatus: 'idle'}, true), 'Server unreachable')
	assert.equal(queryProblem({data: [{id: 'vm-1'}], error: null, fetchStatus: 'idle'}, true), null)
})

test('optimistic app state rolls back on failure without clobbering concurrent changes', async () => {
	const qc = new QueryClient()
	try {
		for (const [prev, next] of [
			['running', 'stopping'],
			['running', 'restarting'],
			['stopped', 'starting'],
		]) {
			qc.setQueryData(['apps.list'], [
				{id: 'immich', state: prev},
				{id: 'jellyfin', state: 'running'},
			])
			const snap = await applyOptimisticAppState(qc, {appId: 'immich', state: next})
			assert.equal(qc.getQueryData(['apps.list']).find((a) => a.id === 'immich').state, next)

			// Concurrent update to another app must survive rollback.
			qc.setQueryData(['apps.list'], (apps) => apps.map((a) => (a.id === 'jellyfin' ? {...a, state: 'stopped'} : a)))
			rollbackOptimisticAppState(qc, snap)
			const after = qc.getQueryData(['apps.list'])
			assert.equal(after.find((a) => a.id === 'immich').state, prev)
			assert.equal(after.find((a) => a.id === 'jellyfin').state, 'stopped')
		}

		// If a poll already updated the target app to a different settled state, rollback leaves it alone.
		qc.setQueryData(['apps.list'], [{id: 'immich', state: 'running'}])
		const snap = await applyOptimisticAppState(qc, {appId: 'immich', state: 'stopping'})
		qc.setQueryData(['apps.list'], [{id: 'immich', state: 'stopped'}])
		rollbackOptimisticAppState(qc, snap)
		assert.equal(qc.getQueryData(['apps.list']).find((a) => a.id === 'immich').state, 'stopped')
	} finally {
		qc.clear()
	}
})

test('Desktop TopBar uses useServerReachable and CSS lets dot.down override dot color', async () => {
	const desktopSrc = await readFile(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	assert.match(desktopSrc, /useServerReachable/)
	assert.equal(/<span className="dot live" \/>/.test(desktopSrc), false)
	assert.match(desktopSrc, /className=\{`dot \$\{online \? 'live' : 'down'\}`\}/)

	const cssSrc = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8')
	const topSysDot = /\.top-sys \.dot \{[^}]*\}/.exec(cssSrc)?.[0] ?? ''
	const sysHeadDot = /\.sys-head \.dot \{[^}]*\}/.exec(cssSrc)?.[0] ?? ''
	assert.equal(topSysDot.includes('var(--green)'), false)
	assert.equal(sysHeadDot.includes('var(--green)'), false)
})
