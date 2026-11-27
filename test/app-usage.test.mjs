// Container usage: last podman-stats snapshot; sampling is triggered, not done on the read.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

test('usage() returns the last snapshot without starting podman stats', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'app-usage-'))
	let apps
	try {
		const calls = []
		const run = async (cmd, args) => {
			calls.push([cmd, args[0]])
			if (cmd === 'podman') return '[]'
			return ''
		}
		apps = createApps({dataDir, home: join(dataDir, 'home'), run, gatewayHost: '127.0.0.1'})
		await apps.ready
		calls.length = 0
		assert.deepEqual(apps.usage(), [])
		assert.deepEqual(calls, [])
		apps.refreshUsage()
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(calls.some((c) => c[0] === 'podman'))
	} finally {
		apps?.close()
		await rm(dataDir, {recursive: true, force: true})
	}
})
