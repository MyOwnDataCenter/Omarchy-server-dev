// Rename must refuse a name another computer already has. Joining still picks a free
// suffix; a person renaming is told the name is taken. The same computer may keep its name.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConnector} from '../omarchyd/connector.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const abilities = {terminal: true, desktop: false, manage: false, storage: false, backup: false}

function agent(id, name) {
	return {id, name, keyHash: 'ab', allowed: abilities, on: {...abilities}, enrolledAt: 1, lastSeen: null, info: {hostname: name}}
}

async function withSwarm(agents, run) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-rename-'))
	await writeFile(join(dataDir, 'swarm.json'), JSON.stringify({agents}))
	const c = createConnector({dataDir, tlsDir: dataDir})
	try {
		await run(c, dataDir)
	} finally {
		c.close()
		await rm(dataDir, {recursive: true, force: true})
	}
}

const taken = (err) => err instanceof RpcError && err.code === 'CONFLICT' && err.message === 'That name’s already taken'

test('rename refuses a name another computer already has', async () => {
	const long = 'n'.repeat(48)
	await withSwarm([agent('aaaaaaaaaaaa', 'box'), agent('bbbbbbbbbbbb', 'other'), agent('cccccccccccc', long)], async (c, dataDir) => {
		const before = await readFile(join(dataDir, 'swarm.json'), 'utf8')
		await assert.rejects(() => c.procedures['swarm.rename'].run({id: 'bbbbbbbbbbbb', name: 'box'}), taken)
		await assert.rejects(() => c.procedures['swarm.rename'].run({id: 'bbbbbbbbbbbb', name: '  box  '}), taken)
		await assert.rejects(() => c.procedures['swarm.rename'].run({id: 'bbbbbbbbbbbb', name: 'box\n'}), taken)
		await assert.rejects(() => c.procedures['swarm.rename'].run({id: 'bbbbbbbbbbbb', name: `box${' '.repeat(50)}extra`}), taken)
		await assert.rejects(() => c.procedures['swarm.rename'].run({id: 'bbbbbbbbbbbb', name: `${long}zzz`}), taken)
		const listed = await c.procedures['swarm.list'].run()
		assert.equal(listed.find((a) => a.id === 'bbbbbbbbbbbb').name, 'other')
		assert.equal(await readFile(join(dataDir, 'swarm.json'), 'utf8'), before, 'a refused rename is not stored')
		// A different string is free. It is stored as the trimmed clipped name, not a suffixed one.
		assert.equal(await c.procedures['swarm.rename'].run({id: 'bbbbbbbbbbbb', name: '  Box  '}), true)
		assert.equal((await c.procedures['swarm.list'].run()).find((a) => a.id === 'bbbbbbbbbbbb').name, 'Box')
		const saved = JSON.parse(await readFile(join(dataDir, 'swarm.json'), 'utf8'))
		assert.equal(saved.agents.find((a) => a.id === 'bbbbbbbbbbbb').name, 'Box')
	})
})

test('renaming a computer to the name it already has still succeeds', async () => {
	await withSwarm([agent('aaaaaaaaaaaa', 'box'), agent('bbbbbbbbbbbb', 'other')], async (c) => {
		assert.equal(await c.procedures['swarm.rename'].run({id: 'aaaaaaaaaaaa', name: 'box'}), true)
		assert.equal(await c.procedures['swarm.rename'].run({id: 'aaaaaaaaaaaa', name: '  box \t'}), true)
		assert.equal((await c.procedures['swarm.list'].run()).find((a) => a.id === 'aaaaaaaaaaaa').name, 'box')
		assert.equal((await c.procedures['swarm.list'].run()).find((a) => a.id === 'bbbbbbbbbbbb').name, 'other')
	})
})
