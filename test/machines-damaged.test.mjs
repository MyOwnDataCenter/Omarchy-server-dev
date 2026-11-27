// A damaged machines.json must survive the next save. libvirt and qemu are stubbed; the
// assertion is the file bytes, through the same create and options procedures the app calls.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const CATALOG = {
	version: 1,
	images: [{id: 'testos-amd64', familyId: 'debian', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/os.qcow2', checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo'}],
}

const open = (dataDir, catalogUrl) =>
	createMachines({
		dataDir,
		catalogUrl,
		fetchImpl: async () => {
			throw new Error('no network in this test')
		},
		run: async () => '',
		kvmDevice: join(dataDir, 'no-kvm'),
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
	})

async function withDir(fn) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-dmg-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify(CATALOG))
		await fn({dataDir, file: join(dataDir, 'machines', 'machines.json'), catalogUrl})
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

const createInput = {name: 'Fresh VM', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'}

test('a truncated machines.json is left unchanged when the next save runs', async (t) => {
	t.mock.method(console, 'error', () => {})
	await withDir(async ({dataDir, file, catalogUrl}) => {
		const damaged = '{"machines":[{"id":"abcd1234","name":"Precious VM"'
		await mkdir(join(dataDir, 'machines'), {recursive: true})
		await writeFile(file, damaged)
		const machines = open(dataDir, catalogUrl)
		await machines.ready
		let error = null
		try {
			await machines.procedures['machines.create'].run(createInput)
		} catch (e) {
			error = e
		}
		assert.equal(await readFile(file, 'utf8'), damaged)
		assert.match(error?.message ?? '', /machines\.json is damaged and was left unchanged/)
	})
})

test('a missing machines.json is a new install and the next save creates it', async () => {
	await withDir(async ({dataDir, file, catalogUrl}) => {
		const machines = open(dataDir, catalogUrl)
		await machines.ready
		const {id} = await machines.procedures['machines.create'].run(createInput)
		const saved = JSON.parse(await readFile(file, 'utf8'))
		assert.equal(Array.isArray(saved.machines), true)
		assert.equal(saved.machines.some((m) => m.id === id && m.name === 'Fresh VM'), true)
	})
})

test('a valid machines.json still loads, normalizes, and keeps the machine on a later save', async () => {
	await withDir(async ({dataDir, file, catalogUrl}) => {
		await mkdir(join(dataDir, 'machines'), {recursive: true})
		await writeFile(
			file,
			JSON.stringify({
				machines: [{id: 'abcd1234', name: 'Kept', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, state: 'installing', portForwards: [], createdAt: 1, layout: {video: 'virtio', disks: []}}],
			}),
		)
		const machines = open(dataDir, catalogUrl)
		await machines.ready
		const listed = await machines.procedures['machines.list'].run()
		assert.equal(listed.length, 1)
		assert.equal(listed[0].id, 'abcd1234')
		assert.equal(listed[0].name, 'Kept')
		assert.equal(listed[0].state, 'error')
		await machines.procedures['machines.updateOptions'].run({id: 'abcd1234', notes: 'still here'})
		const saved = JSON.parse(await readFile(file, 'utf8'))
		assert.equal(saved.machines.length, 1)
		assert.equal(saved.machines[0].id, 'abcd1234')
		assert.equal(saved.machines[0].name, 'Kept')
		assert.equal(saved.machines[0].layout.video, 'vga')
		assert.equal(saved.machines[0].state, 'error')
		assert.equal(saved.machines[0].options.notes, 'still here')
	})
})
