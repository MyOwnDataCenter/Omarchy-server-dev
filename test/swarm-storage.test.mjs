import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {createConnector} from '../omarchyd/connector.mjs'

test('connector helper.py unit tests', () => {
	execFileSync('python3', [fileURLToPath(new URL('../connector/test_helper.py', import.meta.url))], {stdio: 'inherit'})
})

test('swarm.storage.status: missing computer is NOT_FOUND, offline is PRECONDITION_FAILED', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-storage-'))
	try {
		const id = 'aabbccddeeff'
		await writeFile(
			join(dataDir, 'swarm.json'),
			JSON.stringify({
				agents: [
					{
						id,
						name: 'pi',
						keyHash: '0'.repeat(64),
						allowed: {terminal: false, desktop: false, manage: false, storage: true},
						on: {terminal: false, desktop: false, manage: false, storage: true},
						enrolledAt: Date.now(),
						lastSeen: null,
						info: {hostname: 'pi'},
					},
				],
			}),
		)
		const c = createConnector({dataDir, tlsDir: dataDir})
		await assert.rejects(() => c.procedures['swarm.storage.status'].run({id: 'nope'}), /isn’t in your swarm/)
		await assert.rejects(() => c.procedures['swarm.storage.status'].run({id}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.disks'].run({id}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.format'].run({id, device: '/dev/sdc', filesystem: 'blank'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.unmount'].run({id, device: '/dev/sdc'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.mount'].run({id, device: '/dev/sdc'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.pools'].run({id}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.importable'].run({id}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.createPool'].run({id, name: 'tank', profile: 'single', devices: ['/dev/sda']}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.addToPool'].run({id, name: 'tank', device: '/dev/sdb'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.importPool'].run({id, name: 'old', uuid: '44444444-4444-4444-4444-444444444444'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.forgetPool'].run({id, name: 'tank'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.scrub'].run({id, name: 'tank'}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.setSleep'].run({id, device: '/dev/sda', minutes: 20}), /offline/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
