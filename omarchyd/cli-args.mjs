// Shared CLI option validation helpers for omarchyd and the web server.

// Parse a TCP port from an explicit CLI flag or an optional environment variable.
// Empty/whitespace env values count as unset; an explicit empty CLI flag is rejected.
export function parsePort(flagValue, envValue, {flag = '--port', env = null, fallback} = {}) {
	const fromFlag = flagValue !== undefined
	const raw = fromFlag ? flagValue : envValue === undefined || String(envValue).trim() === '' ? undefined : envValue
	if (raw === undefined) return fallback
	const text = String(raw).trim()
	const label = fromFlag || !env ? flag : env
	if (!/^\d+$/.test(text)) throw new Error(`${label} must be a number from 1 to 65535`)
	const n = Number(text)
	if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${label} must be a number from 1 to 65535`)
	return n
}

export function formatDataDirError(dataDir, error) {
	const code = error?.code
	if (code === 'EEXIST' || code === 'ENOTDIR') return `can't use ${dataDir} as the data folder: not a directory`
	if (code === 'EACCES' || code === 'EPERM') return `can't use ${dataDir} as the data folder: permission denied`
	if (code === 'EROFS') return `can't use ${dataDir} as the data folder: read-only file system`
	if (code === 'ENOENT') return `can't use ${dataDir} as the data folder: folder does not exist`
	return error?.message ?? String(error)
}
