// Connector GPU and battery collectors, against a fake sysfs.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const py = fileURLToPath(new URL('./connector-sysfs.py', import.meta.url))

test('connector GPU and battery collectors', () => {
	execFileSync('python3', [py], {encoding: 'utf8', stdio: 'pipe'})
	assert.ok(true)
})
