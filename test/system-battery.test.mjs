// Batteries from /sys/class/power_supply. System packs only; no root needed.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {batteryUsage} from '../omarchyd/system.mjs'

const SYS = '/sys/class/power_supply'

function supply(name, files) {
	const out = {}
	for (const [k, v] of Object.entries(files)) out[`${SYS}/${name}/${k}`] = String(v)
	return out
}

function fromSys(files, names) {
	return batteryUsage({
		list: async (dir) => (dir === SYS ? names : []),
		read: async (p) => files[p] ?? '',
	})
}

test('no power supplies: empty list, not an error', async () => {
	const {batteries} = await fromSys({}, [])
	assert.deepEqual(batteries, [])
})

test('mains and device-scope HID packs are skipped', async () => {
	const files = {
		...supply('AC', {type: 'Mains', online: '1'}),
		...supply('hid-mouse', {type: 'Battery', present: '1', scope: 'Device', capacity: '90', status: 'Discharging'}),
	}
	const {batteries} = await fromSys(files, ['AC', 'hid-mouse'])
	assert.deepEqual(batteries, [])
})

test('a laptop pack: percent, charging, and time to full', async () => {
	const files = supply('BAT0', {
		type: 'Battery',
		present: '1',
		scope: 'System',
		status: 'Charging',
		capacity: '64',
		model_name: 'Internal',
		energy_now: '32000000',
		energy_full: '50000000',
		power_now: '10000000',
	})
	const {batteries} = await fromSys(files, ['BAT0'])
	assert.equal(batteries.length, 1)
	assert.deepEqual(batteries[0], {
		id: 'BAT0',
		index: 0,
		name: 'Internal',
		percent: 64,
		status: 'charging',
		secondsRemaining: 6480,
		power: 10,
		energyNow: 32000000,
		energyFull: 50000000,
	})
})

test('missing scope still counts as a system pack; present=0 is skipped', async () => {
	const files = {
		...supply('BAT0', {type: 'Battery', status: 'Full', capacity: '100', model_name: 'Main'}),
		...supply('BAT1', {type: 'Battery', present: '0', status: 'Unknown', capacity: '0'}),
	}
	const {batteries} = await fromSys(files, ['BAT0', 'BAT1'])
	assert.equal(batteries.length, 1)
	assert.equal(batteries[0].id, 'BAT0')
	assert.equal(batteries[0].status, 'full')
	assert.equal(batteries[0].percent, 100)
	assert.equal(batteries[0].secondsRemaining, null)
})

test('two packs: charge×voltage stands in for energy; discharging time from totals', async () => {
	const files = {
		...supply('BAT0', {
			type: 'Battery',
			present: '1',
			status: 'Discharging',
			capacity: '40',
			model_name: 'Internal',
			charge_now: '4000000',
			charge_full: '10000000',
			current_now: '1000000',
			voltage_now: '10000000',
		}),
		...supply('BAT1', {
			type: 'Battery',
			present: '1',
			status: 'Discharging',
			capacity: '80',
			model_name: 'Bay',
			charge_now: '8000000',
			charge_full: '10000000',
			current_now: '1000000',
			voltage_now: '10000000',
		}),
	}
	const {batteries} = await fromSys(files, ['BAT1', 'BAT0'])
	assert.equal(batteries.length, 2)
	assert.equal(batteries[0].id, 'BAT0')
	assert.equal(batteries[1].id, 'BAT1')
	assert.equal(batteries[0].index, 0)
	assert.equal(batteries[1].index, 1)
	assert.equal(batteries[0].energyNow, 40000000)
	assert.equal(batteries[1].energyNow, 80000000)
	assert.equal(batteries[0].power, 10)
	assert.equal(batteries[0].secondsRemaining, 14400)
	assert.equal(batteries[1].secondsRemaining, 28800)
})

test('capacity [N/A] is null; the pack still appears', async () => {
	const files = supply('BAT0', {
		type: 'Battery',
		present: '1',
		status: 'Unknown',
		capacity: '[N/A]',
		model_name: 'Pack',
	})
	const {batteries} = await fromSys(files, ['BAT0'])
	assert.equal(batteries.length, 1)
	assert.equal(batteries[0].percent, null)
	assert.equal(batteries[0].status, 'unknown')
	assert.equal(batteries[0].name, 'Pack')
})
