// Files places for machines whose files can be read. The path is not a server folder: files.list
// must not see it. A computer is listed only while it is online and Files was granted. A virtual
// machine is listed only while it is running and its connector has granted Files. Its place uses
// the connector’s id, because that is how the files are addressed. Unreadable machines are omitted.

export const COMPUTER_PLACE = '::computer/'
export const GUEST_PLACE = '::guest/'

/** This server's own places (Home, Photos, Trash). Not a filesystem path. */
export const SERVER_FILES = '::server'

export type ComputerFileInput = {
	id: string
	name: string
	online: boolean
	filesGranted: boolean
}

export type GuestFileInput = {
	id: string
	name: string
	state: string
	/** Connector that can read this machine’s files. The place is addressed by this id. */
	agentId?: string
	filesGranted?: boolean
}

export type FilePlace = {
	id: string
	name: string
	path: string
	kind: 'computer' | 'guest'
	/** False when this machine is listed but its files cannot be read from here. */
	browsable: boolean
}

function safeComputerId(id: string): boolean {
	return !!id && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\')
}

function safeRel(rel: string): boolean {
	return !rel.split('/').some((part) => part === '..' || part === '.' || part.includes('\\'))
}

export function computerPlacePath(id: string, rel = ''): string | null {
	if (!safeComputerId(id)) return null
	const clean = rel.replace(/^\/+|\/+$/g, '')
	if (clean && !safeRel(clean)) return null
	return clean ? `${COMPUTER_PLACE}${id}/${clean}` : `${COMPUTER_PLACE}${id}`
}

export function guestPlacePath(id: string): string | null {
	if (!safeComputerId(id)) return null
	return `${GUEST_PLACE}${id}`
}

export function parseGuestPlace(path: string): {id: string} | null {
	if (!path.startsWith(GUEST_PLACE)) return null
	const id = path.slice(GUEST_PLACE.length)
	if (!id || id.includes('/') || !safeComputerId(id)) return null
	return {id}
}

export function parseComputerPlace(path: string): {id: string; rel: string} | null {
	if (!path.startsWith(COMPUTER_PLACE)) return null
	const rest = path.slice(COMPUTER_PLACE.length)
	const slash = rest.indexOf('/')
	const id = slash < 0 ? rest : rest.slice(0, slash)
	const rel = slash < 0 ? '' : rest.slice(slash + 1)
	if (!safeComputerId(id) || !safeRel(rel)) return null
	return {id, rel}
}

/**
 * Parent in the Files manager.
 * Null is the machine list. A shallow server folder returns to this server's places.
 * A computer's own root returns to the machine list.
 */
export function filesParent(path: string): string | null {
	if (parseGuestPlace(path)) return null
	if (parseComputerPlace(path)) return computerParent(path)
	if (path === SERVER_FILES) return null
	if (path.startsWith('::')) return SERVER_FILES
	const parts = path.split('/').filter(Boolean)
	if (parts.length <= 1) return SERVER_FILES
	parts.pop()
	return `/${parts.join('/')}`
}

/** A file manager locked to one machine. The global manager has no scope. */
export type FilesScope = {kind: 'server'} | {kind: 'computer'; id: string; name: string}

export function scopeRoot(scope: FilesScope): string | null {
	if (scope.kind === 'server') return SERVER_FILES
	return computerPlacePath(scope.id)
}

/** Keep navigation inside one machine. A path outside that machine becomes its root. */
export function withinScope(scope: FilesScope | undefined, path: string | null): string | null {
	if (!scope) return path
	const root = scopeRoot(scope)
	if (!root) return path
	if (scope.kind === 'server') {
		if (path == null || parseComputerPlace(path) || parseGuestPlace(path)) return root
		return path
	}
	const here = path ? parseComputerPlace(path) : null
	if (!here || here.id !== scope.id) return root
	return path
}

/** Parent path inside a computer place. Null means the Files root (the place list). */
export function computerParent(path: string): string | null {
	const here = parseComputerPlace(path)
	if (!here) return null
	if (!here.rel) return null
	const parts = here.rel.split('/').filter(Boolean)
	parts.pop()
	return computerPlacePath(here.id, parts.join('/'))
}

export function filePlaces(computers: readonly ComputerFileInput[], guests: readonly GuestFileInput[] = []): {places: FilePlace[]} {
	const computerPlaces: FilePlace[] = computers.filter((row) => row.online && row.filesGranted).flatMap((row) => {
		const path = computerPlacePath(row.id)
		return path ? [{id: row.id, name: row.name, path, kind: 'computer' as const, browsable: true}] : []
	})
	const guestPlaces: FilePlace[] = guests.filter((row) => row.state === 'running' && row.filesGranted && !!row.agentId).flatMap((row) => {
		const path = computerPlacePath(row.agentId ?? '')
		return path ? [{id: row.agentId ?? '', name: row.name, path, kind: 'computer' as const, browsable: true}] : []
	})
	const seen = new Set<string>()
	const places = [...computerPlaces, ...guestPlaces]
		.filter((place) => {
			if (seen.has(place.path)) return false
			seen.add(place.path)
			return true
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
	return {places}
}
