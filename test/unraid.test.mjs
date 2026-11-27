import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {mock, test} from 'node:test'
import YAML from 'yaml'

import {createMachines} from '../omarchyd/machines.mjs'
import {createStorage} from '../omarchyd/storage.mjs'
import {containerPlan, createUnraid, rsyncProgress, slug, sq, unraidPath, vmPlan, webuiPort} from '../omarchyd/unraid.mjs'

const plex = {
	Name: '/plex',
	State: {Running: true},
	Config: {Image: 'lscr.io/linuxserver/plex:latest', Env: ['PUID=99', 'PGID=100', 'VERSION=docker', 'PATH=/usr/bin', 'LSIO_DEFAULT=1'], ExposedPorts: {'32400/tcp': {}}, Labels: {'net.unraid.docker.webui': 'http://[IP]:[PORT:32400]/web'}, Cmd: null},
	HostConfig: {NetworkMode: 'host', PortBindings: {}, Devices: [{PathOnHost: '/dev/dri'}]},
	Mounts: [
		{Type: 'bind', Source: '/mnt/user/appdata/plex', Destination: '/config', RW: true},
		{Type: 'bind', Source: '/mnt/user/Media/Movies', Destination: '/movies', RW: true},
	],
}
const nginx = {
	Name: '/nginx',
	State: {Running: false},
	Config: {Image: 'nginx:1.27', Env: ['NGINX_VERSION=1.27', 'SECRET=a$b'], ExposedPorts: {'80/tcp': {}}, Labels: {}, Cmd: ['nginx', '-g', 'daemon off;'], User: '99:100'},
	HostConfig: {NetworkMode: 'bridge', PortBindings: {'80/tcp': [{HostPort: '8085'}], '53/udp': [{HostPort: '53'}], '9443/tcp': [{HostPort: '9443'}]}, Privileged: true, CapAdd: ['NET_ADMIN']},
	Mounts: [
		{Type: 'bind', Source: '/mnt/cache/appdata/nginx', Destination: '/etc/nginx/conf.d', RW: true},
		{Type: 'bind', Source: '/etc/localtime', Destination: '/etc/localtime', RW: false},
		{Type: 'bind', Source: '/boot/config', Destination: '/flash', RW: true},
	],
}

test('where a path on Unraid lives', () => {
	assert.deepEqual(unraidPath('/mnt/user/appdata/plex'), {kind: 'appdata', rest: 'plex'})
	assert.deepEqual(unraidPath('/mnt/cache/appdata/nginx/conf'), {kind: 'appdata', rest: 'nginx/conf'})
	assert.deepEqual(unraidPath('/mnt/user/Media/Movies'), {kind: 'share', share: 'Media', rest: 'Movies'})
	assert.deepEqual(unraidPath('/mnt/disk3/Media'), {kind: 'share', share: 'Media', rest: ''})
	assert.equal(unraidPath('/boot/config').kind, 'other')
	assert.equal(unraidPath('/mnt/disks/usbstick/x').kind, 'other')
	// ".." in the path after the share would copy or bind outside the folder we chose.
	assert.equal(unraidPath('/mnt/user/appdata/../../.ssh').kind, 'other')
	assert.equal(unraidPath('/mnt/user/appdata/plex/../../.ssh').kind, 'other')
	assert.equal(unraidPath('/mnt/cache/Media/../.config').kind, 'other')
	assert.deepEqual(webuiPort('http://[IP]:[PORT:8096]/web'), {port: 8096, path: '/web'})
	assert.equal(webuiPort(''), null)
	assert.equal(slug('Home Assistant!'), 'home-assistant')
	assert.equal(sq("it's"), `'it'\\''s'`)
})

test('a container mount that climbs out of appdata is not copied or bind-mounted', () => {
	const escaped = {
		...plex,
		Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/../../.ssh', Destination: '/config', RW: true}],
	}
	const p = containerPlan(escaped)
	assert.equal(p.copies.length, 0)
	const compose = YAML.parse(p.files['docker-compose.yml'])
	const volumes = JSON.stringify(compose.services)
	assert.doesNotMatch(volumes, /\.\./)
	assert.ok(p.notes.some((n) => n.includes('isn’t brought over')))
})

test('a container on Unraid becomes the same app here', () => {
	const p = containerPlan(plex, {imageEnv: ['PATH=/usr/bin', 'LSIO_DEFAULT=1']})
	assert.equal(p.id, 'unraid-plex')
	const app = YAML.parse(p.files['omarchy-app.yml'])
	const svc = YAML.parse(p.files['docker-compose.yml']).services.plex
	assert.equal(app.port, 32400)
	assert.deepEqual(app.web, {service: 'plex', port: 32400})
	assert.equal(app.path, '/web')
	assert.equal(svc.image, 'lscr.io/linuxserver/plex:latest')
	// Unraid's nobody:users becomes the app user here; the image's own settings aren't repeated.
	assert.deepEqual(svc.environment, {PUID: '${PUID}', PGID: '${PGID}', VERSION: 'docker'})
	assert.deepEqual(svc.ports, ['32400:32400'])
	assert.deepEqual(p.copies, [{from: '/mnt/user/appdata/plex', to: 'plex'}])
	assert.ok(svc.volumes.includes('${APP_DATA_DIR:-.}/data/plex:/config'))
	assert.deepEqual(p.shares, ['Media'])
	assert.ok(p.notes.some((n) => /\/dev\/dri/.test(n)))
	assert.ok(p.notes.some((n) => /Media share/.test(n)))
	assert.ok(p.notes.some((n) => /own network setting \(host\)/.test(n)))
	assert.equal(p.running, true)
	// …with the share it uses being brought over: that folder.
	const withShare = containerPlan(plex, {shareDest: (s) => (s === 'Media' ? '/home/chris/Unraid/Media' : null)})
	assert.ok(YAML.parse(withShare.files['docker-compose.yml']).services.plex.volumes.includes('/home/chris/Unraid/Media/Movies:/movies'))
})

test('what can’t come across is left out and said', () => {
	const p = containerPlan(nginx, {imageEnv: ['NGINX_VERSION=1.27'], imageCmd: ['nginx', '-g', 'daemon off;'], takenIds: new Set(['unraid-nginx'])})
	assert.equal(p.id, 'unraid-nginx-2')
	const svc = YAML.parse(p.files['docker-compose.yml']).services.nginx
	const app = YAML.parse(p.files['omarchy-app.yml'])
	assert.equal(app.port, 8085)
	assert.deepEqual(app.web, {service: 'nginx', port: 80})
	assert.deepEqual(app.openPorts, [9443])
	assert.deepEqual(svc.ports, ['8085:80', '9443:9443'])
	// A "$" in a setting stays a "$" (Compose would read it as a variable).
	assert.equal(svc.environment.SECRET, 'a$$b')
	assert.equal(svc.user, '${PUID}:${PGID}')
	assert.equal(svc.command, undefined, 'the image’s own command isn’t repeated')
	assert.equal(svc.privileged, undefined)
	assert.ok(svc.volumes.includes('/etc/localtime:/etc/localtime:ro'))
	assert.ok(!svc.volumes.some((v) => v.includes('/boot')))
	for (const what of [/privileged/, /NET_ADMIN/, /below 1024 \(53\)/, /\/boot\/config/]) assert.ok(p.notes.some((n) => what.test(n)), String(what))
})

test('an HTTPS WebUI label sets web.https on the imported app', () => {
	assert.deepEqual(webuiPort('https://[IP]:[PORT:8443]/'), {port: 8443, path: '', https: true})
	assert.deepEqual(webuiPort('HTTPS://[IP]:[PORT:8443]/admin'), {port: 8443, path: '/admin', https: true})
	assert.deepEqual(webuiPort('http://[IP]:[PORT:8096]/web'), {port: 8096, path: '/web'})
	const p = containerPlan({
		Name: '/vaultwarden',
		State: {Running: true},
		Config: {Image: 'vaultwarden/server:latest', Labels: {'net.unraid.docker.webui': 'https://[IP]:[PORT:8443]/'}},
		HostConfig: {PortBindings: {'8443/tcp': [{HostPort: '8443'}]}},
	})
	const app = YAML.parse(p.files['omarchy-app.yml'])
	assert.deepEqual(app.web, {service: 'vaultwarden', port: 8443, https: true})
})

