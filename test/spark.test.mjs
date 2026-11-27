// Path for the System live-card sparkline: last-N poll points, clipped to max.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {sparkPath} from '../web/src/spark.ts'

test('sparkPath: fewer than two points is empty (the svg stays blank)', () => {
	assert.equal(sparkPath([]), '')
	assert.equal(sparkPath([40]), '')
})

test('sparkPath: two points, floor and ceiling, become a smooth cubic', () => {
	assert.equal(sparkPath([0, 100], {width: 300, height: 54, max: 100}), 'M0,51 C150,51 150,5 300,5')
})

test('sparkPath: values above max clip, so 200% draws the same as 100%', () => {
	assert.equal(sparkPath([0, 200], {width: 300, height: 54, max: 100}), sparkPath([0, 100], {width: 300, height: 54, max: 100}))
})
