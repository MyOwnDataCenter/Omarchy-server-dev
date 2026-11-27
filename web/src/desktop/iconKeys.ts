// Desktop icon shortcuts (select all, open, delete) apply only when focus is on the
// desktop surface. The page body is what a click on plain window text focuses, and
// that must not reach icons hidden behind the window.
type Focusable = {closest?: (selector: string) => unknown} | null | undefined

export function desktopIconKeysApply(active: Focusable): boolean {
	if (!active || typeof active.closest !== 'function') return false
	return !!active.closest('.desk-surface')
}

export function desktopIconKeyOpens(key: string): boolean {
	return key === 'Enter' || key === ' '
}

export function iconSelectionClearsOnFocus(target: Focusable): boolean {
	if (!target || typeof target.closest !== 'function') return false
	return !!target.closest('.win') && !target.closest('.desk-surface')
}
