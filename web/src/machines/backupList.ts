import {errorText} from '../queryNotice.ts'

export function backupListView(q: {isLoading: boolean; error: unknown; data: {length: number} | undefined}): {loading: boolean; error: string | null; showEmpty: boolean} {
	const rows = q.data?.length ?? 0
	if (q.error && rows === 0 && !q.isLoading) return {loading: false, error: errorText(q.error), showEmpty: false}
	return {loading: q.isLoading && rows === 0, error: null, showEmpty: !q.isLoading && !q.error && q.data?.length === 0}
}
