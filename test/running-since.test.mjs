// Tooltip text for the version tag: how long this process has been up, and which git revision.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {formatRunningSince, versionTagProps} from '../web/src/runningSince.ts'

const since = Date.UTC(2026, 10, 16, 20, 18, 0) // 16 Nov 2026, 20:18 UTC
const opts = {locale: 'en-GB', timeZone: 'UTC'}

test('formatRunningSince: hours, the wall-clock start, and the git revision', () => {
	assert.equal(
		formatRunningSince(since, {now: since + 2 * 3600_000, revision: '5528b2a', ...opts}),
		'Running 2 hours (since 16 Nov 2026, 20:18). Revision 5528b2a.',
	)
})

test('formatRunningSince: minutes, a single hour, and a single day', () => {
	assert.equal(formatRunningSince(since, {now: since + 60_000, ...opts}), 'Running 1 minute (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 12 * 60_000, ...opts}), 'Running 12 minutes (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 3569_000, ...opts}), 'Running 59 minutes (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 3570_000, ...opts}), 'Running 1 hour (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 3599_000, ...opts}), 'Running 1 hour (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 3600_000, ...opts}), 'Running 1 hour (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 86399_000, ...opts}), 'Running 1 day (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(since, {now: since + 86400_000, ...opts}), 'Running 1 day (since 16 Nov 2026, 20:18).')
})

test('formatRunningSince: less than a minute, and revision only when there is no start time', () => {
	assert.equal(formatRunningSince(since, {now: since + 20_000, ...opts}), 'Running less than a minute (since 16 Nov 2026, 20:18).')
	assert.equal(formatRunningSince(undefined, {revision: 'abc1234'}), 'Revision abc1234.')
	assert.equal(formatRunningSince(undefined, {}), '')
})

test('versionTagProps: visible text is the version; no tooltip before start time and revision are known', () => {
	assert.deepEqual(versionTagProps('0.9.35'), {text: '0.9.35'})
	assert.deepEqual(versionTagProps(undefined), {text: '–'})
})

test('versionTagProps: tooltip and accessible name once start time and revision are known', () => {
	const tip = formatRunningSince(since, {now: since + 2 * 3600_000, revision: '5528b2a', ...opts})
	assert.deepEqual(
		versionTagProps('0.9.35', {startedAt: since, revision: '5528b2a'}, {now: since + 2 * 3600_000, ...opts}),
		{text: '0.9.35', title: tip, ariaLabel: `0.9.35. ${tip}`},
	)
})

test('versionTagProps: footer prefix stays in the visible text', () => {
	assert.deepEqual(versionTagProps('0.9.35', undefined, {prefix: 'MODC '}), {text: 'MODC 0.9.35'})
})
