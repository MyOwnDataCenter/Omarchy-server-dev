// Stale restic password files are removed when the connector is stopped or started.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const py = fileURLToPath(new URL('./connector-backup-password.py', import.meta.url))

test('restic password file is deleted when the connector stops', () => {
	execFileSync('python3', [py], {encoding: 'utf8', stdio: 'pipe'})
	assert.ok(true)
})