test('dollar signs in container commands and mount paths are escaped for Compose', async () => {
	const container = {
		Name: '/Dollar-App',
		State: {Running: false},
		Config: {Image: 'app:1', Env: [], Cmd: ['sh', '-c', 'echo $HOME && exec app --token=ab$cd'], User: 'user$1'},
		HostConfig: {PortBindings: {'8080/tcp': [{HostPort: '8080'}]}},
		Mounts: [
			{Type: 'bind', Source: '/mnt/user/appdata/my$app', Destination: '/config/$dir', RW: true},
			{Type: 'bind', Source: '/mnt/user/Media/sub$1', Destination: '/media/$out', RW: true},
			{Type: 'bind', Source: '/etc/localtime', Destination: '/etc/$tz', RW: false},
			{Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/$sock', RW: true},
		],
	}
	const p = containerPlan(container)
	const svc = YAML.parse(p.files['docker-compose.yml']).services['dollar-app']
	assert.deepEqual(svc.command, ['sh', '-c', 'echo $$HOME && exec app --token=ab$$cd'])
	assert.equal(svc.user, 'user$$1')
	assert.deepEqual(svc.volumes, [
		'${APP_DATA_DIR:-.}/data/my$$app:/config/$$dir',
		'${APP_DATA_DIR:-.}/data/shares/media/sub$$1:/media/$$out',
		'/etc/localtime:/etc/$$tz:ro',
		'/var/run/docker.sock:/var/run/$$sock',
	])
	assert.deepEqual(p.copies, [{from: '/mnt/user/appdata/my$app', to: 'my$app'}])

	const withShare = containerPlan(container, {shareDest: () => '/home/u/Pools/Data$1/Media'})
	const withShareSvc = YAML.parse(withShare.files['docker-compose.yml']).services['dollar-app']
	assert.ok(withShareSvc.volumes.includes('/home/u/Pools/Data$$1/Media/sub$$1:/media/$$out'))

	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-dollar-'))
	await mkdir(join(dir, 'tree', 'Home', 'My$Pool', 'Unraid'), {recursive: true})
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
		if (remote.includes('/mnt/user')) return {stdout: 'Media\t100\n', stderr: ''}
		if (remote.startsWith('docker ps')) return {stdout: 'Dollar-App\n', stderr: ''}
		if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([container]), stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async () => {},
		importState: () => ({done: true, error: null}),
	}
	const u = createUnraid({dataDir: dir, files, apps, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		const started = await u.procedures['unraid.start'].run({shares: ['Media'], containers: ['unraid-dollar-app'], destination: '/Home/My$Pool/Unraid'})
		let st
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
			if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.ok(st?.job?.endedAt)
		assert.deepEqual(st.job.items.map((x) => [x.key, x.status]), [['Media', 'done'], ['unraid-dollar-app', 'done']])
		const written = YAML.parse(await readFile(join(dir, 'store', 'unraid-dollar-app', 'docker-compose.yml'), 'utf8'))
		assert.ok(written.services['dollar-app'].volumes.includes(`${join(dir, 'tree/Home/My$$Pool/Unraid/Media/sub$$1')}:/media/$$out`))
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('single-file appdata mounts are copied without a trailing slash', async () => {
	const container = {
		Name: '/file-app',
		State: {Running: true},
		Config: {Image: 'app:1', Env: [], Labels: {}},
		HostConfig: {PortBindings: {'8080/tcp': [{HostPort: '8080'}]}},
		Mounts: [
			{Type: 'bind', Source: '/mnt/user/appdata/app/config.ini', Destination: '/config.ini', RW: true},
			{Type: 'bind', Source: '/mnt/user/appdata/app/db', Destination: '/db', RW: true},
		],
	}
	const p = containerPlan(container, {appdataFiles: new Set(['/mnt/user/appdata/app/config.ini'])})
	assert.deepEqual(p.copies, [
		{from: '/mnt/user/appdata/app/config.ini', to: 'app/config.ini', file: true},
		{from: '/mnt/user/appdata/app/db', to: 'app/db'},
	])
	assert.ok(YAML.parse(p.files['docker-compose.yml']).services['file-app'].volumes.includes('${APP_DATA_DIR:-.}/data/app/config.ini:/config.ini'))

	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-file-'))
	const rsyncCalls = []
	const sshCmds = []
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			rsyncCalls.push(argv)
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		sshCmds.push(remote)
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'appdata\t4224\n', stderr: ''}
		if (remote.startsWith('docker ps')) return {stdout: 'file-app\n', stderr: ''}
		if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([container]), stderr: ''}
		if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/app/config.ini\t128\tf\n/mnt/user/appdata/app/db\t4096\td\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async () => {},
		importState: () => ({done: true, error: null}),
	}
	const u = createUnraid({dataDir: dir, files: {}, apps, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		const scan = await u.procedures['unraid.scan'].run()
		assert.equal(scan.containers[0].size, 4224)
		assert.ok(sshCmds.some((c) => c.includes('[ -f "$p" ]')))
		const started = await u.procedures['unraid.start'].run({containers: ['unraid-file-app']})
		let st
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
			if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.equal(st.job.items[0].status, 'done')
		const fileCalls = rsyncCalls.filter((a) => a.some((x) => x.includes('config.ini')))
		const dirCalls = rsyncCalls.filter((a) => a.some((x) => x.includes('/app/db')))
		assert.equal(fileCalls.length, 2)
		assert.equal(dirCalls.length, 2)
		const expectedFileDest = join(dir, 'apps/unraid-file-app/data/app/config.ini')
		for (const argv of fileCalls) {
			assert.ok(argv.includes('-lt'))
			assert.ok(!argv.includes('-rlt'))
			assert.equal(argv[argv.length - 2], 'tower.local:/mnt/user/appdata/app/config.ini')
			assert.equal(argv[argv.length - 1], expectedFileDest)
		}
		for (const argv of dirCalls) {
			assert.ok(argv.includes('-rlt'))
			assert.equal(argv[argv.length - 2], 'tower.local:/mnt/user/appdata/app/db/')
			assert.equal(argv[argv.length - 1], `${join(dir, 'apps/unraid-file-app/data/app/db')}/`)
		}
		assert.equal((await stat(join(dir, 'apps/unraid-file-app/data/app'))).isDirectory(), true)
		await assert.rejects(stat(expectedFileDest), {code: 'ENOENT'})
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('rsync exit code 24 (vanished files) finishes the pass while exit 23 fails it', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-rsync24-'))
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	const plexContainer = {...plex, Name: '/plex24', Id: 'p24'}
	const fail23Container = {...plex, Name: '/plex23', Id: 'p23'}
	let containerPass = 0
	const installed = []
	const warned = []
	const origWarn = console.warn
	console.warn = (...a) => warned.push(a.map(String).join(' '))
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			const src = argv[argv.length - 2]
			if (src.includes('/mnt/user/Media')) throw Object.assign(new Error('rsync: some files vanished before they could be transferred (code 24)'), {code: 24})
			if (src.includes('/mnt/user/appdata/plex')) {
				containerPass++
				if (containerPass === 1) throw Object.assign(new Error('rsync: some files vanished before they could be transferred (code 24)'), {code: 24})
				if (containerPass === 3) throw Object.assign(new Error('rsync: rsync error: some files/attrs were not transferred (code 23)'), {code: 23})
			}
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'Media\t100\n', stderr: ''}
		if (remote.startsWith('docker ps')) return {stdout: 'plex24\nplex23\n', stderr: ''}
		if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([plexContainer, fail23Container]), stderr: ''}
		if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/plex\t100\td\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async (id) => installed.push(id),
		importState: () => ({done: true, error: null}),
	}
	const u = createUnraid({dataDir: dir, files, apps, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		const started = await u.procedures['unraid.start'].run({shares: ['Media'], containers: ['unraid-plex24', 'unraid-plex23']})
		let st
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
			if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
			await new Promise((r) => setTimeout(r, 10))
		}
		const byKey = Object.fromEntries(st.job.items.map((x) => [x.key, x]))
		assert.equal(byKey.Media.status, 'done')
		assert.equal(byKey['unraid-plex24'].status, 'done')
		assert.equal(byKey['unraid-plex23'].status, 'failed')
		assert.match(byKey['unraid-plex23'].error, /didn’t finish/)
		assert.deepEqual(installed, ['unraid-plex24'])
		assert.ok(containerPass >= 3)
		assert.ok(warned.some((w) => w.includes('24')))
	} finally {
		console.warn = origWarn
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('imported container version ignores registry ports and image digests', () => {
	const digest = 'a'.repeat(64)
	const cases = [
		['nginx:1.25', '1.25'],
		['registry.local:5000/team/app:1.2', '1.2'],
		['registry.local:5000/team/app', 'latest'],
		[`nginx@sha256:${digest}`, 'latest'],
		[`registry.local:5000/team/app:1.2@sha256:${digest}`, '1.2'],
		['nginx', 'latest'],
	]
	for (const [Image, expected] of cases) {
		const p = containerPlan({Name: '/app', Config: {Image}})
		assert.equal(YAML.parse(p.files['omarchy-app.yml']).version, expected, Image)
	}
})

test('a VM on Unraid: its settings and disks', () => {
	const xml = `<domain type='kvm'><name>Win11</name><memory unit='KiB'>8388608</memory><vcpu placement='static'>4</vcpu>
<os><loader readonly='yes' type='pflash'>/usr/share/qemu/ovmf-x64/OVMF_CODE-pure-efi.fd</loader><type arch='x86_64' machine='pc-q35-7.2'>hvm</type></os>
<devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='hdc' bus='virtio'/></disk>
<disk type='file' device='cdrom'><source file='/mnt/user/isos/w.iso'/><target dev='hda' bus='sata'/></disk>
<disk type='block' device='disk'><source dev='/dev/disk/by-id/ata-X'/><target dev='hdd' bus='sata'/></disk>
<interface type='bridge'><model type='e1000'/></interface><hostdev mode='subsystem' type='pci'/></devices></domain>`
	const v = vmPlan(xml, 'shut off')
	assert.equal(v.name, 'Win11')
	assert.equal(v.memoryMb, 8192)
	assert.equal(v.cores, 4)
	assert.equal(v.firmware, 'efi')
	assert.equal(v.machineType, 'q35')
	assert.equal(v.nic, 'e1000e')
	assert.deepEqual(v.disks, [{file: '/mnt/user/domains/Win11/vdisk1.img', bus: 'virtio', format: 'raw'}])
	assert.ok(v.notes.some((n) => /whole drive/.test(n)))
	assert.ok(v.notes.some((n) => /graphics card/.test(n)))
	assert.equal(vmPlan('<domain><name>x</name><os><type machine="pc-i440fx-7.1">hvm</type></os></domain>').machineType, 'pc')
	assert.deepEqual(vmPlan('<domain><name>x</name></domain>').problems, ['It has no disk image to copy'])
})

test('container and VM settings that are not brought over are named', () => {
	const throughOther = containerPlan({
		Name: '/sidecar',
		Config: {Image: 'app:1'},
		HostConfig: {NetworkMode: 'container:3f2a9b', PortBindings: {}},
	})
	assert.ok(throughOther.notes.some((n) => /3f2a9b/.test(n) && /isn’t brought over/.test(n)), throughOther.notes.join(' | '))
	const named = containerPlan(
		{
			Name: '/sidecar',
			Config: {Image: 'app:1'},
			HostConfig: {NetworkMode: 'container:3f2a9b', PortBindings: {}},
		},
		{peers: new Map([['3f2a9b', 'gluetun']])},
	)
	assert.ok(named.notes.some((n) => /gluetun/.test(n) && /isn’t brought over/.test(n)))

	const frigate = {
		Name: '/frigate',
		State: {Running: true},
		Config: {Image: 'ghcr.io/blakeblackshear/frigate:stable', Env: [], Entrypoint: ['python3', '-u', '-m', 'frigate']},
		HostConfig: {
			NetworkMode: 'bridge',
			PortBindings: {'5000/tcp': [{HostPort: '5000'}]},
			Runtime: 'nvidia',
			DeviceRequests: [{Driver: 'nvidia', Count: -1, Capabilities: [['gpu']]}],
			Sysctls: {'net.ipv4.conf.all.src_valid_mark': '1'},
			ShmSize: 256 * 1024 * 1024,
			Dns: ['1.1.1.1'],
			ExtraHosts: ['mqtt:192.168.1.20'],
			Memory: 2 * 1024 * 1024 * 1024,
			CpusetCpus: '0,1',
			SecurityOpt: ['apparmor=unconfined'],
			Tmpfs: {'/tmp/cache': 'rw,noexec,nosuid,size=64m'},
		},
	}
	const dropped = containerPlan(frigate)
	for (const what of [/NVIDIA/, /graphics card/, /python3 -u -m frigate/, /src_valid_mark/, /256 MB/, /1\.1\.1\.1/, /mqtt:192\.168\.1\.20/, /2 GB/, /0,1/, /apparmor=unconfined/, /\/tmp\/cache/]) {
		assert.ok(dropped.notes.some((n) => what.test(n)), `${what} missing from ${dropped.notes.join(' | ')}`)
	}
	const sameStart = containerPlan(frigate, {imageEntrypoint: ['python3', '-u', '-m', 'frigate']})
	assert.equal(sameStart.notes.some((n) => /python3/.test(n)), false)
	const defaults = containerPlan({
		Name: '/plain',
		Config: {Image: 'app:1', Entrypoint: ['/init']},
		HostConfig: {NetworkMode: 'bridge', Runtime: 'runc', ShmSize: 64 * 1024 * 1024, Memory: 0, PortBindings: {'8080/tcp': [{HostPort: '8080'}]}},
	}, {imageEntrypoint: ['/init']})
	assert.deepEqual(defaults.notes, [])

	const xml = `<domain type='kvm'><name>big</name><memory unit='KiB'>1048576</memory><vcpu>16</vcpu>
<os><nvram>/var/lib/libvirt/qemu/nvram/big_VARS.fd</nvram></os>
<cputune><vcpupin vcpu='0' cpuset='1'/></cputune>
<devices>
<tpm model='tpm-crb'><backend type='emulator' version='2.0'/></tpm>
<disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='/mnt/user/domains/big/vdisk1.img'/><target dev='sda' bus='sata'/></disk>
</devices></domain>`
	const reduced = vmPlan(xml, 'shut off', 8)
	assert.ok(reduced.notes.some((n) => /TPM/.test(n)))
	assert.ok(reduced.notes.some((n) => /NVRAM/.test(n)))
	assert.ok(reduced.notes.some((n) => /pinning/.test(n)))
	assert.ok(reduced.notes.some((n) => /16 CPU cores/.test(n) && /comes over with 8/.test(n)), reduced.notes.join(' | '))
	const roomy = vmPlan(xml, 'shut off', 32)
	assert.equal(roomy.notes.some((n) => /CPU cores/.test(n)), false)
	assert.ok(roomy.notes.some((n) => /TPM/.test(n)))
	const pinOnly = vmPlan(`<domain><name>p</name><vcpu>1</vcpu><vcpupin vcpu='0' cpuset='2'/><devices><disk type='file' device='disk'><source file='/mnt/user/domains/p/v.img'/><target bus='virtio'/></disk></devices></domain>`, 'shut off', 8)
	assert.ok(pinOnly.notes.some((n) => /pinning/.test(n)))
	for (const bus of ['scsi', 'usb']) {
		const kept = vmPlan(`<domain><name>d</name><vcpu>1</vcpu><devices><disk type='file' device='disk'><source file='/mnt/user/domains/d/v.img'/><target dev='sda' bus='${bus}'/></disk></devices></domain>`, 'shut off', 8)
		assert.equal(kept.disks[0].bus, bus)
		assert.equal(kept.notes.some((n) => /sata/i.test(n)), false, bus)
	}
})

test('a share whose Unraid name cannot be a Samba name says the name that was chosen', async () => {
	const shareName = 'Photos+From+The+Very+Old+Unraid+Box'
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-share-name-'))
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	const data = join(dir, 'data')
	const run = async (cmd, argv = [], opts) => {
		if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		if (cmd === 'sh') return '/usr/bin/omarchy\n'
		if (cmd === 'sudo') {
			const verb = argv?.[2]
			if (verb === 'ping' || verb === 'shares-apply' || verb === 'smb-password') return 'ok\n'
			return 'ok\n'
		}
		if (cmd === 'pacman') return `${argv[1]} 1\n`
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\n', stderr: ''}
		if (remote.includes('/mnt/user')) return {stdout: `${shareName}\t100\nMedia\t50\n`, stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const storage = createStorage({dataDir: data, home: join(dir, 'tree', 'Home'), files, run, fstabPath: join(dir, 'fstab'), smbConf: join(dir, 'smb.conf')})
	const u = createUnraid({dataDir: data, files, apps: {}, machines: {}, storage, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		const started = await u.procedures['unraid.start'].run({shares: [shareName, 'Media'], destination: '/Home/Unraid'})
		let st
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			const saved = await readFile(join(data, 'unraid', 'job.json'), 'utf8').catch(() => '')
			if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
			await new Promise((r) => setTimeout(r, 10))
		}
		const items = Object.fromEntries(st.job.items.map((x) => [x.key, x]))
		assert.equal(items[shareName].status, 'done', items[shareName]?.error)
		assert.equal(items.Media.status, 'done', items.Media?.error)
		assert.equal(items.Media.note, undefined)
		const savedShares = JSON.parse(await readFile(join(data, 'shares.json'), 'utf8'))
		const chosen = savedShares.find((s) => s.path.endsWith(`/${shareName}`)).name
		assert.notEqual(chosen, shareName)
		assert.match(chosen, /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/)
		assert.match(items[shareName].note, new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a VM dump unescapes XML entities in its name and disk paths', () => {
	const xml = `<domain type='kvm'><name>Games &amp; Media</name><memory unit='KiB'>4194304</memory><vcpu>2</vcpu>
<devices>
<disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/Games &amp; Stuff/Bob&apos;s PC/vdisk1.img'/><target dev='hdc' bus='virtio'/></disk>
<disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='/mnt/user/Data &#x26; Logs/&#39;keep&amp;apos;&#39;/vdisk2.qcow2'/><target dev='hdd' bus='sata'/></disk>
<disk type='file' device='disk'><driver name='qemu' type='raw'/><source file="/mnt/user/Bob's PC/vdisk3.img"/><target dev='hde' bus='sata'/></disk>
</devices></domain>`
	const v = vmPlan(xml, 'shut off')
	assert.equal(v.name, 'Games & Media')
	assert.deepEqual(
		v.disks.map((d) => d.file),
		[
			"/mnt/user/Games & Stuff/Bob's PC/vdisk1.img",
			"/mnt/user/Data & Logs/'keep&apos;'/vdisk2.qcow2",
			"/mnt/user/Bob's PC/vdisk3.img",
		],
	)
})

test('rsync progress', () => {
	assert.deepEqual(rsyncProgress('    1,234,567  45%   10.00MB/s    0:01:23 (xfr#3, to-chk=0/9)'), {bytes: 1234567, percent: 0.45})
	assert.equal(rsyncProgress('sending incremental file list'), null)
})

test('bad details never reach ssh', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-'))
	const calls = []
	const u = createUnraid({dataDir: dir, files: {}, apps: {}, machines: {}, storage: null, run: async (...a) => (calls.push(a), {stdout: '', stderr: ''})})
	try {
		await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower; rm -rf /', password: 'x'}), /name or address/)
		await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower.local', password: 'a\nb'}), /root password/)
		await assert.rejects(u.procedures['unraid.scan'].run(), /Connect/)
		assert.equal(calls.length, 0)
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'}).catch(() => {})
		const ssh = calls.find((c) => c[0] === 'ssh')
		assert.ok(ssh)
		// The password goes to ssh only through its askpass helper's environment.
		assert.ok(!ssh[1].join(' ').includes('s3cret'))
		assert.equal(ssh[2].env.OMARCHY_UNRAID_SECRET, 's3cret')
		assert.ok(ssh[1].includes('StrictHostKeyChecking=accept-new'))
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('forgetHost removes non-default port entries and host-key errors match the button label', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-forget-'))
	const keygenCalls = []
	const run = async (cmd, argv = []) => {
		if (cmd === 'ssh-keygen') {
			keygenCalls.push(argv)
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh') throw new Error('ssh: Host key verification failed.')
		return {stdout: '', stderr: ''}
	}
	const u = createUnraid({dataDir: dir, files: {}, apps: {}, machines: {}, storage: null, run})
	try {
		const knownHosts = join(dir, 'unraid', 'known_hosts')
		await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower.local', password: 'x'}), /Forget this server’s key/)
		await assert.rejects(u.procedures['unraid.forgetHost'].run({host: 'tower.local', port: 70000}), /Bad host/)
		await assert.rejects(u.procedures['unraid.forgetHost'].run({host: 'bad; host'}), /Bad host/)
		assert.equal(keygenCalls.length, 0)

		await u.procedures['unraid.forgetHost'].run({host: 'tower.local'})
		await u.procedures['unraid.forgetHost'].run({host: 'tower.local:2222'})
		await u.procedures['unraid.forgetHost'].run({host: 'tower.local', port: 2222})
		await u.procedures['unraid.forgetHost'].run({host: 'https://tower.local:2222/Main'})
		assert.deepEqual(keygenCalls, [
			['-R', 'tower.local', '-f', knownHosts],
			['-R', '[tower.local]:2222', '-f', knownHosts],
			['-R', '[tower.local]:2222', '-f', knownHosts],
			['-R', '[tower.local]:2222', '-f', knownHosts],
		])
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('the idle timer forgets the Unraid password after an import ends', async () => {
	// The idle clock is a real timer, not the injected `now`, so only mock timers can move it.
	// Keep one real timer. The copy starts and ends with real file writes, and a short
	// setImmediate spin can return before those writes land when the runner is busy.
	const realSetTimeout = setTimeout
	mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']})
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-idle-'))
	const dirB = await mkdtemp(join(os.tmpdir(), 'unraid-idle-b-'))
	let releaseRsync
	const rsyncHeld = new Promise((resolve) => {
		releaseRsync = resolve
	})
	let rsyncStarted = false
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			rsyncStarted = true
			await rsyncHeld
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\n', stderr: ''}
		if (remote.includes('/mnt/user')) return {stdout: 'Media\t100\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	// realOf creates each folder from /Home/<name> down, so /Home itself has to exist already.
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	const u = createUnraid({dataDir: dir, files, apps: {}, machines: {}, storage: null, run})
	let uB
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		await u.procedures['unraid.start'].run({shares: ['Media']})
		const startWait = process.hrtime.bigint()
		for (;;) {
			if (rsyncStarted) break
			if (process.hrtime.bigint() - startWait > 5_000_000_000n) break
			await new Promise((r) => setImmediate(r))
			if (rsyncStarted) break
			await new Promise((r) => realSetTimeout(r, 20))
		}
		assert.equal(rsyncStarted, true, 'the 3 hour tick has to land while rsync is still pending')
		mock.timers.tick(3 * 60 * 60 * 1000)
		const mid = await u.procedures['unraid.status'].run()
		assert.equal(mid.job.endedAt, null)
		assert.equal(mid.connected.host, 'tower.local')
		releaseRsync()
		let done
		let saved = ''
		const jobFile = join(dir, 'unraid', 'job.json')
		const waitStart = process.hrtime.bigint()
		for (;;) {
			await new Promise((r) => setImmediate(r))
			done = await u.procedures['unraid.status'].run()
			// endedAt is set in memory before the file write finishes. Removing the directory
			// in that gap races writeAtomic's temp file and fails with ENOTEMPTY.
			saved = await readFile(jobFile, 'utf8').catch(() => '')
			if (done.job?.endedAt && /"endedAt": \d/.test(saved)) break
			if (process.hrtime.bigint() - waitStart > 5_000_000_000n) break
			await new Promise((r) => realSetTimeout(r, 20))
		}
		assert.ok(done.job?.endedAt, 'the import should have finished')
		assert.match(saved, /"endedAt": \d/)
		// The window starts again when the import ends. Long after that, the password is gone.
		mock.timers.tick(48 * 60 * 60 * 1000)
		assert.equal((await u.procedures['unraid.status'].run()).connected, null)

		// No import: three idle hours still forgets the password.
		uB = createUnraid({dataDir: dirB, files, apps: {}, machines: {}, storage: null, run})
		await uB.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await uB.procedures['unraid.scan'].run()
		mock.timers.tick(3 * 60 * 60 * 1000)
		assert.equal((await uB.procedures['unraid.status'].run()).connected, null)
	} finally {
		u.close()
		uB?.close()
		mock.timers.reset()
		await rm(dir, {recursive: true, force: true})
		await rm(dirB, {recursive: true, force: true})
	}
})

test('a damaged unraid job.json is not a running import and is left unchanged', async () => {
	// Empty, truncated, a BOM, and JSON that is not a plain object. null and [] parse, but they are not a job.
	const bodies = ['', '{', '\uFEFF{"endedAt":null}', 'null', '[]', '"stuck"']
	for (const body of bodies) {
		const dir = await mkdtemp(join(os.tmpdir(), 'unraid-job-'))
		const jobDir = join(dir, 'unraid')
		const file = join(jobDir, 'job.json')
		await mkdir(jobDir, {recursive: true})
		await writeFile(file, body)
		const rejections = []
		const onRejection = (reason) => rejections.push(reason)
		const logged = []
		const origError = console.error
		console.error = (...args) => logged.push(args.map(String).join(' '))
		process.on('unhandledRejection', onRejection)
		let u
		try {
			u = createUnraid({dataDir: dir, files: {}, apps: {}, machines: {}, storage: null, run: async () => ({stdout: '', stderr: ''})})
			await new Promise((r) => setTimeout(r, 50))
			assert.deepEqual(
				rejections.map((e) => e?.message ?? String(e)),
				[],
				`job.json ${JSON.stringify(body)} rejected startup`,
			)
			await u.ready
			assert.equal(await readFile(file, 'utf8'), body, 'startup must not rewrite a damaged job.json')
			const st = await u.procedures['unraid.status'].run()
			assert.equal(st.job, null)
			await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower.local', password: 'x'}), (err) => {
				assert.doesNotMatch(err.message, /import is running/)
				return true
			})
			const damage = logged.filter((line) => line.includes('job.json'))
			assert.equal(damage.length, 1)
			assert.equal(damage[0].includes(dir), false, 'the log must not include the path')
			if (body) assert.equal(damage[0].includes(body), false, 'the log must not include the file contents')
		} finally {
			console.error = origError
			process.off('unhandledRejection', onRejection)
			u?.close()
			await rm(dir, {recursive: true, force: true})
		}
	}
})

test('a job that was still running is marked stopped in memory without rewriting job.json', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-job-ok-'))
	const file = join(dir, 'unraid', 'job.json')
	const body = '{\n\t"id": "ab12",\n\t"endedAt": null,\n\t"items": []\n}\n'
	await mkdir(join(dir, 'unraid'), {recursive: true})
	await writeFile(file, body)
	const u = createUnraid({dataDir: dir, files: {}, apps: {}, machines: {}, storage: null, run: async () => ({stdout: '', stderr: ''})})
	try {
		await u.ready
		await new Promise((r) => setTimeout(r, 20))
		const st = await u.procedures['unraid.status'].run()
		assert.equal(st.job.id, 'ab12')
		assert.ok(st.job.endedAt)
		assert.match(st.job.stopped, /server restarted/)
		assert.equal(await readFile(file, 'utf8'), body)
		await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower.local', password: 'x'}), (err) => {
			assert.doesNotMatch(err.message, /import is running/)
			return true
		})
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a restart interrupts running and waiting items in memory and gives accurate instructions', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-job-items-'))
	const file = join(dir, 'unraid', 'job.json')
	const body = JSON.stringify(
		{
			id: 'cd34',
			host: 'tower.local',
			endedAt: null,
			items: [
				{kind: 'share', key: 'Docs', name: 'Docs', status: 'done', path: '/Home/Unraid/Docs'},
				{kind: 'share', key: 'Media', name: 'Media', status: 'running', step: 'Copying', progress: 0.4},
				{kind: 'container', key: 'unraid-plex', name: 'plex', status: 'waiting'},
			],
		},
		null,
		'\t',
	)
	await mkdir(join(dir, 'unraid'), {recursive: true})
	await writeFile(file, body)
	const u = createUnraid({dataDir: dir, files: {}, apps: {}, machines: {}, storage: null, run: async () => ({stdout: '', stderr: ''})})
	try {
		await u.ready
		const st = await u.procedures['unraid.status'].run()
		assert.equal(await readFile(file, 'utf8'), body)
		assert.ok(st.job.endedAt)
		assert.match(st.job.stopped, /Done/)
		assert.match(st.job.stopped, /connect again/)
		assert.doesNotMatch(st.job.stopped, /Continue/)
		assert.equal(st.job.items[0].status, 'done')
		assert.equal(st.job.items[1].status, 'failed')
		assert.equal(st.job.items[1].error, 'Stopped when the server restarted')
		assert.equal(st.job.items[1].step, undefined)
		assert.equal(st.job.items[2].status, 'skipped')
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a paused Unraid container is restarted if docker stop fails and is reported if the server restarts', async () => {
	// 1. docker stop times out, docker start still runs and succeeds.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'unraid-pause-1-'))
		const remoteCalls = []
		const plexRunning = {...plex, Name: '/plex', State: {Running: true}}
		const run = async (cmd, argv = []) => {
			if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
			const remote = String(argv[argv.length - 1] ?? '')
			remoteCalls.push(remote)
			if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
			if (remote.includes('/mnt/user/*')) return {stdout: 'appdata\t100\n', stderr: ''}
			if (remote.startsWith('docker ps')) return {stdout: 'plex\n', stderr: ''}
			if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([plexRunning]), stderr: ''}
			if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/plex\t100\td\n', stderr: ''}
			if (remote.startsWith('docker stop')) throw new Error('ssh: Connection timed out')
			return {stdout: '', stderr: ''}
		}
		const apps = {
			importedStoreDir: join(dir, 'store'),
			appDirFor: (id) => join(dir, 'apps', id),
			installed: () => false,
			installImported: async () => {},
			importState: () => ({done: true, error: null}),
		}
		const u = createUnraid({dataDir: dir, files: {}, apps, machines: {}, storage: null, run})
		try {
			await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
			await u.procedures['unraid.scan'].run()
			const started = await u.procedures['unraid.start'].run({containers: ['unraid-plex']})
			let st
			let saved = ''
			for (let i = 0; i < 200; i++) {
				st = await u.procedures['unraid.status'].run()
				saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
				await new Promise((r) => setTimeout(r, 10))
			}
			assert.equal(st.job.items[0].status, 'failed')
			assert.ok(remoteCalls.includes("docker stop 'plex'"))
			assert.ok(remoteCalls.includes("docker start 'plex'"))
			assert.equal(JSON.parse(saved).paused, undefined)
		} finally {
			u.close()
			await rm(dir, {recursive: true, force: true})
		}
	}

	// 2. docker stop fails and docker start also fails: item note warns it may still be stopped.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'unraid-pause-2-'))
		const remoteCalls = []
		const plexRunning = {...plex, Name: '/plex', State: {Running: true}}
		const run = async (cmd, argv = []) => {
			if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
			const remote = String(argv[argv.length - 1] ?? '')
			remoteCalls.push(remote)
			if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
			if (remote.includes('/mnt/user/*')) return {stdout: 'appdata\t100\n', stderr: ''}
			if (remote.startsWith('docker ps')) return {stdout: 'plex\n', stderr: ''}
			if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([plexRunning]), stderr: ''}
			if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/plex\t100\td\n', stderr: ''}
			if (remote.startsWith('docker stop')) throw new Error('ssh: Connection timed out')
			if (remote.startsWith('docker start')) throw new Error('ssh: Connection timed out')
			return {stdout: '', stderr: ''}
		}
		const apps = {
			importedStoreDir: join(dir, 'store'),
			appDirFor: (id) => join(dir, 'apps', id),
			installed: () => false,
			installImported: async () => {},
			importState: () => ({done: true, error: null}),
		}
		const u = createUnraid({dataDir: dir, files: {}, apps, machines: {}, storage: null, run})
		try {
			await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
			await u.procedures['unraid.scan'].run()
			const started = await u.procedures['unraid.start'].run({containers: ['unraid-plex']})
			let st
			for (let i = 0; i < 200; i++) {
				st = await u.procedures['unraid.status'].run()
				const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
				await new Promise((r) => setTimeout(r, 10))
			}
			assert.equal(st.job.items[0].status, 'failed')
			assert.ok(remoteCalls.includes("docker start 'plex'"))
			assert.match(st.job.items[0].note, /may still be stopped on Unraid.*plex/i)
		} finally {
			u.close()
			await rm(dir, {recursive: true, force: true})
		}
	}

	// 3. Server restarts while docker stop is in flight: job.json names paused container and restart message surfaces it.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'unraid-pause-3-'))
		let releaseStop
		let stopReached = false
		const stopHeld = new Promise((resolve, reject) => {
			releaseStop = () => reject(new Error('stopped for cleanup'))
		})
		const plexRunning = {...plex, Name: '/plex', State: {Running: true}}
		const run = async (cmd, argv = []) => {
			if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
			const remote = String(argv[argv.length - 1] ?? '')
			if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
			if (remote.includes('/mnt/user/*')) return {stdout: 'appdata\t100\n', stderr: ''}
			if (remote.startsWith('docker ps')) return {stdout: 'plex\n', stderr: ''}
			if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([plexRunning]), stderr: ''}
			if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/plex\t100\td\n', stderr: ''}
			if (remote.startsWith('docker stop')) {
				stopReached = true
				return stopHeld
			}
			return {stdout: '', stderr: ''}
		}
		const apps = {
			importedStoreDir: join(dir, 'store'),
			appDirFor: (id) => join(dir, 'apps', id),
			installed: () => false,
			installImported: async () => {},
			importState: () => ({done: true, error: null}),
		}
		const u1 = createUnraid({dataDir: dir, files: {}, apps, machines: {}, storage: null, run})
		let u2
		try {
			await u1.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
			await u1.procedures['unraid.scan'].run()
			const started = await u1.procedures['unraid.start'].run({containers: ['unraid-plex']})
			let saved = ''
			for (let i = 0; i < 200; i++) {
				saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				if (stopReached && saved.includes('"paused": "plex"')) break
				await new Promise((r) => setTimeout(r, 10))
			}
			assert.equal(stopReached, true)
			assert.equal(JSON.parse(saved).paused, 'plex')

			u2 = createUnraid({dataDir: dir, files: {}, apps, machines: {}, storage: null, run: async () => ({stdout: '', stderr: ''})})
			await u2.ready
			const st2 = await u2.procedures['unraid.status'].run()
			assert.match(st2.job.stopped, /plex/)
			assert.match(st2.job.stopped, /Start plex on Unraid/)
			assert.equal(st2.job.items[0].status, 'failed')
			assert.match(st2.job.items[0].error, /Start plex on Unraid/)

			releaseStop()
			for (let i = 0; i < 200; i++) {
				const cur = await u1.procedures['unraid.status'].run()
				const disk = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				if (cur.job?.endedAt && disk.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(disk)) break
				await new Promise((r) => setTimeout(r, 10))
			}
		} finally {
			releaseStop?.()
			u2?.close()
			u1.close()
			await rm(dir, {recursive: true, force: true})
		}
	}
})

test('imported VMs are marked installed, blocked from duplicate import, and report renames', async () => {
	const vmXml = `<domain type='kvm'><name>Win11</name><memory unit='KiB'>4194304</memory><vcpu>2</vcpu>
<devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='hdc' bus='virtio'/></disk></devices></domain>`
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-virsh\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'domains\t100\n', stderr: ''}
		if (remote.startsWith('virsh list')) return {stdout: 'Win11\n', stderr: ''}
		if (remote.startsWith('virsh dumpxml')) return {stdout: vmXml, stderr: ''}
		if (remote.startsWith('virsh domstate')) return {stdout: 'shut off\n', stderr: ''}
		if (remote.startsWith('stat -c %s')) return {stdout: '1048576\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}

	// 1. Counting stub: second scan marks installed, second start fails with Already here, removed VM becomes importable again, and rename is noted.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'unraid-vm-dup-'))
		let importCalls = 0
		let stateResult = {done: true, error: null, name: 'Win11 (2)'}
		const machines = {
			importVm: async () => {
				importCalls++
				return {id: 'vm-abc'}
			},
			importState: () => stateResult,
		}
		const u = createUnraid({dataDir: dir, files: {}, apps: {}, machines, storage: null, run})
		try {
			await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
			const s1 = await u.procedures['unraid.scan'].run()
			assert.equal(s1.vms[0].installed, false)

			const start1 = await u.procedures['unraid.start'].run({vms: ['Win11']})
			let st1
			for (let i = 0; i < 200; i++) {
				st1 = await u.procedures['unraid.status'].run()
				const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				if (st1.job?.endedAt && saved.includes(`"id": "${start1.id}"`) && /"endedAt": \d/.test(saved)) break
				await new Promise((r) => setTimeout(r, 10))
			}
			assert.equal(st1.job.items[0].status, 'done')
			assert.equal(st1.job.items[0].machineId, 'vm-abc')
			assert.equal(st1.job.items[0].machineName, 'Win11 (2)')
			assert.match(st1.job.items[0].note, /Win11 \(2\)/)

			const s2 = await u.procedures['unraid.scan'].run()
			assert.equal(s2.vms[0].installed, true)

			const start2 = await u.procedures['unraid.start'].run({vms: ['Win11']})
			let st2
			for (let i = 0; i < 200; i++) {
				st2 = await u.procedures['unraid.status'].run()
				const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				if (st2.job?.endedAt && saved.includes(`"id": "${start2.id}"`) && /"endedAt": \d/.test(saved)) break
				await new Promise((r) => setTimeout(r, 10))
			}
			assert.equal(st2.job.items[0].status, 'failed')
			assert.equal(st2.job.items[0].error, 'It’s already here')
			assert.equal(importCalls, 1)

			// Once removed from machines, it is no longer marked installed.
			stateResult = {done: true, error: 'It was removed'}
			const s3 = await u.procedures['unraid.scan'].run()
			assert.equal(s3.vms[0].installed, false)
		} finally {
			u.close()
			await rm(dir, {recursive: true, force: true})
		}
	}

	// 2. Real createMachines persists importedFrom across a fresh createUnraid even after job.json is removed and when renamed.
	{
		const dir = await mkdtemp(join(os.tmpdir(), 'unraid-vm-real-'))
		await mkdir(join(dir, 'machines'), {recursive: true})
		await writeFile(
			join(dir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [
					{
						id: 'aaaa1111',
						name: 'Win11',
						osId: 'ubuntu-2404',
						cores: 2,
						memoryMb: 2048,
						diskSizeGb: 16,
						layout: {firmware: 'efi', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: '/tmp/x.qcow2', device: 'disk', bus: 'virtio'}]},
					},
				],
			}),
		)
		const m1 = createMachines({dataDir: dir, kvmDevice: '/nonexistent', run: async () => ''})
		await m1.ready
		const u1 = createUnraid({dataDir: dir, files: {}, apps: {}, machines: m1, storage: null, run})
		let u2
		try {
			await u1.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
			const s1 = await u1.procedures['unraid.scan'].run()
			assert.equal(s1.vms[0].installed, false)
			const started = await u1.procedures['unraid.start'].run({vms: ['Win11']})
			let st
			for (let i = 0; i < 600; i++) {
				st = await u1.procedures['unraid.status'].run()
				const savedJob = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
				const savedMachines = await readFile(join(dir, 'machines', 'machines.json'), 'utf8').catch(() => '')
				if (st.job?.endedAt && savedJob.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(savedJob) && savedMachines.includes('Win11 (2)')) break
				await new Promise((r) => setTimeout(r, 10))
			}
			assert.equal(st.job.items[0].status, 'done')
			assert.equal(st.job.items[0].machineName, 'Win11 (2)')
			assert.match(st.job.items[0].note, /Win11 \(2\)/)

			await rm(join(dir, 'unraid', 'job.json'), {force: true})
			const m2 = createMachines({dataDir: dir, kvmDevice: '/nonexistent', run: async () => ''})
			await m2.ready
			assert.equal(m2.importedVm('Win11'), true)
			u2 = createUnraid({dataDir: dir, files: {}, apps: {}, machines: m2, storage: null, run})
			await u2.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
			const s2 = await u2.procedures['unraid.scan'].run()
			assert.equal(s2.vms[0].installed, true)
		} finally {
			u2?.close()
			u1.close()
			await rm(dir, {recursive: true, force: true})
		}
	}
})

