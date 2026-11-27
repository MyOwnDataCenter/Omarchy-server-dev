// Host CPU: guest time is already inside user, and a second caller in the same second
// must not publish a fresh percent from a window shorter than a clock tick.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cpuUsage, forgetCpu} from '../omarchyd/system.mjs'

const line = (fields) => `cpu ${fields.join(' ')}\n`

test('guest time is not counted twice', async () => {
	forgetCpu()
	let t = 0
	const lines = [line([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), line([100, 0, 0, 300, 0, 0, 0, 0, 100, 0])]
	let i = 0
	const read = async () => lines[Math.min(i++, lines.length - 1)]
	await cpuUsage({read, now: () => t})
	t = 1000
	const sample = await cpuUsage({read, now: () => t})
	assert.equal(sample.totalUsed, 25)
})

test('a second call inside the same second keeps the last percent', async () => {
	forgetCpu()
	let t = 0
	let reads = 0
	const lines = [
		line([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		line([100, 0, 0, 300, 0, 0, 0, 0, 100, 0]),
		line([200, 0, 0, 300, 0, 0, 0, 0, 200, 0]),
	]
	let i = 0
	const read = async () => {
		reads++
		return lines[Math.min(i++, lines.length - 1)]
	}
	await cpuUsage({read, now: () => t})
	t = 1000
	const first = await cpuUsage({read, now: () => t})
	t = 1010
	const second = await cpuUsage({read, now: () => t})
	assert.equal(first.totalUsed, 25)
	assert.equal(second.totalUsed, 25)
	assert.equal(reads, 2)
})
