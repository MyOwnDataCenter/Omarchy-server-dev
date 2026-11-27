// A target of "server", or no target, installs on this server.
// Any other id is a machine whose connector is online. apps.install forwards that request.
// An id that is not a machine id is refused here, before any install starts.

const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Null means this server. A string is the other machine. False means the id is not usable. */
export function installTargetId(target) {
	if (target == null || target === '' || target === 'server') return null
	const id = String(target)
	if (!TARGET_ID.test(id) || id.includes('..')) return false
	return id
}
