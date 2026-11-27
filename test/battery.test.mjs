// Home glance: one ring for the whole machine, even with two packs.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {batteryColor, batteryGaugeItem, batteryPackSub, combineBatteries} from '../web/src/battery.ts'

const pack = (over = {}) => ({
	id: 'BAT0',
	index: 0,
	name: 'Internal',
	percent: 64,
	status: 'discharging',
	secondsRemaining: 5400,
	power: 12,
	energyNow: 32_000_000,
	energyFull: 50_000_000,
	...over,
})

test('combineBatteries: no packs means no glance', () => {
	assert.equal(combineBatteries([]), null)
})

test('combineBatteries: one pack is that pack', () => {
	assert.deepEqual(combineBatteries([pack()]), {
		percent: 64,
		status: 'discharging',
		secondsRemaining: 5400,
	})
})

test('combineBatteries: two packs use energy-weighted percent and total time', () => {
	const combined = combineBatteries([
		pack({energyNow: 40_000_000, energyFull: 100_000_000, percent: 40, power: 10, secondsRemaining: 14400}),
		pack({
			id: 'BAT1',
			index: 1,
			name: 'Bay',
			energyNow: 80_000_000,
			energyFull: 100_000_000,
			percent: 80,
			power: 10,
			secondsRemaining: 28800,
			status: 'discharging',
		}),
	])
	assert.equal(combined.percent, 60)
	assert.equal(combined.status, 'discharging')
	assert.equal(combined.secondsRemaining, 21600)
})

test('combineBatteries: without energy, percent is the average of the packs', () => {
	const combined = combineBatteries([
		pack({energyNow: null, energyFull: null, percent: 40, power: null, secondsRemaining: null}),
		pack({id: 'BAT1', energyNow: null, energyFull: null, percent: 80, power: null, secondsRemaining: null}),
	])
	assert.equal(combined.percent, 60)
})

test('combineBatteries: any charging pack makes the glance charging', () => {
	const combined = combineBatteries([
		pack({status: 'full', percent: 100, secondsRemaining: null, energyNow: 50_000_000, energyFull: 50_000_000, power: 0}),
		pack({id: 'BAT1', status: 'charging', percent: 40, secondsRemaining: 3600, energyNow: 20_000_000, energyFull: 50_000_000, power: 10}),
	])
	assert.equal(combined.status, 'charging')
	assert.equal(combined.percent, 70)
	assert.equal(combined.secondsRemaining, 10800)
})

test('batteryGaugeItem: no packs means no ring', () => {
	assert.deepEqual(batteryGaugeItem([]), [])
})

test('batteryGaugeItem: two packs are still one Battery ring', () => {
	const items = batteryGaugeItem([
		pack(),
		pack({id: 'BAT1', index: 1, name: 'Bay', percent: 80}),
	])
	assert.equal(items.length, 1)
	assert.equal(items[0].k, 'Battery')
	assert.equal(items[0].icon, 'battery')
	assert.equal(items[0].ready, true)
})

test('batteryGaugeItem: discharging subtitle is time left', () => {
	assert.equal(batteryGaugeItem([pack()])[0].sub, '1h 30m')
	assert.equal(batteryGaugeItem([pack()])[0].p, 64)
})

test('batteryGaugeItem: charging and full subtitles; a missing reading is not ready', () => {
	assert.equal(batteryGaugeItem([pack({status: 'charging', secondsRemaining: 600})])[0].sub, 'Charging')
	assert.equal(batteryGaugeItem([pack({status: 'full', percent: 100, secondsRemaining: null})])[0].sub, 'Full')
	assert.deepEqual(batteryGaugeItem([pack({percent: null, status: 'unknown', secondsRemaining: null})])[0].ready, false)
})

test('batteryColor: low is red, high is green', () => {
	assert.equal(batteryColor(10), 'var(--red)')
	assert.equal(batteryColor(20), 'var(--yellow)')
	assert.equal(batteryColor(80), 'var(--green)')
})

test('batteryPackSub: model and charging or time', () => {
	assert.equal(batteryPackSub(pack()), 'Internal · 1h 30m')
	assert.equal(batteryPackSub(pack({status: 'charging', secondsRemaining: 1200})), 'Internal · Charging')
	assert.equal(batteryPackSub(pack({name: 'Bay', status: 'full', secondsRemaining: null})), 'Bay · Full')
})
