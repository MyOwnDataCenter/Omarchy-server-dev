// ISO workflow checks every script, and a failed first boot opens a shell instead of starting again.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const setupPath = fileURLToPath(new URL('../iso/target/target-setup.sh', import.meta.url))

function runBash(body, opts = {}) {
	return new Promise((resolve) => {
		execFile('bash', ['-c', body], {cwd: root, timeout: 15_000, ...opts}, (error, stdout, stderr) => {
			resolve({code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr)})
		})
	})
}

test('the ISO workflow syntax-checks each script, not only the first', async () => {
	const yml = await readFile(join(root, '.github/workflows/iso.yml'), 'utf8')
	const step = yml.split('name: Check the scripts')[1]?.split('name: Build')[0] ?? ''
	assert.match(step, /bash -n "\$f"/)
	assert.doesNotMatch(step, /bash -n iso\/build\.sh iso\/live/)
	const run = /run:\s*\|\n([\s\S]*?)(?=\n\s+- name:)/.exec(step)?.[1] ?? ''
	const lines = run.split('\n').filter((l) => l.trim())
	const indent = Math.min(...lines.map((l) => l.match(/^\s*/)[0].length))
	const script = lines.map((l) => l.slice(indent)).join('\n')
	const ok = await runBash(script)
	assert.equal(ok.code, 0, ok.stderr)
	const dir = await mkdtemp(join(os.tmpdir(), 'iso-n-'))
	try {
		await writeFile(join(dir, 'good.sh'), 'echo ok\n')
		await writeFile(join(dir, 'bad.sh'), 'if then fi (\n')
		const together = await runBash('bash -n good.sh bad.sh; echo exit=$?', {cwd: dir})
		assert.match(together.stdout, /exit=0/)
		const loop = await runBash('for f in good.sh bad.sh; do bash -n "$f" || exit $?; done', {cwd: dir})
		assert.notEqual(loop.code, 0)
		assert.match(loop.stderr, /syntax error/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('a command line after a failed first boot does not run first-boot again', async () => {
	const setup = await readFile(setupPath, 'utf8')
	const hook = setup.match(/cat >\/etc\/profile\.d\/zz-omarchy-server-firstboot\.sh <<'EOF'\n([\s\S]*?)\nEOF/)?.[1]
	const script = setup.match(/cat >\/usr\/local\/bin\/omarchy-server-firstboot <<'EOF'\n([\s\S]*?)\nEOF/)?.[1]
	assert.ok(hook)
	assert.ok(script)
	assert.match(script, /OMARCHY_SERVER_FIRSTBOOT_SKIP=1 bash -l/)
	assert.match(hook, /OMARCHY_SERVER_FIRSTBOOT_SKIP/)
	const dir = await mkdtemp(join(os.tmpdir(), 'firstboot-skip-'))
	const bin = join(dir, 'bin')
	const marker = join(dir, 'firstboot')
	const called = join(dir, 'called')
	const stub = join(dir, 'omarchy-server-firstboot')
	await mkdir(bin)
	await writeFile(join(bin, 'tty'), '#!/bin/sh\necho /dev/tty1\n')
	await chmod(join(bin, 'tty'), 0o755)
	await writeFile(marker, 'owner\n')
	await writeFile(stub, '#!/bin/sh\necho ran >"$CALLED"\n')
	await chmod(stub, 0o755)
	const body = hook.replaceAll('/var/lib/omarchy-server/firstboot', marker).replaceAll('/usr/local/bin/omarchy-server-firstboot', stub)
	const run = (skip) =>
		runBash(`${body}\n`, {
			env: {...process.env, PATH: `${bin}:${process.env.PATH}`, USER: 'owner', CALLED: called, ...(skip ? {OMARCHY_SERVER_FIRSTBOOT_SKIP: '1'} : {OMARCHY_SERVER_FIRSTBOOT_SKIP: ''})},
		})
	try {
		await rm(called, {force: true})
		await run(true)
		await assert.rejects(readFile(called, 'utf8'))
		await run(false)
		assert.equal(await readFile(called, 'utf8'), 'ran\n')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
