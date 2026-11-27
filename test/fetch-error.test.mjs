import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createBackups} from '../omarchyd/backups.mjs'
import {fetchErrorMessage, httpDownloadErrorMessage, isNetworkError} from '../omarchyd/fetch-error.mjs'
import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const fakeFiles = (home) => ({
	async resolve(v) {
		if (!v.startsWith('/Home')) throw new Error('outside')
		return {real: join(home, v.slice('/Home'.length)), top: 'Home'}
	},
})

test('fetchErrorMessage and httpDownloadErrorMessage turn network/HTTP errors into plain English', () => {
	assert.match(
		fetchErrorMessage('Debian', Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}})),
		/Couldn’t download Debian: this server can’t reach the internet/,
	)
	assert.match(
		fetchErrorMessage('Debian', Object.assign(new TypeError('fetch failed'), {cause: {code: 'EAI_AGAIN'}})),
		/Couldn’t download Debian: this server can’t reach the internet/,
	)
	assert.match(
		fetchErrorMessage('Debian', Object.assign(new TypeError('fetch failed'), {cause: new AggregateError([{code: 'ENETUNREACH'}], 'all failed')})),
		/Couldn’t download Debian: this server can’t reach the internet/,
	)
	assert.match(
		fetchErrorMessage('Debian', Object.assign(new TypeError('fetch failed'), {cause: {code: 'UND_ERR_CONNECT_TIMEOUT'}})),
		/Couldn’t download Debian: the download timed out/,
	)
	assert.match(
		fetchErrorMessage('Debian', Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})),
		/Couldn’t download Debian: the download timed out/,
	)
	assert.match(
		fetchErrorMessage('Debian', Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})),
		/Couldn’t download Debian: the download server refused the connection/,
	)
	assert.match(
		fetchErrorMessage('Debian', new TypeError('fetch failed')),
		/Couldn’t download Debian: this server can’t reach the internet/,
	)
	assert.equal(isNetworkError(new Error('No space left on device')), false)

	assert.match(httpDownloadErrorMessage('restic', 403), /turned the request away \(HTTP 403\)/)
	assert.match(httpDownloadErrorMessage('restic', 404), /was not found \(HTTP 404\)/)
	assert.match(httpDownloadErrorMessage('restic', 502), /had a problem \(HTTP 502\)/)
})

test('createMachines explains offline and timed-out downloads instead of bare fetch failed', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-fetch-m-'))
	const catalog = join(root, 'catalog.json')
	await writeFile(
		catalog,
		JSON.stringify({
			version: 1,
			images: [
				{
					id: 'debian-12-amd64',
					familyId: 'debian',
					name: 'Debian',
					variantName: 'Server',
					version: '12',
					arch: 'amd64',
					kind: 'cloud',
					url: 'https://fixture.test/debian.qcow2',
					checksums: {url: 'https://fixture.test/SHA256SUMS', algorithm: 'sha256'},
					sizeMb: 1,
					adminGroup: 'sudo',
				},
			],
		}),
	)

	const run = async (cmd, args) => {
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === '--version') return '10.0.0\n'
			if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
		}
		if (cmd === 'qemu-img' && args[0] === '--version') return '9.0.0\n'
		if (cmd === 'openssl') return '$6$rounds=5000$saltsalt$hashedpassword\n'
		if (cmd === 'xorriso') {
			await writeFile(args[args.indexOf('-output') + 1], 'iso')
			return ''
		}
		return ''
	}

	async function runCase(name, failingFetch, expectedPattern) {
		const dataDir = join(root, name)
		await mkdir(dataDir, {recursive: true})
		const m = createMachines({
			dataDir,
			catalogUrl: `file://${catalog}`,
			arch: 'amd64',
			watchIdleMs: 50,
			fetchImpl: failingFetch,
			run,
			kvmDevice: join(root, 'kvm'),
		})
		await m.ready
		const {id} = await m.procedures['machines.create'].run({
			name,
			osId: 'debian-12-amd64',
			cores: 1,
			memoryGb: 1,
			diskSizeGb: 4,
			username: 'chris',
			password: 'pw',
		})
		let rec
		for (let i = 0; i < 60; i++) {
			rec = (await m.procedures['machines.list'].run()).find((x) => x.id === id)
			if (rec?.state === 'error') break
			await new Promise((r) => setTimeout(r, 20))
		}
		assert.equal(rec?.state, 'error')
		assert.match(rec.errorMessage ?? '', expectedPattern)
		assert.equal((rec.errorMessage ?? '').toLowerCase().includes('fetch failed'), false)
	}

	try {
		await runCase(
			'offline-dns',
			async () => {
				throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}})
			},
			/Couldn’t download Debian: this server can’t reach the internet/,
		)
		await runCase(
			'timeout',
			async () => {
				throw Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})
			},
			/Couldn’t download Debian: the download timed out/,
		)
	} finally {
		await new Promise((r) => setTimeout(r, 60))
		await rm(root, {recursive: true, force: true})
	}
})

test('backups.configure blames restic download failure on internet/HTTP, never the backup folder', async () => {
	for (const [label, failingFetch, expectedPattern] of [
		[
			'offline',
			async () => {
				throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}})
			},
			/Couldn’t download the backup program \(restic\): this server can’t reach the internet/,
		],
		[
			'timeout',
			async () => {
				throw Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})
			},
			/Couldn’t download the backup program \(restic\): the download timed out/,
		],
		[
			'http-403',
			async () => new Response('forbidden', {status: 403}),
			/Couldn’t download the backup program \(restic\): the download server turned the request away \(HTTP 403\)/,
		],
	]) {
		const dir = await mkdtemp(join(os.tmpdir(), `bk-fetch-${label}-`))
		const b = createBackups({
			dataDir: dir,
			files: fakeFiles(dir),
			apps: {backupTargets: async () => []},
			timers: false,
			run: async (cmd, args) => {
				if (args[0] === 'version') throw Object.assign(new Error('nope'), {code: 'ENOENT'})
				if (cmd === 'smbclient') return {stdout: '  .omarchy-server-check   A  10  Thu Nov 19 14:48:56 2026\n', stderr: ''}
				return {stdout: '', stderr: ''}
			},
			fetchImpl: failingFetch,
		})
		try {
			await assert.rejects(
				() => b.procedures['backups.configure'].run({nas: {host: 'nas.local', username: 'u', password: 'p', share: 'backups'}}),
				(err) => {
					assert.ok(err instanceof RpcError, label)
					assert.equal(err.code, 'PRECONDITION_FAILED', label)
					assert.match(err.message, expectedPattern, label)
					assert.equal(err.message.includes('backup folder'), false, label)
					return true
				},
			)
		} finally {
			b.close()
			await rm(dir, {recursive: true, force: true})
		}
	}
})