test('unmeasured container appdata sizes are reported as null instead of 0', async () => {
	const containers = [
		{
			Name: '/timed-out',
			State: {Running: true},
			Config: {Image: 'app:1', Env: [], Labels: {}},
			HostConfig: {},
			Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/huge', Destination: '/config', RW: true}],
		},
		{
			Name: '/partial',
			State: {Running: true},
			Config: {Image: 'app:1', Env: [], Labels: {}},
			HostConfig: {},
			Mounts: [
				{Type: 'bind', Source: '/mnt/user/appdata/ok', Destination: '/ok', RW: true},
				{Type: 'bind', Source: '/mnt/user/appdata/huge', Destination: '/huge', RW: true},
			],
		},
		{
			Name: '/empty-dir',
			State: {Running: false},
			Config: {Image: 'app:1', Env: [], Labels: {}},
			HostConfig: {},
			Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/zero', Destination: '/zero', RW: true}],
		},
		{
			Name: '/no-appdata',
			State: {Running: false},
			Config: {Image: 'app:1', Env: [], Labels: {}},
			HostConfig: {},
			Mounts: [],
		},
	]
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-du-null-'))
	const run = async (cmd, argv = []) => {
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'appdata\t\n', stderr: ''}
		if (remote.startsWith('docker ps')) return {stdout: 'timed-out\npartial\nempty-dir\nno-appdata\n', stderr: ''}
		if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify(containers), stderr: ''}
		if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/huge\t\td\n/mnt/user/appdata/ok\t4096\td\n/mnt/user/appdata/zero\t0\td\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const u = createUnraid({dataDir: dir, files: {}, apps: {installed: () => false}, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		const scan = await u.procedures['unraid.scan'].run()
		const byId = Object.fromEntries(scan.containers.map((c) => [c.id, c]))
		assert.equal(byId['unraid-timed-out'].size, null)
		assert.equal(byId['unraid-partial'].size, null)
		assert.equal(byId['unraid-empty-dir'].size, 0)
		assert.equal(byId['unraid-no-appdata'].size, 0)
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('a failed job save does not leave the import running', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-job-ro-'))
	const jobDir = join(dir, 'unraid')
	const file = join(jobDir, 'job.json')
	const previous = '{\n\t"id": "old",\n\t"endedAt": 1,\n\t"items": []\n}\n'
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	await mkdir(jobDir, {recursive: true})
	await writeFile(file, previous)
	let rsyncs = 0
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			rsyncs++
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\n', stderr: ''}
		if (remote.includes('/mnt/user')) return {stdout: 'Media\t100\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const u = createUnraid({dataDir: dir, files, apps: {}, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		// The file itself has to refuse writes. A read-only directory still lets writeFile replace a file it can open.
		await chmod(file, 0o400)
		await chmod(jobDir, 0o500)
		await assert.rejects(u.procedures['unraid.start'].run({shares: ['Media']}), (err) => {
			assert.equal(err.code, 'EACCES')
			assert.doesNotMatch(err.message, /import is already running/)
			return true
		})
		assert.equal(rsyncs, 0, 'the copy must not start when the job file cannot be saved')
		assert.equal(await readFile(file, 'utf8'), previous)
		const stuck = await u.procedures['unraid.status'].run()
		assert.equal(stuck.job?.id, 'old')
		assert.ok(stuck.job?.endedAt)
		await chmod(jobDir, 0o700)
		await chmod(file, 0o600)
		const started = await u.procedures['unraid.start'].run({shares: ['Media']})
		assert.equal(typeof started.id, 'string')
		assert.notEqual(started.id, 'old')
		let done
		let saved = ''
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setImmediate(r))
			done = await u.procedures['unraid.status'].run()
			saved = await readFile(file, 'utf8').catch(() => '')
			// endedAt is visible in memory before the last save finishes. That save creates a
			// temporary file beside job.json, and removing the directory in the meantime throws
			// ENOTEMPTY. Wait until the saved job is the one that just finished.
			if (done.job?.endedAt && done.job.id === started.id && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
		}
		assert.equal(done.job?.id, started.id)
		assert.ok(done.job?.endedAt)
		assert.match(saved, new RegExp(`"id": "${started.id}"`))
		assert.match(saved, /"endedAt": \d/)
		assert.equal(rsyncs, 1)
		assert.equal((await stat(file)).mode & 0o777, 0o600)
	} finally {
		await chmod(jobDir, 0o700).catch(() => {})
		await chmod(file, 0o600).catch(() => {})
		u.close()
		for (let i = 0; i < 20; i++) {
			try {
				await rm(dir, {recursive: true, force: true})
				break
			} catch (error) {
				if (error?.code !== 'ENOTEMPTY' || i === 19) throw error
				await new Promise((r) => setTimeout(r, 15))
			}
		}
	}
})

test('two starts at the same moment let one import run and refuse the other', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-double-start-'))
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	let rsyncs = 0
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			rsyncs++
			await new Promise((r) => setTimeout(r, 100))
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\n', stderr: ''}
		if (remote.includes('/mnt/user')) return {stdout: 'Media\t100\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const u = createUnraid({dataDir: dir, files, apps: {}, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		const settled = await Promise.allSettled([
			u.procedures['unraid.start'].run({shares: ['Media']}),
			u.procedures['unraid.start'].run({shares: ['Media']}),
		])
		const fulfilled = settled.filter((r) => r.status === 'fulfilled')
		const rejected = settled.filter((r) => r.status === 'rejected')
		assert.equal(fulfilled.length, 1)
		assert.equal(rejected.length, 1)
		assert.equal(rejected[0].reason?.code, 'CONFLICT')
		assert.equal(rejected[0].reason?.message, 'An import is already running')
		const id = fulfilled[0].value.id
		let st
		for (let i = 0; i < 50; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job?.endedAt && st.job.id === id) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.equal(st.job?.id, id)
		assert.ok(st.job?.endedAt)
		assert.equal(rsyncs, 1)
	} finally {
		u.close()
		for (let i = 0; i < 20; i++) {
			try {
				await rm(dir, {recursive: true, force: true})
				break
			} catch (error) {
				if (error?.code !== 'ENOTEMPTY' || i === 19) throw error
				await new Promise((r) => setTimeout(r, 15))
			}
		}
	}
})

