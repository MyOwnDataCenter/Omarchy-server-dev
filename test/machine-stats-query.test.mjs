// The Summary page asks omarchyd for its own machine's stats, not every machine's (#676).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {afterEach, test} from 'node:test'

import {fetchStats, statsQueryKey} from '../web/src/machines/statsQuery.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = originalFetch
})

test('machines.stats is requested with the machine id', async () => {
	const urls = []
	globalThis.fetch = async (url) => {
		urls.push(String(url))
		return new Response(JSON.stringify({data: {memoryMb: 1, vcpus: 1, points: [], last: null}}), {status: 200, headers: {'content-type': 'application/json'}})
	}
	await fetchStats('vm-7')
	assert.equal(urls.length, 1)
	const u = new URL(urls[0], 'http://x')
	assert.equal(u.pathname, '/api/rpc/machines.stats')
	assert.deepEqual(JSON.parse(u.searchParams.get('input')), {id: 'vm-7'})
})

test('each machine has its own stats query key', () => {
	assert.notDeepEqual(statsQueryKey('a'), statsQueryKey('b'))
	assert.deepEqual(statsQueryKey('a'), ['machines.stats', 'a'])
})

test('useStats no longer fetches everything and picks one client side', () => {
	const src = readFileSync(new URL('../web/src/machines/api.ts', import.meta.url), 'utf8')
	assert.doesNotMatch(src, /Record<string, Stats>/)
	assert.doesNotMatch(src, /select: \(all\)/)
	assert.match(src, /fetchStats\(/)
})
