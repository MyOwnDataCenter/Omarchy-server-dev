// Retries for the assistant's provider requests. A busy provider (429, 5xx, Anthropic's 529
// "overloaded") or a dropped connection should not end the turn on the first try. Only the request
// is retried, before any of the answer has streamed, so nothing is shown or saved twice.

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529])
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])
// Out of credit is a 429 too, but waiting will not fix it.
const NO_QUOTA = /insufficient_quota|exceeded your current quota|billing|credit balance|spend.?limit/i

export const ATTEMPTS = 3
// A wait longer than this is reported instead: the person can try again themselves.
export const MAX_WAIT_MS = 20_000

const header = (res, name) => {
	try {
		return res?.headers?.get?.(name) ?? null
	} catch {
		return null
	}
}

// How long the provider asked us to wait, in ms, or null when it did not say.
export function retryAfterMs(res, nowMs = Date.now()) {
	const msRaw = header(res, 'retry-after-ms')
	if (msRaw != null && msRaw !== '' && Number.isFinite(Number(msRaw))) return Math.max(0, Number(msRaw))
	const raw = header(res, 'retry-after')
	if (raw == null || raw === '') return null
	const secs = Number(raw)
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
	const at = Date.parse(raw)
	return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

export const backoffMs = (attempt) => 1000 * 2 ** attempt + Math.floor(Math.random() * 250)

const networkError = (e) => e?.name !== 'AbortError' && (NETWORK_CODES.has(e?.cause?.code) || NETWORK_CODES.has(e?.code))

const abortError = () => Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})

export function sleepFor(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError())
		const done = () => {
			signal?.removeEventListener?.('abort', stop)
			resolve()
		}
		const timer = setTimeout(done, ms)
		const stop = () => {
			clearTimeout(timer)
			reject(abortError())
		}
		signal?.addEventListener?.('abort', stop, {once: true})
	})
}

// A failed response whose body was read to decide; handed on with the same text.
const replay = (res, raw) => ({ok: false, status: res.status, headers: res.headers, text: async () => raw, json: async () => JSON.parse(raw)})

// fetch, retried on busy and dropped responses. Same signature as fetch.
export function retryingFetch(fetchImpl = fetch, {attempts = ATTEMPTS, maxWaitMs = MAX_WAIT_MS, sleep = sleepFor, onRetry} = {}) {
	return async (url, init = {}) => {
		const signal = init.signal
		for (let attempt = 0; ; attempt++) {
			const last = attempt >= attempts - 1
			let res
			try {
				res = await fetchImpl(url, init)
			} catch (e) {
				if (last || signal?.aborted || !networkError(e)) throw e
				const wait = backoffMs(attempt)
				onRetry?.({attempt: attempt + 1, wait, reason: e?.cause?.code || e?.code})
				await sleep(wait, signal)
				continue
			}
			if (res.ok || !RETRY_STATUS.has(res.status) || last) return res
			// Anthropic says outright when a retry is pointless.
			if (header(res, 'x-should-retry') === 'false') return res
			let raw = ''
			try {
				raw = await res.text()
			} catch {}
			if (res.status === 429 && NO_QUOTA.test(raw)) return replay(res, raw)
			const asked = retryAfterMs(res)
			if (asked != null && asked > maxWaitMs) return replay(res, raw)
			const wait = asked ?? backoffMs(attempt)
			onRetry?.({attempt: attempt + 1, wait, reason: res.status})
			await sleep(wait, signal)
		}
	}
}

// A stream error that a fresh request may fix (Anthropic can report "overloaded" after a 200).
export const retryableStreamError = (ev) => ev?.type === 'error' && ev.retryable === true