// End to end against a real SSH server standing in for Unraid (see the test's notes in the PR):
// OMARCHY_UNRAID_IT="host:port user password".
const it = process.env.OMARCHY_UNRAID_IT ? false : 'set OMARCHY_UNRAID_IT to run against an SSH stand-in for Unraid'
test('connect, look around, and bring shares, containers and a VM over', {skip: it, timeout: 300_000}, async () => {
	const [hostport, user, password] = String(process.env.OMARCHY_UNRAID_IT).split(' ')
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-it-'))
	const home = join(dir, 'home')
	await mkdir(home)
	const files = {
		async resolve(v, {mustExist = true} = {}) {
			const real = join(home, v.slice('/Home'.length))
			if (mustExist) await stat(real)
			return {real, top: 'Home'}
		},
	}
	const installed = []
	const shared = []
	const vmsMade = []
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async (id) => installed.push(id),
		importState: () => ({done: true, error: null}),
	}
	const machines = {
		importVm: async (spec) => {
			vmsMade.push({...spec, sizes: await Promise.all(spec.disks.map(async (d) => (await stat(d.file)).size))})
			return {id: 'vm1'}
		},
		importState: () => ({done: true, error: null}),
	}
	const storage = {procedures: {'files.addShare': {run: async ({path}) => shared.push(path)}}}
	const u = createUnraid({dataDir: join(dir, 'data'), files, apps, machines, storage, user, runtimeDir: dir})
	await writeFile('/srv/fake-unraid/vmstate', 'shut off\n').catch(() => {})
	const log = '/srv/fake-unraid/log'
	await writeFile(log, '').catch(() => {})
	try {
		await assert.rejects(u.procedures['unraid.connect'].run({host: hostport, password: 'wrong'}), /didn’t accept that password/)
		const c = await u.procedures['unraid.connect'].run({host: hostport, password})
		assert.equal(c.version, '7.0.1')
		assert.match(c.fingerprint, /^SHA256:/)
		const s = await u.procedures['unraid.scan'].run()
		const names = s.shares.map((x) => x.name)
		for (const n of ['Media', 'Documents', 'appdata', 'system', 'domains']) assert.ok(names.includes(n), n)
		assert.equal(s.shares.find((x) => x.name === 'appdata').kind, 'appdata')
		assert.ok(s.shares.find((x) => x.name === 'Media').size > 0)
		assert.deepEqual(s.containers.map((x) => x.id).sort(), ['unraid-nginx', 'unraid-plex'])
		assert.ok(s.containers.find((x) => x.id === 'unraid-plex').size > 0)
		assert.equal(s.vms.length, 1)
		assert.equal(s.vms[0].size, 2 * 1024 * 1024)
		assert.equal(s.containers[0].files, undefined, 'the listings stay on the server')

		await u.procedures['unraid.start'].run({shares: ['Media', 'Documents', 'system'], containers: ['unraid-plex', 'unraid-nginx'], vms: ['Win11'], destination: '/Home/Unraid'})
		let st
		for (let i = 0; i < 600; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job.endedAt) break
			await new Promise((r) => setTimeout(r, 250))
		}
		const items = Object.fromEntries(st.job.items.map((x) => [x.key, x]))
		for (const k of ['Media', 'Documents', 'unraid-plex', 'unraid-nginx', 'Win11']) assert.equal(items[k]?.status, 'done', `${k}: ${items[k]?.error}`)
		assert.equal(items.system, undefined, 'Unraid’s system share isn’t brought over')
		// Shares: copied and shared on the network.
		assert.equal(await readFile(join(home, 'Unraid/Media/Movies/film.txt'), 'utf8'), 'pretend movie\n')
		assert.equal(await readFile(join(home, 'Unraid/Documents/2026.txt'), 'utf8'), 'taxes\n')
		assert.deepEqual(shared.sort(), ['/Home/Unraid/Documents', '/Home/Unraid/Media'])
		// Containers: appdata in the app's folder, the listing in the imported store, installed.
		assert.equal(await readFile(join(dir, 'apps/unraid-plex/data/plex/Library/Application Support/Preferences.xml'), 'utf8'), '<Preferences/>\n')
		assert.equal(await readFile(join(dir, 'apps/unraid-nginx/data/nginx/site.conf'), 'utf8'), 'server {}\n')
		const compose = YAML.parse(await readFile(join(dir, 'store/unraid-plex/docker-compose.yml'), 'utf8'))
		assert.ok(compose.services.plex.volumes.includes(`${join(home, 'Unraid/Media/Movies')}:/movies`))
		assert.ok(compose.services.plex.volumes.includes(`${join(home, 'Unraid/Documents')}:/docs:ro`), 'read-only stays read-only')
		assert.deepEqual(installed, ['unraid-plex', 'unraid-nginx'])
		assert.match(items['unraid-plex'].note, /\/dev\/dri/)
		assert.doesNotMatch(items['unraid-plex'].note, /Media share/, 'the share it uses came over, so no warning about it')
		// Only the running one was paused on Unraid, and started again.
		assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['stop plex', 'start plex'])
		// The VM: its disk copied, then made into a machine; the copy is cleaned up afterwards.
		assert.equal(vmsMade.length, 1)
		assert.deepEqual(vmsMade[0].sizes, [2 * 1024 * 1024])
		assert.equal(vmsMade[0].firmware, 'efi')
		assert.deepEqual(await readdir(join(dir, 'data/unraid/staging')), [])

		// A VM still running on Unraid isn't copied.
		await writeFile('/srv/fake-unraid/vmstate', 'running\n')
		await u.procedures['unraid.start'].run({vms: ['Win11']})
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job.endedAt) break
			await new Promise((r) => setTimeout(r, 100))
		}
		assert.match(st.job.items[0].error, /Shut down Win11 on Unraid first/)
	} finally {
		await writeFile('/srv/fake-unraid/vmstate', 'shut off\n').catch(() => {})
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('scan returns unsupported share and VM names instead of dropping them', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-names-'))
	const sshCmds = []
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync' || cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		sshCmds.push(remote)
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-virsh\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) {
			return {
				stdout: ['Media\t10', 'Música\t20', 'Фото\t30', 'Family Photos\t40', 'TV, Movies\t50', 'appdata\t60', "Bob's Files\t70", '\t80'].join('\n') + '\n',
				stderr: '',
			}
		}
		if (remote.startsWith('virsh list')) return {stdout: "Win11\nWindows 11 & Office\nCafé-PC\nTom's PC\n\n", stderr: ''}
		if (remote.startsWith('virsh dumpxml')) return {stdout: `<domain type='kvm'><name>Win11</name><memory unit='KiB'>1048576</memory><vcpu>1</vcpu><devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='vda' bus='virtio'/></disk></devices></domain>`, stderr: ''}
		if (remote.startsWith('virsh domstate')) return {stdout: 'shut off\n', stderr: ''}
		if (remote.startsWith('stat -c %s')) return {stdout: '1024\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const u = createUnraid({dataDir: dir, files: {}, apps: {installed: () => false}, machines: {}, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		const s = await u.procedures['unraid.scan'].run()
		assert.deepEqual(
			s.shares.map((x) => [x.name, x.kind]),
			[
				['Media', 'share'],
				['Family Photos', 'share'],
				['appdata', 'appdata'],
			],
		)
		assert.deepEqual(s.skippedShares, ['Música', 'Фото', 'TV, Movies', "Bob's Files"])
		assert.deepEqual(
			s.vms.map((v) => v.name),
			['Win11'],
		)
		assert.deepEqual(s.skippedVms, ['Windows 11 & Office', 'Café-PC', "Tom's PC"])
		const probed = sshCmds.filter((c) => c.startsWith('virsh dumpxml') || c.startsWith('virsh domstate')).join('\n')
		assert.doesNotMatch(probed, /Office|Café|Tom/)
		await assert.rejects(u.procedures['unraid.start'].run({shares: ['Música']}), /Choose something/)
		await assert.rejects(u.procedures['unraid.start'].run({vms: ["Tom's PC"]}), /Choose something/)
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('directory rsync for shares and appdata preserves hard links', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-hardlink-'))
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	const rsyncCalls = []
	const container = {
		Name: '/file-app',
		State: {Running: false},
		Config: {Image: 'app:1', Env: [], Labels: {}},
		HostConfig: {PortBindings: {'8080/tcp': [{HostPort: '8080'}]}},
		Mounts: [
			{Type: 'bind', Source: '/mnt/user/appdata/app/config.ini', Destination: '/config.ini', RW: true},
			{Type: 'bind', Source: '/mnt/user/appdata/app/db', Destination: '/db', RW: true},
		],
	}
	const vmXml = `<domain type='kvm'><name>Win11</name><memory unit='KiB'>1048576</memory><vcpu>1</vcpu><devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='vda' bus='virtio'/></disk></devices></domain>`
	const run = async (cmd, argv = []) => {
		if (cmd === 'rsync') {
			rsyncCalls.push(argv)
			return {stdout: '', stderr: ''}
		}
		if (cmd === 'ssh-keygen') return {stdout: '', stderr: ''}
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.1"\nhas-rsync\nhas-docker\nhas-virsh\n', stderr: ''}
		if (remote.includes('/mnt/user/*')) return {stdout: 'Media\t100\nappdata\t200\ndomains\t300\n', stderr: ''}
		if (remote.startsWith('docker ps')) return {stdout: 'file-app\n', stderr: ''}
		if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([container]), stderr: ''}
		if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/app/config.ini\t128\tf\n/mnt/user/appdata/app/db\t4096\td\n', stderr: ''}
		if (remote.startsWith('virsh list')) return {stdout: 'Win11\n', stderr: ''}
		if (remote.startsWith('virsh dumpxml')) return {stdout: vmXml, stderr: ''}
		if (remote.startsWith('virsh domstate')) return {stdout: 'shut off\n', stderr: ''}
		if (remote.startsWith('stat -c %s')) return {stdout: '1048576\n', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async () => {},
		importState: () => ({done: true, error: null}),
	}
	const machines = {importVm: async () => ({id: 'vm-1'}), importState: () => ({done: true, error: null, name: 'Win11'})}
	const u = createUnraid({dataDir: dir, files, apps, machines, storage: null, run})
	try {
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'})
		await u.procedures['unraid.scan'].run()
		const started = await u.procedures['unraid.start'].run({shares: ['Media'], containers: ['unraid-file-app'], vms: ['Win11'], shareOnNetwork: false})
		let st
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
			if (st.job?.endedAt && saved.includes(`"id": "${started.id}"`) && /"endedAt": \d/.test(saved)) break
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.deepEqual(
			st.job.items.map((item) => item.status),
			['done', 'done', 'done'],
		)
		const shareCalls = rsyncCalls.filter((a) => a.some((x) => String(x).includes('/mnt/user/Media')))
		const appdataDirCalls = rsyncCalls.filter((a) => a.some((x) => String(x).includes('/mnt/user/appdata/app/db')))
		const fileCalls = rsyncCalls.filter((a) => a.some((x) => String(x).includes('config.ini')))
		const diskCalls = rsyncCalls.filter((a) => a.some((x) => String(x).includes('vdisk1.img')))
		assert.equal(shareCalls.length, 1)
		assert.equal(appdataDirCalls.length, 1)
		assert.equal(fileCalls.length, 1)
		assert.equal(diskCalls.length, 1)
		for (const argv of [...shareCalls, ...appdataDirCalls]) {
			assert.ok(argv.includes('-H'), `directory rsync should keep hard links: ${argv.join(' ')}`)
			assert.ok(argv.includes('-rlt'))
			assert.ok(argv.includes('--no-inc-recursive'))
		}
		for (const argv of fileCalls) {
			assert.equal(argv.includes('-H'), false)
			assert.ok(argv.includes('-lt'))
		}
		for (const argv of diskCalls) {
			assert.equal(argv.includes('-H'), false)
			assert.ok(argv.includes('--sparse'))
		}
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})
