import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {computerSheetChanged, formatBackupHour, formatBackupStamp, formatBackupWhen, sameFolders, serverLastRun} from '../web/src/backupHelpers.ts'

test('#162 un-ticking and re-ticking a computer folder leaves the sheet unchanged', async () => {
	const savedFolders = ['Documents', 'Pictures']
	const savedSchedule = {frequency: 'daily', hour: 1, weekday: 0}

	assert.equal(sameFolders(['Documents', 'Pictures'], savedFolders), true)
	assert.equal(sameFolders(['Pictures', 'Documents'], savedFolders), true)
	assert.equal(sameFolders(['Pictures'], savedFolders), false)
	assert.equal(sameFolders(['Documents', 'Pictures', 'Music'], savedFolders), false)

	// Un-ticking Documents marks changed; re-ticking it at the end clears changed.
	assert.equal(computerSheetChanged(['Pictures'], savedFolders, savedSchedule, savedSchedule), true)
	assert.equal(computerSheetChanged(['Pictures', 'Documents'], savedFolders, savedSchedule, savedSchedule), false)
	assert.equal(computerSheetChanged(['Pictures', 'Documents'], savedFolders, {frequency: 'daily', hour: 2, weekday: 0}, savedSchedule), true)

	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /computerSheetChanged\(/)
})

test('#437 backup schedule times and next run use the server time zone consistently', async () => {
	const nextRunAt = Date.parse('2026-11-21T03:00:00Z')
	const nowMs = Date.parse('2026-11-20T12:00:00Z')
	const threeAm = formatBackupHour(3)

	// Browser in New York viewing a UTC server sees tomorrow at 3:00 AM (UTC), not today at 10:00 PM.
	assert.equal(formatBackupWhen(nextRunAt, 'UTC', nowMs, 'America/New_York'), `tomorrow at ${threeAm} (UTC)`)
	// Browser in the same zone as the server omits the zone suffix.
	assert.equal(formatBackupWhen(nextRunAt, 'UTC', nowMs, 'UTC'), `tomorrow at ${threeAm}`)
	// Same-day run shows "today at ...".
	assert.equal(formatBackupWhen(Date.parse('2026-11-20T22:00:00Z'), 'UTC', nowMs, 'UTC'), `today at ${formatBackupHour(22)}`)
	// Later day shows weekday in server's time zone.
	assert.equal(formatBackupWhen(Date.parse('2026-11-22T03:00:00Z'), 'UTC', nowMs, 'America/New_York'), `Sunday at ${threeAm} (UTC)`)

	// Stamps render in the server time zone and tolerate an invalid time zone without throwing.
	assert.notEqual(formatBackupStamp(nextRunAt, 'UTC'), formatBackupStamp(nextRunAt, 'America/New_York'))
	assert.doesNotThrow(() => formatBackupWhen(nextRunAt, 'Invalid/Zone', nowMs, 'UTC'))
	assert.doesNotThrow(() => formatBackupStamp(nextRunAt, 'Invalid/Zone'))

	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /formatBackupWhen\(/)
	assert.match(src, /formatBackupHour\(/)
	assert.match(src, /formatBackupStamp\(/)
})

test('#600 serverLastRun prefers status.last when computer backups push server runs past the history slice', async () => {
	const srv = {id: 'srv1', endedAt: 1000, ok: true}
	const comp = {id: 'c1', computer: 'pc1', endedAt: 2000, ok: true}

	assert.equal(serverLastRun({last: srv, history: [comp]}), srv)
	assert.equal(serverLastRun({last: null, history: [comp]}), null)
	assert.equal(serverLastRun({history: [comp, srv]}), srv)
	assert.equal(serverLastRun({history: [comp]}), null)

	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /serverLastRun\(/)
})

test('a computer backup that skipped a folder or could not read files is a warning, not a green success', async () => {
	const mod = await import('../web/src/backupHelpers.ts')
	const backupGapText = mod.backupGapText ?? (() => '')
	const historyRowTone = mod.historyRowTone ?? (() => 'ok')
	const gap = backupGapText({skipped: ['Photos'], unreadable: true, files: 9})
	assert.equal(gap, 'Photos wasn’t found on this computer · 9 files couldn’t be read')
	assert.equal(backupGapText({skipped: ['Photos', 'Music']}), 'Photos, Music weren’t found on this computer')
	assert.equal(backupGapText({unreadable: true, files: 1}), '1 file couldn’t be read')
	assert.equal(backupGapText({skipped: [], unreadable: false, files: 4}), '')
	const warn = {endedAt: 1, ok: true, items: [{skipped: ['Photos'], unreadable: true, files: 9}]}
	assert.equal(historyRowTone(warn), 'warn')
	assert.equal(historyRowTone({endedAt: 1, ok: true, items: [{skipped: []}]}), 'ok')
	assert.equal(historyRowTone({endedAt: null, ok: false, items: []}), 'running')
	assert.equal(historyRowTone({endedAt: 1, ok: false, items: []}), 'bad')
	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /backupGapText\(/)
	assert.match(src, /historyRowTone\(/)
})

test('a folder listing error stays visible when folders are already chosen', async () => {
	const mod = await import('../web/src/backupHelpers.ts')
	const folderListError = mod.folderListError ?? (() => null)
	assert.equal(folderListError({message: 'Study PC is offline right now'}), 'Study PC is offline right now')
	assert.equal(folderListError(null), null)
	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /folderListError\(/)
	assert.equal(src.includes('folders.error && !c.folders.length'), false)
})

test('every kept computer backup is listed, not only the newest 20', async () => {
	const mod = await import('../web/src/backupHelpers.ts')
	const computerSnapshotRows = mod.computerSnapshotRows ?? ((rows) => (rows ?? []).slice(0, 20))
	const rows = Array.from({length: 25}, (_, i) => ({id: `s${i}`}))
	assert.equal(computerSnapshotRows(rows).length, 25)
	assert.equal(computerSnapshotRows(null).length, 0)
	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /computerSnapshotRows\(/)
	assert.equal(src.includes('slice(0, 20)'), false)
	assert.match(src, /Removed computers/)
	assert.match(src, /remove: true/)
})
