import {useCallback, useMemo, useSyncExternalStore} from 'react'
import {useQueryClient, type QueryClient} from '@tanstack/react-query'

export const OFFLINE_MESSAGE = 'You’re offline. Lost contact with your server.'
export const UNREACHABLE_MESSAGE = 'Lost contact with your server. Retrying…'
export const OFFLINE_ACTION_MESSAGE = 'You’re offline. Check your connection and try again.'

export type ConnectionStatus = 'online' | 'offline' | 'unreachable'
export type ConnectionState = {
	reachable: boolean
	browserOnline: boolean
	status: ConnectionStatus
	message: string | null
}
export type ObservedQuery = {
	status: 'pending' | 'error' | 'success'
	fetchStatus: 'fetching' | 'paused' | 'idle'
	error: unknown
	dataUpdatedAt?: number
	errorUpdatedAt?: number
}

export function isBrowserOnline(nav: {onLine?: boolean} | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
	return nav?.onLine !== false
}

export function connectionStateFor(status: ConnectionStatus, browserOnline: boolean): ConnectionState {
	if (status === 'offline') {
		return {reachable: false, browserOnline, status, message: OFFLINE_MESSAGE}
	}
	if (status === 'unreachable') {
		return {reachable: false, browserOnline, status, message: UNREACHABLE_MESSAGE}
	}
	return {reachable: true, browserOnline, status, message: null}
}

export function deriveConnectionState(browserOnline: boolean, queries: ObservedQuery[]): ConnectionState {
	if (!browserOnline) return connectionStateFor('offline', false)
	if (queries.some((q) => q.fetchStatus === 'paused')) return connectionStateFor('offline', browserOnline)
	let newestErrorAt = 0
	let newestSuccessAt = 0
	for (const q of queries) {
		if (q.status === 'error' || q.error != null) {
			const at = q.errorUpdatedAt && q.errorUpdatedAt > 0 ? q.errorUpdatedAt : 1
			if (at > newestErrorAt) newestErrorAt = at
		} else if (q.status === 'success') {
			const at = q.dataUpdatedAt ?? 0
			if (at > newestSuccessAt) newestSuccessAt = at
		}
	}
	if (newestErrorAt > 0 && newestErrorAt > newestSuccessAt) {
		return connectionStateFor('unreachable', browserOnline)
	}
	return connectionStateFor('online', browserOnline)
}

const CORE_KEYS = new Set(['apps.list', 'system.stats'])

export function snapshotCacheStatus(qc: QueryClient, browserOnline = isBrowserOnline()): ConnectionStatus {
	if (!browserOnline) return 'offline'
	const all = qc.getQueryCache().getAll()
	const activeCore = all.filter((q) => q.getObserversCount() > 0 && typeof q.queryKey[0] === 'string' && CORE_KEYS.has(q.queryKey[0]))
	const source = activeCore.length ? activeCore : all.filter((q) => q.getObserversCount() > 0 && q.queryKey[0] !== 'bootstrap')
	const observed: ObservedQuery[] = source.map((q) => ({
		status: q.state.status,
		fetchStatus: q.state.fetchStatus,
		error: q.state.error,
		dataUpdatedAt: q.state.dataUpdatedAt,
		errorUpdatedAt: q.state.errorUpdatedAt,
	}))
	return deriveConnectionState(browserOnline, observed).status
}

export function queryProblem(q: {data: unknown; error: unknown; fetchStatus: 'fetching' | 'paused' | 'idle'}, browserOnline = isBrowserOnline()): string | null {
	if (q.error) return (q.error as Error).message || UNREACHABLE_MESSAGE
	if (q.data === undefined && (!browserOnline || q.fetchStatus === 'paused')) return OFFLINE_MESSAGE
	return null
}

function subscribeBrowserOnline(onStoreChange: () => void) {
	if (typeof window === 'undefined') return () => {}
	window.addEventListener('online', onStoreChange)
	window.addEventListener('offline', onStoreChange)
	return () => {
		window.removeEventListener('online', onStoreChange)
		window.removeEventListener('offline', onStoreChange)
	}
}

export function useBrowserOnline(): boolean {
	return useSyncExternalStore(subscribeBrowserOnline, () => isBrowserOnline(), () => true)
}

export function useServerReachable(): ConnectionState {
	const qc = useQueryClient()
	const browserOnline = useBrowserOnline()
	const subscribe = useCallback((onStoreChange: () => void) => qc.getQueryCache().subscribe(onStoreChange), [qc])
	const status = useSyncExternalStore(
		subscribe,
		() => snapshotCacheStatus(qc, browserOnline),
		() => 'online' as ConnectionStatus,
	)
	return useMemo(() => connectionStateFor(status, browserOnline), [status, browserOnline])
}

export function bootstrapPollInterval(state: {
	status: string
	data?: {configured?: boolean; server?: {reachable?: boolean} | null}
}): number | false {
	if (state.status === 'error') return 3000
	if (state.data?.configured && !state.data?.server?.reachable) return 3000
	return false
}

export function connectSubmitMode(
	unreachable: {url?: string} | null | undefined,
	enteredUrl: string,
): 'retry' | 'setup' {
	if (!unreachable) return 'setup'
	const trimmed = enteredUrl.trim()
	if (!trimmed || trimmed === (unreachable.url ?? '').trim()) return 'retry'
	return 'setup'
}
