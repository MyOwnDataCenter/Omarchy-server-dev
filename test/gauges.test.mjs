// Home glance rings: one GPU gauge per card, labelled like System.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {gpuGaugeItems, shortGpuName} from '../web/src/gauges.ts'

const gpu = (over = {}) => ({
	id: 'gpu-0',
	index: 0,
	name: 'NVIDIA GeForce RTX 3060',
	used: 40,
	memoryUsed: 2 * 1024 ** 3,
	memoryTotal: 12 * 1024 ** 3,
	temperature: 62,
	...over,
})

test('shortGpuName: drops the vendor prefix people already know', () => {
	assert.equal(shortGpuName('NVIDIA GeForce RTX 3060'), 'RTX 3060')
	assert.equal(shortGpuName('AMD Radeon RX 6800'), 'RX 6800')
	assert.equal(shortGpuName('Intel Arc A770'), 'Arc A770')
})

test('gpuGaugeItems: no cards means no extra rings', () => {
	assert.deepEqual(gpuGaugeItems([]), [])
})

test('gpuGaugeItems: one card is labelled GPU, with its short name', () => {
	assert.deepEqual(gpuGaugeItems([gpu()]), [
		{k: 'GPU', key: 'gpu-0', icon: 'gpu', p: 40, sub: 'RTX 3060', ready: true},
	])
})

test('gpuGaugeItems: two cards are GPU 0 and GPU 1, matching System', () => {
	const items = gpuGaugeItems([
		gpu(),
		gpu({id: 'gpu-1', index: 1, name: 'NVIDIA GeForce RTX 3060', used: 12}),
	])
	assert.equal(items.length, 2)
	assert.equal(items[0].k, 'GPU 0')
	assert.equal(items[1].k, 'GPU 1')
	assert.equal(items[1].p, 12)
	assert.equal(items[0].key, 'gpu-0')
	assert.equal(items[1].key, 'gpu-1')
})

test('gpuGaugeItems: a card with no reading is still a ring, not ready', () => {
	assert.deepEqual(gpuGaugeItems([gpu({used: null})]), [
		{k: 'GPU', key: 'gpu-0', icon: 'gpu', p: 0, sub: 'RTX 3060', ready: false},
	])
})
