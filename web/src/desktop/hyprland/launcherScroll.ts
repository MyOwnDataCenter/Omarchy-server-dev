// Helpers for Hyprland launcher keyboard navigation and keeping the active item scrolled in view.
export type ScrollableList = {children: ArrayLike<{scrollIntoView?: (options?: ScrollIntoViewOptions) => void}>} | null | undefined

export function launcherRowMatches(label: string, query: string): boolean {
	const q = query.trim().toLowerCase()
	return q === '' || label.toLowerCase().includes(q)
}

export function stepLauncherSelection(current: number, key: 'ArrowDown' | 'ArrowUp', count: number): number {
	if (count <= 0) return 0
	const clamped = Math.max(0, Math.min(count - 1, current))
	return key === 'ArrowDown' ? Math.min(count - 1, clamped + 1) : Math.max(0, clamped - 1)
}

export function scrollSelectedRow(list: ScrollableList, index: number, count: number): boolean {
	if (!list || count <= 0) return false
	const clamped = Math.max(0, Math.min(count - 1, index))
	const row = list.children[clamped]
	if (!row?.scrollIntoView) return false
	row.scrollIntoView({block: 'nearest'})
	return true
}

// Yield capture-phase launcher keys (ArrowUp/ArrowDown/Enter/Escape) whenever a context menu is open
// above the launcher, so the topmost menu owns keyboard navigation and dismissal.
export function shouldYieldLauncherKey(
	doc: {querySelector?: (sel: string) => unknown; activeElement?: {closest?: (sel: string) => unknown} | null} | null | undefined,
	target: EventTarget | null | undefined,
): boolean {
	const t = target as {closest?: (sel: string) => unknown} | null | undefined
	if (t?.closest?.('.ctx-menu')) return true
	if (doc?.activeElement?.closest?.('.ctx-menu')) return true
	return Boolean(doc?.querySelector?.('.ctx-menu'))
}

// Handle capture-phase Enter only when the Filter input owns focus; focused list buttons activate natively.
export function shouldLauncherCaptureEnter(input: unknown, activeElement: unknown, target: EventTarget | null | undefined): boolean {
	if (!input) return false
	return target === input || activeElement === input
}

// Resolve the 0-based row index containing activeElement when focus is inside the launcher list, or -1 otherwise.
export function focusedLauncherIndex<T>(
	list: {children: ArrayLike<{contains?: (node: T) => boolean}>} | null | undefined,
	activeElement: T,
): number {
	if (!list || !activeElement) return -1
	for (let i = 0; i < list.children.length; i++) {
		if (list.children[i]?.contains?.(activeElement)) return i
	}
	return -1
}
