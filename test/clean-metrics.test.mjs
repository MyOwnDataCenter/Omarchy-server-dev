// Connector metrics are untrusted: only the fields the page shows, trimmed.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cleanMetrics} from '../omarchyd/connector.mjs'

test('cleanMetrics: gpus and batteries are empty when omitted', () => {
	const m = cleanMetrics({cpu: 10, mem: {total: 100, used: 40}})
	assert.deepEqual(m.gpus, [])
	assert.deepEqual(m.batteries, [])
	assert.equal(m.cpu, 10)
})

test('cleanMetrics: keeps a GPU glance and drops junk fields', () => {
	const m = cleanMetrics({
		gpus: [{id: 'GPU-aaa', index: 0, name: 'NVIDIA GeForce RTX 3060', used: 32, secret: 'nope'}],
	})
	assert.deepEqual(m.gpus, [{id: 'GPU-aaa', index: 0, name: 'NVIDIA GeForce RTX 3060', used: 32}])
})

test('cleanMetrics: keeps system battery packs; unknown status becomes unknown', () => {
	const m = cleanMetrics({
		batteries: [
			{
				id: 'BAT0',
				index: 0,
				name: 'Internal',
				percent: 64,
				status: 'charging',
				secondsRemaining: 600,
				power: 10,
				energyNow: 1,
				energyFull: 2,
				path: '/etc/passwd',
			},
			{id: 'BAT1', index: 1, name: 'X', percent: 1, status: 'on-fire', secondsRemaining: null, power: null, energyNow: null, energyFull: null},
		],
	})
	assert.equal(m.batteries.length, 2)
	assert.equal(m.batteries[0].status, 'charging')
	assert.equal(m.batteries[0].path, undefined)
	assert.equal(m.batteries[1].status, 'unknown')
})

test('cleanMetrics: a non-array gpu list is empty, not an error', () => {
	assert.deepEqual(cleanMetrics({gpus: 'all of them'}).gpus, [])
	assert.deepEqual(cleanMetrics({batteries: null}).batteries, [])
})

test('cleanMetrics: unknown GPU use stays null; 0 stays 0', () => {
	const m = cleanMetrics({
		gpus: [
			{id: 'drm-card1', index: 1, name: 'Intel Graphics', used: null},
			{id: 'GPU-aaa', index: 0, name: 'NVIDIA', used: 0},
		],
	})
	assert.equal(m.gpus[0].used, null)
	assert.equal(m.gpus[1].used, 0)
})
