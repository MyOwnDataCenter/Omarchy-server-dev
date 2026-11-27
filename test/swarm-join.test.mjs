import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {newlyJoined} from '../web/src/swarm/join.ts'

test('newlyJoined is the computer that was not in the sheet’s opening snapshot', () => {
	const openedWith = ['old']
	const now = [{id: 'old', name: 'old'}, {id: 'jules', name: 'jules'}]
	assert.equal(newlyJoined(now, openedWith)?.id, 'jules')
})

test('newlyJoined still finds that computer after the live before list catches up', () => {
	const openedWith = []
	const now = [{id: 'jules', name: 'jules'}]
	const liveBefore = now.map((a) => a.id)
	assert.equal(newlyJoined(now, openedWith)?.id, 'jules')
	assert.equal(newlyJoined(now, liveBefore), undefined)
})

test('newlyJoined is empty when nobody new has appeared', () => {
	assert.equal(newlyJoined([], []), undefined)
	assert.equal(newlyJoined([{id: 'old', name: 'old'}], ['old']), undefined)
})

test('Add a computer snapshots swarm ids when the sheet opens', async () => {
	const src = await readFile(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	assert.match(src, /const \[beforeIds\] = useState\(before\)/)
	assert.match(src, /newlyJoined\(swarm\.data \?\? \[\], beforeIds\)/)
	assert.doesNotMatch(src, /newlyJoined\(swarm\.data \?\? \[\], before\)/)
})
