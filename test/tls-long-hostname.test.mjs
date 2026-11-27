// A device name Settings accepts (up to 63 characters) must still get a certificate authority.
// The authority common name is "Omarchy Server " plus the host, and OpenSSL rejects a CN over 64 bytes.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {ensureTls} from '../omarchyd/tls.mjs'

const names = {dns: ['localhost'], ips: ['127.0.0.1']}
const dirs = []
after(() => Promise.all(dirs.map((dir) => rm(dir, {recursive: true, force: true}))))

const subjectOf = (file) => execFileSync('openssl', ['x509', '-in', file, '-noout', '-subject'], {encoding: 'utf8'}).trim()

async function authorityFor(t, host) {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-tls-cn-'))
	dirs.push(dir)
	t.mock.method(os, 'hostname', () => host)
	const made = await ensureTls({dir, names})
	assert.match(made.ca, /BEGIN CERTIFICATE/)
	assert.match(made.cert, /BEGIN CERTIFICATE/)
	execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')], {stdio: 'ignore'})
	const server = subjectOf(join(dir, 'server.crt'))
	assert.equal(server, `subject=CN=${host}`, 'the server certificate keeps the full host as its CN')
	const ca = subjectOf(join(dir, 'ca.crt'))
	const cn = ca.slice(ca.indexOf('CN=') + 3)
	assert.ok(Buffer.byteLength(cn) <= 64, `authority CN is ${Buffer.byteLength(cn)} bytes: ${cn}`)
	return ca
}

test('a 49-character device name keeps the full authority common name', async (t) => {
	const host = 'a'.repeat(49)
	const ca = await authorityFor(t, host)
	assert.equal(ca, `subject=O=Omarchy Server, CN=Omarchy Server ${host}`)
})

test('a 50-character device name still creates the authority', async (t) => {
	const host = 'a'.repeat(50)
	const ca = await authorityFor(t, host)
	assert.equal(ca, `subject=O=Omarchy Server, CN=Omarchy Server ${'a'.repeat(49)}`)
})

test('a 63-character device name still creates the authority', async (t) => {
	const host = 'a'.repeat(63)
	const ca = await authorityFor(t, host)
	assert.equal(ca, `subject=O=Omarchy Server, CN=Omarchy Server ${'a'.repeat(49)}`)
})
