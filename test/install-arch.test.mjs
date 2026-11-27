// Omarchy runs on ARM too (Apple Silicon Macs via Asahi, Snapdragon laptops). The installer
// accepts aarch64 and picks the ARM firmware for virtual machines; x86-64 keeps its packages.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

const skip = process.platform !== 'linux' ? 'needs Linux and bash' : false
const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
// The block from `arch=$(uname -m)` to the end of its case statement.
const block = script.slice(script.indexOf('arch=$(uname -m)'), script.indexOf('esac', script.indexOf('arch=$(uname -m)')) + 4)

async function pick(machine, armRepoHasEdk2) {
	const dir = await mkdtemp(join(os.tmpdir(), 'install-arch-'))
	try {
		await writeFile(join(dir, 'uname'), `#!/bin/sh\necho ${machine}\n`)
		await writeFile(join(dir, 'pacman'), `#!/bin/sh\n[ "$2" = edk2-aarch64 ] && exit ${armRepoHasEdk2 ? 0 : 1}\nexit 1\n`)
		await chmod(join(dir, 'uname'), 0o755)
		await chmod(join(dir, 'pacman'), 0o755)
		const r = spawnSync('bash', ['-c', `die() { echo "DIE $*"; exit 1; }\n${block}\necho "PKGS $vm_pkgs"`], {env: {PATH: `${dir}:/usr/bin:/bin`}, encoding: 'utf8'})
		return r.stdout.trim()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
}

test('x86-64 installs exactly the packages it always has', {skip}, async () => {
	assert.equal(await pick('x86_64'), 'PKGS qemu-base edk2-ovmf')
})

test('aarch64 (Omarchy on an M1 Mac) is accepted and gets the ARM QEMU and firmware', {skip}, async () => {
	assert.equal(await pick('aarch64', true), 'PKGS qemu-base qemu-system-aarch64 edk2-aarch64')
	// Arch Linux ARM names the same firmware qemu-system-arm-firmware.
	assert.equal(await pick('aarch64', false), 'PKGS qemu-base qemu-system-aarch64 qemu-system-arm-firmware')
})

test('other processors are refused with a clear message', {skip}, async () => {
	assert.match(await pick('riscv64'), /^DIE .*64-bit Intel, AMD or ARM.*riscv64/)
})
