import {createContext, useContext} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {
	ApiError,
	mutate,
	query,
	type Bootstrap,
	type InstallReview,
	type Machine,
	type Registry,
	type SystemStats,
	type User,
	type UserApp,
} from './api'
import {OFFLINE_ACTION_MESSAGE, isBrowserOnline} from './connection'
import {applyOptimisticAppState, rollbackOptimisticAppState} from './optimisticApps'
import {isAppBusy, useToast} from './ui'

export const BootstrapContext = createContext<Bootstrap | null>(null)
export const useBootstrap = () => useContext(BootstrapContext)!

export function useApps() {
	return useQuery({
		queryKey: ['apps.list'],
		queryFn: () => query<UserApp[]>('apps.list'),
		// Poll fast while anything is installing/starting/stopping so progress feels live.
		refetchInterval: (q) => ((q.state.data ?? []).some((a) => isAppBusy(a.state)) ? 1500 : 6000),
	})
}
export const useUpdates = () =>
	useQuery({queryKey: ['apps.updates'], queryFn: () => query<{id: string; version: string}[]>('apps.updates'), refetchInterval: 5 * 60_000})
export const useUser = () => useQuery({queryKey: ['user.get'], queryFn: () => query<User>('user.get'), staleTime: 5 * 60_000})
export const useRecent = () =>
	useQuery({queryKey: ['apps.recentlyOpened'], queryFn: () => query<string[]>('apps.recentlyOpened'), staleTime: 30_000, retry: false})

const statsQuery = {
	queryKey: ['system.stats'] as const,
	queryFn: () => query<SystemStats>('system.stats'),
	refetchInterval: 3000,
}
export const useCpu = () => useQuery({...statsQuery, select: (s) => s.cpu})
export const useMemory = () => useQuery({...statsQuery, select: (s) => s.memory})
export const useDisk = () => useQuery({...statsQuery, select: (s) => s.disk})
export const useTemp = () => useQuery({...statsQuery, select: (s) => s.temp})
export const useGpus = () => useQuery({...statsQuery, select: (s) => s.gpu})
export const useBattery = () => useQuery({...statsQuery, select: (s) => s.battery})
export const useUptime = () => useQuery({...statsQuery, select: (s) => s.uptime})
export const useNotifications = () =>
	useQuery({queryKey: ['notifications.get'], queryFn: () => query<string[]>('notifications.get'), refetchInterval: 30_000})
export const useMachines = () =>
	useQuery({
		queryKey: ['machines.list'],
		queryFn: () => query<Machine[]>('machines.list'),
		refetchInterval: (q) => ((q.state.data ?? []).some((m) => !['running', 'stopped', 'error', 'suspended', 'hibernated'].includes(m.state)) ? 2000 : 8000),
	})
export const useRegistry = (enabled = true) =>
	useQuery({queryKey: ['appStore.registry'], queryFn: () => query<Registry>('appStore.registry'), staleTime: 10 * 60_000, enabled})
export const useInstallReview = (appId: string | null) =>
	useQuery({
		queryKey: ['apps.installReview', appId],
		queryFn: () => query<InstallReview>('apps.installReview', {appId}),
		enabled: !!appId,
		retry: false,
		// Waiting for a one-time setup you run in a terminal: notice as soon as it's done.
		refetchInterval: (q) => (q.state.data?.setup?.length ? 3000 : false),
	})

// Run an omarchyd mutation with optimistic state, a toast, and a refresh.
export function useAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		networkMode: 'always',
		mutationFn: async (a: {path: string; input?: unknown; optimistic?: {appId: string; state: UserApp['state']}; adding?: Pick<UserApp, 'id' | 'name' | 'icon'>[]; done?: string}) => {
			if (!isBrowserOnline()) throw new ApiError(OFFLINE_ACTION_MESSAGE, 'OFFLINE', 0)
			return mutate(a.path, a.input)
		},
		onMutate: (a) => (a.optimistic ? applyOptimisticAppState(qc, a.optimistic) : undefined),
		onSuccess: (_, a) => {
			// A new install shows (installing) right away, everywhere the app list is shown, even
			// before the list is fetched again.
			if (a.adding?.length)
				qc.setQueryData<UserApp[]>(['apps.list'], (apps = []) => [
					...apps,
					...a.adding!.filter((n) => !apps.some((x) => x.id === n.id)).map((n) => ({path: '', ...n, state: 'installing', progress: 0}) as UserApp),
				])
			if (a.done) toast(a.done)
		},
		onError: (error: Error, _a, ctx) => {
			rollbackOptimisticAppState(qc, ctx)
			toast(error.message, true)
		},
		onSettled: (_, __, a) => {
			const domain = a.path.split('.')[0]
			if (domain === 'apps') {
				qc.invalidateQueries({queryKey: ['apps.list']})
				qc.invalidateQueries({queryKey: ['apps.updates']})
			}
			if (domain === 'machines') qc.invalidateQueries({queryKey: ['machines.list']})
			if (domain === 'usb') qc.invalidateQueries({queryKey: ['usb.list']})
			if (domain === 'notifications') qc.invalidateQueries({queryKey: ['notifications.get']})
		},
	})
}

export {appUrl} from './appUrl'
