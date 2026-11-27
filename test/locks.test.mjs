import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createKeyedLock} from '../omarchyd/locks.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('serializes calls with the same key while running different keys concurrently', async () => {
	const lock = createKeyedLock()
	const order = []
	let activeA = 0
	let maxActiveA = 0
	let activeBoth = 0
	let maxActiveBoth = 0

	const run = (key, label, ms) =>
		lock(key, async () => {
			order.push(`start:${label}`)
			activeBoth++
			maxActiveBoth = Math.max(maxActiveBoth, activeBoth)
			if (key === 'a') {
				activeA++
				maxActiveA = Math.max(maxActiveA, activeA)
			}
			await wait(ms)
			if (key === 'a') activeA--
			activeBoth--
			order.push(`end:${label}`)
			return label
		})

	const results = await Promise.all([
		run('a', 'a1', 30),
		run('a', 'a2', 10),
		run('b', 'b1', 30),
	])

	assert.deepEqual(results, ['a1', 'a2', 'b1'])
	assert.equal(maxActiveA, 1)
	assert.equal(maxActiveBoth, 2)
	assert.ok(order.indexOf('end:a1') < order.indexOf('start:a2'))
})

test('a rejected or throwing call does not block the next caller on the same key', async () => {
	const lock = createKeyedLock()
	await assert.rejects(
		lock('k', async () => {
			throw new Error('async boom')
		}),
		/async boom/,
	)
	await assert.rejects(
		lock('k', () => {
			throw new Error('sync boom')
		}),
		/sync boom/,
	)
	const ok = await lock('k', async () => 'recovered')
	assert.equal(ok, 'recovered')

	// Even when queued concurrently before settling, failure only rejects the failing call.
	const p1 = lock('k', async () => {
		await wait(10)
		throw new Error('first failed')
	})
	const p2 = lock('k', async () => 'second ok')
	const [r1, r2] = await Promise.allSettled([p1, p2])
	assert.equal(r1.status, 'rejected')
	assert.equal(r2.status, 'fulfilled')
	assert.equal(r2.value, 'second ok')
})
