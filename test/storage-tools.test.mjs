import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {canFormat, canMount, canUnmount, formatConfirmToken, formatPhraseMatches} from '../web/src/storageTools.ts'

const disk = (over) => ({path: '/dev/sdb', name: 'sdb', model: 'SanDisk Ultra', serial: 'AA11BB22', role: 'data', mounted: false, pool: null, ...over})

test('formatConfirmToken prefers model, then last 4 of serial, then kernel name', () => {
	assert.equal(formatConfirmToken(disk({})), 'SanDisk Ultra')
	assert.equal(formatConfirmToken(disk({model: '  '})), 'BB22')
	assert.equal(formatConfirmToken(disk({model: null, serial: null})), 'sdb')
})

test('formatPhraseMatches is case-insensitive and trimmed', () => {
	assert.equal(formatPhraseMatches(disk({}), 'SanDisk Ultra'), true)
	assert.equal(formatPhraseMatches(disk({}), '  sandisk ultra  '), true)
	assert.equal(formatPhraseMatches(disk({}), 'sdb'), false)
})

test('canFormat only for unmounted non-system non-pool disks', () => {
	assert.equal(canFormat(disk({})), true)
	assert.equal(canFormat(disk({role: 'blank'})), true)
	assert.equal(canFormat(disk({role: 'system'})), false)
	assert.equal(canFormat(disk({role: 'pool', pool: 'media'})), false)
	assert.equal(canFormat(disk({mounted: true})), false)
})

test('canUnmount only for mounted non-system non-pool disks', () => {
	assert.equal(canUnmount(disk({mounted: true})), true)
	assert.equal(canUnmount(disk({mounted: false})), false)
	assert.equal(canUnmount(disk({mounted: true, role: 'system'})), false)
	assert.equal(canUnmount(disk({mounted: true, role: 'pool'})), false)
})

test('canMount only for unmounted data disks that already have a filesystem', () => {
	assert.equal(canMount(disk({})), true)
	assert.equal(canMount(disk({role: 'blank'})), false)
	assert.equal(canMount(disk({role: 'system'})), false)
	assert.equal(canMount(disk({role: 'pool', pool: 'media'})), false)
	assert.equal(canMount(disk({mounted: true})), false)
})

test('StoragePage renders Remove for unmounted pools while keeping Check/Add mounted-only', async () => {
	const src = await readFile(new URL('../web/src/screens/Storage.tsx', import.meta.url), 'utf8')
	const poolSection = src.split('pools.map((p) =>')[1]?.split('</Section>')[0] ?? ''
	assert.ok(poolSection.includes('onClick={() => forget(p)}'), 'Remove button is present in pool row')
	const mountedBlock = poolSection.split('{p.mounted && (')[1]?.split('</>\n\t\t\t\t\t\t\t\t)}')[0] ?? ''
	assert.ok(mountedBlock.length > 0, 'mounted stats block exists')
	assert.equal(mountedBlock.includes('forget(p)'), false, 'Remove button is not gated by p.mounted')
	assert.match(poolSection, /\{p\.mounted\s*&&[\s\S]*scrub\(p\)/)
	assert.match(poolSection, /\{p\.mounted\s*&&\s*p\.kind === 'btrfs'[\s\S]*setAdding\(p\)/)
})
