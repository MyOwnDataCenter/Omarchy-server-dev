// Small JSON-file persistence for config and device sessions. Files are written
// atomically with mode 0600 because sessions hold My Own Data Center device credentials.

import {createHash, randomBytes} from 'node:crypto'
import {chmod, mkdir, readFile, rename, stat} from 'node:fs/promises'
import {basename, join} from 'node:path'

import {writeAtomic} from '../omarchyd/atomic.mjs'

function plainObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

// A missing file is the fallback. A parse or shape problem is also the fallback, but the
// damaged bytes stay on disk under the first free aside name (*.bad, then *.bad.1, …).
// Any other read error still rejects startup. The log is the file name only.
async function readJson(file, fallback) {
	let text
	try {
		text = await readFile(file, 'utf8')
	} catch (error) {
		if (error.code === 'ENOENT') return fallback
		throw error
	}
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error
		parsed = undefined
	}
	if (plainObject(parsed)) return parsed
	const aside = await keepDamaged(file)
	console.error(`${basename(file)} is empty or invalid and was moved to ${basename(aside)}`)
	return fallback
}

async function asideName(file) {
	const first = `${file}.bad`
	for (let i = 0; i <= 1000; i++) {
		const candidate = i === 0 ? first : `${first}.${i}`
		try {
			await stat(candidate)
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
			return candidate
		}
	}
	throw new Error(`${basename(file)} damaged-file aside names are exhausted`)
}

async function keepDamaged(file) {
	const aside = await asideName(file)
	await rename(file, aside)
	return aside
}

async function writeJson(file, value) {
	await writeAtomic(file, JSON.stringify(value, null, 2))
	await chmod(file, 0o600).catch(() => {})
}

export const hashId = (id) => createHash('sha256').update(id).digest('hex')
export const newSessionId = () => randomBytes(32).toString('base64url')

export async function createStore(dataDir) {
	await mkdir(dataDir, {recursive: true, mode: 0o700})
	const configFile = join(dataDir, 'config.json')
	const sessionsFile = join(dataDir, 'sessions.json')

	let config = await readJson(configFile, {})
	// Keyed by sha256(cookie value) so the file alone can't be replayed as a cookie.
	let sessions = await readJson(sessionsFile, {})
	let writing = Promise.resolve()
	const persistSessions = () => {
		const run = writing.then(() => writeJson(sessionsFile, sessions))
		// Queue past a failure so the next save still runs, but this caller gets the rejection.
		writing = run.catch((error) => {
			const message = String(error?.message ?? error).split(dataDir).join('')
			console.error(`sessions.json: ${message}`)
		})
		return run
	}
	let configWriting = Promise.resolve()

	return {
		dataDir,
		getConfig: () => ({...config}),
		async setConfig(patch) {
			const run = configWriting.then(async () => {
				const update = typeof patch === 'function' ? await patch({...config}) : patch
				const next = {...config, ...update}
				await writeJson(configFile, next)
				config = next
				return {...config}
			})
			// Queue past a failure so the next save still runs, but this caller gets the rejection.
			configWriting = run.catch(() => {})
			return run
		},
		getSession: (cookieId) => (cookieId ? sessions[hashId(cookieId)] : undefined),
		async putSession(cookieId, session) {
			sessions[hashId(cookieId)] = session
			await persistSessions()
		},
		async updateSession(cookieId, patch) {
			const key = hashId(cookieId)
			if (!sessions[key]) return
			sessions[key] = {...sessions[key], ...patch}
			await persistSessions()
		},
		async deleteSession(cookieId) {
			delete sessions[hashId(cookieId)]
			await persistSessions()
		},
		async clearSessions() {
			sessions = {}
			await persistSessions()
		},
		sessionCount: () => Object.keys(sessions).length,
		// Every stored session with its key (sha256 of the cookie), for Settings › Signed-in devices.
		sessionEntries: () => Object.entries(sessions).map(([key, session]) => ({key, session})),
		async updateSessionByKey(key, patch) {
			if (!sessions[key]) return
			sessions[key] = {...sessions[key], ...patch}
			await persistSessions()
		},
		async deleteSessionByKey(key) {
			delete sessions[key]
			await persistSessions()
		},
	}
}
