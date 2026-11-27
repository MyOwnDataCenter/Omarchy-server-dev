// Per-key async serialization: calls sharing a key wait their turn, while different keys run
// together. A failed call rejects its own caller without blocking the next one in line.
export function createKeyedLock() {
	const queues = new Map()
	return function runLocked(key, fn) {
		const prev = queues.get(key) ?? Promise.resolve()
		const next = prev.then(() => fn())
		const settled = next.catch(() => {})
		queues.set(key, settled)
		settled.then(() => {
			if (queues.get(key) === settled) queues.delete(key)
		})
		return next
	}
}
