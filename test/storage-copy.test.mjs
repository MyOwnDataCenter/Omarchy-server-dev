import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {ZFS_INSTALL_COMMAND, poolCreatedToast, poolImportedToast} from '../web/src/screens/storageCopy.ts'

test('swarm pool toasts use the ~/Pools wording, and this server keeps Files', () => {
	assert.equal(poolCreatedToast('tank', false), 'Pool tank is ready in Files → Home → Pools')
	assert.equal(poolCreatedToast('tank', true), 'Pool tank is ready. It’s mounted at ~/Pools on this computer.')
	assert.equal(poolImportedToast('media', false), 'Imported. It’s in Files → Home → Pools → media')
	assert.equal(poolImportedToast('media', true), 'Imported. It’s mounted at ~/Pools on this computer.')
	assert.equal(ZFS_INSTALL_COMMAND, 'curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash -s -- --zfs')
})

test('the Storage screen shows the piped --zfs command and the swarm toasts', async () => {
	const src = await readFile(new URL('../web/src/screens/Storage.tsx', import.meta.url), 'utf8')
	assert.match(src, /ZFS_INSTALL_COMMAND/)
	assert.match(src, /poolCreatedToast\(name, swarm\)/)
	assert.match(src, /poolImportedToast\(name, swarm\)/)
	assert.doesNotMatch(src, /run the installer with/)
	assert.doesNotMatch(src, /Files → Home → Pools/)
})
