export const OTHER_CATEGORY = 'other'

export function searchNeedle(q: string) {
	return q.trim().toLowerCase()
}

export function joinedFields(parts: Array<string | undefined | null>) {
	return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}

export function categoryOf(category?: string | null) {
	return category ? category : OTHER_CATEGORY
}

export function rankedCategories(apps: {category?: string | null}[]) {
	const counts = new Map<string, number>()
	for (const a of apps) {
		const c = categoryOf(a.category)
		counts.set(c, (counts.get(c) ?? 0) + 1)
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
}

export function effectiveCategory(selected: string, categories: string[], extras: string[] = []) {
	if (selected === 'all' || extras.includes(selected) || categories.includes(selected)) return selected
	return 'all'
}

export function validCommunityStoreUrl(url: string) {
	return /^https:\/\/[\w.-]+(:\d+)?\/[\w.\-~/]+$/.test(url.trim())
}

export function appVersionLine(app: {version?: string; port?: number}, nextVersion?: string) {
	if (nextVersion) return `${app.version ?? '–'} → ${nextVersion}`
	const version = app.version ? `Version ${app.version}` : '–'
	return `${version}${app.port ? ` · port ${app.port}` : ''}`
}

// lastShown starts at 0 so the first probe (0s) does not toast, and later ones wait a full 10s.
export function nextStartingToast(sec: number, lastShown: number) {
	if (sec === 0 || sec - lastShown < 10) return {show: false, lastShown}
	return {show: true, lastShown: sec}
}
