import type {QueryClient} from '@tanstack/react-query'
import type {UserApp} from './api.ts'

export type OptimisticAppSnapshot = {
	previous: UserApp[] | undefined
	appId: string
	prevState: UserApp['state']
	optimisticState: UserApp['state']
}

export async function applyOptimisticAppState(
	qc: QueryClient,
	optimistic: {appId: string; state: UserApp['state']},
): Promise<OptimisticAppSnapshot> {
	await qc.cancelQueries({queryKey: ['apps.list']})
	const previous = qc.getQueryData<UserApp[]>(['apps.list'])
	const prevApp = previous?.find((app) => app.id === optimistic.appId)
	qc.setQueryData<UserApp[]>(['apps.list'], (apps) =>
		apps?.map((app) => (app.id === optimistic.appId ? {...app, state: optimistic.state} : app)),
	)
	return {previous, appId: optimistic.appId, prevState: prevApp?.state, optimisticState: optimistic.state}
}

export function rollbackOptimisticAppState(qc: QueryClient, snapshot: OptimisticAppSnapshot | undefined) {
	if (!snapshot || snapshot.previous === undefined) return
	qc.setQueryData<UserApp[]>(['apps.list'], (current) => {
		if (!current) return snapshot.previous
		return current.map((app) =>
			app.id === snapshot.appId && app.state === snapshot.optimisticState ? {...app, state: snapshot.prevState} : app,
		)
	})
}
