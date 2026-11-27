/** Add a few pixels to the used padding. Replacing it with "2px" jumps a scrolled page. */
export function paddingBottomPlus(computedPaddingBottom: string, extraPx = 2): string {
	const n = Number.parseFloat(computedPaddingBottom)
	const base = Number.isFinite(n) ? n : 0
	return `${base + extraPx}px`
}
