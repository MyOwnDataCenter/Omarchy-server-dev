const TIMEOUT_CODES = new Set([
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'ETIMEDOUT',
])

const OFFLINE_CODES = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'ECONNRESET',
	'EPIPE',
])

function errorCodes(error) {
	const codes = []
	const seen = new Set()
	const visit = (err) => {
		if (!err || typeof err !== 'object' || seen.has(err)) return
		seen.add(err)
		if (typeof err.code === 'string') codes.push(err.code)
		if (Array.isArray(err.errors)) for (const sub of err.errors) visit(sub)
		if (err.cause) visit(err.cause)
	}
	visit(error)
	return codes
}

export function isNetworkError(error) {
	if (!error || typeof error !== 'object') return false
	if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
	const codes = errorCodes(error)
	if (codes.some((c) => TIMEOUT_CODES.has(c) || OFFLINE_CODES.has(c) || c === 'ECONNREFUSED')) return true
	const msg = String(error.message ?? '')
	return /^fetch failed$/i.test(msg) || /timed?\s*out|aborted due to timeout/i.test(msg)
}

export function fetchErrorMessage(what, error) {
	const codes = errorCodes(error)
	const msg = String(error?.message ?? '').trim()
	if (
		error?.name === 'TimeoutError' ||
		codes.some((c) => TIMEOUT_CODES.has(c)) ||
		/timed?\s*out|aborted due to timeout/i.test(msg)
	) {
		return `Couldn’t download ${what}: the download timed out. Check this server’s internet connection and try again.`
	}
	if (codes.includes('ECONNREFUSED')) {
		return `Couldn’t download ${what}: the download server refused the connection. Try again later.`
	}
	if (codes.some((c) => OFFLINE_CODES.has(c)) || /^fetch failed$/i.test(msg)) {
		return `Couldn’t download ${what}: this server can’t reach the internet. Check its connection and try again.`
	}
	if (error?.name === 'AbortError') {
		return `Couldn’t download ${what}: the download was interrupted. Try again.`
	}
	return `Couldn’t download ${what}: ${msg || 'network error'}. Check this server’s internet connection and try again.`
}

export function httpDownloadErrorMessage(what, status) {
	if (status === 404) return `Couldn’t download ${what}: the download link was not found (HTTP 404).`
	if (status === 403 || status === 429) {
		return `Couldn’t download ${what}: the download server turned the request away (HTTP ${status}). Try again later.`
	}
	if (status >= 500) {
		return `Couldn’t download ${what}: the download server had a problem (HTTP ${status}). Try again later.`
	}
	return `Couldn’t download ${what}: the download server answered with HTTP ${status}.`
}
