import {errorText} from './queryNotice.ts'

export function storageDrivesView(q: {isLoading: boolean; error: unknown; data: {length: number} | undefined}): {loading: boolean; error: string | null; showList: boolean} {
	if (q.isLoading && q.data == null) return {loading: true, error: null, showList: false}
	if (q.error && !(q.data && q.data.length)) return {loading: false, error: errorText(q.error), showList: false}
	return {loading: false, error: null, showList: true}
}

// A failed status query has no helperAvailable flag. The "tools aren't set up" card
// is only for a real false, so the error itself has to be shown.
export function storageStatusMessage(q: {error: unknown; data: unknown}): string | null {
	if (q.data != null || !q.error) return null
	return errorText(q.error)
}

type Scrub = {state: string; errors: string; started: string | null; summary?: string} | null

// Clean “no errors” text only after a scrub that finished. Aborted and interrupted did not.
export function poolCheckText(p: {errors: number; kind: string; scrub: Scrub}): string {
	if (p.errors > 0) return `${p.errors} drive error${p.errors === 1 ? '' : 's'} recorded. Run an error check and look at the drives’ health.`
	const s = p.scrub
	if (s?.state === 'running') return 'Checking for errors now…'
	if (s?.errors) return `Last check: ${s.errors}`
	if (s?.state === 'aborted' || s?.state === 'interrupted') return 'Last check did not finish'
	if (s?.state === 'finished' && p.kind === 'zfs' && s.summary) return `Last check: ${s.summary.replace(/^scrub /, '')}`
	if (s?.state === 'finished' && s.started) return `Last checked ${new Date(s.started).toLocaleDateString()}, no errors`
	return 'Never checked for errors'
}
